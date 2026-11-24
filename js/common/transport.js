// Transports for the SeeThrough protocol.
//
//   RelayLink - WebSocket to the Node relay (real deployments, Quest + phones).
//   LocalLink - BroadcastChannel inside one browser (simulator + viewer in two
//               tabs, or in the same page) with no server at all.
//
// Both expose the same small API:
//   link.on(type, fn)   type is a message `t`, or 'status' / 'any'
//   link.send(msg)
//   link.now()          current time on the relay clock (ms)
//   link.status         'connecting' | 'open' | 'closed'
//   link.rtt            last round-trip time to the relay (ms)
//   link.close()

import { safeGetJSON, safeSetJSON } from './protocol.js';

class Emitter {
  constructor() {
    this._handlers = new Map();
  }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type).delete(fn);
  }
  emit(type, payload) {
    for (const fn of this._handlers.get(type) || []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    }
    if (type !== 'any' && type !== 'status') {
      for (const fn of this._handlers.get('any') || []) {
        try {
          fn(payload);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }
}

export class RelayLink extends Emitter {
  constructor(url, { room, role, name, id }) {
    super();
    this.url = url;
    this.hello = { t: 'hello', room, role, name, id };
    this.id = id;
    this.room = room;
    this.status = 'connecting';
    this.offset = 0; // relay clock - local clock
    this.rtt = null;
    this._bestRtt = Infinity;
    this._closed = false;
    this._retry = 500;
    this._queue = [];
    this._connect();
  }

  _connect() {
    if (this._closed) return;
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._setStatus('closed', String(e.message || e));
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this._retry = 500;
      ws.send(JSON.stringify(this.hello));
      this._ping();
      clearInterval(this._pingTimer);
      let n = 0;
      // Sync the clock quickly at first, then every 2 s.
      this._pingTimer = setInterval(() => {
        n++;
        if (n < 6 || n % 8 === 0) this._ping();
      }, 250);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        const now = performance.timeOrigin + performance.now();
        const rtt = now - msg.c;
        this.rtt = rtt;
        // Keep the offset from the lowest-RTT sample: it has the least queueing error.
        // Let old samples age out so a drifting clock still converges.
        this._bestRtt = Math.min(this._bestRtt * 1.05 + 1, Infinity);
        if (rtt <= this._bestRtt) {
          this._bestRtt = rtt;
          this.offset = msg.s - (msg.c + rtt / 2);
        }
        this.emit('pong', msg);
        return;
      }
      if (msg.t === 'welcome') {
        this.offset = msg.serverTime - Date.now();
        this._setStatus('open');
        for (const m of this._queue.splice(0)) this.send(m);
      }
      if (msg.t === 'error') console.warn('Relay error:', msg.error);
      this.emit(msg.t, msg);
    };
    ws.onclose = () => {
      clearInterval(this._pingTimer);
      this._setStatus('closed');
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  _ping() {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ t: 'ping', c: performance.timeOrigin + performance.now() }));
    }
  }

  _scheduleReconnect() {
    if (this._closed) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect(), this._retry);
    this._retry = Math.min(this._retry * 2, 8000);
  }

  _setStatus(s, detail) {
    this.status = s;
    this.emit('status', { status: s, detail });
  }

  now() {
    return Date.now() + this.offset;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1 && this.status === 'open') {
      // Skip object updates when the socket is backed up: a fresher one is coming.
      if (msg.t === 'objects' && this.ws.bufferedAmount > 64 * 1024) return;
      this.ws.send(JSON.stringify(msg));
    } else if (msg.t !== 'objects' && msg.t !== 'thumb') {
      this._queue.push(msg);
    }
  }

  close() {
    this._closed = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

// Same-page registry so several LocalLinks in one page (simulator + viewer) talk directly.
const pageLinks = new Set();

export class LocalLink extends Emitter {
  constructor({ room, role, name, id }) {
    super();
    this.room = room;
    this.role = role;
    this.name = name;
    this.id = id;
    this.status = 'connecting';
    this.rtt = 0;
    this.offset = 0;
    this.mapKey = `seethrough.localmap.${room}`;
    try {
      this.channel = new BroadcastChannel(`seethrough:${room}`);
      this.channel.onmessage = (ev) => this._receive(ev.data);
    } catch {
      this.channel = null;
    }
    pageLinks.add(this);
    // Deliver the welcome asynchronously, like the relay would.
    setTimeout(() => {
      this.status = 'open';
      this.emit('status', { status: 'open' });
      this.emit('welcome', {
        t: 'welcome',
        id,
        room,
        serverTime: Date.now(),
        map: safeGetJSON(this.mapKey),
        cameras: [],
        thumbs: [],
        peers: [],
      });
      this._post({ t: 'peer', id, role, name, joined: true });
    }, 0);
  }

  _receive(msg) {
    if (!msg || msg.from === this.id) return;
    if (msg.t === 'map') safeSetJSON(this.mapKey, msg.map);
    this.emit(msg.t, msg);
  }

  _post(msg) {
    const m = { ...msg, from: this.id };
    for (const l of pageLinks) if (l !== this && l.room === this.room) l._receive(m);
    if (this.channel) this.channel.postMessage(m);
  }

  now() {
    return Date.now();
  }

  send(msg) {
    if (msg.t === 'objects') msg.rx = Date.now();
    if (msg.t === 'map') {
      msg = { ...msg, map: msg.map ? { ...msg.map, updated: Date.now() } : null };
      safeSetJSON(this.mapKey, msg.map);
    }
    if (msg.t === 'clearMap') {
      safeSetJSON(this.mapKey, null);
      msg = { t: 'map', map: null };
    }
    this._post(msg);
  }

  close() {
    this._post({ t: 'peer', id: this.id, role: this.role, joined: false });
    pageLinks.delete(this);
    if (this.channel) this.channel.close();
  }
}

/** Opens a relay link when a URL is given, otherwise a local (no-server) link. */
export function openLink(url, opts) {
  return url ? new RelayLink(url, opts) : new LocalLink(opts);
}
