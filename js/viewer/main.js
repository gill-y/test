// SeeThrough viewer: desktop 3D view + WebXR passthrough viewer for Quest.
//
// The headset is a device in the room like any phone: it shows what every other
// device detects, and it shares its own position and (with the headset camera
// switched on) its own detections, so the phones see what it sees. Only object
// positions are shared, never video.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { openLink } from '../common/transport.js';
import {
  qs, randomId, randomRoomCode, normalizeRoom, defaultRelayUrl, safeGet, safeSet, safeGetJSON, safeSetJSON,
  colorForIndex, prettyLabel, FADE_START_S, FADE_END_S, POSE_HZ, SEND_HZ, HEADSET_COLOR,
} from '../common/protocol.js';
import { msgToPose, poseToMsg, floorPose, headWorldPose, intrinsicsFromFov, detectionToWorld } from '../common/geometry.js';
import { Minimap } from '../common/minimap.js';
import { Tracker } from '../common/tracker.js';
import { ObjectVisual } from './xray.js';
import { MarkerVisuals, CameraVisuals, buildSimHouse, TruthVisuals } from './scene-extras.js';
import { XRPanel } from './xr-panel.js';
import { Aligner } from './alignment.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state

const state = {
  link: null,
  room: normalizeRoom(qs('room') || safeGet('seethrough.room') || ''),
  relay: qs('relay') ?? defaultRelayUrl(),
  map: null,
  cameras: new Map(), // id -> {info, matrix, index, lastSeen, objCount, thumb}
  objects: new Map(), // key -> {visual, cam, label, lastUpdate}
  hiddenLabels: new Set(safeGetJSON('seethrough.hiddenLabels') || []),
  labelCounts: new Map(),
  xray: true,
  labels: true,
  showCams: true,
  showMarkers: true,
  showTruth: false,
  showMinimap: safeGet('seethrough.minimap') !== 'off',
  selfPose: null, // Matrix4 world <- this headset / desktop view, or null when not aligned
  latency: null,
  updates: 0,
  rate: 0,
  sim: null,
  camIndex: 0,
  id: safeGet('seethrough.viewerId') || randomId('v-'),
};
safeSet('seethrough.viewerId', state.id);

// This headset's own entry, used for its own detections (it is not in state.cameras).
const selfSource = { index: -1, objCount: 0, lastSeen: 0, info: { id: state.id, name: 'This headset', color: HEADSET_COLOR, kind: 'headset' } };
if (!state.room) state.room = randomRoomCode();

// ------------------------------------------------------------------ three.js setup

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.domElement.className = 'stage';
$('app').prepend(renderer.domElement);

const scene = new THREE.Scene();
const DESKTOP_BG = new THREE.Color('#0a0e16');
scene.background = DESKTOP_BG;
scene.fog = new THREE.Fog(DESKTOP_BG, 18, 40);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.02, 100);
camera.position.set(1.4, 1.6, 4.3);

scene.add(new THREE.HemisphereLight('#dfe8ff', '#20242c', 1.3));
const sun = new THREE.DirectionalLight('#ffffff', 1.2);
sun.position.set(4, 8, 6);
scene.add(sun);

// Everything in world (map) coordinates lives under worldRoot. On desktop it is the
// identity; in a headset it is the alignment transform (world -> headset space).
const worldRoot = new THREE.Group();
worldRoot.matrixAutoUpdate = false;
scene.add(worldRoot);

const grid = new THREE.GridHelper(30, 30, '#1e2a3a', '#141c28');
worldRoot.add(grid);

const objectsGroup = new THREE.Group();
const markerVis = new MarkerVisuals();
const cameraVis = new CameraVisuals();
const truthVis = new TruthVisuals();
worldRoot.add(objectsGroup, markerVis.group, cameraVis.group, truthVis.group);
let simHouse = null;

// ------------------------------------------------------------------ desktop controls

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(-0.5, 0.5, -2);
orbit.enableDamping = true;
orbit.enabled = false;

const walk = {
  yaw: THREE.MathUtils.degToRad(16),
  pitch: THREE.MathUtils.degToRad(-8),
  keys: new Set(),
  dragging: false,
  last: null,
};
let viewMode = 'walk';

function setViewMode(mode) {
  viewMode = mode;
  $('mode-walk').setAttribute('aria-pressed', mode === 'walk');
  $('mode-orbit').setAttribute('aria-pressed', mode === 'orbit');
  orbit.enabled = mode === 'orbit';
  $('hint').innerHTML =
    mode === 'walk'
      ? 'Walk: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · drag to look'
      : 'Overview: drag to orbit · right-drag to pan · scroll to zoom';
  if (mode === 'orbit') {
    camera.position.set(6, 9, 7);
    orbit.target.set(0, 0, -1.5);
    orbit.update();
  } else {
    camera.position.set(1.4, 1.6, 4.3);
    walk.yaw = THREE.MathUtils.degToRad(16);
    walk.pitch = THREE.MathUtils.degToRad(-8);
  }
}
$('mode-walk').onclick = () => setViewMode('walk');
$('mode-orbit').onclick = () => setViewMode('orbit');

addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return;
  walk.keys.add(e.code);
});
addEventListener('keyup', (e) => walk.keys.delete(e.code));
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (viewMode !== 'walk') return;
  walk.dragging = true;
  walk.last = [e.clientX, e.clientY];
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!walk.dragging) return;
  const dx = e.clientX - walk.last[0];
  const dy = e.clientY - walk.last[1];
  walk.last = [e.clientX, e.clientY];
  walk.yaw -= dx * 0.004;
  walk.pitch = THREE.MathUtils.clamp(walk.pitch - dy * 0.004, -1.4, 1.4);
});
renderer.domElement.addEventListener('pointerup', () => (walk.dragging = false));

function updateWalk(dt) {
  const k = walk.keys;
  const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
  const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
  const speed = (k.has('ShiftLeft') ? 3.2 : 1.6) * dt;
  const fwd = new THREE.Vector3(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw));
  const right = new THREE.Vector3(Math.cos(walk.yaw), 0, -Math.sin(walk.yaw));
  camera.position.addScaledVector(fwd, f * speed).addScaledVector(right, s * speed);
  camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ connection

function connect() {
  if (state.link) state.link.close();
  stopSim();
  clearRoomState();
  state.room = normalizeRoom($('room').value) || randomRoomCode();
  state.relay = $('relay').value.trim();
  $('room').value = state.room;
  safeSet('seethrough.room', state.room);
  if (state.relay) safeSet('seethrough.relay', state.relay);
  else safeSet('seethrough.relay', null);
  const url = new URL(location.href);
  url.searchParams.set('room', state.room);
  if (state.relay) url.searchParams.set('relay', state.relay);
  else url.searchParams.delete('relay');
  history.replaceState(null, '', url);
  $('open-node').href = `node.html?room=${state.room}${state.relay ? `&relay=${encodeURIComponent(state.relay)}` : ''}`;

  const link = openLink(state.relay, { room: state.room, role: 'viewer', name: 'Viewer', id: state.id });
  state.link = link;
  link.on('status', ({ status }) => setStatus(status));
  link.on('welcome', (m) => {
    setMap(m.map);
    for (const c of m.cameras || []) onCamera(c);
    for (const t of m.thumbs || []) onThumb(t);
    announceSelf();
  });
  link.on('peer', (m) => m.joined && announceSelf());
  link.on('map', (m) => setMap(m.map));
  link.on('camera', onCamera);
  link.on('pose', onPose);
  link.on('cameraGone', (m) => removeCamera(m.id));
  link.on('objects', onObjects);
  link.on('thumb', onThumb);
}

function clearRoomState() {
  for (const o of state.objects.values()) {
    objectsGroup.remove(o.visual.group);
    o.visual.dispose();
  }
  state.objects.clear();
  for (const id of state.cameras.keys()) cameraVis.remove(id);
  state.cameras.clear();
  state.labelCounts.clear();
  state.camIndex = 0;
  headCam.tracker = new Tracker({ prefix: 'h' });
  setMap(null);
  renderCameraList();
  renderFilters();
}

function setStatus(status) {
  const pill = $('status-pill');
  pill.className = `pill ${status === 'open' ? 'ok' : status === 'connecting' ? 'warn' : 'bad'}`;
  const where = state.relay ? 'relay' : 'local';
  $('status-text').textContent = status === 'open' ? `${state.room} · ${where}` : status;
}

function setMap(map) {
  state.map = map || null;
  markerVis.setMap(state.map);
}

function onCamera(info) {
  if (info.id === state.id) return; // our own entry, echoed back after a reconnect
  let c = state.cameras.get(info.id);
  if (!c) {
    c = { index: state.camIndex++, objCount: 0, lastSeen: performance.now(), thumb: null };
    state.cameras.set(info.id, c);
  }
  c.info = { ...info, color: info.color || colorForIndex(c.index) };
  c.matrix = msgToPose(info.pose);
  c.lastSeen = performance.now();
  cameraVis.upsert(c.info, c.matrix);
  renderCameraList();
}

/** Fast position update from a moving device (another headset or desktop viewer). */
function onPose(m) {
  const c = state.cameras.get(m.id);
  if (!c || m.id === state.id) return;
  c.info.pose = m.pose;
  c.matrix = msgToPose(m.pose);
  c.lastSeen = performance.now();
  cameraVis.upsert(c.info, c.matrix);
}

/** Tells the room where this headset is, so phones can show it on their maps. */
function announceSelf() {
  if (!state.link) return;
  const xr = renderer.xr.isPresenting;
  state.link.send({
    t: 'camera',
    id: state.id,
    name: xr ? 'Headset' : 'Viewer (desktop)',
    color: HEADSET_COLOR,
    kind: 'headset',
    pose: state.selfPose ? poseToMsg(state.selfPose) : null,
    fovH: headCam.on ? headCam.fov : 90,
    aspect: 4 / 3,
    detecting: headCam.on,
    active: true,
  });
}
setInterval(announceSelf, 4000);

