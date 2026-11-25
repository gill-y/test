// Geometry shared by the browser camera node, the simulator and the viewer.
//
// Conventions
//   Image pixels:   OpenCV style, origin top-left, +x right, +y down.
//   CV camera:      +X right, +Y down, +Z forward (into the scene).
//   GL camera:      +X right, +Y up,   -Z forward (three.js camera convention).
//   World frame:    metres, +Y up, floor at y = 0: the headset's floor-level tracking
//                   space when it started the map (see protocol.js).

import * as THREE from 'three';

const CV_TO_GL = new THREE.Matrix4().makeScale(1, -1, -1);

// ------------------------------------------------------------------ intrinsics

/** Pinhole intrinsics from a horizontal field of view (square pixels, centred). */
export function intrinsicsFromFov(width, height, fovHdeg) {
  const f = width / 2 / Math.tan(THREE.MathUtils.degToRad(fovHdeg) / 2);
  return { f, cx: width / 2, cy: height / 2, w: width, h: height };
}

export function fovFromFocal(f, width) {
  return THREE.MathUtils.radToDeg(2 * Math.atan(width / 2 / f));
}

/** Vertical FOV (degrees) for a three.js PerspectiveCamera with these intrinsics. */
export function verticalFov(K) {
  return THREE.MathUtils.radToDeg(2 * Math.atan(K.h / 2 / K.f));
}

// ------------------------------------------------------------------ small linear algebra

function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting. A is n x n (array of rows).
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Rotation matrix from a rotation vector (axis * angle). */
function rodrigues(rv) {
  const th = Math.hypot(rv[0], rv[1], rv[2]);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = [rv[0] / th, rv[1] / th, rv[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

function rotToRodrigues(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  const th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // 180 degrees: take the axis from the largest diagonal entry.
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1)
    );
    const s = Math.sqrt(1 - q.w * q.w) || 1;
    return [(q.x / s) * th, (q.y / s) * th, (q.z / s) * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(R[2][1] - R[1][2]) * k, (R[0][2] - R[2][0]) * k, (R[1][0] - R[0][1]) * k];
}

// ------------------------------------------------------------------ pose messages

export function poseToMsg(M) {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  M.decompose(p, q, new THREE.Vector3());
  const r = (v) => Math.round(v * 10000) / 10000;
  return { p: [r(p.x), r(p.y), r(p.z)], q: [r(q.x), r(q.y), r(q.z), r(q.w)] };
}

export function msgToPose(pose) {
  if (!pose) return null;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pose.p),
    new THREE.Quaternion(...pose.q).normalize(),
    new THREE.Vector3(1, 1, 1)
  );
}

// ------------------------------------------------------------------ detections -> 3D

/** World-space ray through pixel (u, v) for a camera at worldFromCam (GL convention). */
export function pixelRay(u, v, K, worldFromCam) {
  const dirCam = new THREE.Vector3((u - K.cx) / K.f, -(v - K.cy) / K.f, -1).normalize();
  const origin = new THREE.Vector3().setFromMatrixPosition(worldFromCam);
  const dir = dirCam.transformDirection(worldFromCam);
  return { origin, dir };
}

// Rough real-world depths (front to back) for common COCO classes, used for the
// box depth when only a 2D detection is available.
const TYPICAL_DEPTH = {
  person: 0.4, dog: 0.7, cat: 0.45, chair: 0.55, couch: 0.9, bed: 2.0, 'dining table': 0.9,
  tv: 0.15, laptop: 0.3, bicycle: 1.6, 'potted plant': 0.4, backpack: 0.25, suitcase: 0.3,
};

/**
 * Converts a 2D detection into a 3D box in world space.
 *   bbox: {x, y, w, h} in pixels.
 *   depthMeters (optional): measured distance along the camera axis to the object
 *     (from a depth camera). Without it the bottom edge of the box is assumed to
 *     touch the floor (y = 0) and is projected onto the floor plane.
 * Returns {p:[x,y,z], s:[w,h,d], dist} (object centre, size, distance from camera) or null.
 */
