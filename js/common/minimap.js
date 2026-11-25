// Top-down mini map shared by the headset viewer and the phone camera nodes.
//
// It shows what every device in the room has detected, plus where each device is:
//   - phones / cameras: a dot with a wedge for their field of view
//   - headsets:         an arrow pointing the way the wearer faces
//   - objects:          a dot (people) or square (everything else), coloured by the
//                       device that detected it
//
// Only detections and device positions are drawn: never anyone's video.
//
// World frame: metres, +Y up (the headset's map). On the map +X is right and -Z is up, or,
// in follow mode, the map turns so the viewer's facing direction is always up.

const TAU = Math.PI * 2;

/**
 * Heading of a direction on the floor, in radians: 0 when facing -Z, increasing
 * clockwise when seen from above (towards +X).
 */
export function headingFromForward(fx, fz) {
  return Math.atan2(fx, -fz);
}

/**
 * Maps a world point (x, z) to map pixels.
 * view: {cx, cz, heading, scale (px per metre), size (px)}
 */
export function worldToMap(x, z, view) {
  const dx = x - view.cx;
  const dz = z - view.cz;
  const c = Math.cos(view.heading);
  const s = Math.sin(view.heading);
  return {
    x: view.size / 2 + (dx * c + dz * s) * view.scale,
    y: view.size / 2 + (-dx * s + dz * c) * view.scale,
  };
}

/** Screen angle (canvas radians, 0 = right, clockwise) of a world heading on this map. */
function screenAngle(heading, view) {
  return heading - view.heading - Math.PI / 2;
}

/**
 * Picks the map centre and scale.
 * follow: centred on `self`, turned to its heading, fixed range (metres to the edge).
 * fit:    north-up, zoomed to fit every point, with at least `range` metres shown.
 */
export function computeView({ size, follow, self, points, range }) {
  if (follow && self) {
    return { cx: self.p[0], cz: self.p[1], heading: self.heading ?? 0, scale: size / 2 / range, size };
  }
  const pts = points.slice();
  if (self) pts.push(self.p);
  if (!pts.length) return { cx: 0, cz: 0, heading: 0, scale: size / 2 / range, size };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const half = Math.max(range, (maxX - minX) / 2 + 1, (maxZ - minZ) / 2 + 1);
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, heading: 0, scale: size / 2 / half, size };
}