let lastPoseSent = 0;
function sendSelfPose(now) {
  if (!state.link || !state.selfPose || now - lastPoseSent < 1000 / POSE_HZ) return;
  lastPoseSent = now;
  state.link.send({ t: 'pose', id: state.id, pose: poseToMsg(state.selfPose) });
}

function removeCamera(id) {
  state.cameras.delete(id);
  cameraVis.remove(id);
  renderCameraList();
}

function onThumb(m) {
  const c = state.cameras.get(m.cam);
  if (!c) return;
  c.thumb = m.img;
  const img = document.querySelector(`[data-thumb="${CSS.escape(m.cam)}"]`);
  if (img) img.src = m.img;
  else renderCameraList();
}

function onObjects(msg) {
  let c = msg.cam === state.id ? selfSource : state.cameras.get(msg.cam);
  if (!c) {
    // Objects before the camera's announcement: register it with defaults.
    onCamera({ id: msg.cam, name: msg.cam });
    c = state.cameras.get(msg.cam);
  }
  c.lastSeen = performance.now();
  c.objCount = msg.objs.length;
  state.updates++;
  const lat = state.link.now() - msg.ts;
  if (isFinite(lat) && lat > -500 && lat < 10000) {
    state.latency = state.latency === null ? lat : state.latency * 0.9 + lat * 0.1;
  }
  const now = performance.now();
  for (const o of msg.objs) {
    const key = `${msg.cam}:${o.id}`;
    let rec = state.objects.get(key);
    if (!rec) {
      const visual = new ObjectVisual({ label: o.label, color: c.info.color });
      visual.setXray(state.xray);
      objectsGroup.add(visual.group);
      rec = { visual, cam: msg.cam, label: o.label };
      state.objects.set(key, rec);
      if (!state.labelCounts.has(o.label)) {
        state.labelCounts.set(o.label, 0);
        renderFilters();
      }
    }
    rec.lastUpdate = now;
    rec.color = c.info.color;
    rec.conf = o.c ?? 0.5;
    rec.p = o.p;
    rec.visual.setTarget(o.p, o.s);
  }
}

// ------------------------------------------------------------------ HUD

function renderCameraList() {
  const el = $('cams');
  if (!state.cameras.size) {
    el.innerHTML = '<span class="muted">No cameras connected.</span>';
    return;
  }
  el.innerHTML = '';
  for (const [id, c] of state.cameras) {
    const div = document.createElement('div');
    div.className = 'cam';
    div.dataset.cam = id;
    const calibrated = c.matrix ? (c.info.calibratedWith != null ? `calibrated on marker ${c.info.calibratedWith}` : 'calibrated') : 'not calibrated';
    div.innerHTML = `
      <span class="swatch" style="background:${c.info.color};box-shadow:0 0 8px ${c.info.color}"></span>
      <span class="name"></span>
      <span class="pill"><span class="dot" style="background:var(--live)"></span>live</span>
      <span class="meta"></span>
      ${c.thumb ? `<img data-thumb="${id}" alt="Preview from this camera" src="${c.thumb}">` : ''}`;
    div.querySelector('.name').textContent = c.info.name || id;
    div.querySelector('.meta').textContent = `${c.info.kind || 'camera'} · ${calibrated}`;
    el.append(div);
  }
}

function refreshCameraMeta() {
  const now = performance.now();
  for (const [id, c] of state.cameras) {
    const div = document.querySelector(`.cam[data-cam="${CSS.escape(id)}"]`);
    if (!div) continue;
    const age = (now - c.lastSeen) / 1000;
    div.classList.toggle('stale', age > 3);
    const calibrated = c.matrix ? (c.info.calibratedWith != null ? `marker ${c.info.calibratedWith}` : 'calibrated') : 'not calibrated';
    div.querySelector('.meta').textContent =
      `${c.objCount} object${c.objCount === 1 ? '' : 's'} · ${calibrated} · ${age < 1.5 ? 'live' : `${age.toFixed(0)} s ago`}`;
  }
}

function renderFilters() {
  const el = $('filters');
  if (!state.labelCounts.size) {
    el.innerHTML = '<span class="muted">Nothing seen yet.</span>';
    return;
  }
  el.innerHTML = '';
  for (const label of [...state.labelCounts.keys()].sort()) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.label = label;
    b.setAttribute('aria-pressed', String(!state.hiddenLabels.has(label)));
    b.innerHTML = `<span></span><span class="count">0</span>`;
    b.firstChild.textContent = prettyLabel(label);
    b.onclick = () => toggleLabel(label);
    el.append(b);
  }
}

function toggleLabel(label) {
  if (state.hiddenLabels.has(label)) state.hiddenLabels.delete(label);
  else state.hiddenLabels.add(label);
  safeSetJSON('seethrough.hiddenLabels', [...state.hiddenLabels]);
  renderFilters();
}

function setXray(on) {
  state.xray = on;
  $('t-xray').checked = on;
  for (const o of state.objects.values()) o.visual.setXray(on);
}