export function detectionToWorld(bbox, K, worldFromCam, label, depthMeters = null) {
  const camInv = worldFromCam.clone().invert();
  let foot; // point on the floor under the object's centre
  let z; // depth along the camera axis
  if (depthMeters && depthMeters > 0) {
    const u = bbox.x + bbox.w / 2;
    const v = bbox.y + bbox.h / 2;
    const camPt = new THREE.Vector3(((u - K.cx) / K.f) * depthMeters, (-(v - K.cy) / K.f) * depthMeters, -depthMeters);
    const centre = camPt.applyMatrix4(worldFromCam);
    z = depthMeters;
    const w = (bbox.w * z) / K.f;
    const h = (bbox.h * z) / K.f;
    const d = TYPICAL_DEPTH[label] ?? Math.min(w, 1);
    return { p: [centre.x, centre.y, centre.z], s: [w, h, d], dist: centre.distanceTo(new THREE.Vector3().setFromMatrixPosition(worldFromCam)) };
  }
  const ray = pixelRay(bbox.x + bbox.w / 2, bbox.y + bbox.h, K, worldFromCam);
  if (ray.dir.y > -0.01) return null; // bottom edge is at or above the horizon: no floor hit
  const tHit = -ray.origin.y / ray.dir.y;
  if (tHit <= 0 || tHit > 50) return null;
  foot = ray.origin.clone().addScaledVector(ray.dir, tHit);
  z = -foot.clone().applyMatrix4(camInv).z;
  if (z <= 0.05) return null;
  const w = (bbox.w * z) / K.f;
  const h = (bbox.h * z) / K.f;
  const d = TYPICAL_DEPTH[label] ?? Math.min(w, 1);
  // The bottom-edge ray hits the floor at the object's front face; push the centre
  // back by half its depth, away from the camera, along the floor.
  const away = new THREE.Vector3(foot.x - ray.origin.x, 0, foot.z - ray.origin.z).normalize();
  const centre = foot.clone().addScaledVector(away, d / 2);
  centre.y = h / 2;
  return { p: [centre.x, centre.y, centre.z], s: [w, h, d], dist: centre.distanceTo(ray.origin) };
}

/**
 * Where a device is on the floor and which way it faces, from its pose
 * (world <- GL camera, looking down -Z). heading: 0 = facing -Z, clockwise from above.
 */
export function floorPose(worldFromCam) {
  const e = worldFromCam.elements;
  const fx = -e[8];
  const fz = -e[10];
  return { p: [e[12], e[14]], heading: Math.atan2(fx, -fz), height: e[13] };
}

/**
 * The headset's pose in the world frame.
 * xrFromWorld: the alignment (world -> headset tracking space).
 * xrFromHead:  the viewer pose from WebXR (head -> headset tracking space).
 */
export function headWorldPose(xrFromWorld, xrFromHead) {
  return xrFromWorld.clone().invert().multiply(xrFromHead);
}

/**
 * Projects a world-space box (centre p, size s) into a camera image.
 * Returns {x, y, w, h} in pixels, or null if the box is behind the camera or off screen.
 */
export function projectBox(p, s, K, worldFromCam, camFromWorld = worldFromCam.clone().invert()) {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(p[0] + (i & 1 ? 0.5 : -0.5) * s[0], p[1] + (i & 2 ? 0.5 : -0.5) * s[1], p[2] + (i & 4 ? 0.5 : -0.5) * s[2]);
    v.applyMatrix4(camFromWorld);
    if (v.z > -0.1) return null; // a corner is behind (or at) the camera
    const u = K.cx + (K.f * v.x) / -v.z;
    const vv = K.cy - (K.f * v.y) / -v.z;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, vv);
    maxV = Math.max(maxV, vv);
  }
  if (maxU < 0 || maxV < 0 || minU > K.w || minV > K.h) return null;
  return { x: minU, y: minV, w: maxU - minU, h: maxV - minV };
}

// ---------------------------------------------------------------- marker-free calibration
//
// A fixed camera finds its own pose by watching the headset wearer walk around:
// the headset reports where the wearer's head is (world frame), the camera sees
// where the head and feet are in its picture at the same moment. Many such pairs
// give the camera's pose (a perspective-n-point problem).

