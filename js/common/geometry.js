// Geometry shared by the browser camera node, the simulator and the viewer.
//
// Conventions
//   Image pixels:   OpenCV style, origin top-left, +x right, +y down.
//   CV camera:      +X right, +Y down, +Z forward (into the scene).
//   GL camera:      +X right, +Y up,   -Z forward (three.js camera convention).
//   Marker frame:   origin at the marker centre, +X right, +Y up (as printed),
//                   +Z out of the paper towards whoever is looking at it.
//   World frame:    metres, +Y up, floor at y = 0 (see protocol.js).
//
// Marker corners come from the detector in the order top-left, top-right,
// bottom-right, bottom-left (same order in js-aruco2 and OpenCV; verified).

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

/** Homography H (row-major 3x3) mapping src[i] -> dst[i] for exactly four points. */
export function homography4(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = src[i];
    const [x, y] = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]);
    b.push(x);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]);
    b.push(y);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function rodrigues(rv) {
  const th = norm3(rv);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = scale3(rv, 1 / th);
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

function matVec(R, v) {
  return [dot3(R[0], v), dot3(R[1], v), dot3(R[2], v)];
}

// ------------------------------------------------------------------ marker pose

/** Marker corner coordinates in the marker frame: TL, TR, BR, BL (metres). */
export function markerObjectPoints(size) {
  const s = size / 2;
  return [
    [-s, s],
    [s, s],
    [s, -s],
    [-s, -s],
  ];
}

function projectCV(R, t, P, K) {
  const X = [
    R[0][0] * P[0] + R[0][1] * P[1] + t[0],
    R[1][0] * P[0] + R[1][1] * P[1] + t[1],
    R[2][0] * P[0] + R[2][1] * P[1] + t[2],
  ];
  return [K.cx + (K.f * X[0]) / X[2], K.cy + (K.f * X[1]) / X[2]];
}

function reprojectionError(R, t, obj, img, K) {
  let e = 0;
  for (let i = 0; i < 4; i++) {
    const p = projectCV(R, t, obj[i], K);
    e += Math.hypot(p[0] - img[i][0], p[1] - img[i][1]);
  }
  return e / 4;
}

/**
 * Pose of a square marker relative to the camera.
 * corners: four {x, y} pixel points (TL, TR, BR, BL). size: marker edge in metres.
 * Returns { glCamFromMarker: Matrix4, error: mean reprojection error in px, distance } or null.
 */
export function poseFromMarker(corners, size, K) {
  const obj = markerObjectPoints(size);
  const img = corners.map((c) => [c.x, c.y]);
  const norm = img.map(([u, v]) => [(u - K.cx) / K.f, (v - K.cy) / K.f]);
  const H = homography4(obj, norm);
  if (!H) return null;

  // H ~ [r1 r2 t]
  let h1 = [H[0][0], H[1][0], H[2][0]];
  let h2 = [H[0][1], H[1][1], H[2][1]];
  let h3 = [H[0][2], H[1][2], H[2][2]];
  const lambda = 2 / (norm3(h1) + norm3(h2));
  let r1 = scale3(h1, lambda);
  let r2 = scale3(h2, lambda);
  let t = scale3(h3, lambda);
  if (t[2] < 0) {
    r1 = scale3(r1, -1);
    r2 = scale3(r2, -1);
    t = scale3(t, -1);
  }
  // Orthonormalise symmetrically so neither axis is favoured.
  const a = scale3(r1, 1 / norm3(r1));
  const b = scale3(r2, 1 / norm3(r2));
  const bis = scale3([a[0] + b[0], a[1] + b[1], a[2] + b[2]], 1);
  const z = cross3(a, b);
  const zn = scale3(z, 1 / norm3(z));
  const bisn = scale3(bis, 1 / norm3(bis));
  const perp = cross3(zn, bisn);
  const s2 = Math.SQRT1_2;
  const x = [s2 * (bisn[0] - perp[0]), s2 * (bisn[1] - perp[1]), s2 * (bisn[2] - perp[2])];
  const y = [s2 * (bisn[0] + perp[0]), s2 * (bisn[1] + perp[1]), s2 * (bisn[2] + perp[2])];
  const R0 = [
    [x[0], y[0], zn[0]],
    [x[1], y[1], zn[1]],
    [x[2], y[2], zn[2]],
  ];

  // A square seen small or nearly head-on has two poses that fit the corners almost
  // equally well (the marker tilted towards or away from the camera). Start the
  // refinement from both and keep the one that reprojects better.
  const v = scale3(t, 1 / norm3(t));
  const n = zn;
  const nm = sub3(scale3(v, 2 * dot3(n, v)), n); // normal mirrored about the line of sight
  const axis = cross3(n, nm);
  const sinA = norm3(axis);
  const ang = Math.atan2(sinA, dot3(n, nm));
  const starts = [R0];
  if (sinA > 1e-9) {
    const Q = rodrigues(scale3(axis, ang / sinA));
    starts.push([0, 1, 2].map((r) => [0, 1, 2].map((c) => Q[r][0] * R0[0][c] + Q[r][1] * R0[1][c] + Q[r][2] * R0[2][c])));
  }
  let best = null;
  for (const Rs of starts) {
    const sol = refinePose(Rs, t, obj, img, K);
    if (sol && sol.t[2] > 0 && (!best || sol.err < best.err)) best = sol;
  }
  if (!best) return null;
  const R = best.R;
  t = best.t;
  const error = reprojectionError(R, t, obj, img, K);
  const cvCamFromMarker = new THREE.Matrix4().set(
    R[0][0], R[0][1], R[0][2], t[0],
    R[1][0], R[1][1], R[1][2], t[1],
    R[2][0], R[2][1], R[2][2], t[2],
    0, 0, 0, 1
  );
  const glCamFromMarker = CV_TO_GL.clone().multiply(cvCamFromMarker);
  return { glCamFromMarker, error, distance: norm3(t) };
}

/** Levenberg-Marquardt refinement of a marker pose on the corner reprojection error. */
function refinePose(R, t, obj, img, K) {
  let params = [...rotToRodrigues(R), ...t];
  const residuals = (p) => {
    const Rp = rodrigues(p.slice(0, 3));
    const tp = p.slice(3);
    const r = [];
    for (let i = 0; i < 4; i++) {
      const q = projectCV(Rp, tp, obj[i], K);
      r.push(q[0] - img[i][0], q[1] - img[i][1]);
    }
    return r;
  };
  let mu = 1e-3;
  for (let iter = 0; iter < 30; iter++) {
    const r0 = residuals(params);
    const J = r0.map(() => new Array(6).fill(0));
    for (let j = 0; j < 6; j++) {
      const d = j < 3 ? 1e-6 : 1e-6 * Math.max(1, Math.abs(params[j]));
      const p2 = params.slice();
      p2[j] += d;
      const r2 = residuals(p2);
      for (let i = 0; i < r0.length; i++) J[i][j] = (r2[i] - r0[i]) / d;
    }
    // Normal equations with a little damping (Levenberg-Marquardt style).
    const JTJ = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const JTr = new Array(6).fill(0);
    for (let i = 0; i < r0.length; i++) {
      for (let a2 = 0; a2 < 6; a2++) {
        JTr[a2] += J[i][a2] * r0[i];
        for (let b2 = 0; b2 < 6; b2++) JTJ[a2][b2] += J[i][a2] * J[i][b2];
      }
    }
    const e0 = r0.reduce((s, v) => s + v * v, 0);
    const A = JTJ.map((row, k) => row.map((val, j) => (j === k ? val * (1 + mu) + 1e-12 : val)));
    const step = solveLinear(A, JTr.map((v) => -v));
    if (!step) break;
    const next = params.map((v, k) => v + step[k]);
    const e1 = residuals(next).reduce((s, v) => s + v * v, 0);
    if (e1 < e0) {
      params = next;
      mu = Math.max(mu / 3, 1e-9);
      if (e0 - e1 < 1e-12) break;
    } else {
      mu *= 4;
      if (mu > 1e6) break;
    }
  }
  const Rf = rodrigues(params.slice(0, 3));
  const tf = params.slice(3);
  const err = residuals(params).reduce((s, v) => s + v * v, 0);
  return { R: Rf, t: tf, err };
}

/**
 * Focal length (px) implied by one view of a square marker, assuming square pixels
 * and a centred principal point. Needs the marker to be seen at an angle; returns
 * null when the view is too frontal to tell.
 */
export function estimateFocal(corners, size, cx, cy) {
  const obj = markerObjectPoints(size);
  const img = corners.map((c) => [c.x - cx, c.y - cy]);
  const H = homography4(obj, img);
  if (!H) return null;
  const [h11, h12] = [H[0][0], H[0][1]];
  const [h21, h22] = [H[1][0], H[1][1]];
  const [h31, h32] = [H[2][0], H[2][1]];
  const cands = [];
  const d1 = h31 * h32;
  const d2 = h31 * h31 - h32 * h32;
  const scaleRef = Math.hypot(h31, h32);
  if (scaleRef < 1e-3) return null; // frontal view: no information
  if (Math.abs(d1) > 1e-6) cands.push({ f2: -(h11 * h12 + h21 * h22) / d1, w: Math.abs(d1) });
  if (Math.abs(d2) > 1e-6) cands.push({ f2: -(h11 * h11 + h21 * h21 - h12 * h12 - h22 * h22) / d2, w: Math.abs(d2) });
  const good = cands.filter((c) => c.f2 > 0 && isFinite(c.f2));
  if (!good.length) return null;
  good.sort((a, b) => b.w - a.w);
  return Math.sqrt(good[0].f2);
}

// ------------------------------------------------------------------ world map helpers

/** World matrix of a wall marker stored as {p:[x,y,z], yaw} (yaw about +Y, radians). */
export function markerWorldMatrix(m) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), m.yaw || 0);
  return new THREE.Matrix4().compose(new THREE.Vector3(...m.p), q, new THREE.Vector3(1, 1, 1));
}

