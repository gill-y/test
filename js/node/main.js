// SeeThrough browser camera node.
//
//   camera -> on-device detection -> 3D positions in world coordinates -> relay
//
// Raw video stays on this device. Only object positions (and, if switched on, a
// small preview thumbnail) are sent.
//
// The node also listens: it shows what the headset and the other phones detect,
// on a mini map (top left of the video) and as dashed outlines on the video.

import * as THREE from 'three';
import { openLink } from '../common/transport.js';
import {
  qs, randomId, randomRoomCode, normalizeRoom, defaultRelayUrl, safeGet, safeSet, safeGetJSON, safeSetJSON,
  SEND_HZ, colorForIndex, prettyLabel, FADE_END_S,
} from '../common/protocol.js';
import {
  intrinsicsFromFov, detectionToWorld, poseToMsg, msgToPose, floorPose, projectBox,
} from '../common/geometry.js';
import { WalkCalibrator, PositionHistory } from '../common/walkcal.js';
import { Minimap } from '../common/minimap.js';
import { Tracker } from '../common/tracker.js';
import { CocoDetector } from './detector.js';

const $ = (id) => document.getElementById(id);

const st = {
  id: safeGet('seethrough.nodeId') || randomId('cam-'),
  link: null,
  map: null,
  running: false,
  stream: null,
  source: null, // {kind:'camera'|'synthetic', el, width, height, synthetic?}
  detector: null,
  tracker: new Tracker(),
  calib: null, // {worldId, pose:{p,q}, fovH, width, height, error, at}
  K: null,
  pose: null, // Matrix4 world <- GL camera
  collecting: null,
  lastDets: [],
  headsets: new Map(), // headset id -> PositionHistory of its head (world frame, relay clock)
  pendingObjs: null,
  lastTracked: [], // this node's own objects in world coordinates
  remote: { devices: new Map(), objects: new Map() }, // what the other devices report
  counters: { det: 0, sent: 0 },
  wakeLock: null,
};
safeSet('seethrough.nodeId', st.id);

const room = normalizeRoom(qs('room') || safeGet('seethrough.room') || '') || randomRoomCode();
$('room').value = room;
$('relay').value = qs('relay') ?? defaultRelayUrl();
$('name').value = safeGet('seethrough.nodeName') || defaultName();
$('fov').value = safeGet('seethrough.nodeFov') || 65;
const color = colorForIndex(parseInt(st.id.slice(-2), 36) || 0);

function defaultName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone camera';
  if (/Android/.test(ua)) return 'Android camera';
  return 'Laptop camera';
}

// ------------------------------------------------------------------ sources

async function listSources() {
  const sel = $('source');
  sel.innerHTML = '';
  const add = (value, label) => sel.append(new Option(label, value));
  add('environment', 'Back camera (phones)');
  add('user', 'Front / built-in camera');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices
      .filter((d) => d.kind === 'videoinput' && d.label)
      .forEach((d) => add(`device:${d.deviceId}`, d.label));
  } catch {
    /* labels appear after permission is granted */
  }
  if (qs('synthetic') === '1') add('synthetic', 'Synthetic test scene');
  const saved = safeGet('seethrough.nodeSource');
  if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
  else if (qs('synthetic') === '1') sel.value = 'synthetic';
}

async function openSource() {
  const choice = $('source').value;
  const [w, h] = $('res').value.split('x').map(Number);
  if (choice === 'synthetic') {
    const { SyntheticSource } = await import('./synthetic.js');
    const s = new SyntheticSource({ width: w, height: h, fov: Number($('fov').value) });
    await s.ready;
    s.render(0);
    return { kind: 'synthetic', el: s.canvas, width: w, height: h, synthetic: s };
  }
  const video = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  if (choice.startsWith('device:')) video.deviceId = { exact: choice.slice(7) };
  else video.facingMode = { ideal: choice };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  st.stream = stream;
  const el = $('video');
  el.srcObject = stream;
  await el.play();
  await new Promise((r) => (el.videoWidth ? r() : el.addEventListener('loadedmetadata', r, { once: true })));
  return { kind: 'camera', el, width: el.videoWidth, height: el.videoHeight };
}