function projectPointCV(R, t, f, P, K) {
  const X = R[0][0] * P[0] + R[0][1] * P[1] + R[0][2] * P[2] + t[0];
  const Y = R[1][0] * P[0] + R[1][1] * P[1] + R[1][2] * P[2] + t[1];
  const Z = R[2][0] * P[0] + R[2][1] * P[1] + R[2][2] * P[2] + t[2];
  return [K.cx + (f * X) / Z, K.cy + (f * Y) / Z, Z];
}

/** Weighted pixel residuals of one observation (only the coordinates it constrains). */
function obsResiduals(R, t, f, o, K, out) {
  const q = projectPointCV(R, t, f, o.X, K);
  const w = o.w ?? 1;
  if (q[2] <= 0.05) {
    if (o.u != null) out.push(1e3);
    if (o.v != null) out.push(1e3);
    return;
  }
  if (o.u != null) out.push((q[0] - o.u) * w);
  if (o.v != null) out.push((q[1] - o.v) * w);
}

function obsError(R, t, f, o, K) {
  const r = [];
  obsResiduals(R, t, f, o, K, r);
  return Math.hypot(...r);
}

/**
 * Levenberg-Marquardt on pixel reprojection error, starting from focal length fStart.
 * With refineFocal, the focal length is refined too, with a weak pull towards K.f.
 */
function refineCamera(R, t, fStart, obs, K, refineFocal, maxIter = 40) {
  const nP = refineFocal ? 7 : 6;
  const f0 = refineFocal ? K.f : fStart;
  let params = [...rotToRodrigues(R), ...t];
  if (refineFocal) params.push(Math.log(fStart / K.f)); // log(f / K.f)
  const residuals = (p) => {
    const Rp = rodrigues(p.slice(0, 3));
    const tp = p.slice(3, 6);
    const f = refineFocal ? f0 * Math.exp(p[6]) : f0;
    const r = [];
    for (const o of obs) obsResiduals(Rp, tp, f, o, K, r);
    // Weak prior: keep the focal length near the configured FOV unless the data disagree.
    if (refineFocal) r.push(p[6] * 60);
    return r;
  };
  const sq = (r) => r.reduce((s, v) => s + v * v, 0);
  let mu = 1e-3;
  let r0 = residuals(params);
  let e0 = sq(r0);
  for (let iter = 0; iter < maxIter; iter++) {
    const J = r0.map(() => new Array(nP).fill(0));
    for (let j = 0; j < nP; j++) {
      const d = j < 3 || j === 6 ? 1e-6 : 1e-6 * Math.max(1, Math.abs(params[j]));
      const p2 = params.slice();
      p2[j] += d;
      const r2 = residuals(p2);
      for (let i = 0; i < r0.length; i++) J[i][j] = (r2[i] - r0[i]) / d;
    }
    const JTJ = Array.from({ length: nP }, () => new Array(nP).fill(0));
    const JTr = new Array(nP).fill(0);
    for (let i = 0; i < r0.length; i++) {
      const Ji = J[i];
      for (let a = 0; a < nP; a++) {
        if (!Ji[a]) continue;
        JTr[a] += Ji[a] * r0[i];
        for (let b = 0; b < nP; b++) JTJ[a][b] += Ji[a] * Ji[b];
      }
    }
    const A = JTJ.map((row, k) => row.map((val, j) => (j === k ? val * (1 + mu) + 1e-9 : val)));
    const step = solveLinear(A, JTr.map((v) => -v));
    if (!step) break;
    const next = params.map((v, k) => v + step[k]);
    const r1 = residuals(next);
    const e1 = sq(r1);
    if (e1 < e0) {
      params = next;
      r0 = r1;
      const gain = e0 - e1;
      e0 = e1;
      mu = Math.max(mu / 3, 1e-9);
      if (gain < 1e-9 * e0) break;
    } else {
      mu *= 4;
      if (mu > 1e8) break;
    }
  }
  return { R: rodrigues(params.slice(0, 3)), t: params.slice(3, 6), f: refineFocal ? f0 * Math.exp(params[6]) : f0 };
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : Infinity;
};

