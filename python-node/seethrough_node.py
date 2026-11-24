#!/usr/bin/env python3
"""SeeThrough Python camera node.

For a Raspberry Pi, a desktop with a USB camera, an IP camera (RTSP), or a depth
camera (Intel RealSense). It detects objects with Ultralytics YOLO, works out where
they are in the shared world map, and sends only object positions to the relay.
Raw video never leaves this machine (an optional small thumbnail aside).

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

MARKER_DICT = cv2.aruco.DICT_ARUCO_MIP_36h12  # same dictionary as the browser node and markers page
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


def marker_world_matrix(m: dict) -> np.ndarray:
    yaw = m.get("yaw", 0.0)
    c, s = math.cos(yaw), math.sin(yaw)
    M = np.eye(4)
    M[:3, :3] = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    M[:3, 3] = m["p"]
    return M


def marker_object_points(size: float) -> np.ndarray:
    h = size / 2
    return np.array([[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]], dtype=np.float64)


def pose_from_corners(corners: np.ndarray, size: float, intr: Intrinsics):
    """corners: 4x2 (TL, TR, BR, BL). Returns (gl_cam_from_marker 4x4, reprojection error px)."""
    obj = marker_object_points(size)
    ok, rvec, tvec = cv2.solvePnP(obj, corners.astype(np.float64), intr.K, intr.dist, flags=cv2.SOLVEPNP_IPPE_SQUARE)
    if not ok:
        return None, None
    proj, _ = cv2.projectPoints(obj, rvec, tvec, intr.K, intr.dist)
    err = float(np.mean(np.linalg.norm(proj.reshape(-1, 2) - corners, axis=1)))
    R, _ = cv2.Rodrigues(rvec)
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = tvec.ravel()
    return CV_TO_GL @ T, err


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

class Calibrator:
    def __init__(self, frames_needed: int = 30):
        self.detector = cv2.aruco.ArucoDetector(
            cv2.aruco.getPredefinedDictionary(MARKER_DICT), cv2.aruco.DetectorParameters()
        )
        self.frames_needed = frames_needed
        self.reset()

    def reset(self):
        self.frames: list[np.ndarray] = []
        self.marker_id: str | None = None

    def detect(self, frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        corners, ids, _ = self.detector.detectMarkers(gray)
        if ids is None:
            return []
        if len(corners):
            crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.01)
            for c in corners:
                cv2.cornerSubPix(gray, c, (5, 5), (-1, -1), crit)
        return [(str(int(i)), c.reshape(4, 2).astype(np.float64)) for c, i in zip(corners, ids.ravel())]

    def feed(self, frame, map_markers: dict) -> str | None:
        """Adds one frame. Returns the marker id once enough frames are collected."""
        found = self.detect(frame)
        usable = [(i, c) for i, c in found if not map_markers or i in map_markers]
        if self.marker_id is not None:
            usable = [(i, c) for i, c in usable if i == self.marker_id]
        if not usable:
            return None
        usable.sort(key=lambda ic: -cv2.contourArea(ic[1].astype(np.float32)))
        self.marker_id, corners = usable[0]
        self.frames.append(corners)
        return self.marker_id if len(self.frames) >= self.frames_needed else None

    def mean_corners(self) -> np.ndarray:
        return np.mean(np.stack(self.frames), axis=0)


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
        self.calibrator = Calibrator() if args.calibrate else None
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
        log(f"Loaded calibration from {self.calib_path} (marker {self.state.calib['marker_id']}). "
            "Use --calibrate if the camera has moved.")

    def _recompute_pose(self):
        c = self.state.calib
        if not c or not self.intr:
            return
        markers = (self.state.map or {}).get("markers") or {}
        m = markers.get(c["marker_id"])
        if not m:
            self.state.pose = None
            log(f"Marker {c['marker_id']} is not on this room's map; recalibrate with --calibrate.")
            return
        T, err = pose_from_corners(np.array(c["corners"]), m.get("size", self.args.marker_size), self.intr)
        if T is None:
            return
        self.state.pose = m_world = marker_world_matrix(m) @ np.linalg.inv(T)
        p = m_world[:3, 3]
        log(f"Camera pose: ({p[0]:.2f}, {p[1]:.2f}, {p[2]:.2f}) m, reprojection error {err:.2f} px")
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
            "calibratedWith": (self.state.calib or {}).get("marker_id"),
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
            intr = self._intrinsics_for(frame)
            if self.state.calib and self.state.pose is None and self.state.map is not None:
                self._recompute_pose()

            if self.calibrator is not None:
                self._calibration_step(frame)
                if self.args.show:
                    self._show(frame, [])
                continue

            dets = self._detect(frame)
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

    def _calibration_step(self, frame):
        markers = ((self.state.map or {}).get("markers")) or {}
        done = self.calibrator.feed(frame, markers)
        n = len(self.calibrator.frames)
        if n and n % 5 == 0:
            log(f"Calibrating on marker {self.calibrator.marker_id}: {n}/{self.calibrator.frames_needed}")
        if not done:
            return
        corners = self.calibrator.mean_corners()
        jitter = float(np.max(np.linalg.norm(np.stack(self.calibrator.frames) - corners, axis=2)))
        if jitter > 6:
            log(f"Marker moved {jitter:.0f} px during calibration; keep the camera still. Retrying.")
            self.calibrator.reset()
            return
        mid = self.calibrator.marker_id
        if not markers:
            self.state.map = {"anchor": mid, "markers": {mid: {"p": [0, self.args.anchor_height, 0], "yaw": 0, "size": self.args.marker_size}}}
            self._send({"t": "map", "map": self.state.map})
            log(f"No map in this room yet: created one with marker {mid} as the anchor.")
        size_px = float(np.mean([np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)]))
        if size_px < 60:
            log(f"Warning: marker is only {size_px:.0f} px wide. Print it larger or move the camera closer for accuracy.")
        self.state.calib = {"marker_id": mid, "corners": corners.tolist(), "width": frame.shape[1], "height": frame.shape[0], "at": time.time()}
        with open(self.calib_path, "w") as fh:
            json.dump(self.state.calib, fh, indent=2)
        log(f"Calibration saved to {self.calib_path}. Don't move the camera now.")
        self.calibrator = None
        self._recompute_pose()

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
            for mid, c in self.calibrator.detect(frame):
                cv2.polylines(vis, [c.astype(np.int32)], True, (63, 210, 255), 2)
                cv2.putText(vis, f"marker {mid}", tuple(c[0].astype(int)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (63, 210, 255), 2)
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

    def _set_map(self, m):
        self.state.map = m or {}
        if self.state.calib:
            self._recompute_pose()

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
    p.add_argument("--marker-size", type=float, default=0.15, help="Printed marker size in metres (black square)")
    p.add_argument("--anchor-height", type=float, default=1.5, help="Marker centre height (m) if this camera creates the map")
    p.add_argument("--calibrate", action="store_true", help="Calibrate against a marker before running")
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
