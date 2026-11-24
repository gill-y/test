# SeeThrough

Mixed-reality "x-ray vision". Cameras you own watch other rooms and work out where people and objects are. Anyone wearing a connected headset sees a glowing outline of each object in its real position, drawn through walls and furniture, with a label like **Person · 4.2 m**.

**Live demo (simulator, no hardware):** https://gill-y.github.io/test/viewer.html?sim=1

```
 camera node (phone / laptop / Pi / IP cam)            headset (Quest 3 / 3S, WebXR)
 ┌──────────────────────────────────────┐              ┌──────────────────────────────┐
 │ video → detection (on device)         │   objects    │ passthrough + x-ray outlines │
 │ marker → own pose in the world map    │ ───────────► │ aligned by touching a marker │
 │ 2D box → 3D position (floor / depth)  │  ~12 Hz WS   │ HUD: x-ray, filters, cameras │
 └──────────────────────────────────────┘      │       └──────────────────────────────┘
                                               ▼
                                  Node.js relay (rooms, saved maps)
```

| Part | Where | What it does |
| --- | --- | --- |
| Headset / desktop viewer | `viewer.html`, `js/viewer/` | WebXR + Three.js. Passthrough on Quest, a walk-around 3D view on desktop. |
| Browser camera node | `node.html`, `js/node/` | Any device with a browser and camera. TensorFlow.js COCO-SSD (MobileNet-SSD), ArUco calibration. |
| Python camera node | `python-node/` | Pi, USB or RTSP IP camera, or a RealSense depth camera. Ultralytics YOLO with tracking. |
| Relay server | `server/` | WebSocket rooms joined with a code. Saves each room's marker map. Also serves the web apps over HTTPS. |
| Simulator | `js/sim/` | A fake house with fake cameras running the real calibration and projection code. |
| Markers | `markers.html` | Printable ArUco markers (ARUCO_MIP_36h12) at exact size. |

## Quick start: simulator

Open https://gill-y.github.io/test/viewer.html?sim=1, or run it locally:

```powershell
cd server; npm install; cd ..
node server/server.js --http
```

Then open http://localhost:8080/viewer.html?sim=1.

You're standing in the living room. Three simulated cameras watch the kitchen and bedroom behind the wall. Walk with **W A S D** and drag to look. Switch to **Overview** to see the whole house, and turn on **Ground truth** to compare the reported outlines with where the objects really are. The simulated cameras calibrate on markers using the same code real nodes use, so what you see includes realistic error (2–3 cm in camera pose; about 10–30 cm in object position from floor projection).

## Real hardware setup

### 1. Run the relay with HTTPS

WebXR and phone cameras only work on secure (HTTPS) pages, so the relay serves the apps over HTTPS on your network:

```powershell
cd server
npm install
npm run cert      # self-signed certificate for localhost + this computer's LAN IPs
npm start         # https://<your-ip>:8443/
```

The server prints its LAN address. Every device opens that address (for example `https://192.168.1.20:8443/`). The relay URL then fills in by itself as `wss://<same host>/ws`.

**Certificate warning.** Self-signed certificates show a warning once per device. Choose **Advanced → Proceed**. That's fine on your own network. To avoid the warning:

- **mkcert:** run `mkcert -install` and then `mkcert -key-file server/certs/key.pem -cert-file server/certs/cert.pem localhost 192.168.1.20`. You also need to install the mkcert root CA on the phone or Quest.
- **Quest over USB, no certificate at all:** run the server with `--http`, connect the Quest by USB, then run `adb reverse tcp:8080 tcp:8080` and open `http://localhost:8080/viewer.html` on the Quest. `localhost` counts as secure.
- **Re-run `npm run cert`** if your computer's IP address changes.

### 2. Print markers

Open `/markers.html` and print at **100% / Actual size**. Check the printed 10 cm line with a ruler. Hang one marker per room, flat on a wall, upright, at about chest height. A camera needs to see the black square at least **~70 px wide**: 15 cm is good to about 2.5 m at 720p; use a full-page 19 cm marker for longer distances.