/**
 * Camera pose from observations of known world points.
 * obs: [{X:[x,y,z], u?, v?, g?, w?}] - where the camera saw world point X; u (horizontal pixel),
 *      v (vertical pixel) or both. g groups observations from the same frame: random
 *      samples take whole frames, since a wrong frame (someone else) is wrong throughout.
 *      w weights an observation (default 1); errors are measured weighted.
 * K: intrinsics (its f is the starting guess).
 * Robust to outliers: many starting guesses, then refinement on the frames that fit. Returns
 *   {worldFromCam (GL camera, Matrix4), f, fovH, error (median px), inliers, total} or null.
 */
export function solveCameraFromObservations(obs, K, { refineFocal = true, threshold = null } = {}) {
  const n = obs.length;
  if (n < 12) return null;
  const thr = threshold ?? Math.max(12, K.w * 0.025);
  // Frames (groups): an inlier frame has every one of its observations within the
  // threshold. Judging whole frames stops "solutions" that fit one kind of observation
  // (say, only the vertical box edges) and ignore the rest.
  const groupMap = new Map();
  obs.forEach((o, i) => {
    const g = o.g ?? i;
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push(i);
  });
  const groups = [...groupMap.values()];
  if (groups.length < 5) return null;
  const frameErrors = (R, t, f) => {
    const e = obs.map((o) => obsError(R, t, f, o, K));
    return { obsErr: e, frameErr: groups.map((ids) => Math.max(...ids.map((i) => e[i]))) };
  };
  // MSAC score: lower is better; inliers cost their squared error, outliers a fixed amount.
  const scoreOf = (R, t, f) => frameErrors(R, t, f).frameErr.reduce((s, e) => s + Math.min(e * e, thr * thr), 0);

  // Starting guesses: the camera has to see where the person walked, so put it 1.5-6 m
  // from the middle of the walk, all the way round, at a few heights, looking at it.
  let cx = 0, cz = 0;
  for (const o of obs) {
    cx += o.X[0];
    cz += o.X[2];
  }
  cx /= n;
  cz /= n;
  const sub = groups.length > 40 ? groups.filter((_, i) => i % Math.ceil(groups.length / 40) === 0).flat().map((i) => obs[i]) : obs;
  const starts = [];
  for (let a = 0; a < 16; a++) {
    for (const d of [1.8, 3.2, 5.5]) {
      for (const h of [0.8, 1.8, 2.6]) {
        const eye = new THREE.Vector3(cx + Math.sin((a / 16) * Math.PI * 2) * d, h, cz + Math.cos((a / 16) * Math.PI * 2) * d);
        const worldFromGl = new THREE.Matrix4().lookAt(eye, new THREE.Vector3(cx, 0.9, cz), new THREE.Vector3(0, 1, 0)).setPosition(eye);
        const cv = CV_TO_GL.clone().multiply(worldFromGl.clone().invert()).elements;
        const R = [
          [cv[0], cv[4], cv[8]],
          [cv[1], cv[5], cv[9]],
          [cv[2], cv[6], cv[10]],
        ];
        const t = [cv[12], cv[13], cv[14]];
        const sol = refineCamera(R, t, K.f, sub, K, false, 12);
        starts.push({ ...sol, score: scoreOf(sol.R, sol.t, sol.f) });
      }
    }
  }
  starts.sort((a, b) => a.score - b.score);

  // Refine the most promising few on their inlier frames, re-select, refine again.
  let best = null;
  for (const st0 of starts.slice(0, 4)) {
    let { R, t, f } = st0;
    let ok = true;
    for (let round = 0; round < 4; round++) {
      const { frameErr } = frameErrors(R, t, f);
      const keep = groups.filter((_, gi) => frameErr[gi] < thr * (round ? 1 : 2.5)).flat().map((i) => obs[i]);
      if (keep.length < 12) {
        ok = false;
        break;
      }
      const sol = refineCamera(R, t, f, keep, K, refineFocal && keep.length >= 40 && round > 0);
      ({ R, t, f } = sol);
    }
    if (!ok) continue;
    const score = scoreOf(R, t, f);
    if (!best || score < best.score) best = { R, t, f, score };
  }
  if (!best) return null;
  const { R, t, f } = best;
  const { obsErr, frameErr } = frameErrors(R, t, f);
  const cv = new THREE.Matrix4().set(
    R[0][0], R[0][1], R[0][2], t[0],
    R[1][0], R[1][1], R[1][2], t[1],
    R[2][0], R[2][1], R[2][2], t[2],
    0, 0, 0, 1
  );
  const worldFromCam = CV_TO_GL.clone().multiply(cv).invert();
  return {
    worldFromCam,
    f,
    fovH: fovFromFocal(f, K.w),
    error: median(obsErr.filter((e) => e < thr)),
    inliers: frameErr.filter((e) => e < thr).length, // frames that fit
    total: groups.length, // frames
  };
}