// ------------------------------------------------------------------ start / stop

$('consent').onchange = (e) => ($('start').disabled = !e.target.checked);

$('start').onclick = async () => {
  $('start').disabled = true;
  try {
    safeSet('seethrough.nodeName', $('name').value.trim());
    safeSet('seethrough.nodeSource', $('source').value);
    connect();
    st.source = await openSource();
    await listSources(); // device labels are available now
    $('source').value = safeGet('seethrough.nodeSource') || $('source').value;
  } catch (e) {
    toast(`Couldn't start the camera: ${e.message || e}`);
    $('start').disabled = false;
    return;
  }
  st.running = true;
  setLive(true);
  updateIntrinsics();
  loadCalibration();
  const ov = $('overlay');
  ov.width = st.source.width;
  ov.height = st.source.height;
  $('video').hidden = st.source.kind !== 'camera';
  if (st.source.kind === 'synthetic') {
    $('stage').insertBefore(st.source.el, ov);
    st.source.el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
  }
  $('stage').style.aspectRatio = `${st.source.width} / ${st.source.height}`;
  $('calibrate').disabled = false;
  if (st.source.kind === 'camera') {
    st.detector = new CocoDetector();
    st.detector.load((s) => ($('model-status').textContent = s)).catch((e) => ($('model-status').textContent = `Detector failed to load: ${e.message}`));
  } else {
    $('model-status').textContent = 'Synthetic scene: detections are the test person’s true box.';
  }
  requestWakeLock();
  loop();
};

$('stop').onclick = stop;

function stop() {
  st.running = false;
  if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
  st.stream = null;
  if (st.source?.kind === 'synthetic') st.source.el.remove();
  st.source = null;
  st.lastTracked = [];
  st.remote.devices.clear();
  st.remote.objects.clear();
  if (st.link) {
    st.link.send({ t: 'cameraGone', id: st.id });
    st.link.close();
    st.link = null;
  }
  st.wakeLock?.release?.().catch(() => {});
  setLive(false);
  setStatus('closed');
  $('calibrate').disabled = true;
  $('start').disabled = !$('consent').checked;
}

function setLive(on) {
  $('live-banner').classList.toggle('on', on);
  $('node').classList.toggle('live', on);
  $('live-name').textContent = $('name').value || 'this device';
  $('stage-empty').hidden = on;
  $('start').hidden = on;
  $('stop').hidden = !on;
  for (const id of ['relay', 'room', 'source', 'res']) $(id).disabled = on;
  document.title = on ? '● LIVE · SeeThrough Camera Node' : 'SeeThrough Camera Node';
}

async function requestWakeLock() {
  try {
    st.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* optional */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st.running) requestWakeLock();
});

// ------------------------------------------------------------------ relay

function connect() {
  const roomCode = normalizeRoom($('room').value) || randomRoomCode();
  $('room').value = roomCode;
  safeSet('seethrough.room', roomCode);
  const relay = $('relay').value.trim();
  safeSet('seethrough.relay', relay || null);
  $('open-viewer').href = `viewer.html?room=${roomCode}${relay ? `&relay=${encodeURIComponent(relay)}` : '&sim=0'}`;
  st.link = openLink(relay, { room: roomCode, role: 'camera', name: $('name').value, id: st.id });
  st.link.on('status', ({ status }) => setStatus(status));
  st.link.on('welcome', (m) => {
    setMap(m.map);
    announce();
  });
  st.link.on('map', (m) => setMap(m.map));
  st.link.on('peer', (m) => m.joined && announce());
  st.link.on('welcome', (m) => (m.cameras || []).forEach(onRemoteDevice));
  st.link.on('camera', onRemoteDevice);
  st.link.on('pose', onRemotePose);
  st.link.on('cameraGone', (m) => st.remote.devices.delete(m.id));
  st.link.on('objects', onRemoteObjects);
}

