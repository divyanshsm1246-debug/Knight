/* ============================================================================
   KNIGHT — standalone Node.js WebSocket server
   ----------------------------------------------------------------------------
   This is what makes Knight's chat and live-collaboration features actually
   multiplayer between different people on different devices. It is separate
   from KnightBackendApplication.java (the Java REST API) on purpose — you can
   run this on its own (e.g. a small Node host) and point script.js at it, or
   run it alongside the Java backend.

   WHAT IT DOES
   ------------
   - Accepts WebSocket connections at ws://host:PORT/ws/knight?key=SERVER_KEY
   - Lets clients "join" a room (a project id, or a DM thread id)
   - Relays chat messages, typing indicators, and live file-edit pings to
     everyone else currently in that room
   - Tracks who's online in each room and broadcasts join/leave presence
   - Keeps the last 200 chat messages per room in memory, so someone who joins
     a room late still sees recent history (swap this for a real database —
     see the note at the bottom — if you need history to survive a restart)

   THE SERVER KEY
   ---------------
   Every connection must present a key that matches SERVER_KEY below (or the
   KNIGHT_SERVER_KEY environment variable, which always wins if set). Treat it
   like a password: anyone with it can connect and relay messages through your
   server. A fresh one is generated below so this file works immediately —
   replace it with your own before you tell anyone the server's address.

       Generated default key: see SERVER_KEY on line ~40

   RUNNING IT
   ----------
     npm install ws
     node websocket-server.js
     # or with a custom key and port:
     KNIGHT_SERVER_KEY=your-own-secret PORT=8081 node websocket-server.js

   CONNECTING TO IT FROM script.js
   --------------------------------
   Set these two lines near the top of script.js:
       const API_BASE = "https://your-java-backend.onrender.com";  // REST API
       const WS_BASE  = "wss://your-node-server.onrender.com";     // this file
   script.js already knows how to open the socket, join a room, and send/
   receive chat + file-update messages — see connectKnightSocket() there.
============================================================================ */

'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

/* ---------------------------------------------------------------------------
   CONFIG
--------------------------------------------------------------------------- */

const PORT = process.env.PORT || 8081;

// A real key so this runs out of the box. CHANGE THIS before deploying —
// anyone who has it can connect through your server. Set KNIGHT_SERVER_KEY
// in your environment instead of editing this file, if you'd rather not
// commit a secret to source control.
const SERVER_KEY = process.env.KNIGHT_SERVER_KEY || 'knight_ws_7f3a9c2e1b8d4f6a0c5e9b2d7a1f4c8e';

const MAX_HISTORY_PER_ROOM = 200;
const MAX_MESSAGE_BYTES = 200 * 1024;       // 200 KB — file-update pings can carry a whole file
const HEARTBEAT_INTERVAL_MS = 30000;

/* ---------------------------------------------------------------------------
   STATE (in-memory — see the persistence note at the bottom of this file)
--------------------------------------------------------------------------- */

/** room name -> Set<WebSocket> */
const rooms = new Map();
/** room name -> array of recent {type:'chat', from, username, text, at} */
const roomHistory = new Map();
/** ws -> { userId, username, room } */
const clientInfo = new Map();

function log(...args) {
  console.log('[' + new Date().toISOString() + ']', ...args);
}

function roomSet(room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  return rooms.get(room);
}

function pushHistory(room, entry) {
  const list = roomHistory.get(room) || [];
  list.push(entry);
  if (list.length > MAX_HISTORY_PER_ROOM) list.shift();
  roomHistory.set(room, list);
}

/** Send JSON to every socket in a room, optionally skipping one (the sender). */
function broadcast(room, payload, exclude) {
  const json = JSON.stringify(payload);
  const set = rooms.get(room);
  if (!set) return;
  for (const ws of set) {
    if (ws === exclude) continue;
    if (ws.readyState === ws.OPEN) {
      try { ws.send(json); } catch (e) { log('send failed', e.message); }
    }
  }
}

function leaveRoom(ws) {
  const info = clientInfo.get(ws);
  if (!info || !info.room) return;
  const set = rooms.get(info.room);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(info.room);
  }
  broadcast(info.room, { type: 'presence', room: info.room, userId: info.userId, username: info.username, online: false });
  info.room = null;
}

