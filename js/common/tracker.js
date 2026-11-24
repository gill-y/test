// Keeps object IDs stable between frames on a camera node.
// Matches each new 3D detection to the nearest existing track with the same label
// (greedy, within a distance gate), smooths positions, and drops tracks that have
// not been seen for a short while.

export class Tracker {
  constructor({ gate = 1.0, smoothing = 0.5, maxAgeMs = 800, prefix = 't' } = {}) {
    this.gate = gate;
    this.alpha = smoothing; // weight of the new measurement
    this.maxAgeMs = maxAgeMs;
    this.prefix = prefix;
    this.tracks = new Map();
    this.next = 1;
  }

  /** dets: [{label, p:[x,y,z], s:[w,h,d], c}] -> tracked objects with stable `id`. */
  update(dets, now = performance.now()) {
    const pairs = [];
    dets.forEach((d, di) => {
      for (const tr of this.tracks.values()) {
        if (tr.label !== d.label) continue;
        const dist = Math.hypot(tr.p[0] - d.p[0], tr.p[2] - d.p[2]);
        const gate = this.gate + Math.max(d.s[0], tr.s[0]) * 0.5;
        if (dist < gate) pairs.push({ di, tr, dist });
      }
    });
    pairs.sort((a, b) => a.dist - b.dist);
    const usedD = new Set();
    const usedT = new Set();
    const out = [];
    for (const { di, tr } of pairs) {
      if (usedD.has(di) || usedT.has(tr.id)) continue;
      usedD.add(di);
      usedT.add(tr.id);
      const d = dets[di];
      const a = this.alpha;
      tr.p = tr.p.map((v, k) => v + a * (d.p[k] - v));
      tr.s = tr.s.map((v, k) => v + a * (d.s[k] - v));
      tr.c = d.c;
      tr.seen = now;
      tr.hits++;
      out.push(tr);
    }
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const tr = { id: `${this.prefix}${this.next++}`, label: d.label, p: [...d.p], s: [...d.s], c: d.c, seen: now, hits: 1 };
      this.tracks.set(tr.id, tr);
      out.push(tr);
    });
    for (const [id, tr] of this.tracks) if (now - tr.seen > this.maxAgeMs) this.tracks.delete(id);
    return out.map((tr) => ({
      id: tr.id,
      label: tr.label,
      p: tr.p.map(round3),
      s: tr.s.map(round3),
      c: Math.round(tr.c * 100) / 100,
    }));
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;