// ------------------------------------------------------------------ other devices

function onRemoteDevice(info) {
  if (!info?.id || info.id === st.id) return;
  const d = st.remote.devices.get(info.id) || { index: st.remote.devices.size + 1 };
  d.info = { ...info, color: info.color || colorForIndex(d.index) };
  d.matrix = msgToPose(info.pose);
  d.lastSeen = performance.now();
  st.remote.devices.set(info.id, d);
}

/** Remembers where each headset was, for walk calibration. */
function recordHeadset(id, pose, ts) {
  if (!pose || !ts) return;
  let h = st.headsets.get(id);
  if (!h) st.headsets.set(id, (h = new PositionHistory(20000)));
  h.push(ts, pose.p);
}

function onRemotePose(m) {
  const d = st.remote.devices.get(m.id);
  if (d?.info.kind === 'headset' || !d) recordHeadset(m.id, m.pose, m.ts);
  if (!d) return;
  d.info.pose = m.pose;
  d.matrix = msgToPose(m.pose);
  d.lastSeen = performance.now();
}

function onRemoteObjects(msg) {
  if (msg.cam === st.id) return;
  if (!st.remote.devices.has(msg.cam)) onRemoteDevice({ id: msg.cam, name: msg.cam });
  const d = st.remote.devices.get(msg.cam);
  d.lastSeen = performance.now();
  const now = performance.now();
  for (const o of msg.objs || []) {
    st.remote.objects.set(`${msg.cam}:${o.id}`, { ...o, cam: msg.cam, color: d.info.color, from: d.info.name || 'another device', at: now });
  }
}

/** Other devices' objects that are still fresh and that this node isn't already seeing itself. */
function remoteObjects() {
  const now = performance.now();
  const out = [];
  for (const [k, o] of st.remote.objects) {
    if ((now - o.at) / 1000 > FADE_END_S) {
      st.remote.objects.delete(k);
      continue;
    }
    if ((now - o.at) / 1000 > 1) continue;
    const mine = st.lastTracked.some((m) => m.label === o.label && Math.hypot(m.p[0] - o.p[0], m.p[2] - o.p[2]) < 0.7);
    if (!mine) out.push(o);
  }
  return out;
}

const minimap = new Minimap($('minimap'), { follow: false, range: 3, title: 'Shared map' });

function drawMinimap() {
  const canvas = $('minimap');
  canvas.hidden = !st.running || !$('show-map').checked;
  if (canvas.hidden) return;
  const css = canvas.getBoundingClientRect().width || 200;
  const px = Math.round(css * Math.min(devicePixelRatio, 2));
  if (canvas.width !== px) canvas.width = canvas.height = px;
  const now = performance.now();
  const self = st.pose ? { ...floorPose(st.pose), kind: 'camera', color, name: 'You', fovH: Number($('fov').value) } : null;
  const devices = [];
  for (const d of st.remote.devices.values()) {
    if (!d.matrix) continue;
    devices.push({ ...floorPose(d.matrix), id: d.info.id, color: d.info.color, name: d.info.name, kind: d.info.kind === 'headset' ? 'headset' : 'camera', fovH: d.info.fovH, stale: (now - d.lastSeen) / 1000 > 6 });
  }
  const objects = [
    ...st.lastTracked.map((o) => ({ p: [o.p[0], o.p[2]], label: o.label, color, mine: true })),
    ...remoteObjects().map((o) => ({ p: [o.p[0], o.p[2]], label: o.label, color: o.color, mine: false })),
  ];
  minimap.draw({ self, devices, objects, recording: st.running });
}
setInterval(drawMinimap, 100);
$('show-map').onchange = () => {
  safeSet('seethrough.nodeMap', $('show-map').checked ? 'on' : 'off');
  drawMinimap();
};
$('show-map').checked = safeGet('seethrough.nodeMap') !== 'off';
$('show-remote').checked = safeGet('seethrough.nodeRemote') !== 'off';
$('show-remote').onchange = () => safeSet('seethrough.nodeRemote', $('show-remote').checked ? 'on' : 'off');

