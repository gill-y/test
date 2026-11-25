// A synthetic video source for testing a camera node without a camera (?synthetic=1).
// It renders a room with a person walking, from a known camera pose. The person stands
// in for the headset wearer: headAt() reports where their headset would be, so walk
// calibration can run against the known answer. "Object detection" returns the person's
// true 2D box.

import * as THREE from 'three';
import { intrinsicsFromFov, verticalFov } from '../common/geometry.js';
import { HEAD_TOP_ABOVE_EYES } from '../common/walkcal.js';

export class SyntheticSource {
  constructor({ width = 1280, height = 720, fov = 65 } = {}) {
    this.width = width;
    this.height = height;
    this.K = intrinsicsFromFov(width, height, fov);
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(width, height, false);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#d9d4cc');
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#776655', 2.2));

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshLambertMaterial({ color: '#8a7f73' }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = 3;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), new THREE.MeshLambertMaterial({ color: '#efebe4' }));
    wall.position.set(0, 1.5, -0.001);
    this.scene.add(floor, wall);
    this.ready = Promise.resolve();

    this.person = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.25, 4, 12), new THREE.MeshLambertMaterial({ color: '#3b6ea8' }));
    this.personSize = [0.5, 1.7, 0.4];
    this.scene.add(this.person);

    this.camera = new THREE.PerspectiveCamera(verticalFov(this.K), width / height, 0.05, 50);
    this.camera.position.set(1.1, 1.9, 3.2);
    this.camera.lookAt(-0.2, 1.0, 0);
    this.camera.updateMatrixWorld(true);
    this.t = 0;
  }

  /** True camera pose, for comparing with the calibration result. */
  get trueCameraMatrix() {
    return this.camera.matrixWorld.clone();
  }

  render(dt) {
    this.t += dt;
    const x = Math.sin(this.t * 0.4) * 1.4 - 0.2;
    const z = 1.6 + Math.cos(this.t * 0.4) * 0.6;
    this.person.position.set(x, 0.85, z);
    this.renderer.render(this.scene, this.camera);
  }

  /** Ground-truth "detections" for the synthetic person. */
  detect() {
    const p = this.person.position;
    const s = this.personSize;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) for (const dz of [-0.5, 0.5]) {
      const v = new THREE.Vector3(p.x + dx * s[0], p.y + dy * s[1], p.z + dz * s[2]).project(this.camera);
      const u = (v.x * 0.5 + 0.5) * this.width;
      const w = (-v.y * 0.5 + 0.5) * this.height;
      minX = Math.min(minX, u); maxX = Math.max(maxX, u); minY = Math.min(minY, w); maxY = Math.max(maxY, w);
    }
    return [{ label: 'person', score: 0.9, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } }];
  }

  /** Where the walking person's headset (eyes) is: the top of their box minus the head-top offset. */
  headAt() {
    const p = this.person.position;
    return [p.x, this.personSize[1] - HEAD_TOP_ABOVE_EYES, p.z];
  }

  truth() {
    return { p: this.person.position.toArray(), s: this.personSize };
  }
}
