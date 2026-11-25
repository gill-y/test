#!/usr/bin/env python3
"""SeeThrough Python camera node.

For a Raspberry Pi, a desktop with a USB camera, an IP camera (RTSP), or a depth
camera (Intel RealSense). It detects objects with Ultralytics YOLO, works out where
they are in the shared world map, and sends only object positions to the relay.
Raw video never leaves this machine (an optional small thumbnail aside).

No markers: put on the headset (it is the map), start this node with --calibrate, and
walk around in front of the camera for 15-30 seconds. The calibration is saved.

Examples
  python seethrough_node.py --relay wss://192.168.1.20:8443/ws --room ABC12 --insecure --source 0 --calibrate
  python seethrough_node.py --relay wss://192.168.1.20:8443/ws --room ABC12 --insecure \
      --source rtsp://user:pass@192.168.1.50:554/stream1 --name "Garage cam"
  python seethrough_node.py ... --depth realsense

Only connect cameras you own, pointed at places you're allowed to monitor.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import ssl
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field

import cv2
import numpy as np

SEND_HZ = 12
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])

TYPICAL_DEPTH = {
    "person": 0.4, "dog": 0.7, "cat": 0.45, "chair": 0.55, "couch": 0.9, "bed": 2.0, "dining table": 0.9,
    "tv": 0.15, "laptop": 0.3, "bicycle": 1.6, "potted plant": 0.4, "backpack": 0.25, "suitcase": 0.3,
}


# --------------------------------------------------------------------------- geometry

@dataclass
class Intrinsics:
    K: np.ndarray
    dist: np.ndarray
    width: int
    height: int

    @property
    def f(self) -> float:
        return float(self.K[0, 0])

    @staticmethod
    def from_fov(width: int, height: int, fov_h_deg: float) -> "Intrinsics":
        f = width / 2 / math.tan(math.radians(fov_h_deg) / 2)
        K = np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]], dtype=np.float64)
        return Intrinsics(K, np.zeros(5), width, height)

    @staticmethod
    def from_file(path: str, width: int, height: int) -> "Intrinsics":
        """JSON {"K": 3x3, "dist": [...], "width": w, "height": h} (e.g. from cv2.calibrateCamera)."""
        with open(path) as fh:
            d = json.load(fh)
        K = np.array(d["K"], dtype=np.float64)
        if d.get("width") and d["width"] != width:  # scale to the live resolution
            s = width / d["width"]
            K[:2] *= s
        return Intrinsics(K, np.array(d.get("dist", [0, 0, 0, 0, 0]), dtype=np.float64), width, height)


def pose_msg_to_matrix(pose: dict) -> np.ndarray:
    x, y, z, w = pose["q"]
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    M = np.eye(4)
    M[:3, :3] = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    M[:3, 3] = pose["p"]
    return M


def matrix_to_pose_msg(M: np.ndarray) -> dict:
    R = M[:3, :3]
    tr = np.trace(R)
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w, x, y, z = 0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        w, x, y, z = (R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        w, x, y, z = (R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        w, x, y, z = (R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s
    r = lambda v: round(float(v), 4)
    return {"p": [r(v) for v in M[:3, 3]], "q": [r(x), r(y), r(z), r(w)]}


def detection_to_world(bbox, intr: Intrinsics, world_from_cam: np.ndarray, label: str, depth_m: float | None = None):
    """bbox = (x, y, w, h) in pixels. Mirrors detectionToWorld() in js/common/geometry.js."""
    x, y, w, h = bbox
    f, cx, cy = intr.f, intr.K[0, 2], intr.K[1, 2]
    origin = world_from_cam[:3, 3]
    Rw = world_from_cam[:3, :3]
    d_obj = TYPICAL_DEPTH.get(label)
    if depth_m and depth_m > 0:
        u, v = x + w / 2, y + h / 2
        cam_pt = np.array([(u - cx) / f * depth_m, -(v - cy) / f * depth_m, -depth_m])
        centre = Rw @ cam_pt + origin
        W, H = w * depth_m / f, h * depth_m / f
        D = d_obj if d_obj is not None else min(W, 1.0)
        return {"p": centre.tolist(), "s": [W, H, D], "dist": float(np.linalg.norm(centre - origin))}
    u, v = x + w / 2, y + h
    d = np.array([(u - cx) / f, -(v - cy) / f, -1.0])
    d = Rw @ (d / np.linalg.norm(d))
    if d[1] > -0.01:
        return None
    t = -origin[1] / d[1]
    if t <= 0 or t > 50:
        return None
    foot = origin + t * d
    z = -(np.linalg.inv(world_from_cam) @ np.append(foot, 1.0))[2]
    if z <= 0.05:
        return None
    W, H = w * z / f, h * z / f
    D = d_obj if d_obj is not None else min(W, 1.0)
    away = np.array([foot[0] - origin[0], 0.0, foot[2] - origin[2]])
    away /= np.linalg.norm(away) or 1.0
    centre = foot + away * D / 2
    centre[1] = H / 2
    return {"p": centre.tolist(), "s": [W, H, D], "dist": float(np.linalg.norm(centre - origin))}


# --------------------------------------------------------------------------- calibration
#
# No markers: the headset is the map. The camera calibrates by watching the headset
# wearer walk around in front of it. The headset reports where the wearer's head is;
# the camera sees their head and feet at the same moments. Mirrors js/common/walkcal.js
# and solveCameraFromObservations() in js/common/geometry.js.

HEAD_TOP_ABOVE_EYES = 0.11  # top of the head above the headset (eyes), metres
HEAD_TOP_BEHIND = 0.05  # box top edge = back of the head, seen from above
FEET_IN_FRONT = 0.2  # box bottom edge = front of the nearer foot
FEET_WEIGHT = 0.35  # the feet edge moves with every stride: trust it less


class PositionHistory:
    """Timestamped positions, for looking up where the headset was when a frame was taken."""

    def __init__(self, max_age_ms: float = 20000):
        self.max_age_ms = max_age_ms
        self.items: list[tuple[float, list]] = []

    def push(self, ts: float, p) -> None:
        if self.items and ts <= self.items[-1][0]:
            return
        self.items.append((ts, list(p)))
        while self.items and ts - self.items[0][0] > self.max_age_ms:
            self.items.pop(0)

    def at(self, ts: float, max_gap: float = 250):
        a = self.items
        if not a or ts < a[0][0] or ts > a[-1][0] + 60:
            return None
        if ts >= a[-1][0]:
            return list(a[-1][1])
        for i in range(len(a) - 1, 0, -1):
            if a[i - 1][0] <= ts:
                (t0, p0), (t1, p1) = a[i - 1], a[i]
                if t1 - t0 > max_gap:
                    return None
                k = (ts - t0) / ((t1 - t0) or 1)
                return [v0 + (v1 - v0) * k for v0, v1 in zip(p0, p1)]
        return None


def _project(R, t, f, X, cx, cy):
    Xc = X @ R.T + t
    z = Xc[:, 2]
    zs = np.where(z > 0.05, z, 1.0)
    return cx + f * Xc[:, 0] / zs, cy + f * Xc[:, 1] / zs, z


def _residuals(params, obs, cx, cy, f_prior, refine_focal):
    R, _ = cv2.Rodrigues(params[:3])
    f = f_prior * math.exp(params[6]) if refine_focal else params[6]
    u, v, z = _project(R, params[3:6], f, obs["X"], cx, cy)
    pred = np.where(obs["axis"] == 0, u, v)
    r = (pred - obs["val"]) * obs["w"]
    r = np.where(z > 0.05, r, 1e3)
    if refine_focal:
        r = np.append(r, params[6] * 60)  # weak pull towards the configured field of view
    return r


def _refine(R, t, f, obs, cx, cy, f_prior, refine_focal, max_iter=40):
    rv, _ = cv2.Rodrigues(R)
    params = np.concatenate([rv.ravel(), np.asarray(t, float), [math.log(f / f_prior) if refine_focal else f]])
    n_p = 7 if refine_focal else 6
    mu = 1e-3
    r0 = _residuals(params, obs, cx, cy, f_prior, refine_focal)
    e0 = float(r0 @ r0)
    for _ in range(max_iter):
        J = np.zeros((r0.size, n_p))
        for j in range(n_p):
            d = 1e-6 if j < 3 or j == 6 else 1e-6 * max(1.0, abs(params[j]))
            p2 = params.copy()
            p2[j] += d
            J[:, j] = (_residuals(p2, obs, cx, cy, f_prior, refine_focal) - r0) / d
        A = J.T @ J
        A[np.diag_indices(n_p)] *= 1 + mu
        A[np.diag_indices(n_p)] += 1e-9
        try:
            step = np.linalg.solve(A, -J.T @ r0)
        except np.linalg.LinAlgError:
            break
        nxt = params.copy()
        nxt[:n_p] += step
        r1 = _residuals(nxt, obs, cx, cy, f_prior, refine_focal)
        e1 = float(r1 @ r1)
        if e1 < e0:
            gain = e0 - e1
            params, r0, e0 = nxt, r1, e1
            mu = max(mu / 3, 1e-9)
            if gain < 1e-9 * e0:
                break
        else:
            mu *= 4
            if mu > 1e8:
                break
    R, _ = cv2.Rodrigues(params[:3])
    f = f_prior * math.exp(params[6]) if refine_focal else params[6]
    return R, params[3:6].copy(), f


def _obs_arrays(obs_list):
    return {
        "X": np.array([o["X"] for o in obs_list], float),
        "axis": np.array([o["axis"] for o in obs_list]),
        "val": np.array([o["val"] for o in obs_list], float),
        "w": np.array([o.get("w", 1.0) for o in obs_list], float),
        "g": np.array([o["g"] for o in obs_list]),
    }


def solve_camera(obs_list, intr: "Intrinsics", refine_focal=True):
    """Camera pose from observations {X, axis (0 = u, 1 = v), val (px), w, g (frame)}.
    Returns dict(world_from_cam (GL, 4x4), f, fov_h, error, inliers, total) or None."""
    if len(obs_list) < 12:
        return None
    W = intr.width
    cx, cy, f0 = intr.K[0, 2], intr.K[1, 2], intr.f
    thr = max(12.0, W * 0.025)
    obs = _obs_arrays(obs_list)
    groups = [np.flatnonzero(obs["g"] == g) for g in np.unique(obs["g"])]
    if len(groups) < 5:
        return None

    def frame_errors(R, t, f):
        u, v, z = _project(R, t, f, obs["X"], cx, cy)
        e = np.abs((np.where(obs["axis"] == 0, u, v) - obs["val"]) * obs["w"])
        e = np.where(z > 0.05, e, 1e3)
        return e, np.array([e[ids].max() for ids in groups])

    def score(R, t, f):
        return float(np.minimum(frame_errors(R, t, f)[1] ** 2, thr * thr).sum())

    def subset(mask_groups):
        ids = np.concatenate([groups[i] for i in mask_groups]) if len(mask_groups) else np.array([], int)
        return {k: v[ids] for k, v in obs.items()}

    centre = obs["X"].mean(axis=0)
    step = max(1, math.ceil(len(groups) / 40))
    sub = subset(list(range(0, len(groups), step)))
    starts = []
    target = np.array([centre[0], 0.9, centre[2]])
    for a in range(16):
        ang = a / 16 * 2 * math.pi
        for d in (1.8, 3.2, 5.5):
            for h in (0.8, 1.8, 2.6):
                eye = np.array([centre[0] + math.sin(ang) * d, h, centre[2] + math.cos(ang) * d])
                zax = eye - target
                zax /= np.linalg.norm(zax)
                xax = np.cross([0.0, 1.0, 0.0], zax)
                xax /= np.linalg.norm(xax)
                yax = np.cross(zax, xax)
                Rgl = np.stack([xax, yax, zax], axis=1)  # world <- GL camera
                Rcv = np.diag([1.0, -1.0, -1.0]) @ Rgl.T  # CV camera <- world
                tcv = -Rcv @ eye
                R, t, f = _refine(Rcv, tcv, f0, sub, cx, cy, f0, False, max_iter=12)
                starts.append((score(R, t, f), R, t, f))
    starts.sort(key=lambda s: s[0])
    best = None
    for _, R, t, f in starts[:4]:
        ok = True
        for rnd in range(4):
            _, fe = frame_errors(R, t, f)
            keep = [i for i, e in enumerate(fe) if e < thr * (1 if rnd else 2.5)]
            sel = subset(keep)
            if sel["X"].shape[0] < 12:
                ok = False
                break
            R, t, f = _refine(R, t, f, sel, cx, cy, f0, refine_focal and sel["X"].shape[0] >= 40 and rnd > 0)
        if ok:
            sc = score(R, t, f)
            if best is None or sc < best[0]:
                best = (sc, R, t, f)
    if best is None:
        return None
    _, R, t, f = best
    e, fe = frame_errors(R, t, f)
    T = np.eye(4)
    T[:3, :3], T[:3, 3] = R, t
    world_from_cam = np.linalg.inv(CV_TO_GL @ T)
    inl = e[e < thr]
    return {
        "world_from_cam": world_from_cam,
        "f": f,
        "fov_h": math.degrees(2 * math.atan(W / 2 / f)),
        "error": float(np.median(inl)) if inl.size else float("inf"),
        "inliers": int((fe < thr).sum()),
        "total": len(groups),
    }


class WalkCalibrator:
    """Collects (person box, headset position) pairs and solves for the camera pose."""

    def __init__(self, intr: "Intrinsics", min_frames: int = 100, min_spread: float = 2.0, min_seconds: float = 12.0):
        self.intr = intr
        self.min_frames = min_frames
        self.min_spread = min_spread
        self.min_seconds = min_seconds
        self.started = time.time()
        self.obs: list[dict] = []
        self.heads: list[tuple[float, float]] = []
        self.us: list[float] = []
        self.frames = 0

    def add(self, bbox, head) -> bool:
        x, y, w, h = bbox
        W, H = self.intr.width, self.intr.height
        cxb = x + w / 2
        if cxb < 0 or cxb > W or w < 8 or h < 16:
            return False
        top = head[1] + HEAD_TOP_ABOVE_EYES
        top_vis = y > 3
        feet_vis = y + h < H - 3 and head[1] > 1.2
        if not top_vis and not feet_vis:
            return False
        g = self.frames
        if top_vis:
            self.obs.append({"X": [head[0], top, head[2]], "axis": 1, "val": y, "g": g, "kind": "top"})
        if feet_vis:
            self.obs.append({"X": [head[0], 0.0, head[2]], "axis": 1, "val": y + h, "g": g, "kind": "feet", "w": FEET_WEIGHT})
        if x > 3 and x + w < W - 3:
            self.obs.append({"X": [head[0], top / 2, head[2]], "axis": 0, "val": cxb, "g": g})
        self.frames += 1
        self.heads.append((head[0], head[2]))
        self.us.append(cxb / W)
        return True

    def progress(self) -> dict:
        pts = np.array(self.heads) if self.heads else np.zeros((0, 2))
        spread = float(np.max(np.linalg.norm(pts[:, None] - pts[None], axis=2))) if len(pts) > 1 else 0.0
        width = float(math.sqrt(max(0.0, np.linalg.eigvalsh(np.cov(pts.T))[0]))) if len(pts) > 2 else 0.0
        u_spread = (max(self.us) - min(self.us)) if self.us else 0.0
        elapsed = time.time() - self.started
        parts = [min(1, self.frames / self.min_frames), min(1, spread / self.min_spread), min(1, u_spread / 0.4), min(1, width / 0.35),
                 min(1, elapsed / self.min_seconds) if self.min_seconds else 1]
        hint = ""
        if parts[1] < 1:
            hint = "Walk around more: cover at least 2 m."
        elif parts[3] < 1:
            hint = "Walk towards the camera and away from it too, not just across."
        elif parts[2] < 1:
            hint = "Walk across the picture, from one side to the other."
        return {"fraction": min(parts), "ready": min(parts) >= 1, "hint": hint}

    def _corrected(self, cam_x, cam_z):
        out = []
        far = [o for o in self.obs if math.hypot(o["X"][0] - cam_x, o["X"][2] - cam_z) > 1.0]
        for o in far if len(far) >= len(self.obs) * 0.5 else self.obs:
            k = {"top": HEAD_TOP_BEHIND, "feet": -FEET_IN_FRONT}.get(o.get("kind"))
            if k is None:
                out.append(o)
                continue
            dx, dz = o["X"][0] - cam_x, o["X"][2] - cam_z
            n = math.hypot(dx, dz) or 1.0
            out.append({**o, "X": [o["X"][0] + dx / n * k, o["X"][1], o["X"][2] + dz / n * k]})
        return out

    def solve(self):
        res = solve_camera(self.obs, self.intr)
        for _ in range(2):
            if not res:
                break
            c = res["world_from_cam"][:3, 3]
            nxt = solve_camera(self._corrected(c[0], c[2]), self.intr)
            if not nxt:
                break
            res = nxt
        if not res:
            return None
        c = res["world_from_cam"][:3, 3]
        mx, mz = np.mean(self.heads, axis=0)
        res["ok"] = bool(
            0.05 < c[1] < 4 and math.hypot(c[0] - mx, c[2] - mz) < 12
            and res["inliers"] >= res["total"] * 0.6 and res["error"] <= max(12, self.intr.width * 0.025)
        )
        return res


# --------------------------------------------------------------------------- tracking

class SimpleTracker:
    """Fallback ID tracker (YOLO's own tracker is used when it gives IDs)."""

    def __init__(self, gate=1.0, alpha=0.5, max_age=0.8):
        self.gate, self.alpha, self.max_age = gate, alpha, max_age
        self.tracks: dict[str, dict] = {}
        self.next = 1

    def update(self, dets, now):
        pairs = []
        for di, d in enumerate(dets):
            for tid, tr in self.tracks.items():
                if tr["label"] != d["label"]:
                    continue
                dist = math.hypot(tr["p"][0] - d["p"][0], tr["p"][2] - d["p"][2])
                if dist < self.gate + max(d["s"][0], tr["s"][0]) * 0.5:
                    pairs.append((dist, di, tid))
        pairs.sort()
        used_d, used_t, out = set(), set(), []
        for _, di, tid in pairs:
            if di in used_d or tid in used_t:
                continue
            used_d.add(di)
            used_t.add(tid)
            tr, d = self.tracks[tid], dets[di]
            tr["p"] = [a + self.alpha * (b - a) for a, b in zip(tr["p"], d["p"])]
            tr["s"] = [a + self.alpha * (b - a) for a, b in zip(tr["s"], d["s"])]
            tr["c"], tr["seen"] = d["c"], now
            out.append(tr)
        for di, d in enumerate(dets):
            if di not in used_d:
                tid = f"p{self.next}"
                self.next += 1
                self.tracks[tid] = {"id": tid, **d, "seen": now}
                out.append(self.tracks[tid])
        self.tracks = {k: v for k, v in self.tracks.items() if now - v["seen"] < self.max_age}
        return out


# --------------------------------------------------------------------------- capture

class Capture:
    """OpenCV capture (index, file, RTSP/HTTP URL) or a RealSense colour + aligned depth stream."""

    def __init__(self, source: str, width: int, height: int, depth: str | None):
        self.depth_mode = depth
        self.rs = None
        if depth == "realsense":
            import pyrealsense2 as rs  # optional dependency

            self.rs = rs
            self.pipe = rs.pipeline()
            cfg = rs.config()
            cfg.enable_stream(rs.stream.color, width, height, rs.format.bgr8, 30)
            cfg.enable_stream(rs.stream.depth, width, height, rs.format.z16, 30)
            profile = self.pipe.start(cfg)
            self.align = rs.align(rs.stream.color)
            self.depth_scale = profile.get_device().first_depth_sensor().get_depth_scale()
            intr = profile.get_stream(rs.stream.color).as_video_stream_profile().get_intrinsics()
            self.factory_intrinsics = Intrinsics(
                np.array([[intr.fx, 0, intr.ppx], [0, intr.fy, intr.ppy], [0, 0, 1]]), np.array(intr.coeffs), intr.width, intr.height
            )
        else:
            src = int(source) if source.isdigit() else source
            if isinstance(src, str) and src.startswith("rtsp"):
                os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
            self.cap = cv2.VideoCapture(src)
            # A video file plays in real time and loops (handy for testing with recorded footage).
            self.is_file = isinstance(src, str) and os.path.exists(src)
            self.frame_dt = 1.0 / (self.cap.get(cv2.CAP_PROP_FPS) or 30) if self.is_file else 0
            if isinstance(src, int):
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # always the newest frame: latency over completeness
            if not self.cap.isOpened():
                raise SystemExit(f"Could not open video source {source!r}")
            self.factory_intrinsics = None
        self.lock = threading.Lock()
        self.latest = None
        self.running = True
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while self.running:
            if self.rs:
                frames = self.align.process(self.pipe.wait_for_frames())
                color, depth = frames.get_color_frame(), frames.get_depth_frame()
                if not color or not depth:
                    continue
                item = (np.asanyarray(color.get_data()).copy(), np.asanyarray(depth.get_data()).copy() * self.depth_scale)
            else:
                ok, frame = self.cap.read()
                if not ok:
                    if self.is_file:
                        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    time.sleep(0.05)
                    continue
                if self.frame_dt:
                    time.sleep(self.frame_dt)
                item = (frame, None)
            with self.lock:
                self.latest = item

    def read(self):
        with self.lock:
            item, self.latest = self.latest, None
        return item

    def close(self):
        self.running = False
        if self.rs:
            self.pipe.stop()
        else:
            self.cap.release()


def depth_at(depth_img, bbox) -> float | None:
    if depth_img is None:
        return None
    x, y, w, h = bbox
    cx, cy = int(x + w / 2), int(y + h / 2)
    r = max(2, int(min(w, h) * 0.1))
    patch = depth_img[max(0, cy - r): cy + r, max(0, cx - r): cx + r]
    vals = patch[(patch > 0.1) & (patch < 15)]
    return float(np.median(vals)) if vals.size else None


# --------------------------------------------------------------------------- node

@dataclass
class NodeState:
    map: dict | None = None
    pose: np.ndarray | None = None
    calib: dict | None = None
    offset_ms: float = 0.0
    best_rtt: float = float("inf")
    pending: list | None = None
    thumb: str | None = None
    connected: asyncio.Event = field(default_factory=asyncio.Event)


class Node:
    def __init__(self, args):
        self.args = args
        self.id = args.id or f"py-{uuid.uuid5(uuid.NAMESPACE_DNS, args.name + args.source).hex[:8]}"
        self.state = NodeState()
        self.calib_path = args.calib_file or f"seethrough_calib_{self.id}_{args.room}.json"
        self.calibrating = bool(args.calibrate)
        self.calibrator: WalkCalibrator | None = None
        self.headsets: dict[str, PositionHistory] = {}  # headset id -> head positions (world, relay clock)
        self._last_calib_log = 0.0
        self.capture = Capture(args.source, args.width, args.height, args.depth)
        self.intr = None
        self.model = None
        self.tracker = SimpleTracker()
        self.ws = None
        self.loop = None
        self.stop = threading.Event()
        self._load_calibration()

    # ---- helpers

    def now_ms(self) -> float:
        return time.time() * 1000 + self.state.offset_ms

    def _intrinsics_for(self, frame) -> Intrinsics:
        h, w = frame.shape[:2]
        if self.intr and self.intr.width == w and self.intr.height == h:
            return self.intr
        if self.capture.factory_intrinsics is not None:
            self.intr = self.capture.factory_intrinsics
        elif self.args.intrinsics:
            self.intr = Intrinsics.from_file(self.args.intrinsics, w, h)
        else:
            self.intr = Intrinsics.from_fov(w, h, self.args.fov)
        return self.intr

    def _load_calibration(self):
        if self.args.calibrate or not os.path.exists(self.calib_path):
            return
        with open(self.calib_path) as fh:
            self.state.calib = json.load(fh)
        log(f"Loaded calibration from {self.calib_path}. Use --calibrate if the camera has moved.")

    def _apply_calibration(self):
        c = self.state.calib
        if not c:
            return
        world = (self.state.map or {}).get("worldId")
        if world and c.get("worldId") != world:
            if self.state.pose is not None or not getattr(self, "_warned_world", False):
                log("This calibration belongs to an older map (the headset started a new one). Run again with --calibrate.")
                self._warned_world = True
            self.state.pose = None
            return
        self.state.pose = pose_msg_to_matrix(c["pose"])
        p = self.state.pose[:3, 3]
        log(f"Camera pose: ({p[0]:.2f}, {p[1]:.2f}, {p[2]:.2f}) m on the headset's map")
        self._send_camera()

    def _send(self, msg: dict):
        if self.ws is None or self.loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._send_async(msg), self.loop)

    async def _send_async(self, msg):
        try:
            await self.ws.send(json.dumps(msg))
        except Exception:
            pass

    def _send_camera(self):
        self._send({
            "t": "camera", "id": self.id, "name": self.args.name, "kind": "python",
            "pose": matrix_to_pose_msg(self.state.pose) if self.state.pose is not None else None,
            "fovH": math.degrees(2 * math.atan(self.intr.width / 2 / self.intr.f)) if self.intr else self.args.fov,
            "aspect": (self.intr.width / self.intr.height) if self.intr else 16 / 9,
            "active": True,
        })

    # ---- worker thread: capture -> detect -> 3D

    def worker(self):
        try:
            self._worker()
        except Exception:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            self.stop.set()

    def _worker(self):
        last_send = 0.0
        last_thumb = 0.0
        fps_t, fps_n = time.time(), 0
        while not self.stop.is_set():
            item = self.capture.read()
            if item is None:
                time.sleep(0.003)
                continue
            frame, depth = item
            ts = self.now_ms()  # when this frame was taken, on the relay clock
            intr = self._intrinsics_for(frame)
            if self.state.calib and self.state.pose is None and self.state.map is not None and not self.calibrating:
                self._apply_calibration()

            dets = self._detect(frame)
            if self.calibrating:
                self._calibration_step(dets, ts, intr)
                if self.args.show:
                    self._show(frame, dets)
                continue
            objs = []
            if self.state.pose is not None:
                for d in dets:
                    w = detection_to_world(d["bbox"], intr, self.state.pose, d["label"], depth_at(depth, d["bbox"]))
                    d["world"] = w
                    if w:
                        objs.append({"label": d["label"], "p": w["p"], "s": w["s"], "c": d["score"], "tid": d.get("tid")})
            now = time.time()
            tracked = self._track(objs, now)
            if now - last_send >= 1 / SEND_HZ and self.state.pose is not None:
                last_send = now
                self._send({"t": "objects", "cam": self.id, "ts": self.now_ms(), "objs": tracked})
            if self.args.thumbs and now - last_thumb > 2:
                last_thumb = now
                small = cv2.resize(frame, (192, int(192 * frame.shape[0] / frame.shape[1])))
                ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 55])
                if ok:
                    self._send({"t": "thumb", "cam": self.id, "img": "data:image/jpeg;base64," + base64.b64encode(buf).decode()})
            fps_n += 1
            if now - fps_t > 5:
                log(f"● CAMERA ACTIVE · {fps_n / (now - fps_t):.1f} fps · {len(tracked)} objects"
                    + ("" if self.state.pose is not None else " · NOT CALIBRATED (nothing sent)"))
                fps_t, fps_n = now, 0
            if self.args.show:
                self._show(frame, dets)

    def _active_headset(self):
        now = self.now_ms()
        best = None
        for hid, h in self.headsets.items():
            if h.items and now - h.items[-1][0] < 1500 and (best is None or h.items[-1][0] > best.items[-1][0]):
                best = h
        return best

    def _calibration_step(self, dets, ts, intr):
        """Walk calibration: pair the only person in view with where the headset says it is."""
        now = time.time()
        if self.calibrator is None:
            if not (self.state.map or {}).get("worldId"):
                if now - self._last_calib_log > 5:
                    log("Waiting for the map: put on the headset and press Enter AR (the headset becomes the map).")
                    self._last_calib_log = now
                return
            if self._active_headset() is None:
                if now - self._last_calib_log > 5:
                    log("Waiting for the headset's position: make sure it's in AR and on the map.")
                    self._last_calib_log = now
                return
            self.calibrator = WalkCalibrator(intr)
            log("Calibrating: walk slowly around in front of this camera wearing the headset, "
                "crossing the picture, nearer and further. Only you should be in view.")
        cal = self.calibrator
        people = [d for d in dets if d["label"] == "person" and d["score"] >= 0.5]
        hs = self._active_headset()
        head = hs.at(ts) if hs else None
        if len(people) == 1 and head:
            cal.add(people[0]["bbox"], head)
        prog = cal.progress()
        if now - self._last_calib_log > 2:
            log(f"Calibrating… {prog['fraction'] * 100:.0f}% ({cal.frames} frames). {prog['hint']}"
                + (" More than one person in view." if len(people) > 1 else ""))
            self._last_calib_log = now
        if not prog["ready"] or cal.frames % 10:
            return
        res = cal.solve()
        if not res or not res["ok"]:
            if cal.frames > cal.min_frames * 3:
                log("Couldn't get a good fit. Check that only you are in view and the camera is still; starting over.")
                self.calibrator = None
            return
        self.state.calib = {
            "worldId": self.state.map["worldId"],
            "pose": matrix_to_pose_msg(res["world_from_cam"]),
            "fovH": res["fov_h"],
            "width": intr.width,
            "height": intr.height,
            "error": res["error"],
            "at": time.time(),
        }
        # Use the refined field of view from now on.
        self.intr = Intrinsics.from_fov(intr.width, intr.height, res["fov_h"]) if self.capture.factory_intrinsics is None and not self.args.intrinsics else intr
        with open(self.calib_path, "w") as fh:
            json.dump(self.state.calib, fh, indent=2)
        log(f"Calibrated from {cal.frames} frames (fit {res['error']:.1f} px, field of view {res['fov_h']:.1f}°). "
            f"Saved to {self.calib_path}. Don't move the camera now.")
        self.calibrator = None
        self.calibrating = False
        self._apply_calibration()

    def _load_model(self):
        if self.model is None:
            from ultralytics import YOLO  # heavy import, only when detecting

            self.model = YOLO(self.args.model)
            log(f"Loaded {self.args.model}")

    def _detect(self, frame):
        self._load_model()
        res = self.model.track(frame, persist=True, conf=self.args.min_conf, verbose=False, imgsz=self.args.imgsz)[0]
        out = []
        names = res.names
        ids = res.boxes.id.int().tolist() if res.boxes.id is not None else [None] * len(res.boxes)
        for xyxy, cls, conf, tid in zip(res.boxes.xyxy.tolist(), res.boxes.cls.int().tolist(), res.boxes.conf.tolist(), ids):
            label = names[cls]
            if self.args.labels and label not in self.args.labels:
                continue
            x1, y1, x2, y2 = xyxy
            out.append({"label": label, "score": float(conf), "bbox": (x1, y1, x2 - x1, y2 - y1), "tid": tid})
        return out

    def _track(self, objs, now):
        r3 = lambda v: [round(float(a), 3) for a in v]
        if objs and all(o.get("tid") is not None for o in objs):
            return [{"id": f"y{o['tid']}", "label": o["label"], "p": r3(o["p"]), "s": r3(o["s"]), "c": round(o["c"], 2)} for o in objs]
        tracked = self.tracker.update([{k: o[k] for k in ("label", "p", "s", "c")} for o in objs], now)
        return [{"id": t["id"], "label": t["label"], "p": r3(t["p"]), "s": r3(t["s"]), "c": round(t["c"], 2)} for t in tracked]

    def _show(self, frame, dets):
        vis = frame.copy()
        for d in dets:
            x, y, w, h = map(int, d["bbox"])
            cv2.rectangle(vis, (x, y), (x + w, y + h), (255, 232, 56), 2)
            txt = f"{d['label']} {d['score']:.2f}" + (f" {d['world']['dist']:.1f} m" if d.get("world") else "")
            cv2.putText(vis, txt, (x, max(15, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        if self.calibrator is not None:
            prog = self.calibrator.progress()
            cv2.putText(vis, f"Calibrating {prog['fraction'] * 100:.0f}%  {prog['hint']}", (12, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (63, 210, 255), 2)
        cv2.rectangle(vis, (0, 0), (vis.shape[1], 28), (28, 28, 185), -1)
        cv2.circle(vis, (16, 14), 7, (255, 255, 255), -1)
        cv2.putText(vis, f"CAMERA ACTIVE - {self.args.name}", (32, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        cv2.imshow("SeeThrough node", vis)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            self.stop.set()

    # ---- networking

    async def run(self):
        import websockets  # imported here so the geometry above can be tested without it

        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self.worker, daemon=True).start()
        ssl_ctx = None
        if self.args.relay.startswith("wss://"):
            ssl_ctx = ssl.create_default_context()
            if self.args.insecure:  # self-signed local certificate
                ssl_ctx.check_hostname = False
                ssl_ctx.verify_mode = ssl.CERT_NONE
        backoff = 1
        while not self.stop.is_set():
            try:
                async with websockets.connect(self.args.relay, ssl=ssl_ctx, max_size=2**20) as ws:
                    self.ws = ws
                    backoff = 1
                    await ws.send(json.dumps({"t": "hello", "room": self.args.room, "role": "camera", "name": self.args.name, "id": self.id}))
                    pinger = asyncio.create_task(self._pinger(ws))
                    announcer = asyncio.create_task(self._announcer())
                    try:
                        async for raw in ws:
                            self._on_message(json.loads(raw))
                    finally:
                        pinger.cancel()
                        announcer.cancel()
            except Exception as e:  # noqa: BLE001
                log(f"Relay connection problem: {e}. Retrying in {backoff}s.")
            self.ws = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10)

    def _on_message(self, msg):
        t = msg.get("t")
        if t == "welcome":
            self.state.offset_ms = msg["serverTime"] - time.time() * 1000
            log(f"Joined room {msg['room']} ({len(msg.get('peers', []))} connected)")
            self._set_map(msg.get("map"))
        elif t == "map":
            self._set_map(msg.get("map"))
        elif t == "pong":
            now = time.time() * 1000
            rtt = now - msg["c"]
            self.state.best_rtt = self.state.best_rtt * 1.05 + 1
            if rtt <= self.state.best_rtt:
                self.state.best_rtt = rtt
                self.state.offset_ms = msg["s"] - (msg["c"] + rtt / 2)
        elif t == "peer" and msg.get("joined"):
            self._send_camera()
        elif t == "camera" and msg.get("kind") == "headset" and msg.get("id") != self.id:
            self.headsets.setdefault(msg["id"], PositionHistory())
        elif t == "pose" and msg.get("ts") and msg.get("pose"):
            # Fast position updates come from the headset; remember them for walk calibration.
            self.headsets.setdefault(msg["id"], PositionHistory()).push(msg["ts"], msg["pose"]["p"])

    def _set_map(self, m):
        self.state.map = m if m and m.get("worldId") else {}
        if self.state.calib and not self.calibrating:
            self._apply_calibration()

    async def _pinger(self, ws):
        while True:
            await ws.send(json.dumps({"t": "ping", "c": time.time() * 1000}))
            await asyncio.sleep(2)

    async def _announcer(self):
        while True:
            if self.intr:
                self._send_camera()
            await asyncio.sleep(4)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="SeeThrough Python camera node", formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--relay", required=True, help="Relay WebSocket URL, e.g. wss://192.168.1.20:8443/ws")
    p.add_argument("--room", required=True, help="Room code (same as the viewer)")
    p.add_argument("--source", default="0", help="Camera index, video file, or rtsp:// / http:// URL")
    p.add_argument("--name", default="Python camera")
    p.add_argument("--id", help="Stable camera id (default: derived from name + source)")
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--fov", type=float, default=65.0, help="Horizontal field of view in degrees (if no --intrinsics)")
    p.add_argument("--intrinsics", help="JSON with K/dist from cv2.calibrateCamera (more accurate than --fov)")
    p.add_argument("--calibrate", action="store_true", help="Calibrate by watching the headset wearer walk in front of the camera")
    p.add_argument("--calib-file", help="Where to store this camera's calibration")
    p.add_argument("--model", default="yolov8n.pt", help="Ultralytics model (yolov8n.pt, yolo11n.pt, ...)")
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--min-conf", type=float, default=0.45)
    p.add_argument("--labels", nargs="*", help="Only send these COCO labels (default: all)")
    p.add_argument("--depth", choices=["realsense"], help="Use a depth camera for 3D positions")
    p.add_argument("--thumbs", action="store_true", help="Send a small preview thumbnail every 2 s")
    p.add_argument("--show", action="store_true", help="Show a local preview window (press q to quit)")
    p.add_argument("--insecure", action="store_true", help="Accept the relay's self-signed certificate")
    p.add_argument("--i-own-this-camera", action="store_true", help="Skip the ownership prompt")
    return p.parse_args(argv)


def main():
    args = parse_args()
    if not args.i_own_this_camera:
        print("SeeThrough: only connect cameras you own, pointed at spaces you're allowed to monitor.\n"
              "People in view should know the camera is running.")
        if input("Is this your camera, and do you have that permission? [y/N] ").strip().lower() not in ("y", "yes"):
            sys.exit("Not starting.")
    node = Node(args)
    log(f"● CAMERA ACTIVE · {args.name} ({node.id}) · source {args.source!r} · only object positions are sent")
    try:
        asyncio.run(node.run())
    except KeyboardInterrupt:
        pass
    finally:
        node.stop.set()
        node.capture.close()
        log("Camera stopped.")


if __name__ == "__main__":
    main()
