// X-ray visuals: a glowing outline for each tracked object, drawn on top of
// everything (depth test off) so it shows through walls and furniture.

import * as THREE from 'three';
import { SILHOUETTE_LABELS, prettyLabel } from '../common/protocol.js';

const RIM_VERTEX = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const RIM_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float fill;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float a = fill + pow(rim, 2.2) * 0.95;
    gl_FragColor = vec4(color * (0.6 + rim), a * opacity);
  }
`;

function rimMaterial(color, fill = 0.06) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 1 }, fill: { value: fill } },
    vertexShader: RIM_VERTEX,
    fragmentShader: RIM_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const UNIT_BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const BODY = new THREE.CapsuleGeometry(0.5, 1, 6, 16); // height 2, width 1
const HEAD = new THREE.SphereGeometry(0.5, 16, 12);
const RING = (() => {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
})();

const RENDER_ORDER = 1000;

export class ObjectVisual {
  constructor({ label, color }) {
    this.label = label;
    this.color = color;
    this.group = new THREE.Group();
    this.group.renderOrder = RENDER_ORDER;
    this.materials = [];
    this.kind = SILHOUETTE_LABELS.has(label) ? 'silhouette' : 'box';
    this.body = new THREE.Group();
    this.group.add(this.body);

    if (this.kind === 'silhouette') {
      const m = rimMaterial(color, 0.05);
      this.materials.push(m);
      this.torso = new THREE.Mesh(BODY, m);
      this.head = new THREE.Mesh(HEAD, m);
      this.body.add(this.torso, this.head);
    } else {
      const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
      const fillMat = rimMaterial(color, 0.04);
      this.materials.push(edgeMat, fillMat);
      this.edges = new THREE.LineSegments(UNIT_BOX_EDGES, edgeMat);
      this.fill = new THREE.Mesh(UNIT_BOX, fillMat);
      this.body.add(this.edges, this.fill);
    }
    const ringMat = new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
    this.materials.push(ringMat);
    this.ring = new THREE.Line(RING, ringMat);
    this.group.add(this.ring);

    this.labelSprite = new LabelSprite(color);
    this.group.add(this.labelSprite.sprite);

    for (const o of [this.group, ...this.group.children, ...this.body.children]) o.renderOrder = RENDER_ORDER;
    this.target = new THREE.Vector3();
    this.size = new THREE.Vector3(0.5, 1, 0.5);
    this.targetSize = this.size.clone();
    this.initialised = false;
  }

  setTarget(p, s) {
    this.target.set(p[0], p[1], p[2]);
    this.targetSize.set(Math.max(0.05, s[0]), Math.max(0.05, s[1]), Math.max(0.05, s[2]));
    if (!this.initialised) {
      this.group.position.copy(this.target);
      this.size.copy(this.targetSize);
      this.initialised = true;
    }
  }

  setXray(on) {
    for (const m of this.materials) {
      m.depthTest = !on;
      m.needsUpdate = true;
    }
    this.labelSprite.sprite.material.depthTest = !on;
  }

  /** dt in seconds; opacity 0..1; viewerPos in the same (world) frame as the object. */
  update(dt, opacity, viewerPos, showLabel, suffix = '') {
    const k = 1 - Math.exp(-dt * 10);
    this.group.position.lerp(this.target, k);
    this.size.lerp(this.targetSize, k);
    const { x: w, y: h, z: d } = this.size;

    if (this.kind === 'silhouette') {
      const headR = Math.min(0.13, h * 0.075);
      const torsoH = h - headR * 2.2;
      this.torso.scale.set(w * 0.8, torsoH / 2, Math.max(d, 0.2));
      this.torso.position.set(0, -h / 2 + torsoH / 2, 0);
      this.head.scale.setScalar(headR * 2);
      this.head.position.set(0, h / 2 - headR, 0);
    } else {
      this.edges.scale.set(w, h, d);
      this.fill.scale.set(w, h, d);
    }
    this.ring.scale.setScalar(Math.max(w, d) * 1.25);
    this.ring.position.set(0, -h / 2 + 0.01, 0);

    const pulse = 0.85 + 0.15 * Math.sin(performance.now() / 260);
    for (const m of this.materials) {
      if (m.uniforms) m.uniforms.opacity.value = opacity * pulse;
      else m.opacity = opacity;
    }

    const dist = viewerPos ? viewerPos.distanceTo(this.group.position) : 0;
    this.distance = dist;
    this.labelSprite.sprite.visible = showLabel && opacity > 0.05;
    if (this.labelSprite.sprite.visible) {
      this.labelSprite.setText(`${prettyLabel(this.label)} · ${dist.toFixed(1)} m${suffix}`);
      const sc = Math.max(0.12, dist * 0.045);
      this.labelSprite.sprite.scale.set(sc * this.labelSprite.aspect, sc, 1);
      this.labelSprite.sprite.position.set(0, h / 2 + sc * 0.8, 0);
      this.labelSprite.sprite.material.opacity = opacity;
    }
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    this.labelSprite.dispose();
  }
}

export class LabelSprite {
  constructor(color) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 112;
    this.aspect = this.canvas.width / this.canvas.height;
    this.ctx = this.canvas.getContext('2d');
    this.color = color;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.renderOrder = RENDER_ORDER + 1;
    this.text = null;
  }

  setText(text) {
    if (text === this.text) return;
    this.text = text;
    const g = this.ctx;
    const { width: W, height: H } = this.canvas;
    g.clearRect(0, 0, W, H);
    g.font = '600 52px system-ui, -apple-system, "Segoe UI", sans-serif';
    const tw = Math.min(W - 24, g.measureText(text).width + 56);
    const x = (W - tw) / 2;
    g.fillStyle = 'rgba(6, 10, 18, 0.72)';
    roundRect(g, x, 10, tw, H - 20, (H - 20) / 2);
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = this.color;
    g.stroke();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, W / 2, H / 2 + 2);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}

export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
