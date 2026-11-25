"""Integration test for the Python camera node (no camera, YOLO or markers needed).

1. A fake headset joins the room, starts the map and streams its position while its
   wearer walks a loop in front of the camera (as a real headset would).
2. The real Node class runs with --calibrate against a running relay, with YOLO swapped
   for a stand-in that reports the box a detector would draw around the wearer.
3. A viewer client in the same room checks the camera pose and the person's world
   position that arrive through the relay.

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
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python-node"))
import seethrough_node as sn  # noqa: E402

W, H, FOV = 1280, 720, 68.0  # true FOV; the node starts from its default guess (65°)
CAM_POS = np.array([0.6, 2.2, 3.6])
LOOK_AT = np.array([0.0, 0.8, 0.0])
EYE = 1.62
WORLD_ID = "w-pytest"


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


WORLD_FROM_CAM = look_at(CAM_POS, LOOK_AT)
CAM_FROM_WORLD = np.linalg.inv(WORLD_FROM_CAM)
F = W / 2 / math.tan(math.radians(FOV) / 2)


def wearer(t):
    """Where the wearer's eyes are at time t (s): a slow wobbly loop, 1.5-5 m from the camera."""
    a = t * 0.55
    return np.array([math.sin(a) * 1.6, EYE + 0.02 * math.sin(t * 7), -0.2 + math.cos(a * 1.3) * 1.2])


def project(p):
    v = CAM_FROM_WORLD @ np.append(p, 1.0)
    return np.array([W / 2 + F * v[0] / -v[2], H / 2 - F * v[1] / -v[2]])


def person_box(t, rng):
    """The box a detector would draw: head top, shoulders facing the camera, feet."""
    e = wearer(t)
    to_cam = np.array([CAM_POS[0] - e[0], 0, CAM_POS[2] - e[2]])
    to_cam /= np.linalg.norm(to_cam)
    side = np.array([-to_cam[2], 0, to_cam[0]])
    pts = [np.array([e[0], e[1] + sn.HEAD_TOP_ABOVE_EYES, e[2]])]
    for hgt, half in ((e[1] - 0.2, 0.22), (0.9, 0.18)):
        for s in (-1, 1):
            pts.append(np.array([e[0], hgt, e[2]]) + side * half * s)
    for d in (-0.1, 0.15):
        pts.append(np.array([e[0], 0.0, e[2]]) + to_cam * d)
    uv = np.array([project(p) for p in pts])
    x1, y1 = uv.min(axis=0) + rng.normal(0, 3, 2)
    x2, y2 = uv.max(axis=0) + rng.normal(0, 3, 2)
    return (float(x1), float(y1), float(x2 - x1), float(y2 - y1))


async def headset(relay, room, stop):
    """Fake headset: starts the map, announces itself, streams its pose at 20 Hz."""
    import websockets

    async with websockets.connect(relay) as ws:
        await ws.send(json.dumps({"t": "hello", "room": room, "role": "viewer", "name": "Headset", "id": "test-headset"}))
        welcome = json.loads(await ws.recv())
        offset = welcome["serverTime"] - time.time() * 1000
        await ws.send(json.dumps({"t": "map", "map": {"worldId": WORLD_ID, "created": 0}}))
        await ws.send(json.dumps({"t": "camera", "id": "test-headset", "name": "Headset", "kind": "headset", "pose": None, "active": True}))
        while not stop.is_set():
            t = time.time()
            e = wearer(t)
            await ws.send(json.dumps({"t": "pose", "id": "test-headset", "ts": t * 1000 + offset, "pose": {"p": e.tolist(), "q": [0, 0, 0, 1]}}))
            await asyncio.sleep(0.05)


async def viewer(relay, room, result, done):
    import websockets

    async with websockets.connect(relay) as ws:
        await ws.send(json.dumps({"t": "hello", "room": room, "role": "viewer", "name": "test viewer", "id": "test-viewer"}))
        async for raw in ws:
            m = json.loads(raw)
            if m["t"] == "camera" and m.get("pose") and m.get("kind") == "python":
                result["camera"] = m
            if m["t"] == "objects" and m["objs"] and "camera" in result:
                result["objects"] = m
                result["truth"] = wearer(time.time()).tolist()
                done.set()
                return


def main():
    relay = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8080/ws"
    room = "PYTEST" + str(os.getpid() % 1000)
    tmp = tempfile.mkdtemp()
    video = os.path.join(tmp, "blank.avi")
    vw = cv2.VideoWriter(video, cv2.VideoWriter_fourcc(*"MJPG"), 30, (W, H))
    for _ in range(30):
        vw.write(np.full((H, W, 3), 200, np.uint8))
    vw.release()

    args = sn.parse_args([
        "--relay", relay, "--room", room, "--source", video, "--name", "Test node", "--calibrate",
        "--calib-file", os.path.join(tmp, "calib.json"), "--i-own-this-camera",
    ])
    node = sn.Node(args)
    rng = np.random.default_rng(3)
    node._detect = lambda frame: [{"label": "person", "score": 0.9, "bbox": person_box(time.time(), rng), "tid": 1}]

    stop = threading.Event()
    result, done = {}, threading.Event()
    threading.Thread(target=lambda: asyncio.run(headset(relay, room, stop)), daemon=True).start()
    time.sleep(0.5)
    threading.Thread(target=lambda: asyncio.run(node.run()), daemon=True).start()
    threading.Thread(target=lambda: asyncio.run(viewer(relay, room, result, done)), daemon=True).start()
    ok = done.wait(120)
    stop.set()
    node.stop.set()

    fails = 0

    def check(name, cond, detail=""):
        nonlocal fails
        print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
        fails += 0 if cond else 1

    check("node calibrated by walking and sent objects", ok)
    if ok:
        p = np.array(result["camera"]["pose"]["p"])
        err = float(np.linalg.norm(p - CAM_POS))
        check("camera pose from walk calibration", err < 0.5, f"{err * 100:.1f} cm, FOV {node.state.calib['fovH']:.1f}° (true {FOV})")
        obj = result["objects"]["objs"][0]["p"]
        t = result["truth"]
        d = math.hypot(obj[0] - t[0], obj[2] - t[2])
        check("person position through the relay", d < 0.6, f"{d * 100:.0f} cm on the floor")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
