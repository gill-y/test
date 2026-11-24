// SeeThrough browser camera node.
//
//   camera -> on-device detection -> 3D positions in world coordinates -> relay
//
// Raw video stays on this device. Only object positions (and, if switched on, a
// small preview thumbnail) are sent.

import * as THREE from 'three';
import { openLink } from '../common/transport.js';
import {
  qs, randomId, randomRoomCode, normalizeRoom, defaultRelayUrl, safeGet, safeSet, safeGetJSON, safeSetJSON,
  SEND_HZ, MARKER_DICTIONARY, colorForIndex, prettyLabel,
} from '../common/protocol.js';
import {
  intrinsicsFromFov, poseFromMarker, markerWorldMatrix, cameraWorldFromMarker, detectionToWorld,
  poseToMsg, msgToPose, estimateFocal, fovFromFocal, averageCorners, markerPixelSize,
} from '../common/geometry.js';
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
  calib: null, // {markerId, corners, size, fov, width, height, pose(Matrix4)}
  K: null,
  pose: null, // Matrix4 world <- GL camera
  collecting: null,
  lastDets: [],
  lastMarkers: [],
  pendingObjs: null,
  counters: { det: 0, sent: 0 },
  wakeLock: null,
};
safeSet('seethrough.nodeId', st.id);

const room = normalizeRoom(qs('room') || safeGet('seethrough.room') || '') || randomRoomCode();
$('room').value = room;
$('relay').value = qs('relay') ?? defaultRelayUrl();
$('name').value = safeGet('seethrough.nodeName') || defaultName();
$('fov').value = safeGet('seethrough.nodeFov') || 65;
$('msize').value = safeGet('seethrough.markerSizeCm') || 15;
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
    const s = new SyntheticSource({ width: w, height: h, fov: Number($('fov').value), markerSize: Number($('msize').value) / 100, markerHeight: Number($('mheight').value) });
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
}

function setStatus(status) {
  $('status-pill').className = `pill ${status === 'open' ? 'ok' : status === 'connecting' ? 'warn' : 'bad'}`;
  $('status-text').textContent = status === 'open' ? `room ${$('room').value}` : status === 'closed' ? 'not connected' : status;
}

function setMap(map) {
  st.map = map;
  $('height-row').hidden = !!(map && map.markers && Object.keys(map.markers).length);
  // A recalibration elsewhere may have moved markers: recompute our pose from our
  // stored marker view so we stay consistent with the shared map.
  if (st.calib) recomputePose();
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
    calibratedWith: st.calib?.markerId ?? null,
    active: true,
  });
}
setInterval(announce, 4000);

// ------------------------------------------------------------------ calibration

const calibKey = () => `seethrough.calib.${$('room').value}.${st.id}`;

function updateIntrinsics() {
  if (!st.source) return;
  st.K = intrinsicsFromFov(st.source.width, st.source.height, Number($('fov').value));
}

$('fov').onchange = () => {
  safeSet('seethrough.nodeFov', $('fov').value);
  updateIntrinsics();
  if (st.calib) recomputePose();
};
$('msize').onchange = () => {
  safeSet('seethrough.markerSizeCm', $('msize').value);
  if (st.calib) recomputePose();
};

function loadCalibration() {
  const saved = safeGetJSON(calibKey());
  if (saved && st.source && saved.width === st.source.width && saved.height === st.source.height) {
    st.calib = saved;
    recomputePose();
    toast(`Loaded saved calibration (marker ${saved.markerId}). If this camera has moved, calibrate again.`);
  } else {
    renderCalib();
  }
}

/** Pose from the stored (averaged) marker view, the current FOV and the current map. */
function recomputePose() {
  const c = st.calib;
  if (!c || !st.K) return;
  const m = st.map?.markers?.[c.markerId];
  if (!m) {
    st.pose = null;
    renderCalib(`Marker ${c.markerId} isn't on this room's map. Calibrate again on a marker that is.`);
    announce();
    return;
  }
  const size = m.size || Number($('msize').value) / 100;
  const pose = poseFromMarker(c.corners, size, st.K);
  if (!pose) {
    st.pose = null;
    renderCalib('Could not compute a pose from the saved marker view.');
    return;
  }
  st.pose = cameraWorldFromMarker(markerWorldMatrix(m), pose.glCamFromMarker);
  c.error = pose.error;
  c.distance = pose.distance;
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
    el.textContent = 'Not calibrated: objects are detected but not sent.';
    return;
  }
  const p = new THREE.Vector3().setFromMatrixPosition(st.pose);
  const small = c.pixelSize < 60;
  el.className = `calib-state ${small ? 'warn' : 'ok'}`;
  el.textContent =
    `Calibrated on marker ${c.markerId}: ${c.distance.toFixed(2)} m away, camera at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) m.` +
    (small ? ` The marker was only ${Math.round(c.pixelSize)} px wide; print it larger or move closer for better accuracy.` : '');
}