$('t-xray').onchange = (e) => setXray(e.target.checked);
$('t-labels').onchange = (e) => (state.labels = e.target.checked);
$('t-cams').onchange = (e) => (state.showCams = e.target.checked);
$('t-markers').onchange = (e) => (state.showMarkers = e.target.checked);
$('t-truth').onchange = (e) => (state.showTruth = e.target.checked);
$('t-minimap').onchange = (e) => setMinimap(e.target.checked);
$('connect').onclick = connect;
$('room').addEventListener('keydown', (e) => e.key === 'Enter' && connect());
$('hud-toggle').onclick = () => {
  const c = $('hud').classList.toggle('collapsed');
  $('hud-toggle').textContent = c ? 'Show' : 'Hide';
  $('hud-toggle').setAttribute('aria-expanded', String(!c));
};

let toastTimer;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ mini map (top left)

const miniCanvas = $('minimap');
const miniDesktop = new Minimap(miniCanvas, { follow: true, range: 6, title: 'Shared map' });
function sizeMiniCanvas() {
  const css = miniCanvas.getBoundingClientRect().width || 200;
  const px = Math.round(css * Math.min(devicePixelRatio, 2));
  if (miniCanvas.width !== px) miniCanvas.width = miniCanvas.height = px;
}
addEventListener('resize', sizeMiniCanvas);

// In the headset the map is a small panel fixed to the top left of your view.
const miniXRCanvas = document.createElement('canvas');
miniXRCanvas.width = miniXRCanvas.height = 512;
const miniXR = new Minimap(miniXRCanvas, { follow: true, range: 6, title: 'Shared map' });
const miniXRTexture = new THREE.CanvasTexture(miniXRCanvas);
miniXRTexture.colorSpace = THREE.SRGBColorSpace;
const miniXRMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(0.13, 0.13),
  new THREE.MeshBasicMaterial({ map: miniXRTexture, transparent: true, depthTest: false, depthWrite: false })
);
miniXRMesh.renderOrder = 2100;
miniXRMesh.matrixAutoUpdate = false;
miniXRMesh.visible = false;
scene.add(miniXRMesh);
// Head-relative placement: up and to the left, 0.6 m in front of the eyes.
const MINI_XR_OFFSET = new THREE.Matrix4().makeTranslation(-0.2, 0.12, -0.6);

/** Everything the mini map shows: devices, their detections and the markers. */
function minimapData(now) {
  const self = state.selfPose ? { ...floorPose(state.selfPose), kind: 'headset', color: HEADSET_COLOR, name: 'You' } : null;
  const devices = [];
  for (const c of state.cameras.values()) {
    if (!c.matrix) continue;
    devices.push({ ...floorPose(c.matrix), id: c.info.id, color: c.info.color, name: c.info.name, kind: c.info.kind === 'headset' ? 'headset' : 'camera', fovH: c.info.fovH, stale: (now - c.lastSeen) / 1000 > 6 });
  }
  const objects = [];
  for (const o of state.objects.values()) {
    if (o.dupOf || state.hiddenLabels.has(o.label) || (now - o.lastUpdate) / 1000 > FADE_START_S) continue;
    objects.push({ p: [o.p[0], o.p[2]], label: o.label, color: o.color, mine: o.cam === state.id });
  }
  const markers = Object.entries(state.map?.markers || {}).map(([id, m]) => ({ id, p: [m.p[0], m.p[2]], yaw: m.yaw }));
  return { self, devices, objects, markers, recording: headCam.on };
}

function setMinimap(on) {
  state.showMinimap = on;
  safeSet('seethrough.minimap', on ? 'on' : 'off');
  $('t-minimap').checked = on;
  miniCanvas.hidden = !on || renderer.xr.isPresenting;
}

// ------------------------------------------------------------------ headset camera
//
// With the headset camera on, the headset runs the same on-device detector as the
// phones and shares what it detects. Frames are processed on the headset and never
// sent anywhere. Needs a Quest Browser that lets web pages use the headset cameras.

const headCam = {
  on: false,
  starting: false,
  confirm: false, // first press asks the wearer to confirm, second press starts
  fov: Number(qs('hfov', 80)), // approximate horizontal FOV of the Quest passthrough camera
  status: '',
  video: null,
  stream: null,
  detector: null,
  K: null,
  busy: false,
  lastRun: 0,
  tracker: new Tracker({ prefix: 'h' }),
};

async function startHeadsetCamera() {
  if (headCam.on || headCam.starting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    headCam.status = 'This browser does not let web pages use the headset camera.';
    return;
  }
  headCam.starting = true;
  headCam.status = 'Starting headset camera…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
    headCam.stream = stream;
    headCam.video = video;
    headCam.K = intrinsicsFromFov(video.videoWidth, video.videoHeight, headCam.fov);
    if (!headCam.detector) {
      const { CocoDetector } = await import('../node/detector.js');
      headCam.detector = new CocoDetector();
      await headCam.detector.load((t) => (headCam.status = t));
    }
    headCam.on = true;
    headCam.status = `Headset camera on · ${video.videoWidth}×${video.videoHeight} · detecting on this headset`;
    announceSelf();
  } catch (e) {
    stopHeadsetCamera();
    headCam.status = `Headset camera unavailable: ${e.message || e}`;
  } finally {
    headCam.starting = false;
  }
}

