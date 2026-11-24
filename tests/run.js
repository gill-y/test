// Headless tests for the calibration and projection math (run: npm test).
// They use the same modules the browser loads, with three.js from node_modules.

import * as THREE from 'three';
import {
  intrinsicsFromFov, poseFromMarker, markerWorldMatrix, markerObjectPoints, cameraWorldFromMarker,
  detectionToWorld, estimateFocal, markerMatrixFromTwoPoints, markerFromMatrix, fovFromFocal,
  averageCorners, markerPixelSize,
} from '../js/common/geometry.js';
import { Aligner } from '../js/viewer/alignment.js';
import { Tracker } from '../js/common/tracker.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeCamera(pos, target, K) {
  const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(K.h / 2 / K.f)), K.w / K.h, 0.05, 100);
  cam.position.set(...pos);
  cam.lookAt(...target);
  cam.updateMatrixWorld(true);
  return cam;
}

function project(cam, K, world) {
  const v = world.clone().applyMatrix4(cam.matrixWorldInverse);
  return { x: K.cx + (K.f * v.x) / -v.z, y: K.cy - (K.f * v.y) / -v.z };
}

function markerCorners(cam, K, m) {
  const W = markerWorldMatrix(m);
  return markerObjectPoints(m.size).map(([x, y]) => project(cam, K, new THREE.Vector3(x, y, 0).applyMatrix4(W)));
}

// 1. Noise-free marker pose must recover the exact camera pose.
{
  const K = intrinsicsFromFov(1280, 720, 65);
  const m = { p: [0.4, 1.5, -0.12], yaw: Math.PI, size: 0.15 };
  for (const [pos, target] of [
    [[0.2, 1.8, -3], [0.4, 1.4, -0.12]],
    [[-1.5, 2.2, -4.5], [0.2, 1.0, -0.5]],
    [[1.6, 1.1, -1.4], [0.4, 1.5, -0.12]],
  ]) {
    const cam = makeCamera(pos, target, K);
    const pose = poseFromMarker(markerCorners(cam, K, m), m.size, K);
    const est = cameraWorldFromMarker(markerWorldMatrix(m), pose.glCamFromMarker);
    const dp = new THREE.Vector3().setFromMatrixPosition(est).distanceTo(cam.position);
    const da = THREE.MathUtils.radToDeg(new THREE.Quaternion().setFromRotationMatrix(est).angleTo(cam.quaternion));
    check(`exact marker pose from ${pos.join(',')}`, dp < 1e-3 && da < 0.05, `${(dp * 1000).toFixed(2)} mm, ${da.toFixed(3)}°, reproj ${pose.error.toFixed(4)} px`);
  }
}

// 2. Noisy corners averaged over 30 frames: error should be centimetres, not decimetres.
// Recommended setup: marker at least ~70 px wide in the image -> a few cm.
// Far setup: a 20 cm marker 4.9 m away is near the limit -> tens of cm (the node warns).
for (const [w, h, pos, limit] of [
  [1280, 720, [-1.3, 2.2, -2.6], 0.05],
  [1920, 1080, [-1.2, 2.3, -4.9], 0.3],
]) {
  const K = intrinsicsFromFov(w, h, 70);
  const m = { p: [-1.6, 1.5, -0.12], yaw: Math.PI, size: 0.2 };
  const cam = makeCamera(pos, [-1.8, 0.9, -1.0], K);
  const truth = markerCorners(cam, K, m);
  let worst = 0;
  for (let trial = 0; trial < 20; trial++) {
    const frames = [];
    for (let i = 0; i < 30; i++) frames.push(truth.map((p) => ({ x: p.x + gauss() * 0.5, y: p.y + gauss() * 0.5 })));
    const pose = poseFromMarker(averageCorners(frames), m.size, K);
    const est = cameraWorldFromMarker(markerWorldMatrix(m), pose.glCamFromMarker);
    worst = Math.max(worst, new THREE.Vector3().setFromMatrixPosition(est).distanceTo(cam.position));
  }
  const span = markerPixelSize(truth);
  const dist = new THREE.Vector3(...m.p).distanceTo(cam.position);
  check(`noisy marker ${dist.toFixed(1)} m away at ${h}p, 30 frames averaged`, worst < limit, `worst of 20 runs ${(worst * 100).toFixed(1)} cm, marker ${span.toFixed(0)} px wide`);
}

