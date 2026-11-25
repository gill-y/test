// Helper geometry for the viewer: camera frustums, ground-truth outlines and the
// simulated house (walls + floors) for desktop simulator mode.

import * as THREE from 'three';
import { LabelSprite } from './xray.js';

export class CameraVisuals {
  constructor() {
    this.group = new THREE.Group();
    this.items = new Map();
  }

  upsert(cam, matrix) {
    let it = this.items.get(cam.id);
    if (!it) {
      it = { group: new THREE.Group(), color: null };
      it.group.matrixAutoUpdate = false;
      this.group.add(it.group);
      this.items.set(cam.id, it);
    }
    const key = `${cam.color}|${cam.fovH}|${cam.aspect}|${cam.name}|${cam.kind}`;
    if (it.key !== key) {
      it.key = key;
      it.group.clear();
      const fov = THREE.MathUtils.degToRad(cam.fovH || 65);
      const aspect = cam.aspect || 16 / 9;
      // A headset is drawn smaller than a camera: it walks right up to you.
      const small = cam.kind === 'headset';
      const d = small ? 0.18 : 0.35;
      const hw = Math.tan(fov / 2) * d;
      const hh = hw / aspect;
      const o = new THREE.Vector3();
      const c = [
        new THREE.Vector3(-hw, hh, -d),
        new THREE.Vector3(hw, hh, -d),
        new THREE.Vector3(hw, -hh, -d),
        new THREE.Vector3(-hw, -hh, -d),
      ];
      const pts = [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]];
      const lines = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: cam.color, depthTest: false, transparent: true, opacity: 0.85 })
      );
      // Small "up" tick so the camera's roll is readable.
      const up = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-hw * 0.3, hh, -d), new THREE.Vector3(0, hh * 1.4, -d), new THREE.Vector3(0, hh * 1.4, -d), new THREE.Vector3(hw * 0.3, hh, -d)]),
        lines.material
      );
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.06, 0.06),
        new THREE.MeshBasicMaterial({ color: cam.color, transparent: true, opacity: 0.7, depthTest: false })
      );
      body.position.z = 0.03;
      const label = new LabelSprite(cam.color);
      label.setText(`● ${cam.name || cam.id}`);
      const ls = small ? 0.05 : 0.1;
      label.sprite.scale.set(ls * label.aspect, ls, 1);
      label.sprite.position.set(0, small ? 0.1 : 0.16, 0);
      it.label = label;
      it.group.add(lines, up, body, label.sprite);
      it.group.traverse((x) => (x.renderOrder = 950));
    }
    if (matrix) it.group.matrix.copy(matrix);
    it.group.visible = !!matrix;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    this.group.remove(it.group);
    this.items.delete(id);
  }
}

/** Walls and floors of the simulated house, for desktop simulator mode only. */
export function buildSimHouse({ ROOMS, WALLS, WALL_HEIGHT }) {
  const g = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: '#c9ccd3', roughness: 0.9, metalness: 0 });
  for (const [x0, x1, z0, z1] of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, WALL_HEIGHT, z1 - z0), wallMat);
    m.position.set((x0 + x1) / 2, WALL_HEIGHT / 2, (z0 + z1) / 2);
    m.castShadow = false;
    g.add(m);
  }
  const floorColors = { A: '#3a3f4a', B: '#4a4236', C: '#38443f' };
  for (const r of ROOMS) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(r.x[1] - r.x[0], r.z[1] - r.z[0]),
      new THREE.MeshStandardMaterial({ color: floorColors[r.id] || '#3a3a3a', roughness: 1 })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set((r.x[0] + r.x[1]) / 2, 0.001, (r.z[0] + r.z[1]) / 2);
    g.add(m);
    const label = new LabelSprite('#6b7280');
    label.setText(r.name);
    label.sprite.material.depthTest = true;
    label.sprite.scale.set(0.14 * label.aspect, 0.14, 1);
    label.sprite.position.set((r.x[0] + r.x[1]) / 2, 2.4, (r.z[0] + r.z[1]) / 2);
    g.add(label.sprite);
  }
  // A couple of pieces of real furniture in the living room, so walk mode has depth cues.
  const furn = new THREE.MeshStandardMaterial({ color: '#59606e', roughness: 0.8 });
  const sofa = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.8, 0.9), furn);
  sofa.position.set(2.2, 0.4, 4.3);
  const table = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.45, 0.6), furn);
  table.position.set(2.2, 0.225, 3.0);
  g.add(sofa, table);
  return g;
}

/** Faint ground-truth boxes (simulator only) to compare against what the cameras report. */
export class TruthVisuals {
  constructor() {
    this.group = new THREE.Group();
    this.meshes = [];
    this.mat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthTest: false });
    this.geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  }
  update(list) {
    while (this.meshes.length < list.length) {
      const m = new THREE.LineSegments(this.geo, this.mat);
      m.renderOrder = 999;
      this.meshes.push(m);
      this.group.add(m);
    }
    this.meshes.forEach((m, i) => {
      const o = list[i];
      m.visible = !!o;
      if (o) {
        m.position.set(...o.p);
        m.scale.set(...o.s);
      }
    });
  }
}