$('clear-calib').onclick = () => {
  st.calib = null;
  st.pose = null;
  safeSetJSON(calibKey(), null);
  renderCalib();
  announce();
};

$('calibrate').onclick = () => {
  st.collecting = { frames: [], focal: [], markerId: null, lastGood: performance.now() };
  $('calibrate').disabled = true;
  $('calib-progress').style.width = '0%';
  renderCalib('Hold still… looking for a marker.');
};

$('use-fov').onclick = () => {
  const f = Number($('use-fov').dataset.fov);
  if (!f) return;
  $('fov').value = f.toFixed(1);
  $('fov').onchange();
  $('use-fov').hidden = true;
  toast(`Field of view set to ${f.toFixed(1)}°.`);
};

const arDetector = new window.AR.Detector({ dictionaryName: MARKER_DICTIONARY, maxHammingDistance: 3 });
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true });

function detectMarkers() {
  const { width, height, el } = st.source;
  work.width = width;
  work.height = height;
  workCtx.drawImage(el, 0, 0, width, height);
  const image = workCtx.getImageData(0, 0, width, height);
  // Ignore tiny false positives from texture: a real marker spans at least ~16 px.
  const found = arDetector.detect(image).filter((m) => markerPixelSize(m.corners) > 16);

  // js-aruco2 finds the square outline of small markers (under ~60 px) but often
  // can't read their bits. Re-run on an upscaled crop around each unread outline
  // and map the corners back to full-image pixels.
  for (const cand of arDetector.candidates.slice(0, 8)) {
    const xs = cand.map((p) => p.x);
    const ys = cand.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (size < 16 || size > 140) continue;
    if (found.some((m) => Math.hypot(m.corners[0].x - cand[0].x, m.corners[0].y - cand[0].y) < size)) continue;
    const half = size * 0.9;
    const scale = Math.min(4, Math.max(1.5, 160 / size));
    const sx = Math.max(0, cx - half);
    const sy = Math.max(0, cy - half);
    const sw = Math.min(width - sx, half * 2);
    const sh = Math.min(height - sy, half * 2);
    zoom.width = Math.round(sw * scale);
    zoom.height = Math.round(sh * scale);
    zoomCtx.imageSmoothingEnabled = true;
    zoomCtx.drawImage(work, sx, sy, sw, sh, 0, 0, zoom.width, zoom.height);
    const sub = zoomDetector.detect(zoomCtx.getImageData(0, 0, zoom.width, zoom.height));
    for (const m of sub) {
      found.push({ id: m.id, corners: m.corners.map((p) => ({ x: sx + p.x / scale, y: sy + p.y / scale })) });
    }
  }
  return found;
}
const zoom = document.createElement('canvas');
const zoomCtx = zoom.getContext('2d', { willReadFrequently: true });
const zoomDetector = new window.AR.Detector({ dictionaryName: MARKER_DICTIONARY, maxHammingDistance: 3 });

