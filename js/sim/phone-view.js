// Simulator "phone view": what a simulated camera's node page would draw.
//
// A real phone shows its video with its own detections (solid boxes), what the other
// devices detect (dashed outlines, even behind walls) and the shared mini map in the
// top-left corner. The simulator has no video, so the picture is a sketch of the
// camera's room (floor grid and corners, drawn from the camera's true pose); the
// boxes and outlines use the camera's *calibrated* pose, exactly as a phone would,
// so calibration error shows up as outlines that sit slightly off.

import * as THREE from 'three';
import { projectBox, floorPose } from '../common/geometry.js';
import { Minimap } from '../common/minimap.js';
import { ROOMS, WALL_HEIGHT } from './world.js';
import { prettyLabel } from '../common/protocol.js';

export class PhoneView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = this.mapCanvas.height = 300;
    this.minimap = new Minimap(this.mapCanvas, { follow: false, range: 3, title: 'Shared map' });
  }

  /**
   * cam: a SimCamera. remote: [{p, s, label, color, from}] other devices' detections.
   * devices: [{p:[x,z], heading, color, name, kind, fovH}] the other devices.
   */
  draw(cam, { remote, devices }) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const k = W / cam.K.w; // canvas px per camera px
    g.save();
    g.fillStyle = '#10141c';
    g.fillRect(0, 0, W, H);
    g.scale(k, k);
    const lw = 1 / k;

    // A sketch of the room: 0.5 m floor grid and the vertical corners.
    const room = ROOMS.find((r) => r.id === cam.def.room);
    const seg = (a, b) => {
      const pa = cam.projectPoint(a);
      const pb = cam.projectPoint(b);
      if (!pa || !pb) return;
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.stroke();
    };
    g.strokeStyle = 'rgba(148, 170, 200, 0.22)';
    g.lineWidth = 1.5 * lw;
    const step = 0.25;
    for (let x = Math.ceil(room.x[0] * 2) / 2; x <= room.x[1]; x += 0.5) {
      for (let z = room.z[0]; z < room.z[1]; z += step) seg(vec(x, 0, z), vec(x, 0, Math.min(z + step, room.z[1])));
    }
    for (let z = Math.ceil(room.z[0] * 2) / 2; z <= room.z[1]; z += 0.5) {
      for (let x = room.x[0]; x < room.x[1]; x += step) seg(vec(x, 0, z), vec(Math.min(x + step, room.x[1]), 0, z));
    }
    g.strokeStyle = 'rgba(148, 170, 200, 0.45)';
    g.lineWidth = 2 * lw;
    for (const x of room.x) for (const z of room.z) {
      for (let y = 0; y < WALL_HEIGHT; y += step) seg(vec(x, y, z), vec(x, Math.min(y + step, WALL_HEIGHT), z));
    }

    const font = (px, weight = 600) => `${weight} ${px}px system-ui, sans-serif`;
    // Own detections: solid boxes, as the node draws them.
    g.lineWidth = 3;
    g.font = font(24);
    for (const d of cam.last2d || []) {
      g.strokeStyle = cam.color;
      g.strokeRect(d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h);
      label(g, `${prettyLabel(d.label)} ${Math.round(d.score * 100)}%`, d.bbox.x, d.bbox.y - 34, cam.color, '#fff');
    }

    // What the other devices detect: dashed, where it would be in this picture.
    const camFromWorld = cam.estPose.clone().invert();
    const own = cam.lastObjs || [];
    g.setLineDash([16, 11]);
    for (const o of remote) {
      if (own.some((m) => m.label === o.label && Math.hypot(m.p[0] - o.p[0], m.p[2] - o.p[2]) < 0.7)) continue;
      const b = projectBox(o.p, o.s, cam.estK, cam.estPose, camFromWorld);
      if (!b) continue;
      g.strokeStyle = o.color;
      g.strokeRect(b.x, b.y, b.w, b.h);
      // Label under the outline, or inside its top edge when the outline runs off the picture.
      const below = b.y + b.h + 34 <= cam.K.h;
      label(g, `${prettyLabel(o.label)} · from ${o.from}`, Math.max(0, b.x), below ? b.y + b.h + 4 : Math.max(0, b.y) + 4, 'rgba(0,0,0,0.65)', o.color);
    }
    g.setLineDash([]);
    g.restore();

    // The shared mini map, top left, as on the phone.
    const self = { ...floorPose(cam.estPose), kind: 'camera', color: cam.color, name: 'You', fovH: cam.estFov };
    const objects = [
      ...own.map((o) => ({ p: [o.p[0], o.p[2]], label: o.label, color: cam.color, mine: true })),
      ...remote
        .filter((o) => !own.some((m) => m.label === o.label && Math.hypot(m.p[0] - o.p[0], m.p[2] - o.p[2]) < 0.7))
        .map((o) => ({ p: [o.p[0], o.p[2]], label: o.label, color: o.color, mine: false })),
    ];
    this.minimap.draw({ self, devices, objects, recording: true });
    const ms = Math.round(H * 0.52);
    g.drawImage(this.mapCanvas, 8, 8, ms, ms);
  }
}

const vec = (x, y, z) => new THREE.Vector3(x, y, z);

function label(g, text, x, y, bg, fg) {
  const w = g.measureText(text).width + 14;
  g.fillStyle = bg;
  g.fillRect(x, y, w, 30);
  g.fillStyle = fg;
  g.fillText(text, x + 7, y + 22);
}
