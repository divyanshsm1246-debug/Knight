// ============================================================
// KNIGHT — server.js
// Real backend: Express REST API + Socket.IO for live chat and
// friend-request notifications. No Supabase, no mock endpoints —
// every route below reads/writes through database.js.
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
// SECURITY FIX: express.static(__dirname) used to serve EVERY file in this
// folder — including server.js, database.js, package.json, and worst of all
// data.json (which holds password hashes and every user's data) to anyone
// who requested them directly. That's a real data leak, not a style issue.
// Only the three files the browser actually needs are served now.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.sendFile(path.join(__dirname, 'style.css'));
});
app.get('/script.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'script.js'));
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- AUTH HELPERS ----------
function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------- AUTH ROUTES ----------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, username, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (db.findUserByEmail(email)) return res.status(400).json({ error: 'An account with that email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = db.createUser(email, passwordHash);
    const profile = db.createProfile(user.id, { username: username || email.split('@')[0], role: role || 'Coder' });
    const token = signToken(user.id);
    res.json({ token, profile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.findUserByEmail(email);
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const profile = db.getProfile(user.id);
    const token = signToken(user.id);
    res.json({ token, profile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/guest', (req, res) => {
  try {
    const user = db.createGuestUser();
    const profile = db.createProfile(user.id, { username: 'Guest_Knight', role: 'Coder' });
    const token = signToken(user.id);
    res.json({ token, profile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- PROFILE ----------
app.get('/api/profile/me', authMiddleware, (req, res) => {
  const profile = db.getProfile(req.userId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});
app.put('/api/profile/me', authMiddleware, (req, res) => {
  try { res.json(db.updateProfile(req.userId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- FRIENDS ----------
app.post('/api/friend-request', authMiddleware, (req, res) => {
  try {
    const { toSocialId } = req.body;
    const { req: request, targetUserId } = db.sendFriendRequest(req.userId, toSocialId);
    io.to(`user:${targetUserId}`).emit('friend_request', { fromProfile: db.getProfile(req.userId) });
    res.json(request);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/friend-requests/incoming', authMiddleware, (req, res) => {
  const profile = db.getProfile(req.userId);
  res.json(db.listIncomingRequests(profile.socialId));
});
app.post('/api/friend-request/:id/accept', authMiddleware, (req, res) => {
  try {
    const fromUserId = db.acceptFriendRequest(req.params.id, req.userId);
    io.to(`user:${fromUserId}`).emit('friend_accepted', { by: db.getProfile(req.userId) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/friends', authMiddleware, (req, res) => {
  res.json(db.listFriends(req.userId));
});

// ---------- PROJECTS ----------
app.post('/api/projects', authMiddleware, (req, res) => {
  try { res.json(db.createProject(req.userId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/projects', (req, res) => {
  const { search, category, order } = req.query;
  res.json(db.listProjects({ search, category, order }));
});
app.get('/api/projects/:id', (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});
app.put('/api/projects/:id/deployed-url', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can set this' });
  res.json(db.setDeployedUrl(req.params.id, req.body.url));
});
app.get('/api/projects/:id/files', (req, res) => {
  res.json(db.listProjectFiles(req.params.id));
});
app.post('/api/projects/:id/files', authMiddleware, (req, res) => {
  const role = db.getUserRoleOnProject(req.params.id, req.userId);
  if (!['owner', 'editor', 'contributor'].includes(role)) return res.status(403).json({ error: 'You need Editor or Contributor access to add files' });
  const { filename, content, language } = req.body;
  res.json(db.upsertProjectFile(req.params.id, filename, content || '', language || 'plaintext', req.userId));
});
app.get('/api/projects/:id/members', (req, res) => {
  res.json(db.listMembers(req.params.id));
});
app.post('/api/projects/:id/members', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can invite members' });
  try { db.addMemberBySocialId(req.params.id, req.body.socialId, req.body.role); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/projects/:id/change-requests', authMiddleware, (req, res) => {
  const r = db.submitChangeRequest(req.params.id, req.body.fileId, req.userId, req.body.summary);
  const project = db.getProject(req.params.id);
  io.to(`user:${project.ownerId}`).emit('notification', {
    title: 'New change request', text: `${db.getProfile(req.userId).username} requested a change on ${project.name}`, type: 'gold'
  });
  res.json(r);
});
app.get('/api/projects/:id/change-requests', (req, res) => {
  res.json(db.listChangeRequests(req.params.id));
});
app.post('/api/change-requests/:id/resolve', authMiddleware, (req, res) => {
  res.json(db.resolveChangeRequest(req.params.id, req.body.status));
});

// ---------- NOTES ----------
app.get('/api/notes', authMiddleware, (req, res) => res.json(db.listNotes(req.userId)));
app.post('/api/notes', authMiddleware, (req, res) => res.json(db.createNote(req.userId, req.body.title || 'Untitled note', req.body.content || '')));
app.put('/api/notes/:id', authMiddleware, (req, res) => {
  try { res.json(db.updateNote(req.params.id, req.body.title, req.body.content)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/notes/:id', authMiddleware, (req, res) => { db.deleteNote(req.params.id); res.json({ ok: true }); });

// ---------- CHAT (history via REST, live delivery via Socket.IO) ----------
app.get('/api/chat/:friendId', authMiddleware, (req, res) => {
  res.json(db.loadThread(req.userId, req.params.friendId));
});

// ---------- ADMIN ----------
app.get('/api/admin/check', authMiddleware, (req, res) => {
  const profile = db.getProfile(req.userId);
  res.json({ isAdmin: !!profile?.isAdmin });
});
app.get('/api/admin/projects', authMiddleware, (req, res) => {
  const profile = db.getProfile(req.userId);
  if (!profile?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  res.json(db.listProjects({}));
});

// ---------- SOCKET.IO (real-time chat) ----------
io.use((socket, next) => {
  try {
    const decoded = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (e) { next(new Error('Unauthorized socket connection')); }
});
io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
  socket.on('send_message', ({ toUserId, body }) => {
    const message = db.saveMessage(socket.userId, toUserId, body);
    io.to(`user:${toUserId}`).emit('new_message', message);
    io.to(`user:${socket.userId}`).emit('new_message', message); // echo to sender's other tabs
  });
});

// Catch-all 404 — logs the exact path so Render's logs tell you
// immediately if the frontend is requesting a route that doesn't exist,
// instead of a silent unexplained 404 in the browser.
app.use((req, res) => {
  console.warn(`404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

server.listen(PORT, () => console.log(`Knight server running on port ${PORT}`));