### 3. Start camera nodes

**Phone or laptop:** open `https://<relay>:8443/node.html`. Enter the room code, confirm that you own the camera, and press **Start camera**. Point the camera so a marker is clearly visible, keep it still, and press **Calibrate** (it averages 30 frames). Then don't move the camera. The calibration is saved on the device, so next time it only needs Start.

**Python (Pi, IP camera, RealSense):**

```powershell
cd python-node
pip install -r requirements.txt
python seethrough_node.py --relay wss://192.168.1.20:8443/ws --insecure --room ABC12 --source 0 --calibrate --show
python seethrough_node.py --relay wss://192.168.1.20:8443/ws --insecure --room ABC12 --source "rtsp://user:pass@192.168.1.50:554/stream1" --name "Garage cam" --calibrate
python seethrough_node.py ... --depth realsense     # 3D from the depth camera instead of the floor
```

Useful flags:

| Flag | What it does |
| --- | --- |
| `--intrinsics calib.json` | Use the `K` and `dist` from `cv2.calibrateCamera` instead of `--fov`. |
| `--labels person dog` | Only send these labels. |
| `--thumbs` | Send a small preview frame every 2 s. |
| `--model yolo11n.pt` | Use a different YOLO model. |
| `--insecure` | Accept the self-signed certificate. |

On a Pi, use `opencv-python-headless`.

### 4. Headset

On the Quest, open `https://<relay>:8443/viewer.html`, enter the room code, and press **Enter AR**. A panel appears in front of you. Squeeze either grip to bring it back. To press panel buttons, point at them and pull the trigger.

- **Align to marker:** touch the **centre** of a marker with the tip of your right controller (or your index fingertip) and pull the trigger. Then touch the wall a hand's width to the **right** of the marker and pull again. Two touches plus gravity give the marker's full pose.
- Use **◀ / ▶** to pick the marker ID you're touching.
- Where the Quest Browser supports it, the alignment is stored as a persistent WebXR anchor, so the next session is aligned straight away. Re-align if the outlines drift.

## Calibration in detail

**World frame:** metres, +Y up, floor at y = 0. The origin is on the floor directly below the **anchor** marker (the first marker anyone calibrates on), and +Z points out of that marker's wall.

**Camera nodes** detect a marker's four corners and average them over 30 frames. They then solve the marker's pose: a homography gives a first estimate, and Levenberg-Marquardt refinement starts from both candidate solutions (small markers have a mirror-image ambiguity) and keeps the better fit. The result is chained with the marker's world pose: `world←camera = world←marker · (camera←marker)⁻¹`. If the room has no map yet, the node creates one with that marker as the anchor (enter the marker's height above the floor). If the marker is seen at an angle, the node also estimates the camera's field of view and offers to use it.

**The headset** gets a marker's pose from the two touches. Aligning computes `headset←world = headset←marker · (world←marker)⁻¹`.

**Markers in different rooms.** Press **Map rooms**, touch a marker that's already on the map, then walk to the next room and touch its marker. The headset's own tracking carries the transform between rooms, so each new marker is added to the map in world coordinates. Touching a marker that's already mapped reports how far tracking has drifted and corrects it. The map is saved on the relay (`server/data/<ROOM>.json`), so this is a one-time setup. Any camera can then calibrate on any linked marker, and any later headset session can align to any of them.

## Detection and 3D position

- **Browser node:** COCO-SSD lite MobileNet v2 runs in TensorFlow.js (WebGL) on the device.
- **Python node:** Ultralytics YOLO with ByteTrack IDs.
- **Without depth:** objects are assumed to stand on the floor. The bottom edge of the 2D box is projected onto the floor plane, and size comes from the box and the distance. Expect about 10–30 cm of error. It's biased towards the camera when the camera looks steeply down, because the bottom of the box is the object's nearest edge.
- **With depth (RealSense):** each box's position comes from the median depth around its centre.
- Each object update carries: id, label, centre `p`, size `s` (w, h, d), confidence `c`, camera id, and a relay-clock timestamp.