function stopHeadsetCamera() {
  headCam.on = false;
  headCam.confirm = false;
  headCam.stream?.getTracks().forEach((t) => t.stop());
  headCam.stream = null;
  headCam.video = null;
  if (headCam.status.startsWith('Headset camera on')) headCam.status = 'Headset camera off.';
  announceSelf();
}

/** Runs one detection on the latest headset camera frame (called from the frame loop). */
function runHeadsetDetection(now) {
  if (!headCam.on || headCam.busy || !headCam.detector?.model || !state.selfPose) return;
  if (now - headCam.lastRun < 1000 / SEND_HZ) return;
  headCam.lastRun = now;
  headCam.busy = true;
  // Use the head pose from when the frame was taken, not when detection finishes.
  const pose = state.selfPose.clone();
  headCam.detector
    .detect(headCam.video, 20, 0.5)
    .then((dets) => {
      const objs3d = [];
      for (const d of dets) {
        const w = detectionToWorld(d.bbox, headCam.K, pose, d.label);
        if (w) objs3d.push({ label: d.label, p: w.p, s: w.s, c: d.score });
      }
      const objs = headCam.tracker.update(objs3d);
      const msg = { t: 'objects', cam: state.id, ts: state.link.now(), objs };
      state.link.send(msg);
      onObjects(msg); // show our own detections too
    })
    .catch((e) => console.warn(e))
    .finally(() => (headCam.busy = false));
}

// ------------------------------------------------------------------ simulator

async function startSim() {
  if (state.sim) return;
  const [{ Simulator }, world] = await Promise.all([import('../sim/simulator.js'), import('../sim/world.js')]);
  // The simulator connects as its own client, over the same transport as the viewer.
  const simLink = openLink(state.relay, { room: state.room, role: 'sim', name: 'Simulator', id: randomId('s-') });
  await new Promise((res) => {
    if (simLink.status === 'open') res();
    else simLink.on('welcome', res);
  });
  state.sim = new Simulator(simLink);
  state.sim.link = simLink;
  state.sim.start();
  // Local echo of the map so this page's viewer gets it immediately.
  setMap(world.SIM_MAP);
  if (!simHouse) {
    simHouse = buildSimHouse(world);
    worldRoot.add(simHouse);
  }
  simHouse.visible = !renderer.xr.isPresenting;
  $('truth-row').hidden = false;
  $('sim-toggle').textContent = 'Stop simulator';
  $('sim-toggle').setAttribute('aria-pressed', 'true');
  const errs = state.sim.stats().map((s) => `${s.name}: ${(s.errorM * 100).toFixed(0)} cm`).join(' · ');
  toast(`Simulator running. Camera calibration error: ${errs}`, 6000);
}

function stopSim() {
  if (!state.sim) return;
  state.sim.stop();
  state.sim.link.close();
  state.sim = null;
  if (simHouse) simHouse.visible = false;
  $('truth-row').hidden = true;
  state.showTruth = false;
  $('t-truth').checked = false;
  $('sim-toggle').textContent = 'Start simulator';
  $('sim-toggle').setAttribute('aria-pressed', 'false');
}

$('sim-toggle').onclick = () => (state.sim ? stopSim() : startSim());

// ------------------------------------------------------------------ WebXR

const aligner = new Aligner({
  getMap: () => state.map,
  publishMap: (map) => {
    setMap(map);
    state.link?.send({ t: 'map', map });
  },
});

const panel = new XRPanel();
panel.mesh.visible = false;
scene.add(panel.mesh);

const tipMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.008, 12, 8),
  new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false })
);
tipMarker.renderOrder = 3000;
tipMarker.visible = false;
scene.add(tipMarker);

const raycaster = new THREE.Raycaster();
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: '#38e8ff', transparent: true, opacity: 0.7, depthTest: false })
  );
  ray.scale.z = 1.5;
  ray.renderOrder = 2500;
  c.add(ray);
  c.userData.ray = ray;
  c.addEventListener('connected', (e) => {
    c.userData.inputSource = e.data;
    ray.visible = !e.data.hand;
  });
  c.addEventListener('disconnected', () => (c.userData.inputSource = null));
  c.addEventListener('select', () => onSelect(c, i));
  c.addEventListener('squeeze', () => placePanel());
  scene.add(c);
  return c;
});
const hands = [0, 1].map((i) => {
  const h = renderer.xr.getHand(i);
  scene.add(h);
  return h;
});

/** The point the user touches the wall with: index fingertip, or the controller tip. */
function touchPoint(i) {
  const hand = hands[i];
  const tip = hand.joints?.['index-finger-tip'];
  if (controllers[i].userData.inputSource?.hand && tip) return tip.getWorldPosition(new THREE.Vector3());
  const c = controllers[i];
  return new THREE.Vector3(0, 0, -0.02).applyMatrix4(c.matrixWorld);
}