/* ---------------------------------------------------------------------------
   HTTP SERVER (health check + the WebSocket upgrade lives on this)
--------------------------------------------------------------------------- */

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'up',
      rooms: rooms.size,
      connections: clientInfo.size,
      time: new Date().toISOString(),
    }));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws/knight', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const key = url.searchParams.get('key');
  const userId = url.searchParams.get('userId');
  const username = url.searchParams.get('username') || 'Knight';

  if (key !== SERVER_KEY) {
    log('rejected connection: bad key from', req.socket.remoteAddress);
    ws.close(4001, 'invalid server key');
    return;
  }
  if (!userId) {
    ws.close(4002, 'userId required');
    return;
  }

  clientInfo.set(ws, { userId, username, room: null });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  log('connected:', username, '(' + userId + ')');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    const info = clientInfo.get(ws);
    if (!info) return;

    switch (msg.type) {
      case 'join': {
        const room = String(msg.room || '').slice(0, 200);
        if (!room) return;
        if (info.room) leaveRoom(ws);
        roomSet(room).add(ws);
        info.room = room;
        broadcast(room, { type: 'presence', room, userId: info.userId, username: info.username, online: true }, ws);
        ws.send(JSON.stringify({ type: 'history', room, messages: roomHistory.get(room) || [] }));
        break;
      }

      case 'leave': {
        leaveRoom(ws);
        break;
      }

      case 'chat': {
        if (!info.room) return;
        const text = String(msg.text || '').slice(0, 4000);
        if (!text.trim()) return;
        const entry = {
          type: 'chat', room: info.room, from: info.userId,
          username: info.username, text, at: Date.now(),
        };
        pushHistory(info.room, entry);
        broadcast(info.room, entry);   // including the sender, so every tab stays in sync
        break;
      }

      case 'typing': {
        if (!info.room) return;
        broadcast(info.room, { type: 'typing', room: info.room, from: info.userId, username: info.username }, ws);
        break;
      }

      case 'file-update': {
        // Live "someone else is editing this file" pings for project collaboration.
        // This server relays only — the Java backend's REST API remains the
        // source of truth for what actually gets saved.
        if (!info.room) return;
        broadcast(info.room, {
          type: 'file-update', room: info.room, from: info.userId, username: info.username,
          filename: msg.filename, content: msg.content,
        }, ws);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clientInfo.delete(ws);
    log('disconnected:', username, '(' + userId + ')');
  });

  ws.on('error', (e) => log('socket error for', username, e.message));
});

/** Drop dead connections (phone locked, wifi dropped, etc.) so rooms stay accurate. */
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { leaveRoom(ws); clientInfo.delete(ws); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  log('Knight WebSocket server listening on port', PORT);
  log('Server key (share this with clients, keep it out of public repos):', SERVER_KEY);
  log('Connect with: ws://<host>:' + PORT + '/ws/knight?key=' + SERVER_KEY + '&userId=<id>&username=<name>');
});

/* ============================================================================
   DEPLOYING THIS SOMEWHERE REAL
   ----------------------------------------------------------------------------
   package.json (create this next to the file):
     {
       "name": "knight-websocket-server",
       "version": "1.0.0",
       "main": "websocket-server.js",
       "scripts": { "start": "node websocket-server.js" },
       "dependencies": { "ws": "^8.18.0" }
     }

   Render / Railway / Fly.io: set the start command to `node websocket-server.js`,
   set the KNIGHT_SERVER_KEY environment variable to your own secret, and note
   the PORT they give you is usually injected automatically via process.env.PORT
   (already handled above).

   PERSISTENCE NOTE
   -----------------
   Chat history here lives in memory (`roomHistory`) and is lost on restart —
   fine for live relay, not fine as a permanent record. If you want messages
   to survive restarts, either:
     (a) also POST each chat message to the Java backend's REST API to persist
         it in the database there, and use the REST API for history on join
         instead of `roomHistory`, or
     (b) swap the in-memory Maps here for a real store (Redis, Postgres) —
         the shape of the data (room, from, username, text, at) stays the same.
============================================================================ */
