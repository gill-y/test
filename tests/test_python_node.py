"""Integration test for the Python camera node (no camera or YOLO needed).

1. Renders a video of a printed marker on a wall from a known camera pose.
2. Runs the real Node class on that video with --calibrate, against a running relay,
   with YOLO swapped for a stand-in that reports a known person box.
3. A viewer client in the same room checks the map, the camera pose and the person's
   world position that arrive through the relay.

Run with the relay up:  node server/server.js --http --port=8080
Then:                   python -I tests/test_python_node.py ws://localhost:8080/ws
"""

import asyncio
import json
import math
import os
import sys
import tempfile
import threading

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python-node"))
import seethrough_node as sn  # noqa: E402

W, H, FOV = 1280, 720, 65.0
MARKER = {"p": [0.0, 1.5, 0.0], "yaw": 0.0, "size": 0.15}
CAM_POS = np.array([0.7, 1.7, 1.8])
LOOK_AT = np.array([0.0, 1.3, 0.0])
PERSON = {"p": [-0.4, 0.85, 1.2], "s": [0.5, 1.7, 0.4]}


def look_at(eye, target):
    """GL camera world matrix (camera looks down -Z, +Y up)."""
    z = eye - target
    z /= np.linalg.norm(z)
    x = np.cross([0, 1, 0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    M = np.eye(4)
    M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = x, y, z, eye
    return M


def project(world_from_cam, intr, pts):
    cam_from_world = np.linalg.inv(world_from_cam)
    out = []
    for p in pts:
        v = cam_from_world @ np.append(p, 1.0)
        out.append([intr.K[0, 2] + intr.f * v[0] / -v[2], intr.K[1, 2] - intr.f * v[1] / -v[2]])
    return np.array(out, dtype=np.float32)


def render_video(path, world_from_cam, intr, frames=60):
    marker_px = 400
    tag = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(sn.MARKER_DICT), 7, marker_px)
    Mw = sn.marker_world_matrix(MARKER)
    corners_w = [(Mw @ np.append(p, 1.0))[:3] for p in sn.marker_object_points(MARKER["size"])]
    dst = project(world_from_cam, intr, corners_w)
    src = np.array([[0, 0], [marker_px, 0], [marker_px, marker_px], [0, marker_px]], dtype=np.float32)
    Hm = cv2.getPerspectiveTransform(src, dst)
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), 30, (W, H))
    rng = np.random.default_rng(1)
    for _ in range(frames):
        bg = np.full((H, W), 225, np.uint8)
        bg[int(H * 0.72):] = 140  # floor
        warped = cv2.warpPerspective(tag, Hm, (W, H), flags=cv2.INTER_LINEAR, borderValue=255)
        mask = cv2.warpPerspective(np.full_like(tag, 255), Hm, (W, H)) > 0
        img = bg.copy()
        img[mask] = warped[mask]
        noise = rng.normal(0, 2.0, img.shape)
        img = np.clip(img + noise, 0, 255).astype(np.uint8)
        vw.write(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR))
    vw.release()
    return dst


def person_bbox(world_from_cam, intr):
    p, s = np.array(PERSON["p"]), np.array(PERSON["s"])
    pts = [p + s * np.array([dx, dy, dz]) for dx in (-0.5, 0.5) for dy in (-0.5, 0.5) for dz in (-0.5, 0.5)]
    uv = project(world_from_cam, intr, pts)
    x1, y1 = uv.min(axis=0)
    x2, y2 = uv.max(axis=0)
    return (float(x1), float(y1), float(x2 - x1), float(y2 - y1))


async def viewer(relay, room, result, done):
    import websockets

    async with websockets.connect(relay) as ws:
        await ws.send(json.dumps({"t": "hello", "room": room, "role": "viewer", "name": "test viewer", "id": "test-viewer"}))
        async for raw in ws:
            m = json.loads(raw)
            if m["t"] == "map" or (m["t"] == "welcome" and m.get("map")):
                result["map"] = m["map"]
            if m["t"] == "camera" and m.get("pose"):
                result["camera"] = m
            if m["t"] == "objects" and m["objs"]:
                result["objects"] = m
                if "camera" in result:
                    done.set()
                    return


def main():
    relay = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8080/ws"
    room = "PYTEST" + str(os.getpid() % 1000)
    intr = sn.Intrinsics.from_fov(W, H, FOV)
    world_from_cam = look_at(CAM_POS, LOOK_AT)
    tmp = tempfile.mkdtemp()
    video = os.path.join(tmp, "marker.avi")
    corners = render_video(video, world_from_cam, intr)
    print(f"Rendered test video: marker {np.linalg.norm(corners[0] - corners[1]):.0f} px wide")

    bbox = person_bbox(world_from_cam, intr)
    args = sn.parse_args([
        "--relay", relay, "--room", room, "--source", video, "--name", "Test node", "--calibrate",
        "--fov", str(FOV), "--marker-size", str(MARKER["size"]), "--anchor-height", str(MARKER["p"][1]),
        "--calib-file", os.path.join(tmp, "calib.json"), "--i-own-this-camera",
    ])
    node = sn.Node(args)
    node._detect = lambda frame: [{"label": "person", "score": 0.9, "bbox": bbox, "tid": 1}]

    result, done = {}, threading.Event()
    t = threading.Thread(target=lambda: asyncio.run(node.run()), daemon=True)

    async def drive():
        stop = asyncio.Event()
        vtask = asyncio.create_task(viewer(relay, room, result, stop))
        await asyncio.sleep(0.3)
        t.start()
        try:
            await asyncio.wait_for(stop.wait(), 30)
        finally:
            vtask.cancel()

    asyncio.run(drive())
    node.stop.set()

    failures = 0

    def check(name, ok, detail=""):
        nonlocal failures
        print(("PASS" if ok else "FAIL"), name, f"({detail})" if detail else "")
        failures += 0 if ok else 1

    check("map created by the node", result.get("map", {}).get("anchor") == "7", json.dumps(result.get("map")))
    cam = result.get("camera", {})
    if cam.get("pose"):
        p = np.array(cam["pose"]["p"])
        err = float(np.linalg.norm(p - CAM_POS))
        check("camera pose from marker calibration", err < 0.05, f"{err * 100:.1f} cm")
    else:
        check("camera pose from marker calibration", False, "no pose received")
    objs = result.get("objects", {}).get("objs", [])
    if objs:
        o = objs[0]
        err = math.hypot(o["p"][0] - PERSON["p"][0], o["p"][2] - PERSON["p"][2])
        # Floor projection puts the object where the bottom of its 2D box meets the floor,
        # which for a box seen at a steep angle is its nearest corner: ~20-30 cm of bias
        # here even with a perfect camera pose. A depth camera removes it.
        check("person position in world through the relay", err < 0.35, f"{err * 100:.1f} cm, height {o['s'][1]:.2f} m, id {o['id']}")
    else:
        check("person position in world through the relay", False, "no objects received")
    print("All Python node tests passed" if not failures else f"{failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