function panelHit(controller) {
  if (!panel.mesh.visible) return null;
  const m = controller.matrixWorld;
  raycaster.ray.origin.setFromMatrixPosition(m);
  raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
  const hit = raycaster.intersectObject(panel.mesh)[0];
  return hit ? { id: panel.buttonAt(hit.uv), distance: hit.distance } : null;
}

function onSelect(controller, i) {
  const hit = panelHit(controller);
  if (hit) {
    if (hit.id) onPanelButton(hit.id);
    return;
  }
  if (aligner.mode !== 'idle') {
    const msg = aligner.tap(touchPoint(i));
    if (aligner.aligned) saveAnchor();
    flashTip();
    return msg;
  }
}

function flashTip() {
  tipMarker.material.color.set('#4ade80');
  setTimeout(() => tipMarker.material.color.set('#ffffff'), 300);
}

function placePanel() {
  const xrCam = renderer.xr.getCamera();
  const pos = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(xrCam.matrixWorld);
  fwd.y = 0;
  fwd.normalize();
  panel.mesh.position.copy(pos).addScaledVector(fwd, 0.6);
  panel.mesh.position.y = pos.y - 0.18;
  panel.mesh.lookAt(pos.x, panel.mesh.position.y + 0.1, pos.z);
  panel.mesh.visible = true;
}

function onPanelButton(id) {
  if (id === 'xray') setXray(!state.xray);
  else if (id === 'labels') state.labels = !state.labels;
  else if (id === 'cams') state.showCams = !state.showCams;
  else if (id === 'markers') state.showMarkers = !state.showMarkers;
  else if (id === 'align') aligner.begin('align');
  else if (id === 'map') aligner.begin('map');
  else if (id === 'done') aligner.cancel();
  else if (id === 'prev') aligner.cycleMarker(-1);
  else if (id === 'next') aligner.cycleMarker(1);
  else if (id === 'hide') panel.mesh.visible = false;
  else if (id === 'minimap') setMinimap(!state.showMinimap);
  else if (id === 'headcam') {
    if (headCam.on) stopHeadsetCamera();
    else if (!headCam.confirm) {
      headCam.confirm = true;
      headCam.status = 'Only use the headset camera where people nearby know it is on. Press again to start.';
    } else startHeadsetCamera();
  }
  else if (id.startsWith('label:')) toggleLabel(id.slice(6));
}

function panelModel() {
  const lat = state.latency === null ? '–' : `${Math.round(state.latency)} ms`;
  const status = state.link?.status === 'open' ? `room ${state.room}` : state.link?.status || 'offline';
  const sections = [
    {
      buttons: [
        { id: 'xray', label: `X-ray ${state.xray ? 'on' : 'off'}`, on: state.xray },
        { id: 'labels', label: 'Labels', on: state.labels },
        { id: 'cams', label: 'Cameras', on: state.showCams },
        { id: 'markers', label: 'Markers', on: state.showMarkers },
        { id: 'minimap', label: 'Mini map', on: state.showMinimap },
        { id: 'hide', label: 'Hide' },
      ],
    },
    {
      heading: 'Share what this headset sees',
      lines: [{ text: headCam.status || 'Off. Turn on to detect with the headset camera and share it with the phones.', color: headCam.on ? '#f87171' : '#8c9bb0' }],
      buttons: [
        {
          id: 'headcam',
          label: headCam.on ? '● Headset camera on' : headCam.starting ? 'Starting…' : headCam.confirm ? 'Confirm: start camera' : 'Headset camera',
          on: headCam.on,
          accent: '#f87171',
        },
      ],
    },
  ];
  const alignLines = [{ text: aligner.message || (aligner.aligned ? `Aligned to marker ${aligner.alignedWith}.` : 'Not aligned: outlines are not in the right place yet.'), color: aligner.aligned ? '#4ade80' : '#ffd23f' }];
  if (aligner.mode === 'idle') {
    sections.push({ heading: 'Calibration', lines: alignLines, buttons: [{ id: 'align', label: 'Align to marker' }, { id: 'map', label: 'Map rooms' }] });
  } else {
    sections.push({
      heading: aligner.mode === 'map' ? 'Map rooms' : 'Align',
      lines: alignLines,
      buttons: [
        { id: 'prev', label: '◀' },
        { id: 'marker', label: `Marker ${aligner.markerId}`, on: true, accent: '#ffd23f' },
        { id: 'next', label: '▶' },
        { id: 'done', label: 'Done' },
      ],
    });
  }
  if (state.labelCounts.size) {
    sections.push({
      heading: 'Object types',
      buttons: [...state.labelCounts.keys()].sort().map((l) => ({ id: `label:${l}`, label: `${prettyLabel(l)} ${state.labelCounts.get(l)}`, on: !state.hiddenLabels.has(l) })),
    });
  }
  const now = performance.now();
  sections.push({
    heading: 'Cameras',
    lines: state.cameras.size
      ? [...state.cameras.values()].slice(0, 5).map((c) => ({
          dot: c.info.color,
          text: `${c.info.name || c.info.id} · ${c.objCount} obj · ${(now - c.lastSeen) / 1000 < 1.5 ? 'live' : 'stale'}${c.matrix ? '' : ' · not calibrated'}`,
        }))
      : [{ text: 'No cameras in this room yet.', color: '#8c9bb0' }],
  });
  return {
    title: 'SeeThrough',
    subtitle: `${headCam.on ? '● CAMERA ON · ' : ''}${status} · ${state.objects.size} objects · ${lat}`,
    sections,
    footer: 'Squeeze to bring this panel in front of you. Trigger to press.',
  };
}

