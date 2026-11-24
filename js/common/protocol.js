// Shared constants and small helpers for the SeeThrough protocol.
//
// Messages are JSON objects with a `t` (type) field:
//   hello      {t, role:'viewer'|'camera'|'sim', id, name, room}
//   welcome    {t, id, room, serverTime, map, cameras[], thumbs[], peers[]}
//   ping/pong  {t:'ping', c} -> {t:'pong', c, s}        (clock sync)
//   camera     {t, id, name, color, kind, pose:{p:[x,y,z], q:[x,y,z,w]}|null, fovH, active}
//              kind 'headset' is the headset itself: it is a device that detects too.
//   pose       {t, id, pose:{p, q}}  fast position updates for a moving device (headset), ~10 Hz
//   cameraGone {t, id}
//   objects    {t, cam, ts, objs:[{id, label, p:[x,y,z], s:[w,h,d], c, kind}]}
//              ts is in relay-clock milliseconds; p is the object's centre in world metres.
//              Sent by phones, Python nodes and the headset alike; every device shows
//              everyone else's detections (positions only, never video).
//   thumb      {t, cam, img:'data:image/jpeg;base64,...'}
//   map        {t, map:{markers:{[id]:{p:[x,y,z], yaw, size}}, anchor, updated}}
//
// World frame: metres, +Y up, floor at y = 0. The origin is on the floor directly
// below the anchor marker; +Z points out of the anchor marker's wall.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_MARKER_SIZE = 0.15; // metres, black square edge to edge
export const MARKER_DICTIONARY = 'ARUCO_MIP_36h12';
export const SEND_HZ = 12;
export const POSE_HZ = 10;
export const FADE_START_S = 1.0;
export const FADE_END_S = 2.5;

export const PALETTE = [
  '#38e8ff', // cyan
  '#ff4fd8', // magenta
  '#ffd23f', // amber
  '#7dff6a', // green
  '#ff7a45', // orange
  '#a78bfa', // violet
  '#4ade80', // mint
  '#f87171', // coral
];

/** The headset's colour on every map and outline (phones use PALETTE colours). */
export const HEADSET_COLOR = '#ffffff';

export function colorForIndex(i) {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function randomId(prefix = '') {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return prefix + [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
}

export function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return [...a].map((b) => chars[b % chars.length]).join('');
}

export function normalizeRoom(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/** Pretty label for a COCO class name. */
export function prettyLabel(label) {
  if (!label) return 'Object';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Labels that should be drawn as a silhouette rather than a box. */
export const SILHOUETTE_LABELS = new Set(['person']);

/** Query-string helper. */
export function qs(name, fallback = null) {
  const v = new URLSearchParams(location.search).get(name);
  return v === null ? fallback : v;
}

/** Default relay URL: same origin when the page is served by the relay itself. */
export function defaultRelayUrl() {
  const saved = safeGet('seethrough.relay');
  if (saved) return saved;
  if (location.hostname.endsWith('github.io') || location.protocol === 'file:') return '';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode etc.) */
  }
}

export function safeGetJSON(key) {
  try {
    const v = safeGet(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

export function safeSetJSON(key, value) {
  safeSet(key, value === null ? null : JSON.stringify(value));
}
