// SeeThrough viewer: desktop 3D view + WebXR passthrough viewer for Quest.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { openLink } from '../common/transport.js';
import {
  qs, randomId, randomRoomCode, normalizeRoom, defaultRelayUrl, safeGet, safeSet, safeGetJSON, safeSetJSON,
  colorForIndex, prettyLabel, FADE_START_S, FADE_END_S,
} from '../common/protocol.js';
import { msgToPose } from '../common/geometry.js';
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
  latency: null,
  updates: 0,
  rate: 0,
  sim: null,
  camIndex: 0,
  id: safeGet('seethrough.viewerId') || randomId('v-'),
};
safeSet('seethrough.viewerId', state.id);
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
  });
  link.on('map', (m) => setMap(m.map));
  link.on('camera', onCamera);
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
  let c = state.cameras.get(msg.cam);
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
        { id: 'hide', label: 'Hide' },
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
    subtitle: `${status} · ${state.objects.size} objects · ${lat}`,
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
  } else {
    if (viewMode === 'walk') updateWalk(dt);
    else orbit.update();
    viewerWorld.copy(camera.position);
  }
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
connect();
if (qs('sim') === '1' || (!state.relay && qs('sim') !== '0')) {
  // With no relay the viewer has nothing to show, so run the simulator by default.
  startSim();
}

// Expose a little for debugging from the console.
window.seethrough = { state, aligner, scene, worldRoot };