// Persistent anchors (Quest Browser): remember where the world origin is between sessions.
let anchor = null;
let anchorSavePending = false;
const anchorKey = () => `seethrough.anchor.${state.room}`;

async function saveAnchor() {
  anchorSavePending = true;
}

async function trySaveAnchor(frame, refSpace) {
  anchorSavePending = false;
  if (!frame.createAnchor || !aligner.xrFromWorld) return;
  try {
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    aligner.xrFromWorld.decompose(p, q, new THREE.Vector3());
    const a = await frame.createAnchor(new XRRigidTransform(p, q), refSpace);
    const session = renderer.xr.getSession();
    const old = safeGet(anchorKey());
    if (old && session.deletePersistentAnchor) session.deletePersistentAnchor(old).catch(() => {});
    if (a.requestPersistentHandle) {
      const uuid = await a.requestPersistentHandle();
      safeSet(anchorKey(), uuid);
    }
    if (anchor) anchor.delete?.();
    anchor = a;
  } catch (e) {
    console.warn('Anchor not saved:', e);
  }
}

async function restoreAnchor(session) {
  const uuid = safeGet(anchorKey());
  if (!uuid || !session.restorePersistentAnchor) return;
  try {
    anchor = await session.restorePersistentAnchor(uuid);
    aligner.message = 'Restored last alignment from a saved anchor. Re-align if outlines look off.';
  } catch (e) {
    console.warn('Could not restore anchor', e);
  }
}

const arButton = ARButton.createButton(renderer, {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['hand-tracking', 'anchors'],
});
$('xr-slot').append(arButton);

renderer.xr.addEventListener('sessionstart', () => {
  scene.background = null;
  scene.fog = null;
  grid.visible = false;
  if (simHouse) simHouse.visible = false;
  $('hud').hidden = true;
  $('hint').hidden = true;
  miniCanvas.hidden = true;
  const session = renderer.xr.getSession();
  restoreAnchor(session);
  setTimeout(placePanel, 300);
  if (!aligner.aligned) aligner.message = state.map ? 'Not aligned. Press "Align to marker", then touch a marker.' : 'No map yet. Press "Map rooms" and touch your first marker.';
});
renderer.xr.addEventListener('sessionend', () => {
  scene.background = DESKTOP_BG;
  scene.fog = new THREE.Fog(DESKTOP_BG, 18, 40);
  grid.visible = true;
  if (simHouse && state.sim) simHouse.visible = true;
  $('hud').hidden = false;
  $('hint').hidden = false;
  miniCanvas.hidden = !state.showMinimap;
  miniXRMesh.visible = false;
  stopHeadsetCamera();
  state.selfPose = null;
  panel.mesh.visible = false;
  tipMarker.visible = false;
  anchor = null;
  worldRoot.matrix.identity();
});

// ------------------------------------------------------------------ frame loop

const clock = new THREE.Clock();
const viewerWorld = new THREE.Vector3();
const invRoot = new THREE.Matrix4();
let rateTimer = performance.now();
let hudTimer = 0;
let miniTimer = 0;
const xrFromHead = new THREE.Matrix4();