function setStatus(status) {
  $('status-pill').className = `pill ${status === 'open' ? 'ok' : status === 'connecting' ? 'warn' : 'bad'}`;
  $('status-text').textContent = status === 'open' ? `room ${$('room').value}` : status === 'closed' ? 'not connected' : status;
}

function setMap(map) {
  st.map = map && map.worldId ? map : null;
  // The headset started a new map: this camera's old calibration no longer applies.
  if (st.calib && st.map && st.calib.worldId !== st.map.worldId) {
    st.pose = null;
    renderCalib('The headset started a new map. Calibrate this camera again.');
    announce();
  } else if (st.calib && !st.pose) applyCalibration();
}

function announce() {
  if (!st.link || !st.running) return;
  st.link.send({
    t: 'camera',
    id: st.id,
    name: $('name').value || 'Camera',
    color,
    kind: st.source?.kind === 'synthetic' ? 'synthetic' : 'browser',
    pose: st.pose ? poseToMsg(st.pose) : null,
    fovH: Number($('fov').value),
    aspect: st.source ? st.source.width / st.source.height : 16 / 9,
    active: true,
  });
}
setInterval(announce, 4000);

// ------------------------------------------------------------------ calibration
//
// No markers: the camera watches the headset wearer walk around in front of it. The
// headset reports where its wearer's head is; the camera sees the wearer's head and
// feet in its picture at the same moments; together they give the camera's pose.

const calibKey = () => `seethrough.calib.${$('room').value}.${st.id}`;

function updateIntrinsics() {
  if (!st.source) return;
  st.K = intrinsicsFromFov(st.source.width, st.source.height, Number($('fov').value));
}

$('fov').onchange = () => {
  safeSet('seethrough.nodeFov', $('fov').value);
  updateIntrinsics();
};

function loadCalibration() {
  const saved = safeGetJSON(calibKey());
  if (saved?.pose && st.source && saved.width === st.source.width && saved.height === st.source.height) {
    st.calib = saved;
    applyCalibration();
    if (st.pose) toast('Loaded saved calibration. If this camera has moved, calibrate again.');
  } else {
    renderCalib();
  }
}

function applyCalibration() {
  const c = st.calib;
  if (!c) return;
  if (st.map && c.worldId !== st.map.worldId) {
    st.pose = null;
    renderCalib('This calibration belongs to an older map. Calibrate again.');
    return;
  }
  st.pose = msgToPose(c.pose);
  if (c.fovH) {
    $('fov').value = c.fovH.toFixed(1);
    safeSet('seethrough.nodeFov', $('fov').value);
    updateIntrinsics();
  }
  renderCalib();
  announce();
}

function renderCalib(problem) {
  const el = $('calib-state');
  const c = st.calib;
  $('clear-calib').hidden = !c;
  if (problem) {
    el.className = 'calib-state warn';
    el.textContent = problem;
    return;
  }
  if (!c || !st.pose) {
    el.className = 'calib-state warn';
    el.textContent = 'Not calibrated: objects are detected but not shared.';
    return;
  }
  const p = new THREE.Vector3().setFromMatrixPosition(st.pose);
  el.className = 'calib-state ok';
  el.textContent = `Calibrated: camera at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) m on the headset's map, field of view ${c.fovH.toFixed(1)}°, fit ${c.error.toFixed(1)} px.`;
}

$('clear-calib').onclick = () => {
  st.calib = null;
  st.pose = null;
  safeSetJSON(calibKey(), null);
  renderCalib();
  announce();
};

/** The headset whose position to calibrate against: one that reported recently. */
function activeHeadset() {
  const now = st.link?.now() ?? Date.now();
  let best = null;
  for (const [id, h] of st.headsets) {
    const last = h.items[h.items.length - 1];
    if (last && now - last.ts < 1500 && (!best || last.ts > best.ts)) best = { id, ts: last.ts, history: h };
  }
  return best;
}

