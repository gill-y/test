// A flat, canvas-drawn control panel for use inside a WebXR session, where HTML
// isn't available. Point a controller (or a pinching hand) at a button and pull
// the trigger to press it.

import * as THREE from 'three';
import { roundRect } from './xray.js';

const W = 1024;
const H = 800;

export class XRPanel {
  constructor({ width = 0.44 } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const height = (width * H) / W;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, side: THREE.DoubleSide })
    );
    this.mesh.renderOrder = 2000;
    this.mesh.name = 'xr-panel';
    this.buttons = [];
    this.hover = null;
    this.model = null;
    this._dirty = true;
  }

  /** model: {title, subtitle, sections:[{heading, buttons:[{id,label,on,accent}], lines:[{text,color}]}], footer} */
  setModel(model) {
    const key = JSON.stringify(model);
    if (key === this._key) return;
    this._key = key;
    this.model = model;
    this._dirty = true;
  }

  setHover(id) {
    if (id === this.hover) return;
    this.hover = id;
    this._dirty = true;
  }

  draw() {
    if (!this._dirty || !this.model) return;
    this._dirty = false;
    const g = this.ctx;
    const m = this.model;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8, 12, 20, 0.86)';
    roundRect(g, 4, 4, W - 8, H - 8, 36);
    g.fill();
    g.strokeStyle = 'rgba(56, 232, 255, 0.55)';
    g.lineWidth = 4;
    g.stroke();

    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = '700 46px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText(m.title || 'SeeThrough', 40, 56);
    g.font = '28px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillStyle = '#9fb3c8';
    g.fillText(m.subtitle || '', 40, 100);

    this.buttons = [];
    let y = 140;
    for (const sec of m.sections || []) {
      if (sec.heading) {
        g.font = '600 24px system-ui, sans-serif';
        g.fillStyle = '#6b7f96';
        g.fillText(sec.heading.toUpperCase(), 40, y + 14);
        y += 36;
      }
      if (sec.buttons?.length) {
        let x = 40;
        const bh = 64;
        g.font = '600 28px system-ui, sans-serif';
        for (const b of sec.buttons) {
          const bw = Math.max(120, g.measureText(b.label).width + 48);
          if (x + bw > W - 40) {
            x = 40;
            y += bh + 14;
          }
          const hovered = this.hover === b.id;
          g.fillStyle = b.on ? (b.accent || '#38e8ff') : hovered ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
          roundRect(g, x, y, bw, bh, 18);
          g.fill();
          if (hovered) {
            g.strokeStyle = '#ffffff';
            g.lineWidth = 3;
            g.stroke();
          }
          g.fillStyle = b.on ? '#061018' : '#e6edf5';
          g.textAlign = 'center';
          g.fillText(b.label, x + bw / 2, y + bh / 2 + 1);
          g.textAlign = 'left';
          this.buttons.push({ id: b.id, x, y, w: bw, h: bh });
          x += bw + 14;
        }
        y += bh + 18;
      }
      for (const line of sec.lines || []) {
        g.font = line.bold ? '600 28px system-ui, sans-serif' : '26px system-ui, sans-serif';
        if (line.dot) {
          g.fillStyle = line.dot;
          g.beginPath();
          g.arc(52, y + 16, 10, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = line.color || '#d5dee8';
        g.fillText(line.text, line.dot ? 74 : 40, y + 16, W - 110);
        y += 38;
      }
      y += 8;
      if (y > H - 60) break;
    }
    if (m.footer) {
      g.font = '24px system-ui, sans-serif';
      g.fillStyle = '#6b7f96';
      g.fillText(m.footer, 40, H - 40, W - 80);
    }
    this.texture.needsUpdate = true;
  }

  /** Button id under a ray hit's uv coordinate, or null. */
  buttonAt(uv) {
    const x = uv.x * W;
    const y = (1 - uv.y) * H;
    const b = this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    return b ? b.id : null;
  }
}
