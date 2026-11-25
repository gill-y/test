// Headless tests for the calibration, projection and mini-map math (run: npm test).
// They use the same modules the browser loads, with three.js from node_modules.

import * as THREE from 'three';
import { intrinsicsFromFov, detectionToWorld, floorPose, headWorldPose, projectBox } from '../js/common/geometry.js';
import { worldToMap, computeView, headingFromForward } from '../js/common/minimap.js';
import { WalkCalibrator, Relocalizer, PositionHistory, HEAD_TOP_ABOVE_EYES } from '../js/common/walkcal.js';
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

// 1. Floor projection: a box standing on the floor comes back at the right place.
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

// 2. Tracker keeps IDs stable for a moving object.
{
  const tr = new Tracker();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const out = tr.update([{ label: 'person', p: [i * 0.08, 0.85, -2], s: [0.5, 1.7, 0.4], c: 0.9 }], i * 80);
    ids.push(out[0].id);
  }
  check('tracker keeps one id for a walking person', new Set(ids).size === 1, ids[0]);
}

// 3. Shared view: headset pose, mini map and projecting other devices' objects.
{
  // A headset aligned with some tracking offset, standing at (2, 1.6, 1) facing +X.
  const xrFromWorld = new THREE.Matrix4().makeRotationY(0.7).setPosition(1, 0, -3);
  const worldFromHeadTrue = new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(2, 1.6, 1);
  const xrFromHead = xrFromWorld.clone().multiply(worldFromHeadTrue);
  const head = headWorldPose(xrFromWorld, xrFromHead);
  const fp = floorPose(head);
  check('headset world pose from alignment', Math.hypot(fp.p[0] - 2, fp.p[1] - 1) < 1e-6 && Math.abs(fp.height - 1.6) < 1e-6 && Math.abs(fp.heading - Math.PI / 2) < 1e-6, `heading ${fp.heading.toFixed(3)}`);

  // Follow-mode map: the direction you face is up, and a point to your right is to the right.
  const view = computeView({ size: 200, follow: true, self: fp, points: [], range: 5 });
  const ahead = worldToMap(3, 1, view); // 1 m in front (+X)
  const right = worldToMap(2, 2, view); // facing +X, your right is +Z
  check('mini map: ahead is up, right is right', Math.abs(ahead.x - 100) < 1e-6 && ahead.y < 100 && Math.abs(right.y - 100) < 1e-6 && right.x > 100);
  check('heading convention', Math.abs(headingFromForward(0, -1)) < 1e-9 && Math.abs(headingFromForward(1, 0) - Math.PI / 2) < 1e-9);
  const fit = computeView({ size: 200, follow: false, self: null, points: [[-4, -2], [6, 3]], range: 3 });
  const a = worldToMap(-4, -2, fit);
  const b = worldToMap(6, 3, fit);
  check('mini map fit mode keeps every point on the map', [a, b].every((q) => q.x > 0 && q.x < 200 && q.y > 0 && q.y < 200));

  // A person the headset sees, projected into a phone's picture, matches a direct projection.
  const K = intrinsicsFromFov(1280, 720, 65);
  const cam = makeCamera([0, 2.2, 3], [0, 0.8, -1], K);
  const box = projectBox([0.3, 0.85, -0.5], [0.5, 1.7, 0.4], K, cam.matrixWorld);
  const top = project(cam, K, new THREE.Vector3(0.3, 1.7, -0.5));
  check('projects a shared object into a phone camera', !!box && top.y >= box.y - 1 && top.y <= box.y + box.h && top.x > box.x && top.x < box.x + box.w, box ? `${box.w.toFixed(0)}×${box.h.toFixed(0)} px` : 'null');
  check('ignores shared objects behind the phone', projectBox([0, 0.85, 6], [0.5, 1.7, 0.4], K, cam.matrixWorld) === null);
}