$('calibrate').onclick = () => {
  if (st.collecting) {
    stopCollecting('Calibration cancelled.');
    return;
  }
  updateIntrinsics();
  if (st.source.kind !== 'synthetic') {
    if (!st.map) {
      renderCalib('No map yet. Put on the headset and press Enter AR: the headset becomes the map. Then calibrate here.');
      return;
    }
    if (!activeHeadset()) {
      renderCalib("Can't see the headset's position. Put it on, make sure it's in AR and on the map (its panel says so), then try again.");
      return;
    }
  }
  st.collecting = new WalkCalibrator(st.K);
  $('calibrate').textContent = 'Cancel';
  $('calib-progress').style.width = '0%';
  renderCalib('Calibrating: walk slowly around in front of this camera wearing the headset, crossing the picture from side to side. Only you should be in view.');
};

function stopCollecting(message) {
  st.collecting = null;
  $('calibrate').textContent = 'Calibrate';
  if (message) renderCalib(message);
}

/** One frame of walk calibration: the only person in view, paired with the headset's position then. */
function collectCalibration(dets, ts) {
  const cal = st.collecting;
  const people = dets.filter((d) => d.label === 'person' && d.score >= 0.5);
  let head = null;
  if (st.source.kind === 'synthetic') head = st.source.synthetic.headAt(ts);
  else head = activeHeadset()?.history.at(ts);
  if (people.length === 1 && head) cal.add(people[0].bbox, head);
  const prog = cal.progress();
  $('calib-progress').style.width = `${Math.round(prog.fraction * 100)}%`;
  if (people.length > 1) renderCalib('More than one person in view: only the headset wearer should be in the picture.');
  else if (!head) renderCalib("Waiting for the headset's position… make sure it's in AR and on the map.");
  else renderCalib(`Calibrating… ${Math.round(prog.fraction * 100)}%. ${prog.hint}`);
  if (prog.timedOut) {
    stopCollecting('Calibration timed out. Walk around more, across the whole picture, and make sure the camera sees your head and feet.');
    return;
  }
  if (!prog.ready || cal.frames % 10 !== 0) return;
  const res = cal.solve();
  if (!res?.ok) {
    if (cal.frames > cal.minFrames * 3) stopCollecting(`Couldn't get a good fit (${res ? `${res.error.toFixed(0)} px` : 'no solution'}). Check that only you are in view and that the camera stays still, then try again.`);
    return;
  }
  st.calib = {
    worldId: st.map?.worldId ?? 'synthetic',
    pose: poseToMsg(res.worldFromCam),
    fovH: res.fovH,
    width: st.source.width,
    height: st.source.height,
    error: res.error,
    at: Date.now(),
  };
  safeSetJSON(calibKey(), st.calib);
  stopCollecting();
  applyCalibration();
  toast(`Calibrated from ${cal.frames} frames of you walking (fit ${res.error.toFixed(1)} px).`);
}

// ------------------------------------------------------------------ main loop

let lastSend = 0;
let lastThumb = 0;
let lastFrame = performance.now();

async function loop() {
  if (!st.running) return;
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (st.source.kind === 'synthetic') st.source.synthetic.render(dt);

  if (!st.busy) {
    st.busy = true;
    detectObjects()
      .catch((e) => console.warn(e))
      .finally(() => (st.busy = false));
  }

  if (st.pendingObjs && now - lastSend > 1000 / SEND_HZ && st.link) {
    lastSend = now;
    st.link.send({ t: 'objects', cam: st.id, ts: st.link.now(), objs: st.pendingObjs });
    st.pendingObjs = null;
    st.counters.sent++;
  }
  if ($('thumbs').checked && now - lastThumb > 2000 && st.link) {
    lastThumb = now;
    sendThumb();
  }
  drawOverlay();
  requestAnimationFrame(loop);
}