renderer.setAnimationLoop((t, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  const xr = renderer.xr.isPresenting;

  if (xr && frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    if (anchorSavePending) trySaveAnchor(frame, refSpace);
    if (anchor && frame.trackedAnchors?.has(anchor)) {
      const pose = frame.getPose(anchor.anchorSpace, refSpace);
      if (pose) aligner.setFromAnchor(new THREE.Matrix4().fromArray(pose.transform.matrix));
    }
    if (aligner.xrFromWorld) worldRoot.matrix.copy(aligner.xrFromWorld);
    else worldRoot.matrix.identity();
    worldRoot.matrixWorldNeedsUpdate = true;

    // Controller rays: hover the panel, show the touch point while aligning.
    let hover = null;
    controllers.forEach((c, i) => {
      const h = panelHit(c);
      if (h?.id) hover = h.id;
      if (c.userData.ray) c.userData.ray.scale.z = h ? h.distance : 1.5;
      if (aligner.mode !== 'idle' && i === 1) {
        tipMarker.visible = true;
        tipMarker.position.copy(touchPoint(i));
      }
    });
    if (aligner.mode === 'idle') tipMarker.visible = false;
    panel.setHover(hover);
    panel.setModel(panelModel());
    panel.draw();
    renderer.xr.getCamera().getWorldPosition(viewerWorld);

    // Where the headset is in the shared world (only known once aligned to a marker).
    const viewerPose = frame.getViewerPose(refSpace);
    if (viewerPose) {
      xrFromHead.fromArray(viewerPose.transform.matrix);
      state.selfPose = aligner.xrFromWorld ? headWorldPose(aligner.xrFromWorld, xrFromHead) : null;
      miniXRMesh.matrix.multiplyMatrices(xrFromHead, MINI_XR_OFFSET);
      miniXRMesh.matrixWorldNeedsUpdate = true;
      miniXRMesh.visible = state.showMinimap;
    }
    runHeadsetDetection(now);
  } else {
    if (viewMode === 'walk') updateWalk(dt);
    else orbit.update();
    viewerWorld.copy(camera.position);
    // On the desktop the walk view stands in for the headset, so phones can see it.
    camera.updateMatrixWorld();
    state.selfPose = viewMode === 'walk' ? camera.matrixWorld.clone() : null;
  }
  sendSelfPose(now);
  invRoot.copy(worldRoot.matrix).invert();
  viewerWorld.applyMatrix4(invRoot);

  // Fuse duplicates: when cameras overlap, the same object arrives once per camera.
  // Draw one outline (from the lowest-numbered camera, so it doesn't flicker).
  const live = [...state.objects.values()].filter((o) => (now - o.lastUpdate) / 1000 < FADE_START_S);
  for (const o of state.objects.values()) {
    o.dupOf = null;
    o.cams = 1;
  }
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (a.dupOf) continue;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (b.dupOf || b.cam === a.cam || b.label !== a.label) continue;
      if (Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]) > 0.7) continue;
      const ia = state.cameras.get(a.cam)?.index ?? 0;
      const ib = state.cameras.get(b.cam)?.index ?? 0;
      const [keep, drop] = ia <= ib ? [a, b] : [b, a];
      drop.dupOf = keep;
      keep.cams++;
      if (keep === b) break;
    }
  }

  // Objects: fade out after FADE_START_S without updates, remove after FADE_END_S.
  for (const k of state.labelCounts.keys()) state.labelCounts.set(k, 0);
  for (const [key, o] of state.objects) {
    const age = (now - o.lastUpdate) / 1000;
    if (age > FADE_END_S) {
      objectsGroup.remove(o.visual.group);
      o.visual.dispose();
      state.objects.delete(key);
      continue;
    }
    const hidden = state.hiddenLabels.has(o.label) || !!o.dupOf;
    const fade = age < FADE_START_S ? 1 : 1 - (age - FADE_START_S) / (FADE_END_S - FADE_START_S);
    o.visual.group.visible = !hidden;
    if (hidden) continue;
    o.visual.update(dt, Math.max(0, fade), viewerWorld, state.labels, o.cams > 1 ? ` · ${o.cams} cams` : '');
    state.labelCounts.set(o.label, (state.labelCounts.get(o.label) || 0) + 1);
  }
  cameraVis.group.visible = state.showCams;
  markerVis.group.visible = state.showMarkers;
  truthVis.group.visible = state.showTruth && !!state.sim;
  if (truthVis.group.visible) truthVis.update(state.sim.truth());

  if (now - rateTimer > 1000) {
    state.rate = (state.updates * 1000) / (now - rateTimer);
    state.updates = 0;
    rateTimer = now;
  }
  miniTimer += dt;
  if (state.showMinimap && miniTimer > 1 / 15) {
    miniTimer = 0;
    const data = minimapData(now);
    if (xr) {
      miniXR.draw(data);
      miniXRTexture.needsUpdate = true;
    } else if (!miniCanvas.hidden) {
      sizeMiniCanvas();
      miniDesktop.draw(data);
    }
  }
  hudTimer += dt;
  if (hudTimer > 0.25 && !xr) {
    hudTimer = 0;
    $('st-objects').textContent = [...state.objects.values()].filter((o) => !state.hiddenLabels.has(o.label)).length;
    $('st-latency').textContent = state.latency === null ? '–' : Math.max(0, Math.round(state.latency));
    $('st-rate').textContent = Math.round(state.rate);
    for (const chip of document.querySelectorAll('#filters .chip')) {
      chip.querySelector('.count').textContent = state.labelCounts.get(chip.dataset.label) || 0;
    }
    refreshCameraMeta();
  }

  renderer.render(scene, camera);
});

// ------------------------------------------------------------------ boot

$('room').value = state.room;
$('relay').value = state.relay;
setViewMode('walk');
setMinimap(state.showMinimap);
connect();
if (qs('sim') === '1' || (!state.relay && qs('sim') !== '0')) {
  // With no relay the viewer has nothing to show, so run the simulator by default.
  startSim();
}

// Expose a little for debugging from the console.
window.seethrough = { state, aligner, scene, worldRoot };