// 4. Marker-free calibration: a camera finds itself by watching the headset wearer walk.
{
  /** Person box as a detector would draw it, for a wearer whose eyes are at `head`. */
  function personBox(cam, K, head, noisePx) {
    const xs = [];
    const ys = [];
    for (const dx of [-0.25, 0.25]) for (const dz of [-0.18, 0.18]) for (const y of [0, head[1] + HEAD_TOP_ABOVE_EYES]) {
      const q = project(cam, K, new THREE.Vector3(head[0] + dx, y, head[2] + dz));
      xs.push(q.x);
      ys.push(q.y);
    }
    const top = project(cam, K, new THREE.Vector3(head[0], head[1] + HEAD_TOP_ABOVE_EYES, head[2]));
    const foot = project(cam, K, new THREE.Vector3(head[0], 0, head[2]));
    const x0 = Math.min(...xs) + gauss() * noisePx;
    const x1 = Math.max(...xs) + gauss() * noisePx;
    const y0 = top.y + gauss() * noisePx;
    const y1 = foot.y + gauss() * noisePx;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function walkCalibrate(camPos, target, fovTrue, fovGuess, noisePx, outliers = 0) {
    const Ktrue = intrinsicsFromFov(1280, 720, fovTrue);
    const cam = makeCamera(camPos, target, Ktrue);
    const cal = new WalkCalibrator(intrinsicsFromFov(1280, 720, fovGuess), { minSeconds: 0 });
    for (let i = 0; i < 200; i++) {
      const t = i / 200;
      // A wobbly loop in front of the camera, eye height 1.55-1.7 m.
      const head = [target[0] + Math.sin(t * 6.28) * 1.6, 1.62 + Math.sin(t * 40) * 0.04, target[2] + Math.cos(t * 6.28) * 1.1];
      const box = personBox(cam, Ktrue, head, noisePx);
      if (box.x < 0 || box.x + box.w > 1280) continue;
      // Headset tracking noise ~1 cm; some frames see someone else (outliers).
      const reported = Math.random() < outliers ? [head[0] + 2, head[1], head[2] - 1.5] : head.map((v) => v + gauss() * 0.01);
      cal.add(box, reported);
    }
    const prog = cal.progress();
    const res = cal.solve();
    const posErr = res ? new THREE.Vector3().setFromMatrixPosition(res.worldFromCam).distanceTo(cam.position) : Infinity;
    const fwdTrue = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
    const fwd = res ? new THREE.Vector3(0, 0, -1).transformDirection(res.worldFromCam) : new THREE.Vector3();
    const angErr = THREE.MathUtils.radToDeg(fwd.angleTo(fwdTrue));
    return { prog, res, posErr, angErr };
  }

  const a = walkCalibrate([1.5, 2.2, 3.5], [0, 0.8, -0.5], 65, 65, 4);
  check('walk calibration: camera pose from a 1-person walk', a.prog.ready && a.res?.ok && a.posErr < 0.12 && a.angErr < 2, `pos ${(a.posErr * 100).toFixed(1)} cm, angle ${a.angErr.toFixed(2)}°, median ${a.res?.error.toFixed(1)} px`);
  const b = walkCalibrate([-2, 2.4, 2], [0.5, 0.5, -1], 74, 65, 4);
  check('walk calibration: finds the field of view when the setting is wrong', b.res?.ok && Math.abs(b.res.fovH - 74) < 3 && b.posErr < 0.2, `fov ${b.res?.fovH.toFixed(1)}° (true 74, guess 65), pos ${(b.posErr * 100).toFixed(1)} cm`);
  const c = walkCalibrate([1.5, 2.2, 3.5], [0, 0.8, -0.5], 65, 65, 4, 0.2);
  check('walk calibration: ignores frames of someone else', c.res?.ok && c.posErr < 0.15, `20% wrong frames, pos ${(c.posErr * 100).toFixed(1)} cm`);

  // Re-finding the headset: its tracking space is rotated and shifted from the world.
  const worldFromTracking = new THREE.Matrix4().makeRotationY(2.1).setPosition(3, 0, -1.5);
  const reloc = new Relocalizer();
  for (let i = 0; i < 120; i++) {
    const ts = 1000 + i * 100;
    const world = new THREE.Vector3(Math.sin(i / 20) * 2, 1.65, Math.cos(i / 25) * 1.5);
    const own = world.clone().applyMatrix4(worldFromTracking.clone().invert());
    reloc.addOwn(ts, own.toArray());
    // The camera sees the wearer every third frame, with 20 cm of error, about 50 ms later.
    if (i % 3 === 0) reloc.addSighting(ts - 50, [world.x + gauss() * 0.15, 0.85, world.z + gauss() * 0.15]);
    if (i % 9 === 0) reloc.addSighting(ts, [world.x + 3, 0.85, world.z - 2]); // another person
  }
  const fitR = reloc.solve();
  const probe = new THREE.Vector3(1, 1.6, 1);
  const errR = fitR ? probe.clone().applyMatrix4(fitR.matrix).distanceTo(probe.clone().applyMatrix4(worldFromTracking)) : Infinity;
  check('headset re-finds itself from camera sightings', errR < 0.25, `${(errR * 100).toFixed(1)} cm, rms ${fitR?.rms.toFixed(2)} m`);

  const h = new PositionHistory();
  h.push(0, [0, 0, 0]);
  h.push(100, [1, 0, 0]);
  check('position history interpolates', Math.abs(h.at(25)[0] - 0.25) < 1e-9 && h.at(500) === null);
}

// 5. The simulator's cameras calibrate the same way, by watching a simulated wearer walk.
{
  const { Simulator } = await import('../js/sim/simulator.js');
  const link = { send: () => {}, on: () => () => {}, now: () => Date.now() };
  const sim = new Simulator(link);
  sim.start();
  sim.stop();
  const stats = sim.stats();
  check('simulated cameras calibrate by walk', stats.length === 3 && stats.every((c) => c.calibrated && c.errorM < 0.4), stats.map((c) => `${c.name} ${(c.errorM * 100).toFixed(0)} cm, ${c.fov.toFixed(0)}°`).join(' · '));
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