/** Inverse of markerWorldMatrix for a (near-)vertical marker pose. */
export function markerFromMatrix(M, size) {
  const p = new THREE.Vector3().setFromMatrixPosition(M);
  const z = new THREE.Vector3().setFromMatrixColumn(M, 2);
  const yaw = Math.atan2(z.x, z.z);
  return { p: [p.x, p.y, p.z], yaw, size };
}

/**
 * A marker pose from two points touched in a tracked space (e.g. WebXR local-floor):
 * the marker centre, then any point to its right along the wall. +Y is taken from
 * gravity, so the marker is assumed to hang on a vertical wall.
 */
export function markerMatrixFromTwoPoints(center, rightPoint) {
  const xAxis = new THREE.Vector3().subVectors(rightPoint, center);
  xAxis.y = 0;
  if (xAxis.lengthSq() < 1e-4) return null; // points too close together
  xAxis.normalize();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(center);
}

/** World pose of a camera that sees a marker whose world pose is known. */
export function cameraWorldFromMarker(worldFromMarker, glCamFromMarker) {
  return worldFromMarker.clone().multiply(glCamFromMarker.clone().invert());
}

/** Average of several rigid poses (position mean, sign-aligned quaternion mean). */
export function averagePoses(mats) {
  if (!mats.length) return null;
  const pos = new THREE.Vector3();
  const qs = mats.map((m) => {
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    m.decompose(p, q, new THREE.Vector3());
    pos.add(p);
    return q;
  });
  pos.divideScalar(mats.length);
  const ref = qs[0];
  const acc = new THREE.Vector4();
  for (const q of qs) {
    const s = q.dot(ref) < 0 ? -1 : 1;
    acc.x += s * q.x;
    acc.y += s * q.y;
    acc.z += s * q.z;
    acc.w += s * q.w;
  }
  const q = new THREE.Quaternion(acc.x, acc.y, acc.z, acc.w).normalize();
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
}