// 3. Floor projection: a box standing on the floor comes back at the right place.
{
  const K = intrinsicsFromFov(640, 480, 60);
  const cam = makeCamera([0, 2.2, 0], [0, 0.5, -4], K);
  const obj = new THREE.Vector3(0.6, 0.85, -3.5);
  const size = [0.5, 1.7, 0.4];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) for (const dz of [-0.5, 0.5]) {
    const p = project(cam, K, new THREE.Vector3(obj.x + dx * size[0], obj.y + dy * size[1], obj.z + dz * size[2]));
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const w = detectionToWorld({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, K, cam.matrixWorld, 'person');
  const err = Math.hypot(w.p[0] - obj.x, w.p[2] - obj.z);
  check('floor projection of a person', err < 0.25 && Math.abs(w.s[1] - 1.7) < 0.4, `ground error ${(err * 100).toFixed(1)} cm, height ${w.s[1].toFixed(2)} m`);
}

// 4. Focal length estimate from a tilted marker view.
{
  const K = intrinsicsFromFov(1280, 720, 67);
  const m = { p: [0, 1.5, 0], yaw: 0, size: 0.15 };
  const cam = makeCamera([1.0, 1.2, 1.2], [0, 1.5, 0], K);
  const f = estimateFocal(markerCorners(cam, K, m), m.size, K.cx, K.cy);
  check('focal length from one tilted view', f && Math.abs(f - K.f) / K.f < 0.01, `true ${K.f.toFixed(1)} px, est ${f?.toFixed(1)} px, fov ${f ? fovFromFocal(f, K.w).toFixed(1) : '?'}°`);
}

// 5. Two-touch marker pose + headset map building across rooms.
{
  const center = new THREE.Vector3(0.3, 1.45, -2);
  const right = new THREE.Vector3(0.45, 1.47, -2.005);
  const M = markerMatrixFromTwoPoints(center, right);
  const z = new THREE.Vector3().setFromMatrixColumn(M, 2);
  check('two-touch marker frame faces the user', z.z > 0.99, `z axis ${z.toArray().map((v) => v.toFixed(3))}`);

  // Simulated headset session whose tracking origin is arbitrary relative to the world.
  const trueWorld = { 0: { p: [0, 1.5, 0], yaw: 0 }, 1: { p: [-1.6, 1.5, -0.12], yaw: Math.PI }, 2: { p: [2.6, 1.4, -3.0], yaw: -Math.PI / 2 } };
  const xrFromWorldTrue = new THREE.Matrix4().makeRotationY(0.7).setPosition(1.2, 0, -0.4);
  const touch = (id) => {
    const W = xrFromWorldTrue.clone().multiply(markerWorldMatrix(trueWorld[id]));
    return [new THREE.Vector3(0, 0, 0).applyMatrix4(W), new THREE.Vector3(0.12, 0, 0).applyMatrix4(W)];
  };
  let map = null;
  const al = new Aligner({ getMap: () => map, publishMap: (m) => (map = m) });
  al.begin('map');
  for (const id of ['0', '1', '2']) {
    al.markerId = id;
    const [a, b] = touch(id);
    al.tap(a);
    al.tap(b);
  }
  const errs = ['1', '2'].map((id) => {
    const est = new THREE.Vector3(...map.markers[id].p);
    const tru = new THREE.Vector3(...trueWorld[id].p);
    return est.distanceTo(tru);
  });
  check('map mode links markers in three rooms', map && Object.keys(map.markers).length === 3 && Math.max(...errs) < 0.01, `errors ${errs.map((e) => (e * 1000).toFixed(1) + ' mm').join(', ')}`);

  // A second session with a different tracking origin aligns to marker 2 only.
  const xr2 = new THREE.Matrix4().makeRotationY(-1.1).setPosition(-3, 0, 2);
  const W2 = xr2.clone().multiply(markerWorldMatrix(trueWorld[2]));
  const al2 = new Aligner({ getMap: () => map, publishMap: () => {} });
  al2.begin('align');
  al2.markerId = '2';
  al2.tap(new THREE.Vector3(0, 0, 0).applyMatrix4(W2));
  al2.tap(new THREE.Vector3(0.12, 0, 0).applyMatrix4(W2));
  const p0 = new THREE.Vector3(0, 1.5, 0).applyMatrix4(al2.xrFromWorld);
  const p0true = new THREE.Vector3(0, 1.5, 0).applyMatrix4(xr2);
  check('later session aligns from any linked marker', p0.distanceTo(p0true) < 0.01, `${(p0.distanceTo(p0true) * 1000).toFixed(2)} mm`);

  const back = markerFromMatrix(markerWorldMatrix(trueWorld[2]), 0.15);
  check('marker pose round-trip', Math.abs(back.yaw - trueWorld[2].yaw) < 1e-6);
}

// 6. Tracker keeps IDs stable for a moving object.
{
  const tr = new Tracker();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const out = tr.update([{ label: 'person', p: [i * 0.08, 0.85, -2], s: [0.5, 1.7, 0.4], c: 0.9 }], i * 80);
    ids.push(out[0].id);
  }
  check('tracker keeps one id for a walking person', new Set(ids).size === 1, ids[0]);
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
