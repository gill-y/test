# SeeThrough

Mixed-reality "x-ray vision". Cameras you own watch other rooms and work out where people and objects are. Anyone wearing a connected headset sees a glowing outline of each object in its real position, drawn through walls and furniture, with a label like **Person · 4.2 m**.

Sharing works both ways. The headset and every phone show what all the other devices detect, and every device has a **mini map** in its top-left corner. Only detections and device positions are shared, never video.

**No markers.** The headset is the map. Each camera finds its own place by watching you walk in front of it wearing the headset.

**Live demo (simulator, no hardware):** https://gill-y.github.io/test/viewer.html?sim=1

```
 camera node (phone / laptop / Pi / IP cam)            headset (Quest 3 / 3S, WebXR)
 ┌──────────────────────────────────────┐              ┌──────────────────────────────┐
 │ video → detection (on device)         │   objects    │ passthrough + x-ray outlines │
 │ walk calibration → pose on the map    │ ◄──────────► │ headset is the map (anchor)  │
 │ 2D box → 3D position (floor / depth)  │  ~12 Hz WS   │ HUD: x-ray, filters, cameras │
 └──────────────────────────────────────┘      │       └──────────────────────────────┘
                                               ▼
                                  Node.js relay (rooms, saved maps)
```

| Part | Where | What it does |
| --- | --- | --- |
| Headset / desktop viewer | `viewer.html`, `js/viewer/` | WebXR + Three.js. Passthrough on Quest, a walk-around 3D view on desktop. |
| Browser camera node | `node.html`, `js/node/` | Any device with a browser and camera. TensorFlow.js COCO-SSD (MobileNet-SSD), calibration by watching the headset wearer walk. |
| Python camera node | `python-node/` | Pi, USB or RTSP IP camera, or a RealSense depth camera. Ultralytics YOLO with tracking. |
| Relay server | `server/` | WebSocket rooms joined with a code. Saves each room's map id. Also serves the web apps over HTTPS. |
| Simulator | `js/sim/` | A fake house with fake cameras running the real calibration and projection code. |

## Quick start: simulator

Open https://gill-y.github.io/test/viewer.html?sim=1, or run it locally:

```powershell
cd server; npm install; cd ..
node server/server.js --http
```

Then open http://localhost:8080/viewer.html?sim=1.

You're standing in the living room. Three simulated cameras watch the kitchen and bedroom behind the wall. Walk with **W A S D** and drag to look. Switch to **Overview** to see the whole house, and turn on **Ground truth** to compare the reported outlines with where the objects really are. The simulated cameras calibrate the way real ones do: a simulated headset wearer walks around each room and the same calibration code solves each camera's pose, so what you see includes realistic error (typically 10–40 cm in camera position; about 10–30 cm in object position from floor projection). The toast at start shows each camera's error.

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

### 2. Headset: create the map

On the Quest, open `https://<relay>:8443/viewer.html`, enter the room code, and press **Enter AR**. A panel appears in front of you. Squeeze either grip to bring it back. To press panel buttons, point at them and pull the trigger.

The first time, the headset **becomes the map**: its floor-level tracking space is the room's world, saved as a persistent WebXR anchor, so later sessions land in the same place. No markers and nothing to touch.

If the headset can't find its saved anchor (cleared browser data, another headset, no anchor support), the panel asks you to walk around in front of a camera that's already calibrated. The headset matches where it thinks it walked with where the cameras saw you, and finds its place on the map again. **New map** starts over; every camera then has to calibrate again.

### 3. Start and calibrate camera nodes

**Phone or laptop:** open `https://<relay>:8443/node.html`. Enter the room code, confirm that you own the camera, and press **Start camera**. Put the camera where it will stay. Then, wearing the headset in AR:

1. Press **Calibrate** on the phone.
2. Walk slowly around in front of the camera for 15–30 seconds. Cross the picture from side to side, and walk towards it and away from it too. Keep your head and feet in view, and make sure only you are in the picture.
3. The progress bar fills, the phone solves its position and field of view, and shows **Calibrated**. Don't move the camera afterwards.

The calibration is saved on the device. It stays valid until the camera moves or someone starts a new map.

**Python (Pi, IP camera, RealSense):**