async function detectObjects() {
  let dets;
  // When the frame was taken, on the relay clock: matched to the headset's position for calibration.
  const ts = st.link ? st.link.now() : Date.now();
  if (st.source.kind === 'synthetic') dets = st.source.synthetic.detect();
  else if (st.detector?.model) dets = await st.detector.detect(st.source.el, 20, Number($('minconf').value));
  else return;
  st.counters.det++;
  st.lastDets = dets;
  if (st.collecting) collectCalibration(dets, ts);
  if (!st.pose || !st.K) {
    st.lastTracked = [];
    return;
  }
  const objs3d = [];
  for (const d of dets) {
    const w = detectionToWorld(d.bbox, st.K, st.pose, d.label);
    d.world = w;
    if (w) objs3d.push({ label: d.label, p: w.p, s: w.s, c: d.score });
  }
  st.pendingObjs = st.tracker.update(objs3d);
  st.lastTracked = st.pendingObjs;
}

function sendThumb() {
  const c = document.createElement('canvas');
  c.width = 192;
  c.height = Math.round((192 * st.source.height) / st.source.width);
  c.getContext('2d').drawImage(st.source.el, 0, 0, c.width, c.height);
  st.link.send({ t: 'thumb', cam: st.id, img: c.toDataURL('image/jpeg', 0.55) });
}

function drawOverlay() {
  const ov = $('overlay');
  const g = ov.getContext('2d');
  g.clearRect(0, 0, ov.width, ov.height);
  const s = ov.width / 1280;
  g.lineWidth = Math.max(2, 3 * s);
  g.font = `600 ${Math.round(22 * Math.max(s, 0.6))}px system-ui, sans-serif`;
  for (const d of st.lastDets) {
    g.strokeStyle = color;
    g.strokeRect(d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h);
    const text = `${prettyLabel(d.label)} ${Math.round(d.score * 100)}%${d.world ? ` · ${d.world.dist.toFixed(1)} m` : ''}`;
    const tw = g.measureText(text).width + 12;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(d.bbox.x, d.bbox.y - 30 * Math.max(s, 0.6), tw, 28 * Math.max(s, 0.6));
    g.fillStyle = '#fff';
    g.fillText(text, d.bbox.x + 6, d.bbox.y - 9 * Math.max(s, 0.6));
  }
  // What the headset and the other phones detect, where it would be in this camera's picture.
  // Dashed, so it's clear this device didn't detect it itself (it may be behind a wall).
  if ($('show-remote').checked && st.pose && st.K) {
    const camFromWorld = st.pose.clone().invert();
    g.setLineDash([10 * Math.max(s, 0.6), 7 * Math.max(s, 0.6)]);
    for (const o of remoteObjects()) {
      const b = projectBox(o.p, o.s, st.K, st.pose, camFromWorld);
      if (!b) continue;
      g.strokeStyle = o.color;
      g.strokeRect(b.x, b.y, b.w, b.h);
      const text = `${prettyLabel(o.label)} · from ${o.from}`;
      const tw = g.measureText(text).width + 12;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(b.x, b.y + b.h, tw, 28 * Math.max(s, 0.6));
      g.fillStyle = o.color;
      g.fillText(text, b.x + 6, b.y + b.h + 20 * Math.max(s, 0.6));
    }
    g.setLineDash([]);
  }
}

setInterval(() => {
  $('st-fps').textContent = st.counters.det;
  $('st-sent').textContent = st.counters.sent;
  $('st-objs').textContent = st.lastDets.length;
  $('st-rtt').textContent = st.link?.rtt != null && st.link.status === 'open' ? Math.round(st.link.rtt) : '–';
  st.counters.det = 0;
  st.counters.sent = 0;
}, 1000);

let toastTimer;
function toast(text, ms = 4500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

addEventListener('pagehide', () => st.link?.send({ t: 'cameraGone', id: st.id }));

listSources();
renderCalib();
window.seethroughNode = st;
// Test hook: advance the synthetic scene one step.
st.debugStep = (dt = 1 / 30) => {
  st.source.synthetic?.render(dt);
};