/** Same, for full point/pixel pairs: points [[x,y,z]], pixels [[u,v]]. */
export function solveCameraFromPoints(points, pixels, K, opts) {
  return solveCameraFromObservations(points.map((X, i) => ({ X, u: pixels[i][0], v: pixels[i][1] })), K, opts);
}

/**
 * Rotation about +Y plus a floor translation that best maps src onto dst (both [[x,z]]),
 * robust to outliers. Used to place the headset's tracking space in the shared world
 * from where calibrated cameras saw the wearer. Returns {matrix: dst <- src, rms, inliers} or null.
 */
export function fitFloorTransform(src, dst, { threshold = 0.5, iterations = 200 } = {}) {
  const n = src.length;
  if (n < 3) return null;
  const fit = (ids) => {
    let ax = 0, az = 0, bx = 0, bz = 0;
    for (const i of ids) {
      ax += src[i][0];
      az += src[i][1];
      bx += dst[i][0];
      bz += dst[i][1];
    }
    ax /= ids.length;
    az /= ids.length;
    bx /= ids.length;
    bz /= ids.length;
    let sc = 0, ss = 0;
    for (const i of ids) {
      const a0 = src[i][0] - ax, a1 = src[i][1] - az;
      const b0 = dst[i][0] - bx, b1 = dst[i][1] - bz;
      sc += b0 * a0 + b1 * a1;
      ss += b0 * a1 - b1 * a0;
    }
    const th = Math.atan2(ss, sc);
    const c = Math.cos(th), s = Math.sin(th);
    // makeRotationY(th): x' = c x + s z, z' = -s x + c z
    return { th, tx: bx - (c * ax + s * az), tz: bz - (-s * ax + c * az) };
  };
  const errOf = (T, i) => {
    const c = Math.cos(T.th), s = Math.sin(T.th);
    return Math.hypot(c * src[i][0] + s * src[i][1] + T.tx - dst[i][0], -s * src[i][0] + c * src[i][1] + T.tz - dst[i][1]);
  };
  const all = [...Array(n).keys()];
  let best = null;
  for (let it = 0; it < iterations; it++) {
    const a = Math.floor(Math.random() * n);
    const b = Math.floor(Math.random() * n);
    if (a === b || Math.hypot(src[a][0] - src[b][0], src[a][1] - src[b][1]) < 0.5) continue;
    const T = fit([a, b]);
    const inl = all.filter((i) => errOf(T, i) < threshold);
    if (!best || inl.length > best.inl.length) best = { T, inl };
  }
  if (!best || best.inl.length < 3) return null;
  let T = fit(best.inl);
  const inl = all.filter((i) => errOf(T, i) < threshold);
  if (inl.length >= 3) T = fit(inl);
  const rms = Math.sqrt(inl.reduce((s, i) => s + errOf(T, i) ** 2, 0) / inl.length);
  return { matrix: new THREE.Matrix4().makeRotationY(T.th).setPosition(T.tx, 0, T.tz), rms, inliers: inl.length, total: n };
}
