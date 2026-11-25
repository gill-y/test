// Simulator mode: fake camera nodes watching fake objects in a fake house.
//
// It is not a shortcut around the real pipeline. Each simulated camera:
//   1. Calibrates the way a real phone does, with no markers: a simulated headset
//      wearer walks around its room, the camera sees noisy person boxes, the
//      "headset" reports its position, and the same WalkCalibrator solves the pose.
//   2. Each frame, projects the true objects into its image to get 2D boxes,
//      adds noise and dropouts, and then converts those boxes back to 3D with the
//      same floor-projection code, using its *estimated* pose.
//   3. Tracks and publishes objects over the link, at ~12 Hz, like a real node.
// So what the viewer shows includes realistic calibration and projection error.

import * as THREE from 'three';
import { ROOMS, SIM_CAMERAS, SIM_MAP, SIM_OBJECTS, roomAt } from './world.js';
import { intrinsicsFromFov, detectionToWorld, poseToMsg, verticalFov } from '../common/geometry.js';
import { WalkCalibrator, HEAD_TOP_ABOVE_EYES } from '../common/walkcal.js';
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
  constructor(def, index, link) {
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
    this.calibrate();
  }

  /**
   * Walk calibration, as on a real phone: a simulated headset wearer walks around this
   * camera's room; the camera sees noisy person boxes and the headset reports its
   * position (1 cm noise). The camera starts from a 65° FOV guess, like a phone.
   */
  calibrate() {
    const room = ROOMS.find((r) => r.id === this.def.room);
    const cal = new WalkCalibrator(intrinsicsFromFov(this.def.w, this.def.h, 65), { minSeconds: 0 });
    const eye = 1.6;
    // Start somewhere in the room that is in front of the camera and not right under it.
    let x = (room.x[0] + room.x[1]) / 2;
    let z = (room.z[0] + room.z[1]) / 2;
    for (let k = 0; k < 200; k++) {
      const tx = room.x[0] + 0.5 + Math.random() * (room.x[1] - room.x[0] - 1);
      const tz = room.z[0] + 0.5 + Math.random() * (room.z[1] - room.z[0] - 1);
      if (Math.hypot(tx - this.def.pos[0], tz - this.def.pos[2]) > 1.6 && this.personBox(tx, tz, eye, 0)) {
        x = tx;
        z = tz;
        break;
      }
    }
    let heading = Math.random() * Math.PI * 2;
    for (let i = 0; i < 3000 && !cal.progress().ready; i++) {
      // A meandering walk that stays 0.4 m away from the walls.
      heading += (Math.random() - 0.5) * 0.6;
      const nx = x + Math.sin(heading) * 0.08;
      const nz = z + Math.cos(heading) * 0.08;
      // Stay 0.4 m from the walls and, like a person walking in front of a camera, at least 1.3 m from it.
      const tooClose = Math.hypot(nx - this.def.pos[0], nz - this.def.pos[2]) < 1.3;
      if (tooClose || nx < room.x[0] + 0.4 || nx > room.x[1] - 0.4 || nz < room.z[0] + 0.4 || nz > room.z[1] - 0.4) {
        heading += Math.PI / 2;
        continue;
      }
      x = nx;
      z = nz;
      const bbox = this.personBox(x, z, eye, heading);
      if (bbox) cal.add(bbox, [x + gauss() * 0.01, eye + gauss() * 0.01, z + gauss() * 0.01]);
    }
    const res = cal.solve();
    this.calibFrames = cal.frames;
    this.calibrated = !!res?.ok;
    if (res?.ok) {
      this.estPose = res.worldFromCam;
      this.estFov = res.fovH;
      this.estK = intrinsicsFromFov(this.def.w, this.def.h, res.fovH);
    } else {
      // Couldn't calibrate (shouldn't happen): fall back to a slightly wrong pose so the demo still runs.
      const noisy = this.cam.matrixWorld.clone();
      noisy.multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(0.6)));
      noisy.setPosition(new THREE.Vector3().setFromMatrixPosition(noisy).add(new THREE.Vector3(0.03, -0.02, 0.04)));
      this.estPose = noisy;
      this.estFov = this.def.fov;
      this.estK = this.K;
      console.warn(`${this.def.name}: walk calibration failed`, res);
    }
    const truePos = new THREE.Vector3().setFromMatrixPosition(this.cam.matrixWorld);
    const estPos = new THREE.Vector3().setFromMatrixPosition(this.estPose);
    this.calibError = truePos.distanceTo(estPos);
  }

  /**
   * The box a person detector would draw around someone standing at (x, z) with their
   * eyes at `eye`, walking towards `heading`: a round head, shoulders and hips facing
   * the camera, and two feet a stride apart. Null when they're not fully in view.
   */
  personBox(x, z, eye, heading) {
    const camPos = this.def.pos;
    const toCam = new THREE.Vector3(camPos[0] - x, 0, camPos[2] - z).normalize();
    const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    const walk = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const headC = new THREE.Vector3(x, eye + HEAD_TOP_ABOVE_EYES - 0.1, z);
    const pts = [];
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      for (const el of [0, 0.7, 1.2, Math.PI / 2]) {
        pts.push(headC.clone().add(new THREE.Vector3(Math.cos(ang) * Math.cos(el) * 0.1, Math.sin(el) * 0.1, Math.sin(ang) * Math.cos(el) * 0.1)));
      }
    }
    for (const [h, half, depth] of [[eye - 0.2, 0.22, 0.12], [0.95, 0.18, 0.12], [0.5, 0.14, 0.1]]) {
      for (const sgn of [-1, 1]) for (const d of [-1, 1]) pts.push(new THREE.Vector3(x, h, z).addScaledVector(side, sgn * half).addScaledVector(toCam, d * depth));
    }
    for (const stride of [-0.18, 0.18]) for (const toe of [-0.12, 0.12]) for (const lat of [-0.06, 0.06]) {
      pts.push(new THREE.Vector3(x, 0, z).addScaledVector(walk, stride + toe).addScaledVector(side, lat));
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      const q = this.projectPoint(p);
      if (!q) return null;
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
    if (minX < 0 || maxX > this.K.w || minY < 0 || maxY > this.K.h) return null;
    const n = 3;
    return { x: minX + gauss() * n, y: minY + gauss() * n, w: maxX - minX + gauss() * n, h: maxY - minY + gauss() * n };
  }

  projectPoint(world) {
    const v = world.clone().applyMatrix4(this.cam.matrixWorldInverse);
    if (v.z > -0.05) return null;
    return { x: this.K.cx + (this.K.f * v.x) / -v.z, y: this.K.cy - (this.K.f * v.y) / -v.z };
  }

  /** 2D detections this camera would produce for the current true object positions. */
  detect(movers, missRate = 0.04) {
    const dets = [];
    for (const o of movers) {
      const r = roomAt(o.pos.x, o.pos.z);
      if (!r || r.id !== this.def.room) continue;
      if (Math.random() < missRate) continue; // missed detection
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
      const w = detectionToWorld(d.bbox, this.estK, this.estPose, d.label);
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
      fovH: this.estFov,
      aspect: this.def.w / this.def.h,
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
    // The simulated house is its own map (its frame is the "headset" frame).
    if (this.publishMap) this.link.send({ t: 'map', map: SIM_MAP });
    this.cameras = SIM_CAMERAS.map((d, i) => new SimCamera(d, i, this.link));
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
    return this.cameras.map((c) => ({ id: c.id, name: c.def.name, errorM: c.calibError, fov: c.estFov, calibrated: c.calibrated }));
  }

  /** True object positions (ground truth), for the desktop view's debug overlay. */
  truth() {
    return this.movers.map((m) => ({ label: m.label, p: m.pos.toArray(), s: m.size }));
  }
}
