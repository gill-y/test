// SeeThrough relay server.
//
// - Serves the web apps (viewer, camera node, simulator) from the repo root.
// - Runs a WebSocket relay at /ws. Clients join a room with a code; object updates
//   from any device (phones, Python nodes, the headset) are forwarded to everyone
//   else in the room, so every device sees what the others detect.
// - Keeps per-room state (the map's id, camera list) and saves the map to disk, so
//   cameras calibrated against it stay valid across relay restarts.
//
// HTTPS is used automatically when server/certs/key.pem + cert.pem exist
// (run `npm run cert` to make a self-signed pair). WebXR on Quest needs HTTPS.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const CERT_DIR = path.join(__dirname, 'certs');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const KEY = path.join(CERT_DIR, 'key.pem');
const CERT = path.join(CERT_DIR, 'cert.pem');
const useHttps = !args.http && fs.existsSync(KEY) && fs.existsSync(CERT);
const PORT = Number(args.port || process.env.PORT || (useHttps ? 8443 : 8080));
const HOST = args.host || process.env.HOST || '0.0.0.0';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Never serve server internals (certs, saved maps, node_modules) or git metadata.
const BLOCKED = [/^\/server\//, /^\/\.git/, /node_modules/];

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, time: Date.now() }));
    return;
  }
  if (BLOCKED.some((re) => re.test(urlPath))) {
    res.writeHead(404).end('Not found');
    return;
  }
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = useHttps
  ? https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, serveStatic)
  : http.createServer(serveStatic);

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

const ROOM_RE = /^[A-Z0-9]{3,12}$/;

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Set();
    this.cameras = new Map(); // id -> camera info (last 'camera' message)
    this.thumbs = new Map(); // id -> last thumbnail message
    this.mapFile = path.join(DATA_DIR, `${code}.json`);
    this.map = null;
    try {
      this.map = JSON.parse(fs.readFileSync(this.mapFile, 'utf8'));
    } catch {
      /* no saved map yet */
    }
  }
  saveMap() {
    fs.writeFile(this.mapFile, JSON.stringify(this.map, null, 2), () => {});
  }
  broadcast(msg, except) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const c of this.clients) {
      if (c !== except && c.readyState === 1) {
        // Drop updates for clients that are badly backed up rather than queueing
        // stale positions: latency matters more than completeness here.
        if (c.bufferedAmount > 512 * 1024) continue;
        c.send(data);
      }
    }
  }
}

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = new Room(code);
    rooms.set(code, r);
  }
  return r;
}

// ---------------------------------------------------------------- websocket relay

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
let nextId = 1;

wss.on('connection', (ws, req) => {
  ws.id = `c${nextId++}`;
  ws.room = null;
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
      return;
    }

    if (msg.t === 'hello') {
      const code = String(msg.room || '').toUpperCase();
      if (!ROOM_RE.test(code)) {
        ws.send(JSON.stringify({ t: 'error', error: 'Room code must be 3-12 letters or digits.' }));
        return;
      }
      if (ws.room) leave(ws);
      const room = getRoom(code);
      ws.room = room;
      ws.role = msg.role === 'camera' || msg.role === 'sim' ? msg.role : 'viewer';
      ws.clientId = typeof msg.id === 'string' && msg.id.length < 64 ? msg.id : ws.id;
      ws.name = String(msg.name || ws.role).slice(0, 40);
      room.clients.add(ws);
      ws.send(
        JSON.stringify({
          t: 'welcome',
          id: ws.clientId,
          room: code,
          serverTime: Date.now(),
          map: room.map,
          cameras: [...room.cameras.values()],
          thumbs: [...room.thumbs.values()],
          peers: [...room.clients].map((c) => ({ id: c.clientId, role: c.role, name: c.name })),
        })
      );
      room.broadcast({ t: 'peer', id: ws.clientId, role: ws.role, name: ws.name, joined: true }, ws);
      log(`${ws.role} "${ws.name}" joined ${code} (${room.clients.size} in room)`);
      return;
    }

    const room = ws.room;
    if (!room) return;

    switch (msg.t) {
      case 'objects': {
        // Stamp arrival time so viewers can see relay delay; forward to the room.
        msg.rx = Date.now();
        room.broadcast(msg, ws);
        break;
      }
      case 'camera': {
        if (typeof msg.id !== 'string') return;
        ws.cameraIds = ws.cameraIds || new Set();
        ws.cameraIds.add(msg.id);
        room.cameras.set(msg.id, msg);
        room.broadcast(msg, ws);
        break;
      }
      case 'pose': {
        // A moving device (the headset): keep its stored entry fresh for late joiners.
        if (typeof msg.id !== 'string' || !msg.pose) return;
        const cam = room.cameras.get(msg.id);
        if (cam) cam.pose = msg.pose;
        room.broadcast(msg, ws);
        break;
      }
      case 'thumb': {
        if (typeof msg.img !== 'string' || msg.img.length > 60000) return;
        room.thumbs.set(msg.cam, msg);
        room.broadcast(msg, ws);
        break;
      }
      case 'map': {
        if (!msg.map || typeof msg.map !== 'object' || typeof msg.map.worldId !== 'string') return;
        room.map = { ...msg.map, updated: Date.now() };
        room.saveMap();
        room.broadcast({ t: 'map', map: room.map }, ws);
        log(`map ${room.map.worldId || '(none)'} in ${room.code}`);
        break;
      }
      case 'clearMap': {
        room.map = null;
        fs.rm(room.mapFile, { force: true }, () => {});
        room.broadcast({ t: 'map', map: null }, ws);
        break;
      }
      default:
        // Unknown message types are relayed as-is so clients can extend the protocol.
        room.broadcast(msg, ws);
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  for (const camId of ws.cameraIds || []) {
    room.cameras.delete(camId);
    room.thumbs.delete(camId);
    room.broadcast({ t: 'cameraGone', id: camId });
  }
  room.broadcast({ t: 'peer', id: ws.clientId, role: ws.role, joined: false });
  log(`${ws.role} "${ws.name}" left ${room.code} (${room.clients.size} in room)`);
  ws.room = null;
  if (room.clients.size === 0) rooms.delete(room.code);
}

// Drop dead connections (phones that went to sleep, etc.).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

function log(...a) {
  if (!args.quiet) console.log(new Date().toISOString().slice(11, 19), ...a);
}

server.listen(PORT, HOST, () => {
  const proto = useHttps ? 'https' : 'http';
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`\nSeeThrough relay running (${useHttps ? 'HTTPS + WSS' : 'HTTP + WS'})`);
  console.log(`  this computer: ${proto}://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  on your LAN:   ${proto}://${ip}:${PORT}/`);
  if (!useHttps) console.log('\n  WebXR and phone cameras need HTTPS. Run `npm run cert` and restart.');
  console.log('');
});

export { server };