function collectCalibration() {
  const col = st.collecting;
  const markers = detectMarkers();
  st.lastMarkers = markers;
  const known = st.map?.markers || {};
  const mapEmpty = !Object.keys(known).length;
  // Use the biggest marker that's on the map (or, with no map yet, the biggest marker).
  const usable = markers
    .filter((m) => mapEmpty || known[String(m.id)])
    .filter((m) => col.markerId === null || String(m.id) === col.markerId)
    .sort((a, b) => markerPixelSize(b.corners) - markerPixelSize(a.corners));
  const sinceGood = performance.now() - col.lastGood;
  if (!usable.length) {
    if (markers.length && !mapEmpty) {
      renderCalib(`Seeing marker ${markers.map((m) => m.id).join(', ')}, but it isn't on this room's map. Link it with the headset's "Map rooms" mode, or point at marker ${Object.keys(known).join(', ')}.`);
    }
    if (sinceGood > 15000) {
      st.collecting = null;
      $('calibrate').disabled = false;
      renderCalib(markers.length ? 'Calibration stopped: no usable marker.' : 'No marker found. Make sure a printed marker is in view and well lit.');
    }
    return;
  }
  const m = usable[0];
  col.lastGood = performance.now();
  col.markerId = String(m.id);
  col.frames.push(m.corners.map((c) => ({ x: c.x, y: c.y })));
  const f = estimateFocal(m.corners, 1, st.source.width / 2, st.source.height / 2);
  if (f) col.focal.push(f);
  $('calib-progress').style.width = `${(col.frames.length / 30) * 100}%`;
  renderCalib(`Calibrating on marker ${m.id}… ${col.frames.length}/30`);
  if (col.frames.length < 30) return;

  // Done: average the corners, then solve.
  st.collecting = null;
  $('calibrate').disabled = false;
  const corners = averageCorners(col.frames);
  const pixelSize = markerPixelSize(corners);
  // Reject a calibration where the camera moved during capture.
  const jitter = Math.max(...col.frames.map((fr) => Math.max(...fr.map((c, i) => Math.hypot(c.x - corners[i].x, c.y - corners[i].y)))));
  if (jitter > 6) {
    renderCalib(`The marker moved ${jitter.toFixed(0)} px during calibration. Keep the camera completely still and try again.`);
    return;
  }

  if (mapEmpty) {
    // First marker in this room: it becomes the anchor of a new map.
    const size = Number($('msize').value) / 100;
    const h = Number($('mheight').value);
    const map = { anchor: col.markerId, markers: { [col.markerId]: { p: [0, h, 0], yaw: 0, size } } };
    st.map = map;
    st.link?.send({ t: 'map', map });
    toast(`Created a new map with marker ${col.markerId} as the anchor.`);
  }

  st.calib = { markerId: col.markerId, corners, pixelSize, width: st.source.width, height: st.source.height, at: Date.now() };
  safeSetJSON(calibKey(), st.calib);
  recomputePose();

  // Offer a better FOV if the marker was seen at an angle and it disagrees with the setting.
  if (col.focal.length > 10) {
    const sorted = col.focal.sort((a, b) => a - b);
    const fMed = sorted[Math.floor(sorted.length / 2)];
    const fovEst = fovFromFocal(fMed, st.source.width);
    const spread = (sorted[Math.floor(sorted.length * 0.8)] - sorted[Math.floor(sorted.length * 0.2)]) / fMed;
    if (spread < 0.08 && Math.abs(fovEst - Number($('fov').value)) > 2 && fovEst > 30 && fovEst < 130) {
      $('use-fov').hidden = false;
      $('use-fov').dataset.fov = fovEst;
      $('use-fov').textContent = `Use estimated FOV (${fovEst.toFixed(1)}°)`;
    }
  }
}

// ------------------------------------------------------------------ main loop

let lastSend = 0;
let lastThumb = 0;
let lastFrame = performance.now();
let markerCheck = 0;

async function loop() {
  if (!st.running) return;
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (st.source.kind === 'synthetic') st.source.synthetic.render(dt);

  if (st.collecting) collectCalibration();
  else if (now - markerCheck > 2000) {
    // Occasional marker check, just to draw it on the preview.
    markerCheck = now;
    st.lastMarkers = detectMarkers();
  }

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
  if (st.source.kind === 'synthetic') dets = st.source.synthetic.detect();
  else if (st.detector?.model) dets = await st.detector.detect(st.source.el, 20, Number($('minconf').value));
  else return;
  st.counters.det++;
  st.lastDets = dets;
  if (!st.pose || !st.K) return;
  const objs3d = [];
  for (const d of dets) {
    const w = detectionToWorld(d.bbox, st.K, st.pose, d.label);
    d.world = w;
    if (w) objs3d.push({ label: d.label, p: w.p, s: w.s, c: d.score });
  }
  st.pendingObjs = st.tracker.update(objs3d);
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
  for (const m of st.lastMarkers) {
    g.strokeStyle = '#ffd23f';
    g.beginPath();
    m.corners.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
    g.closePath();
    g.stroke();
    g.fillStyle = '#ffd23f';
    g.fillText(`marker ${m.id}`, m.corners[0].x, m.corners[0].y - 8);
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
// Test hook: advance the synthetic scene one step and run calibration on it.
st.debugStep = (dt = 1 / 30) => {
  st.source.synthetic?.render(dt);
  if (st.collecting) collectCalibration();
};
