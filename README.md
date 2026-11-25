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

You're standing in the living room. Three simulated phones watch the kitchen and bedroom behind the wall, and a **simulated headset wearer** walks from the kitchen into the bedroom and back through the house. Walk with **W A S D** and drag to look. Switch to **Overview** to see the whole house, and turn on **Ground truth** to compare the reported outlines with where things really are.

What the simulator shows:

- **Two-way sharing.** The phones see the headset wearer like anyone else, and the simulated headset shares its own position and what it sees in front of it (as a real headset does with its camera on). Everything shows up as outlines in your view and on the mini map (top left).
- **What a phone shows.** The **phone view** panel (bottom left) draws exactly what a chosen phone's camera page would show: its own detections as solid boxes, what the other devices see as dashed outlines labelled "from Kitchen cam", "from Simulated headset" and so on (even behind walls), and the phone's mini map. There's no video in the simulator, so the picture is a sketch of the room. Pick the phone from the list; turn the panel off with **Phone view** in the panel on the right.
- **Real calibration.** The simulated phones calibrate the way real ones do: a simulated wearer walks around each room and the same walk-calibration code solves each camera's pose, so what you see includes realistic error (typically 10–40 cm in camera position; about 10–30 cm in object position). The message at start shows each camera's error, and outlines in the phone view sit slightly off for the same reason.

## Your setup: Quest 3 and iPhones

A step-by-step for one Quest 3 / 3S headset and iPhones as cameras. You need a computer on the same Wi-Fi to run the relay (Windows, Mac or Linux with [Node.js](https://nodejs.org) 18 or newer).

**Why this order:** the headset creates the map, and each iPhone then finds its place on that map by watching you walk while you wear the headset. iPhones can't run AR in a browser (Safari has no WebXR), so they're fixed cameras: put each one where it will stay.

### 1. Start the relay on the computer

```powershell
cd server
npm install
npm run cert      # once: a certificate for this computer's network address
npm start
```

It prints an address like `https://192.168.1.20:8443/`. Use that address (with your number) on the headset and every iPhone. The GitHub Pages link can't reach your relay: it has to be this `https://` address.

### 2. Headset: open the viewer and make the map

1. On the Quest, open the **Quest Browser** and go to `https://192.168.1.20:8443/viewer.html`.
2. The browser warns about the certificate. Choose **Advanced → Proceed**. (Once per device.)
3. Type a room code (or keep the one shown) and press **Connect**. The pill at the top should say the room and "relay".
4. Press **Enter AR**. Allow anything it asks for (spatial data, hand tracking).
5. A panel appears. Its **Map** section says *"This headset is now the map."* That's it: no markers, nothing to touch. The headset remembers this between sessions.

Point a controller at the panel and pull the trigger to press buttons. Squeeze a grip to bring the panel back in front of you.

### 3. Each iPhone: start the camera

1. In **Safari**, go to `https://192.168.1.20:8443/node.html`.
2. Safari says *"This connection is not private"*. Tap **Show Details → visit this website**, then confirm.
3. Enter the **same room code** as the headset and a name like "Kitchen".
4. Tick the ownership box, choose **Back camera**, and tap **Start camera**. Allow camera access.
5. Put the iPhone where it will stay, looking at the area you want to watch: a shelf or tripod, ideally above head height looking slightly down. Plug it in to charge.

Keep the screen on: the page asks iOS to keep it awake, but also set **Settings → Display & Brightness → Auto-Lock → Never** while it's running as a camera.

### 4. Calibrate each iPhone by walking

With the headset on and in AR (its panel says it's on the map):

1. Put the headset on first, in AR. Then tap **Calibrate** on the iPhone. (If the headset isn't on the map yet, the iPhone says so.)
2. Walk slowly around in front of that iPhone for 15–30 seconds. Cross the picture from side to side, and walk towards it and away from it too. Keep your whole body, head to feet, in the picture. Nobody else should be in view.
3. The bar fills and the iPhone shows **Calibrated** with its position and field of view. If it asks you to cover more ground or walk towards it, keep going.

Do this once per iPhone. After that, don't move the iPhone. If you move it, tap **Calibrate** again.

### 5. Use it

- **In the headset:** people and objects the iPhones see show as glowing outlines through the walls, with a mini map at the top left of your view. Turn on **Headset camera** in the panel to share what the headset sees with the iPhones too (if your Quest Browser allows it).
- **On each iPhone:** its own detections are solid boxes. What the headset and the other iPhones see shows as dashed outlines, plus the mini map at the top left.

### Next time

Start the relay, open the viewer on the Quest and enter AR: it lands on the same map. Open `node.html` on each iPhone and tap **Start camera**; their calibration is saved. If the headset says it has no saved place on the map, walk in front of any calibrated iPhone and it finds itself again.

### If something's wrong

| Problem | Fix |
| --- | --- |
| **"AR not supported"** | Use the Quest Browser on the Quest, and the `https://` relay address. Desktop and iPhone browsers can't do AR. |
| iPhone page loads but the pill says "not connected" | Make sure the room code matches and the relay is still running. If it keeps failing, Safari may not trust the certificate for the connection: install it with mkcert (below) instead of tapping through the warning. |
| Calibration never finishes | Make sure only you are in the picture and your feet are visible. Walk across the picture *and* towards and away from the iPhone. Check the headset panel says it's on the map. |
| Outlines in the wrong place | Re-calibrate the iPhone that's off. If everything is off, press **Re-find me** in the headset panel and walk in front of a calibrated iPhone. |
| Headset says "Another device started a new map" | Someone pressed **New map**. Calibrate every iPhone again. |

**No certificate warnings (optional):** install [mkcert](https://github.com/FiloSottile/mkcert) on the computer, run `mkcert -install` and `mkcert -key-file server/certs/key.pem -cert-file server/certs/cert.pem localhost 192.168.1.20` (your address). For each iPhone, AirDrop the file from `mkcert -CAROOT` named `rootCA.pem`, install it in **Settings → General → VPN & Device Management**, then turn it on in **Settings → General → About → Certificate Trust Settings**.

## Real hardware setup (any devices)

The same steps in general form, including laptops, Python cameras (Pi, USB, IP cameras) and options.

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
| 7. Simulator: headset + phone view | A simulated headset wearer walks the house and shares detections; the phone view panel shows what a phone draws. Tested in a browser through the relay. |
