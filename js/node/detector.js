// On-device object detection for the browser camera node.
// Uses TensorFlow.js + COCO-SSD (MobileNet-SSD), loaded from a CDN on first use so
// the page stays light until the camera actually starts. Everything runs locally.

const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const COCO = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

export class CocoDetector {
  constructor({ base = 'lite_mobilenet_v2' } = {}) {
    this.base = base;
    this.model = null;
    this.busy = false;
  }

  async load(onStatus = () => {}) {
    onStatus('Loading TensorFlow.js…');
    await loadScript(TFJS);
    await loadScript(COCO);
    try {
      await window.tf.setBackend('webgl');
    } catch {
      /* falls back to whatever is available */
    }
    await window.tf.ready();
    onStatus(`Loading COCO-SSD (${this.base})…`);
    this.model = await window.cocoSsd.load({ base: this.base });
    onStatus(`Detector ready · ${window.tf.getBackend()} · COCO-SSD ${this.base}`);
  }

  /** source: video/canvas/image. Returns [{label, score, bbox:{x,y,w,h}}] in source pixels. */
  async detect(source, maxResults = 20, minScore = 0.4) {
    if (!this.model) return [];
    const preds = await this.model.detect(source, maxResults, minScore);
    return preds.map((p) => ({ label: p.class, score: p.score, bbox: { x: p.bbox[0], y: p.bbox[1], w: p.bbox[2], h: p.bbox[3] } }));
  }
}
