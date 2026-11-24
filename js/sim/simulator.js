// Simulator mode: fake camera nodes watching fake objects in a fake house.
//
// It is not a shortcut around the real pipeline. Each simulated camera:
//   1. "Calibrates" by projecting a real map marker into its image (with pixel
//      noise) and running the same marker-pose code a phone node runs.
//   2. Each frame, projects the true objects into its image to get 2D boxes,
//      adds noise and dropouts, and then converts those boxes back to 3D with the
//      same floor-projection code, using its *estimated* pose.
//   3. Tracks and publishes objects over the link, at ~12 Hz, like a real node.
// So what the viewer shows includes realistic calibration and projection error.

import * as THREE from 'three';
import { ROOMS, SIM_CAMERAS, SIM_MAP, SIM_OBJECTS, roomAt } from './world.js';
import {
  intrinsicsFromFov,
  poseFromMarker,
  markerWorldMatrix,
  markerObjectPoints,
  cameraWorldFromMarker,
  averageCorners,
  detectionToWorld,
  poseToMsg,
  verticalFov,
} from '../common/geometry.js';
import { Tracker } from '../common/tracker.js';
import { SEND_HZ, colorForIndex } from '../common/protocol.js';

function gauss() {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class Mover {
  constructor(def, i) {
    this.label = def.label;
    this.size = def.size;
    this.speed = def.speed;
    this.path = def.path;
    this.seg = 0;
    this.t = (i * 0.37) % 1;
    this.pos = new THREE.Vector3(def.path[0][0], def.size[1] / 2, def.path[0][1]);
  }
  step(dt) {
    if (this.path.length < 2 || !this.speed) return;
    let remaining = this.speed * dt;
    while (remaining > 0) {
      const a = this.path[this.seg];
      const b = this.path[(this.seg + 1) % this.path.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const left = (1 - this.t) * len;
      if (remaining < left) {
        this.t += remaining / len;
        remaining = 0;
      } else {
        remaining -= left;
        this.t = 0;
        this.seg = (this.seg + 1) % this.path.length;
      }
    }
    const a = this.path[this.seg];
    const b = this.path[(this.seg + 1) % this.path.length];
    this.pos.set(a[0] + (b[0] - a[0]) * this.t, this.size[1] / 2, a[1] + (b[1] - a[1]) * this.t);
  }
}

class SimCamera {
  constructor(def, index, link, map) {
    this.def = def;
    this.id = def.id;
    this.color = colorForIndex(index);
    this.link = link;
    this.K = intrinsicsFromFov(def.w, def.h, def.fov);
    this.cam = new THREE.PerspectiveCamera(verticalFov(this.K), def.w / def.h, 0.05, 60);
    this.cam.position.set(...def.pos);
    this.cam.lookAt(...def.target);
    this.cam.updateMatrixWorld(true);
    this.tracker = new Tracker({ prefix: `${def.id}-` });
    this.calibrate(map);
  }

  /** Estimates this camera's world pose from noisy views of a marker. */
  calibrate(map) {
    const markers = map?.markers || {};
    let best = null;
    for (const [id, m] of Object.entries(markers)) {
      const corners = this.projectMarker(m);
      if (!corners) continue;
      const area = Math.abs(
        (corners[1].x - corners[0].x) * (corners[3].y - corners[0].y) - (corners[3].x - corners[0].x) * (corners[1].y - corners[0].y)
      );
      if (area > 200 && (!best || area > best.area)) best = { id, m, area };
    }
    this.calibratedWith = null;
    if (best) {
      // Same procedure as a real node: average 30 noisy corner detections, then solve.
      const frames = [];
      for (let i = 0; i < 30; i++) {
        frames.push(this.projectMarker(best.m).map((c) => ({ x: c.x + gauss() * 0.5, y: c.y + gauss() * 0.5 })));
      }
      const pose = poseFromMarker(averageCorners(frames), best.m.size, this.K);
      if (pose) {
        this.estPose = cameraWorldFromMarker(markerWorldMatrix(best.m), pose.glCamFromMarker);
        this.calibratedWith = best.id;
      }
    }
    if (!this.estPose) {
      // No marker in view: pretend the camera was linked through setup mode, with a
      // little error, so the demo still runs.
      const noisy = this.cam.matrixWorld.clone();
      noisy.multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(0.6)));
      noisy.setPosition(new THREE.Vector3().setFromMatrixPosition(noisy).add(new THREE.Vector3(0.03, -0.02, 0.04)));
      this.estPose = noisy;
    }
    const truePos = new THREE.Vector3().setFromMatrixPosition(this.cam.matrixWorld);
    const estPos = new THREE.Vector3().setFromMatrixPosition(this.estPose);
    this.calibError = truePos.distanceTo(estPos);
  }

  projectMarker(m) {
    const W = markerWorldMatrix(m);
    const camPos = new THREE.Vector3().setFromMatrixPosition(this.cam.matrixWorld);
    const markerPos = new THREE.Vector3().setFromMatrixPosition(W);
    const normal = new THREE.Vector3().setFromMatrixColumn(W, 2);
    if (normal.dot(camPos.clone().sub(markerPos)) <= 0) return null; // seen from behind
    const out = [];
    for (const [x, y] of markerObjectPoints(m.size)) {
      const p = this.projectPoint(new THREE.Vector3(x, y, 0).applyMatrix4(W));
      if (!p || p.x < 0 || p.y < 0 || p.x > this.K.w || p.y > this.K.h) return null;
      out.push(p);
    }
    return out;
  }

  projectPoint(world) {
    const v = world.clone().applyMatrix4(this.cam.matrixWorldInverse);
    if (v.z > -0.05) return null;
    return { x: this.K.cx + (this.K.f * v.x) / -v.z, y: this.K.cy - (this.K.f * v.y) / -v.z };
  }

  /** 2D detections this camera would produce for the current true object positions. */
  detect(movers) {
    const dets = [];
    for (const o of movers) {
      const r = roomAt(o.pos.x, o.pos.z);
      if (!r || r.id !== this.def.room) continue;
      if (Math.random() < 0.04) continue; // missed detection
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let ok = true;
      for (const dx of [-0.5, 0.5])
        for (const dy of [-0.5, 0.5])
          for (const dz of [-0.5, 0.5]) {
            const p = this.projectPoint(
              new THREE.Vector3(o.pos.x + dx * o.size[0], o.pos.y + dy * o.size[1], o.pos.z + dz * o.size[2])
            );
            if (!p) {
              ok = false;
              continue;
            }
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
          }
      if (!ok) continue;
      // Require the bottom of the object to be in frame, as a real detector would
      // need for floor projection.
      if (maxX < 0 || minX > this.K.w || minY > this.K.h || maxY < 0 || maxY > this.K.h + 2) continue;
      minX = Math.max(0, minX);
      maxX = Math.min(this.K.w, maxX);
      minY = Math.max(0, minY);
      const n = 3; // px of box-edge jitter at 720p, typical for a small detector
      dets.push({
        label: o.label,
        bbox: { x: minX + gauss() * n, y: minY + gauss() * n, w: maxX - minX + gauss() * n, h: maxY - minY + gauss() * n },
        score: Math.min(0.99, 0.72 + Math.random() * 0.25),
      });
    }
    return dets;
  }

  tick(movers, now) {
    const dets2d = this.detect(movers);
    this.last2d = dets2d;
    const dets3d = [];
    for (const d of dets2d) {
      const w = detectionToWorld(d.bbox, this.K, this.estPose, d.label);
      if (w) dets3d.push({ label: d.label, p: w.p, s: w.s, c: d.score });
    }
    const objs = this.tracker.update(dets3d, now);
    this.link.send({ t: 'objects', cam: this.id, ts: this.link.now(), objs });
  }

  announce() {
    this.link.send({
      t: 'camera',
      id: this.id,
      name: this.def.name,
      color: this.color,
      kind: 'simulated',
      pose: poseToMsg(this.estPose),
      fovH: this.def.fov,
      aspect: this.def.w / this.def.h,
      calibratedWith: this.calibratedWith,
      active: true,
    });
  }

  thumbnail() {
    const c = document.createElement('canvas');
    c.width = 192;
    c.height = 108;
    const g = c.getContext('2d');
    const sx = c.width / this.K.w;
    g.fillStyle = '#10141c';
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#2a3242';
    for (let i = 1; i < 6; i++) {
      g.beginPath();
      g.moveTo(0, c.height * (0.55 + i * 0.09));
      g.lineTo(c.width, c.height * (0.55 + i * 0.09));
      g.stroke();
    }
    g.font = '9px system-ui, sans-serif';
    for (const d of this.last2d || []) {
      g.strokeStyle = this.color;
      g.strokeRect(d.bbox.x * sx, d.bbox.y * sx, d.bbox.w * sx, d.bbox.h * sx);
      g.fillStyle = this.color;
      g.fillText(d.label, d.bbox.x * sx + 2, d.bbox.y * sx + 9);
    }
    g.fillStyle = '#ff3b3b';
    g.beginPath();
    g.arc(8, 8, 3.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText('SIM', 14, 11);
    this.link.send({ t: 'thumb', cam: this.id, img: c.toDataURL('image/jpeg', 0.6) });
  }
}

export class Simulator {
  constructor(link, { publishMap = true } = {}) {
    this.link = link;
    this.publishMap = publishMap;
    this.movers = SIM_OBJECTS.map((d, i) => new Mover(d, i));
    this.cameras = [];
    this.running = false;
    this.rooms = ROOMS;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // The simulated house always uses its own marker map, so the fake cameras line up
    // with the fake walls. A real headset joining the room aligns to marker 0.
    if (this.publishMap) this.link.send({ t: 'map', map: SIM_MAP });
    this.cameras = SIM_CAMERAS.map((d, i) => new SimCamera(d, i, this.link, SIM_MAP));
    for (const c of this.cameras) c.announce();
    this._offPeer = this.link.on('peer', (m) => {
      if (m.joined) {
        if (this.publishMap) this.link.send({ t: 'map', map: SIM_MAP });
        for (const c of this.cameras) c.announce();
      }
    });
    let last = performance.now();
    this._physics = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      for (const m of this.movers) m.step(dt);
    }, 1000 / 60);
    this._send = setInterval(() => {
      const now = performance.now();
      for (const c of this.cameras) c.tick(this.movers, now);
    }, 1000 / SEND_HZ);
    this._announce = setInterval(() => {
      for (const c of this.cameras) c.announce();
    }, 4000);
    this._thumbs = setInterval(() => {
      for (const c of this.cameras) c.thumbnail();
    }, 1500);
  }

  stop() {
    this.running = false;
    clearInterval(this._physics);
    clearInterval(this._send);
    clearInterval(this._announce);
    clearInterval(this._thumbs);
    if (this._offPeer) this._offPeer();
    for (const c of this.cameras) this.link.send({ t: 'cameraGone', id: c.id });
  }

  /** Calibration error per camera, for display. */
  stats() {
    return this.cameras.map((c) => ({ id: c.id, name: c.def.name, calibratedWith: c.calibratedWith, errorM: c.calibError }));
  }

  /** True object positions (ground truth), for the desktop view's debug overlay. */
  truth() {
    return this.movers.map((m) => ({ label: m.label, p: m.pos.toArray(), s: m.size }));
  }
}