/**
 * Mean of several detections of the same marker (each four {x, y} corners).
 * Averaging the corners before solving the pose cuts pixel noise by sqrt(N) and,
 * unlike averaging per-frame poses, cannot mix the two mirror-image solutions a
 * small or distant marker flips between.
 */
export function averageCorners(list) {
  if (!list.length) return null;
  return [0, 1, 2, 3].map((i) => ({
    x: list.reduce((s, c) => s + c[i].x, 0) / list.length,
    y: list.reduce((s, c) => s + c[i].y, 0) / list.length,
  }));
}

/** Width of a detected marker in pixels (mean edge length). */
export function markerPixelSize(c) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(c[i].x - c[(i + 1) % 4].x, c[i].y - c[(i + 1) % 4].y);
  return s / 4;
}

/** Spread of a set of poses: max position deviation (m) and max angle deviation (deg). */
export function poseSpread(mats, mean) {
  const mp = new THREE.Vector3().setFromMatrixPosition(mean);
  const mq = new THREE.Quaternion().setFromRotationMatrix(mean);
  let dp = 0;
  let da = 0;
  for (const m of mats) {
    dp = Math.max(dp, new THREE.Vector3().setFromMatrixPosition(m).distanceTo(mp));
    da = Math.max(da, THREE.MathUtils.radToDeg(new THREE.Quaternion().setFromRotationMatrix(m).angleTo(mq)));
  }
  return { position: dp, angle: da };
}

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