export class Minimap {
  /**
   * canvas: the element to draw on (its width/height are the drawing size in px).
   * follow: true = centred on the viewer and turned with them (headset);
   *         false = north-up and zoomed to fit everything (phones).
   */
  constructor(canvas, { follow = false, range = 5, title = 'Shared map' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.follow = follow;
    this.range = range;
    this.title = title;
    this._view = null;
  }

  /**
   * data: {
   *   self:    {p:[x,z], heading, color, name, kind:'headset'|'camera', fovH} | null
   *   devices: [{id, p:[x,z], heading, color, name, kind, fovH, stale}]
   *   objects: [{p:[x,z], label, color, mine}]
   *   recording: true while this device's own camera is on
   * }
   */
  draw(data) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const size = Math.min(W, H);
    const u = size / 220; // design unit: sizes below are for a 220 px map
    const devices = data.devices || [];
    const objects = data.objects || [];

    const target = computeView({
      size,
      follow: this.follow,
      self: data.self,
      points: [...devices.map((d) => d.p), ...objects.map((o) => o.p)],
      range: this.range,
    });
    // Ease the fit-mode zoom so the map doesn't jump every time something moves.
    const v = this._view && !this.follow ? ease(this._view, target, 0.15) : target;
    this._view = v;

    g.save();
    g.clearRect(0, 0, W, H);
    const r = 16 * u;
    roundRect(g, 1, 1, size - 2, size - 2, r);
    g.fillStyle = 'rgba(8, 12, 20, 0.82)';
    g.fill();
    g.clip();

    // Range rings (follow) or a 1 m grid (fit).
    g.lineWidth = 1 * u;
    if (this.follow) {
      g.strokeStyle = 'rgba(148, 170, 200, 0.16)';
      for (let m = 1; m <= this.range; m++) {
        g.beginPath();
        g.arc(size / 2, size / 2, m * v.scale, 0, TAU);
        g.stroke();
      }
    } else {
      g.strokeStyle = 'rgba(148, 170, 200, 0.09)';
      const half = size / 2 / v.scale;
      const step = half > 8 ? 2 : 1;
      for (let x = Math.floor((v.cx - half) / step) * step; x <= v.cx + half; x += step) {
        const a = worldToMap(x, v.cz - half, v);
        const b = worldToMap(x, v.cz + half, v);
        line(g, a, b);
      }
      for (let z = Math.floor((v.cz - half) / step) * step; z <= v.cz + half; z += step) {
        const a = worldToMap(v.cx - half, z, v);
        const b = worldToMap(v.cx + half, z, v);
        line(g, a, b);
      }
    }

    // Devices: cameras get a field-of-view wedge, headsets an arrow.
    const all = data.self ? [...devices, { ...data.self, isSelf: true }] : devices;
    for (const d of all) {
      if (!d.p) continue;
      const at = worldToMap(d.p[0], d.p[1], v);
      const ang = screenAngle(d.heading ?? 0, v);
      g.globalAlpha = d.stale ? 0.4 : 1;
      if (d.kind === 'headset') {
        drawArrow(g, at, ang, (d.isSelf ? 11 : 9) * u, d.isSelf ? '#ffffff' : d.color);
      } else {
        const fov = ((d.fovH || 65) * Math.PI) / 180;
        const len = Math.min(1.6 * v.scale, 46 * u);
        g.beginPath();
        g.moveTo(at.x, at.y);
        g.arc(at.x, at.y, len, ang - fov / 2, ang + fov / 2);
        g.closePath();
        g.fillStyle = hexA(d.color, 0.14);
        g.fill();
        g.strokeStyle = hexA(d.color, 0.6);
        g.lineWidth = 1 * u;
        g.stroke();
        g.beginPath();
        g.arc(at.x, at.y, 4.5 * u, 0, TAU);
        g.fillStyle = d.color;
        g.fill();
        if (d.isSelf) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2 * u;
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    }

    // Objects on top.
    for (const o of objects) {
      const at = worldToMap(o.p[0], o.p[1], v);
      const rr = (o.label === 'person' ? 5 : 4) * u;
      g.shadowColor = o.color;
      g.shadowBlur = 8 * u;
      g.fillStyle = o.color;
      if (o.label === 'person') {
        g.beginPath();
        g.arc(at.x, at.y, rr, 0, TAU);
        g.fill();
      } else {
        g.fillRect(at.x - rr, at.y - rr, rr * 2, rr * 2);
      }
      g.shadowBlur = 0;
      if (!o.mine) {
        // A ring marks things this device can't detect itself: they come from another device.
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 1.2 * u;
        g.beginPath();
        g.arc(at.x, at.y, rr + 2.5 * u, 0, TAU);
        g.stroke();
      }
    }

    // Header and scale.
    g.font = `600 ${11 * u}px system-ui, sans-serif`;
    g.textBaseline = 'top';
    if (data.recording) {
      // This device's camera is on: say so wherever the map is shown.
      g.fillStyle = '#f87171';
      g.fillText('● CAMERA ON', 10 * u, 9 * u);
    } else {
      g.fillStyle = '#9fb3c8';
      g.fillText(this.title.toUpperCase(), 10 * u, 9 * u);
    }
    g.textAlign = 'right';
    g.fillStyle = '#e6edf5';
    g.fillText(`${objects.length} seen · ${all.length} device${all.length === 1 ? '' : 's'}`, size - 10 * u, 9 * u);
    g.textAlign = 'left';
    const barM = this.follow ? 1 : niceStep(size / 2 / v.scale / 3);
    const barPx = barM * v.scale;
    g.strokeStyle = '#9fb3c8';
    g.lineWidth = 2 * u;
    const by = size - 12 * u;
    line(g, { x: 10 * u, y: by }, { x: 10 * u + barPx, y: by });
    g.textBaseline = 'bottom';
    g.font = `${10 * u}px system-ui, sans-serif`;
    g.fillStyle = '#9fb3c8';
    g.fillText(this.follow ? `rings ${barM} m` : `${barM} m`, 10 * u, by - 3 * u);
    g.restore();

    // Border drawn after restoring the clip so it stays crisp.
    roundRect(g, 1, 1, size - 2, size - 2, r);
    g.strokeStyle = 'rgba(56, 232, 255, 0.45)';
    g.lineWidth = 1.5 * u;
    g.stroke();
  }
}

function ease(a, b, k) {
  return {
    cx: a.cx + (b.cx - a.cx) * k,
    cz: a.cz + (b.cz - a.cz) * k,
    heading: b.heading,
    scale: a.scale + (b.scale - a.scale) * k,
    size: b.size,
  };
}

function niceStep(m) {
  for (const s of [0.5, 1, 2, 5, 10, 20]) if (s >= m) return s;
  return 50;
}

function line(g, a, b) {
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
}

function drawArrow(g, at, ang, len, color) {
  g.save();
  g.translate(at.x, at.y);
  g.rotate(ang);
  g.beginPath();
  g.moveTo(len, 0);
  g.lineTo(-len * 0.7, len * 0.65);
  g.lineTo(-len * 0.35, 0);
  g.lineTo(-len * 0.7, -len * 0.65);
  g.closePath();
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = len * 0.8;
  g.fill();
  g.restore();
}

function hexA(hex, a) {
  const h = String(hex || '#38e8ff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