## Networking

- **Rooms:** WebSocket rooms joined with a code (3–12 letters or digits). Nodes send at 12 Hz.
- **Freshness over completeness:** stale updates are dropped instead of queued, on the node and on the relay.
- **Clock sync:** clients sync clocks with the relay (ping/pong, keeping the lowest-RTT sample). The viewer shows end-to-end latency.
- **Measured locally:** about 1 ms relay latency and 36–39 updates/s with three simulated cameras.
- **Privacy:** only object data leaves a camera node. Preview thumbnails are optional, off by default, 192 px wide, one every 2 s.
- **No server:** with a blank relay URL, pages in the same browser talk over BroadcastChannel. That's useful for the simulator and for testing a node alongside a viewer in two tabs.

The full message list is at the top of [`js/common/protocol.js`](js/common/protocol.js).

## Viewer rendering

- **People:** a capsule-and-head silhouette with a Fresnel rim glow.
- **Other objects:** a wireframe box with a faint glowing fill.
- **X-ray:** all of these use `depthTest: false`, so they show through anything.
- **Labels and colours:** every object gets a floor ring and a distance label, and is colour-coded by camera.
- **Fusing:** when two cameras see the same object (same type, under 0.7 m apart), only one outline is drawn and it's labelled "· 2 cams".
- **Fading:** outlines fade out after 1 s without updates and are gone by 2.5 s.
- **HUD:** turn x-ray, labels, camera positions and markers on or off, filter by object type, and see the camera list with live status and thumbnails.

## Tests

```powershell
npm install
npm test
```

`npm test` runs `tests/run.js`, which covers marker pose (exact and noisy), floor projection, field-of-view estimation, two-touch alignment, three-room map linking, and the tracker. To test the Python node end to end with the relay running:

```powershell
python tests/test_python_node.py ws://localhost:8080/ws
```

That test renders a marker video from a known pose, runs the real node with a stand-in detector, and checks the map, the camera pose, and the person's position as received by a viewer.

To test the browser node without a camera, open `node.html?synthetic=1`. It renders a room with a real marker and a walking test person. Marker detection runs for real on the rendered pixels.

## Deployment

- **Static apps:** the viewer, node, markers and simulator are plain files with no build step. Host them anywhere. This repo publishes them with GitHub Pages.
- **Relay:** any Node 18+ host with WebSockets works (a VPS, Fly.io, Render, Railway). Set `PORT`. Behind a TLS proxy, run `node server/server.js --http`. With a relay on a public HTTPS domain, the Pages-hosted apps can use it: enter `wss://your-relay.example/ws` as the relay URL.
- **Room codes:** anyone with the code can join a room, so use long, random codes on a public relay.

## Rules

- Only connect cameras you own, pointed at spaces you're allowed to monitor. People in view should know the camera is running.
- Every node shows a visible **CAMERA ACTIVE** indicator while it runs. The browser node shows a red banner and changes the tab title. The Python node logs it and draws a banner in `--show` mode. The Python node asks you to confirm ownership at startup unless you pass `--i-own-this-camera`.

## Status

| Step | Status |
| --- | --- |
| 1. Relay + simulator with fake objects | Done. Tested in a browser through the relay. |
| 2. Marker calibration (one camera, one headset, same room) | Camera side tested with real marker detection on rendered video, browser and Python. Headset alignment math is unit-tested. **Not yet tried on a physical Quest.** |
| 3. Real detection | COCO-SSD (browser) and YOLO (Python) are wired up. The YOLO path still needs a run with `ultralytics` installed. |
| 4. Multi-room linking | Map rooms mode is unit-tested with three rooms; needs a walk-through on a Quest. |
| 5. Polish | Duplicate fusion, persistent anchors, FOV estimation, and small-marker handling are done. Ideas for next: WebXR depth-sensing occlusion when x-ray is off, and multi-camera triangulation. |