```powershell
cd python-node
pip install -r requirements.txt
python seethrough_node.py --relay wss://192.168.1.20:8443/ws --insecure --room ABC12 --source 0 --calibrate --show   # then walk in front of it with the headset on
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

## Calibration in detail

**World frame:** metres, +Y up, floor at y = 0: the floor-level tracking space of the headset that created the map. The relay keeps the map's id (`server/data/<ROOM>.json`); cameras store which map id they calibrated against.

**Camera nodes (walk calibration).** The headset streams its position about 10 times a second, stamped with the relay clock. For every frame with exactly one person in view, the camera pairs the person box with where the headset was when the frame was taken:

- the box's **top edge** with the top of the head (11 cm above the headset),
- its **bottom edge** with the floor under the wearer (trusted less, because feet move with every stride),
- its **horizontal centre** with the body's vertical axis.

It solves the camera's position, rotation and field of view from these, robustly: many starting guesses around where you walked, refinement on whole frames that fit (so frames showing someone else are ignored), then a correction for where box edges really fall (the back of the head and the front of the feet) once the camera's rough position is known. It needs about 100 frames, 12 seconds, at least 2 m of walking, and movement towards and away from the camera; the progress text says what's missing. In tests it lands within about 5–40 cm and finds the field of view within a few degrees.

**The headset.** The map is the headset's own tracking space, kept with a persistent anchor. Re-finding it from camera sightings fits a rotation about the vertical axis plus a floor shift between the headset's own path and where calibrated cameras saw a person (robust to other people in view).

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

## Shared view: every device sees what the others detect

The headset is a device in the room like any phone. Each device sends what it detects and where it is, and shows everyone else's detections:

| Device | Sends | Shows |
| --- | --- | --- |
| Phone / laptop node | Its detections and its calibrated position | Mini map (top left of the video) with the headset, other phones and all detections. Things other devices detect are drawn as dashed outlines on its video, labelled "from Headset", even when they're behind a wall. |
| Headset | Its position and facing direction (10 Hz, once aligned). With **Headset camera** on, also its own detections. | X-ray outlines of everything, plus a mini map fixed to the top left of your view that turns with you. |
| Desktop viewer | In the simulator only, its walk-mode position (so you can test without a headset) | Mini map in the top-left corner. |

**Mini map.** It shows the devices from above: phones with a wedge for their field of view, the headset as an arrow, and detections coloured by the device that made them. A white ring marks things that came from another device. In the headset the map turns with you and the rings are 1 m apart. On phones it stays fixed and zooms to fit everything. Turn it off with **Mini map** (headset panel, viewer HUD, or the node's Room card).

**Headset camera.** In the headset panel, press **Headset camera**, then press it again to confirm. The headset then runs the same COCO-SSD detector as the phones on its own camera and shares the results. Frames stay on the headset. The panel and the mini map show **● CAMERA ON** while it runs. It needs:

- A Quest Browser and Horizon OS version that lets web pages use the headset cameras (Quest 3 / 3S). If it isn't supported, the panel says why and everything else keeps working.
- The headset to be on the map (its panel says so), so its detections can be placed in it.

The camera's field of view is assumed to be 80° (`viewer.html?hfov=…` overrides it), and the camera's offset from your eyes is ignored. Expect headset detections to be rougher than a calibrated phone's: about 20–50 cm.

Detections of the same thing from several devices are merged (same type, under 0.7 m apart), so the headset draws one outline and the phone doesn't draw a dashed copy of something it already sees.

## Viewer rendering

- **People:** a capsule-and-head silhouette with a Fresnel rim glow.
- **Other objects:** a wireframe box with a faint glowing fill.
- **X-ray:** all of these use `depthTest: false`, so they show through anything.
- **Labels and colours:** every object gets a floor ring and a distance label, and is colour-coded by camera.
- **Fusing:** when two cameras see the same object (same type, under 0.7 m apart), only one outline is drawn and it's labelled "· 2 cams".
- **Fading:** outlines fade out after 1 s without updates and are gone by 2.5 s.
- **HUD:** turn x-ray, labels, camera positions and the mini map on or off, filter by object type, and see the camera list with live status and thumbnails.

## Tests

```powershell
npm install
npm test
```

`npm test` runs `tests/run.js`, which covers floor projection, the tracker, the mini map, walk calibration (including a wrong field-of-view guess and frames of another person), the headset re-finding itself from camera sightings, and the simulator's cameras calibrating by walk. To test the Python node end to end with the relay running:

```powershell
python tests/test_python_node.py ws://localhost:8080/ws
```

That test runs a fake headset that starts a map and walks a loop, runs the real node with `--calibrate` and a stand-in detector, and checks the camera pose and the person's position as received by a viewer.

To test the browser node without a camera, open `node.html?synthetic=1`. It renders a room with a walking test person who stands in for the headset wearer, so **Calibrate** runs the real walk calibration against a known answer.

## Deployment

- **Static apps:** the viewer, node and simulator are plain files with no build step. Host them anywhere. This repo publishes them with GitHub Pages.
- **Relay:** any Node 18+ host with WebSockets works (a VPS, Fly.io, Render, Railway). Set `PORT`. Behind a TLS proxy, run `node server/server.js --http`. With a relay on a public HTTPS domain, the Pages-hosted apps can use it: enter `wss://your-relay.example/ws` as the relay URL.
- **Room codes:** anyone with the code can join a room, so use long, random codes on a public relay.

## Rules

- Only connect cameras you own, pointed at spaces you're allowed to monitor. People in view should know the camera is running.
- Every node shows a visible **CAMERA ACTIVE** indicator while it runs. The browser node shows a red banner and changes the tab title. The Python node logs it and draws a banner in `--show` mode. The Python node asks you to confirm ownership at startup unless you pass `--i-own-this-camera`.

## Status

| Step | Status |
| --- | --- |
| 1. Relay + simulator with fake objects | Done. Tested in a browser through the relay. |
| 2. Calibration | Markers removed. Walk calibration tested in the browser (synthetic scene: 27 cm, FOV within 1°), in the simulator and in the Python node through the relay. Headset re-finding is unit-tested. **Not yet tried on a physical Quest or phone.** |
| 3. Real detection | COCO-SSD (browser) and YOLO (Python) are wired up. The YOLO path still needs a run with `ultralytics` installed. |
| 4. Multi-room | Each camera calibrates in its own room by walk; the headset's tracking carries the map between rooms. Needs a walk-through on a Quest. |
| 5. Polish | Duplicate fusion, persistent anchors and FOV estimation are done. Ideas for next: WebXR depth-sensing occlusion when x-ray is off, and multi-camera triangulation. |
| 6. Two-way sharing + mini map | Phone ↔ headset sharing, mini maps and dashed outlines tested in a browser through the relay (desktop viewer + simulator + synthetic phone node). **Headset camera detection not yet tried on a physical Quest.** |
