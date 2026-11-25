// Marker-free calibration.
//
// The headset is the map: its floor-level tracking space is the shared world.
//
//   WalkCalibrator - a fixed camera works out where it is by watching the headset
//                    wearer walk in front of it. Each frame pairs the wearer's head
//                    and feet in the picture with where the headset says the head is.
//   Relocalizer    - the reverse: a headset that has lost its saved position finds
//                    itself again by walking in front of cameras that are already
//                    calibrated. Each camera reports a person at some world position;
//                    the headset knows where it is in its own tracking space at that
//                    moment. Matching the two paths gives the headset's place in the world.

import { solveCameraFromObservations, fitFloorTransform } from './geometry.js';

/** How far the top of the head is above the headset's reported position (eyes), metres. */
export const HEAD_TOP_ABOVE_EYES = 0.11;
/**
 * Seen from a camera above head height, a person box's top edge is the back of the
 * head and its bottom edge is the front of the nearer foot, not the centre of either.
 * These are those offsets along the floor, away from / towards the camera, in metres.
 */
export const HEAD_TOP_BEHIND = 0.05;
export const FEET_IN_FRONT = 0.2;
/** The feet edge moves with every stride, so it counts for less than the head and centre. */
const FEET_WEIGHT = 0.35;

/** Timestamped positions, for looking up where something was at a given moment. */
export class PositionHistory {
  constructor(maxAgeMs = 30000) {
    this.maxAgeMs = maxAgeMs;
    this.items = []; // {ts, p:[x,y,z]} in ts order
  }
  push(ts, p) {
    const last = this.items[this.items.length - 1];
    if (last && ts <= last.ts) return;
    this.items.push({ ts, p: [...p] });
    while (this.items.length && ts - this.items[0].ts > this.maxAgeMs) this.items.shift();
  }
  clear() {
    this.items.length = 0;
  }
  /** Position at time ts, interpolated between samples no more than maxGap ms apart. */
  at(ts, maxGap = 250) {
    const a = this.items;
    if (!a.length || ts < a[0].ts || ts > a[a.length - 1].ts + 60) return null;
    let lo = 0;
    let hi = a.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid].ts <= ts) lo = mid;
      else hi = mid;
    }
    const p = a[lo];
    const q = a[hi];
    if (ts >= q.ts) return ts - q.ts < 60 ? [...q.p] : null; // newest sample, slightly old
    if (q.ts - p.ts > maxGap) return null;
    const k = (ts - p.ts) / (q.ts - p.ts || 1);
    return p.p.map((v, i) => v + (q.p[i] - v) * k);
  }
}

export class WalkCalibrator {
  /** K: intrinsics from the configured field of view (refined during the solve). */
  constructor(K, { minFrames = 100, minSpread = 2, minSeconds = 12, maxSeconds = 120 } = {}) {
    this.K = K;
    this.minFrames = minFrames;
    this.minSpread = minSpread;
    this.minSeconds = minSeconds;
    this.maxSeconds = maxSeconds;
    this.obs = []; // {X:[x,y,z], u?|v?}
    this.heads = []; // floor positions of the wearer, for coverage
    this.us = []; // horizontal pixel positions, for coverage
    this.frames = 0;
    this.started = null;
  }

  /**
   * One frame: bbox of the only person in view, and the headset's world position
   * (eyes) at the moment the frame was taken.
   *
   * The box gives three constraints: its top edge is the top of the head, its bottom
   * edge is the floor under the wearer (when the feet are in view), and its horizontal
   * centre is the middle of the body. Top and bottom constrain only the vertical pixel
   * position, because a camera looking down sees the head and feet at slightly
   * different horizontal positions.
   */
  add(bbox, head, now = Date.now()) {
    if (this.started === null) this.started = now;
    const { w, h } = this.K;
    const cx = bbox.x + bbox.w / 2;
    if (cx < 0 || cx > w || bbox.w < 8 || bbox.h < 16) return false;
    const top = head[1] + HEAD_TOP_ABOVE_EYES;
    const topVisible = bbox.y > 3;
    const feetVisible = bbox.y + bbox.h < h - 3 && head[1] > 1.2;
    if (!topVisible && !feetVisible) return false;
    const g = this.frames;
    if (topVisible) this.obs.push({ X: [head[0], top, head[2]], v: bbox.y, g, kind: 'top' });
    if (feetVisible) this.obs.push({ X: [head[0], 0, head[2]], v: bbox.y + bbox.h, g, kind: 'feet', w: FEET_WEIGHT });
    // The box's horizontal centre is on the body's vertical axis; half height is a good
    // stand-in. Not when the box is cut off by the side of the picture.
    if (bbox.x > 3 && bbox.x + bbox.w < w - 3) this.obs.push({ X: [head[0], top / 2, head[2]], u: cx, g });
    this.frames++;
    this.heads.push([head[0], head[2]]);
    this.us.push(cx / w);
    return true;
  }

  /** How far along the calibration is, and what's missing. */
  progress(now = Date.now()) {
    const elapsed = this.started === null ? 0 : (now - this.started) / 1000;
    let spread = 0;
    for (let i = 0; i < this.heads.length; i += 3) {
      for (let j = i + 1; j < this.heads.length; j += 3) {
        spread = Math.max(spread, Math.hypot(this.heads[i][0] - this.heads[j][0], this.heads[i][1] - this.heads[j][1]));
      }
    }
    const uSpread = this.us.length ? Math.max(...this.us) - Math.min(...this.us) : 0;
    // Walking along a single line leaves the camera's distance ambiguous: the walk has
    // to cover an area, so measure its narrower side.
    const width = minorStd(this.heads);
    const parts = [
      Math.min(1, this.frames / this.minFrames),
      Math.min(1, spread / this.minSpread),
      Math.min(1, uSpread / 0.4),
      Math.min(1, width / 0.35),
      // A fast camera collects frames quickly: also walk for a while, to cover more ground.
      this.minSeconds ? Math.min(1, elapsed / this.minSeconds) : 1,
    ];
    const fraction = Math.min(...parts);
    let hint = '';
    if (parts[1] < 1) hint = 'Walk around more: cover at least 2 m.';
    else if (parts[3] < 1) hint = 'Walk towards the camera and away from it too, not just across.';
    else if (parts[2] < 1) hint = 'Walk across the picture, from one side to the other.';
    else if (fraction < 1) hint = 'Keep walking…';
    return { fraction, frames: this.frames, spread, uSpread, ready: fraction >= 1, hint, timedOut: elapsed > this.maxSeconds };
  }

  /**
   * Observations with the head-top and feet points moved to where the box edges really
   * are, given roughly where the camera is (null: no correction yet).
   */
  _corrected(camPos) {
    if (!camPos) return this.obs;
    // Very close to the camera, a box is too distorted to model: leave those frames out.
    const far = this.obs.filter((o) => Math.hypot(o.X[0] - camPos.x, o.X[2] - camPos.z) > 1.0);
    return (far.length >= this.obs.length * 0.5 ? far : this.obs).map((o) => {
      if (!o.kind) return o;
      const dx = o.X[0] - camPos.x;
      const dz = o.X[2] - camPos.z;
      const len = Math.hypot(dx, dz) || 1;
      const k = o.kind === 'top' ? HEAD_TOP_BEHIND : -FEET_IN_FRONT;
      return { ...o, X: [o.X[0] + (dx / len) * k, o.X[1], o.X[2] + (dz / len) * k] };
    });
  }

  /** Camera pose from everything collected, or null. */
  solve() {
    let res = solveCameraFromObservations(this.obs, this.K, { refineFocal: true });
    // Two more rounds with the box-edge offsets, now that the camera's rough position is known.
    for (let round = 0; round < 2 && res; round++) {
      const e = res.worldFromCam.elements;
      const next = solveCameraFromObservations(this._corrected({ x: e[12], z: e[14] }), this.K, { refineFocal: true });
      if (!next) break;
      res = next;
    }
    if (!res) return null;
    // Sanity: a plausible camera (not under the floor, not on the ceiling, not far from
    // where you walked), and most observations should fit, and fit well.
    const e = res.worldFromCam.elements;
    const cx = this.heads.reduce((s, h) => s + h[0], 0) / this.heads.length;
    const cz = this.heads.reduce((s, h) => s + h[1], 0) / this.heads.length;
    if (e[13] < 0.05 || e[13] > 4 || Math.hypot(e[12] - cx, e[14] - cz) > 12) return { ...res, ok: false };
    if (res.inliers < res.total * 0.6 || res.error > Math.max(12, this.K.w * 0.025)) return { ...res, ok: false };
    return { ...res, ok: true };
  }
}

/** Standard deviation of floor points along their narrowest direction. */
function minorStd(pts) {
  const n = pts.length;
  if (n < 3) return 0;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const mz = pts.reduce((s, p) => s + p[1], 0) / n;
  let a = 0, b = 0, c = 0;
  for (const p of pts) {
    a += (p[0] - mx) ** 2;
    b += (p[0] - mx) * (p[1] - mz);
    c += (p[1] - mz) ** 2;
  }
  a /= n;
  b /= n;
  c /= n;
  const minEig = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
  return Math.sqrt(Math.max(0, minEig));
}

export class Relocalizer {
  constructor({ minPairs = 15, minSpread = 1.5 } = {}) {
    this.minPairs = minPairs;
    this.minSpread = minSpread;
    this.ownPath = new PositionHistory(30000); // headset positions in its own tracking space
    this.pairs = []; // {src:[x,z] tracking space, dst:[x,z] world, ts}
  }

  /** Where the headset is in its own tracking space, with the relay-clock time. */
  addOwn(ts, p) {
    this.ownPath.push(ts, p);
  }

  /** A person reported by a calibrated camera at world position p, at relay time ts. */
  addSighting(ts, p) {
    const own = this.ownPath.at(ts, 300);
    if (!own) return;
    this.pairs.push({ src: [own[0], own[2]], dst: [p[0], p[2]], ts });
    while (this.pairs.length && ts - this.pairs[0].ts > 30000) this.pairs.shift();
  }

  reset() {
    this.ownPath.clear();
    this.pairs.length = 0;
  }

  /** Tries to place the tracking space in the world. Returns {matrix: world <- tracking, rms, inliers} or null. */
  solve() {
    if (this.pairs.length < this.minPairs) return null;
    const src = this.pairs.map((q) => q.src);
    let spread = 0;
    for (let i = 0; i < src.length; i += 2) for (let j = i + 1; j < src.length; j += 2) spread = Math.max(spread, Math.hypot(src[i][0] - src[j][0], src[i][1] - src[j][1]));
    if (spread < this.minSpread) return null;
    const res = fitFloorTransform(src, this.pairs.map((q) => q.dst), { threshold: 0.6 });
    if (!res || res.inliers < this.minPairs * 0.7 || res.inliers < this.pairs.length * 0.5 || res.rms > 0.35) return null;
    return res;
  }

  progress() {
    return Math.min(1, this.pairs.length / this.minPairs);
  }
}
