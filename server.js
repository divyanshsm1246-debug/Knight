// ============================================================
// KNIGHT — server.js
// Real backend: Express REST API + Socket.IO for live chat and
// friend-request notifications. No Supabase, no mock endpoints —
// every route below reads/writes through database.js.
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const RP_NAME = 'Knight';

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy — needed so req.protocol reports https, not http
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

// Log anything that would otherwise die silently — without this, a crash
// deep in a promise chain can leave you with a mysteriously empty/odd
// response and nothing in the logs explaining why.
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));

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
// Like authMiddleware, but never blocks the request — used on routes (project
// browsing) that are readable by anyone but behave differently when the
// caller happens to be signed in (e.g. so "friends only" projects show up).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.userId = jwt.verify(token, JWT_SECRET).userId; } catch (e) { /* ignore bad/expired token here */ }
  }
  next();
}
// A user record can exist without a profile if the server ever crashed between
// creating the two (this happened during the guest-login crash bug). Rather
// than 500 forever, heal it transparently so the account is usable again.
function ensureProfile(user) {
  let profile = db.getProfile(user.id);
  if (!profile) profile = db.createProfile(user.id, { username: user.email ? user.email.split('@')[0] : 'Recovered_Knight' });
  return profile;
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
    if (!profile) { console.error('signup: createProfile returned falsy for user', user.id); return res.status(500).json({ error: 'Account was created but the profile could not be built — check server logs' }); }
    const token = signToken(user.id);
    res.json({ token, profile });
  } catch (e) { console.error('signup error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.findUserByEmail(email);
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const profile = ensureProfile(user);
    if (!profile) { console.error('login: ensureProfile returned falsy for user', user.id); return res.status(500).json({ error: 'Could not load or create a profile — check server logs' }); }
    const token = signToken(user.id);
    res.json({ token, profile });
  } catch (e) { console.error('login error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/guest', (req, res) => {
  try {
    const user = db.createGuestUser();
    const profile = db.createProfile(user.id, { username: 'Guest_Knight', role: 'Coder' });
    if (!profile) { console.error('guest signup: createProfile returned falsy for user', user.id); return res.status(500).json({ error: 'Guest account was created but the profile could not be built' }); }
    const token = signToken(user.id);
    res.json({ token, profile });
  } catch (e) { console.error('guest signup error:', e); res.status(500).json({ error: e.message }); }
});

// ---------- PASSKEYS (WebAuthn — real ceremony via @simplewebauthn/server) ----------
// Registration challenges are short-lived and keyed by user; login (discoverable
// credential) challenges are keyed by a random attemptId since there's no logged-in
// user yet to key them by. Both are in-memory, which is fine for a single instance.
const pendingRegistrations = new Map(); // userId -> challenge
const pendingLogins = new Map();        // attemptId -> { challenge, expires }
const onlineUsers = new Map();          // userId -> count of open sockets (tabs/devices)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingLogins) if (v.expires < now) pendingLogins.delete(k);
}, 5 * 60 * 1000).unref();

function rpID(req) { return req.hostname; }
function rpOrigin(req) { return `${req.protocol}://${req.get('host')}`; }

app.post('/api/auth/passkey/register-options', authMiddleware, async (req, res) => {
  try {
    const profile = db.getProfile(req.userId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const existing = db.getCredentialsByUser(req.userId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpID(req),
      userID: Buffer.from(req.userId, 'utf8'),
      userName: profile.username,
      userDisplayName: profile.username,
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
    });
    pendingRegistrations.set(req.userId, options.challenge);
    res.json(options);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/passkey/register-verify', authMiddleware, async (req, res) => {
  try {
    const expectedChallenge = pendingRegistrations.get(req.userId);
    if (!expectedChallenge) return res.status(400).json({ error: 'No pending passkey registration — try again' });
    const verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge,
      expectedOrigin: rpOrigin(req),
      expectedRPID: rpID(req)
    });
    pendingRegistrations.delete(req.userId);
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey could not be verified' });
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    db.addCredential(req.userId, {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: credential.transports || req.body.credential?.response?.transports || [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      nickname: (req.body.nickname || '').trim() || 'Passkey'
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/auth/passkeys', authMiddleware, (req, res) => {
  const list = db.getCredentialsByUser(req.userId)
    .map(c => ({ id: c.id, nickname: c.nickname, deviceType: c.deviceType, createdAt: c.createdAt }));
  res.json(list);
});

app.delete('/api/auth/passkeys/:id', authMiddleware, (req, res) => {
  const removed = db.deleteCredential(req.params.id, req.userId);
  if (!removed) return res.status(404).json({ error: 'Passkey not found' });
  res.json({ ok: true });
});

app.post('/api/auth/passkey/login-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: rpID(req),
      userVerification: 'preferred'
    });
    const attemptId = crypto.randomUUID();
    pendingLogins.set(attemptId, { challenge: options.challenge, expires: Date.now() + 5 * 60 * 1000 });
    res.json({ attemptId, options });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/passkey/login-verify', async (req, res) => {
  try {
    const { attemptId, credential } = req.body;
    const pending = attemptId && pendingLogins.get(attemptId);
    if (!pending) return res.status(400).json({ error: 'Passkey login expired — try again' });
    pendingLogins.delete(attemptId);

    const stored = credential && db.getCredentialById(credential.id);
    if (!stored) return res.status(400).json({ error: 'That passkey is not registered on this server' });

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: rpOrigin(req),
      expectedRPID: rpID(req),
      credential: {
        id: stored.id,
        publicKey: Buffer.from(stored.publicKey, 'base64'),
        counter: stored.counter,
        transports: stored.transports
      }
    });
    if (!verification.verified) return res.status(400).json({ error: 'Passkey could not be verified' });

    db.updateCredentialCounter(stored.id, verification.authenticationInfo.newCounter);
    const profile = db.getProfile(stored.userId);
    if (!profile) return res.status(404).json({ error: 'Account for this passkey no longer exists' });
    const token = signToken(stored.userId);
    res.json({ token, profile });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- PROFILE ----------
app.get('/api/profile/me', authMiddleware, (req, res) => {
  const user = db.findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  res.json(ensureProfile(user));
});
app.put('/api/profile/me', authMiddleware, (req, res) => {
  try { res.json(db.updateProfile(req.userId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- FRIENDS ----------
app.post('/api/friend-request', authMiddleware, (req, res) => {
  try {
    const { toSocialId } = req.body;
    const { req: request, targetUserId, autoAccepted } = db.sendFriendRequest(req.userId, toSocialId);
    if (autoAccepted) {
      io.to(`user:${targetUserId}`).emit('friend_accepted', { by: db.getProfile(req.userId) });
    } else {
      io.to(`user:${targetUserId}`).emit('friend_request', { fromProfile: db.getProfile(req.userId) });
    }
    res.json({ ...request, autoAccepted: !!autoAccepted });
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
app.get('/api/profile/by-social/:socialId', optionalAuth, (req, res) => {
  const p = db.getPublicProfile(req.params.socialId.toUpperCase(), req.userId || null);
  if (!p) return res.status(404).json({ error: 'No user found with that Social ID' });
  res.json(p);
});
app.get('/api/presence/friends', authMiddleware, (req, res) => {
  const friends = db.listFriends(req.userId);
  res.json(friends.map(f => f.friendId).filter(id => onlineUsers.has(id)));
});

// ---------- PROJECTS ----------
app.post('/api/projects', authMiddleware, (req, res) => {
  try {
    const body = { ...req.body };
    if (Array.isArray(body.visibleToSocialIds)) {
      body.visibleTo = body.visibleToSocialIds
        .map(sid => db.getProfileBySocialId(String(sid).trim())?.userId)
        .filter(Boolean);
    }
    res.json(db.createProject(req.userId, body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/projects', optionalAuth, (req, res) => {
  const { search, category, order } = req.query;
  res.json(db.listProjects({ search, category, order, viewerUserId: req.userId || null }));
});
app.get('/api/projects/mine', authMiddleware, (req, res) => {
  res.json(db.listMyProjects(req.userId));
});
// These must be registered before '/api/projects/:id' — otherwise Express
// matches "trending"/"socials"/"near" as an :id and they never fire.
app.get('/api/projects/trending', optionalAuth, (req, res) => {
  res.json(db.listTrendingProjects(req.userId || null));
});
app.get('/api/projects/socials', authMiddleware, (req, res) => {
  res.json(db.listSocialsProjects(req.userId));
});
app.get('/api/projects/near', optionalAuth, (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = req.query.radius ? parseFloat(req.query.radius) : 200;
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng are required' });
  res.json(db.listNearProjects(lat, lng, radius, req.userId || null));
});
app.get('/api/projects/:id', optionalAuth, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!db.canViewProject(p, req.userId || null)) return res.status(403).json({ error: 'This project is private' });
  const role = req.userId ? (db.getUserRoleOnProject(p.id, req.userId) || (req.userId === p.ownerId ? 'owner' : null)) : null;
  res.json({ ...p, myRole: role, stars: db.getStarCount(p.id), starredByMe: req.userId ? db.hasUserStarred(p.id, req.userId) : false });
});
app.post('/api/projects/:id/star', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || !db.canViewProject(p, req.userId)) return res.status(403).json({ error: 'Not accessible' });
  res.json(db.toggleProjectStar(req.params.id, req.userId));
});
app.put('/api/projects/:id/deployed-url', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can set this' });
  res.json(db.setDeployedUrl(req.params.id, req.body.url));
});

// ---------- JOIN CODE ("passkey" to invite people without knowing their Social ID) ----------
app.get('/api/projects/:id/join-code', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can see this' });
  res.json({ code: p.joinCode, enabled: p.joinCodeEnabled, role: p.joinCodeRole });
});
app.post('/api/projects/:id/join-code/regenerate', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can do this' });
  const updated = db.regenerateJoinCode(req.params.id);
  res.json({ code: updated.joinCode, enabled: updated.joinCodeEnabled, role: updated.joinCodeRole });
});
app.put('/api/projects/:id/join-code', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can do this' });
  const updated = db.updateJoinCodeSettings(req.params.id, req.body);
  res.json({ code: updated.joinCode, enabled: updated.joinCodeEnabled, role: updated.joinCodeRole });
});
app.post('/api/projects/join', authMiddleware, (req, res) => {
  try {
    const { project, role, alreadyMember } = db.joinProjectByCode(req.userId, req.body.code);
    if (!alreadyMember) {
      io.to(`user:${project.ownerId}`).emit('notification', {
        title: 'New member joined', text: `${db.getProfile(req.userId).username} joined ${project.name} as ${role} via passkey`, type: 'green'
      });
    }
    res.json({ project, role, alreadyMember });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- VERSIONS ----------
app.get('/api/projects/:id/versions', optionalAuth, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || !db.canViewProject(p, req.userId || null)) return res.status(403).json({ error: 'Not accessible' });
  try { res.json(db.listVersions(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/projects/:id/versions', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can cut a new version' });
  try { res.json(db.createVersionSnapshot(req.params.id, req.body.note)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/projects/:id/versions/:version/restore', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can restore a version' });
  try { res.json(db.restoreVersion(req.params.id, req.params.version, req.userId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- FILES ----------
app.get('/api/projects/:id/files', optionalAuth, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || !db.canViewProject(p, req.userId || null)) return res.status(403).json({ error: 'Not accessible' });
  res.json(db.listProjectFiles(req.params.id));
});
app.post('/api/projects/:id/files', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const role = p.ownerId === req.userId ? 'owner' : db.getUserRoleOnProject(req.params.id, req.userId);
  // Owner and Editor write straight through. Contributors don't get a direct
  // write here at all — their edits go through /change-requests below and
  // only land once the owner approves them. Viewers can't write anything.
  if (!['owner', 'editor'].includes(role)) {
    return res.status(403).json({ error: role === 'contributor' ? 'Contributors propose changes for approval — use "Propose Change" instead' : 'You need Editor access to add files directly' });
  }
  const { filename, content, language } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename required' });
  res.json(db.upsertProjectFile(req.params.id, filename, content || '', language || 'plaintext', req.userId));
});
app.delete('/api/projects/:id/files/:fileId', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the project owner can delete files' });
  const removed = db.deleteProjectFile(req.params.id, req.params.fileId);
  if (!removed) return res.status(404).json({ error: 'File not found' });
  res.json({ ok: true });
});

// ---------- MEMBERS ----------
app.get('/api/projects/:id/members', optionalAuth, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || !db.canViewProject(p, req.userId || null)) return res.status(403).json({ error: 'Not accessible' });
  res.json(db.listMembers(req.params.id));
});
app.post('/api/projects/:id/members', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner can invite members' });
  try { db.addMemberBySocialId(req.params.id, req.body.socialId, req.body.role); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- CHANGE REQUESTS (the real propose → review → apply flow) ----------
app.post('/api/projects/:id/change-requests', authMiddleware, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const role = p.ownerId === req.userId ? 'owner' : db.getUserRoleOnProject(req.params.id, req.userId);
  if (!['owner', 'editor', 'contributor'].includes(role)) return res.status(403).json({ error: 'You need at least Contributor access to propose a change' });
  try {
    const r = db.submitChangeRequest(req.params.id, { ...req.body, requestedBy: req.userId });
    io.to(`user:${p.ownerId}`).emit('notification', {
      title: 'New change request', text: `${db.getProfile(req.userId).username} proposed a change to ${r.filename} on ${p.name}`, type: 'gold'
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/projects/:id/change-requests', optionalAuth, (req, res) => {
  const p = db.getProject(req.params.id);
  if (!p || !db.canViewProject(p, req.userId || null)) return res.status(403).json({ error: 'Not accessible' });
  res.json(db.listChangeRequests(req.params.id));
});
app.post('/api/change-requests/:id/resolve', authMiddleware, (req, res) => {
  const cr = db.getChangeRequest(req.params.id);
  if (!cr) return res.status(404).json({ error: 'Request not found' });
  const p = db.getProject(cr.projectId);
  // This check didn't exist before — any signed-in user could approve or
  // reject changes on any project. Only the owner may resolve requests now.
  if (!p || p.ownerId !== req.userId) return res.status(403).json({ error: 'Only the project owner can resolve change requests' });
  try {
    const resolved = db.resolveChangeRequest(req.params.id, req.body.status);
    io.to(`user:${cr.requestedBy}`).emit('notification', {
      title: `Change request ${req.body.status}`, text: `Your change to ${cr.filename} on ${p.name} was ${req.body.status}`,
      type: req.body.status === 'approved' ? 'green' : 'coral'
    });
    res.json(resolved);
  } catch (e) { res.status(400).json({ error: e.message }); }
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

  // ---------- Presence (real online/offline, not simulated) ----------
  const wasOffline = !onlineUsers.has(socket.userId);
  onlineUsers.set(socket.userId, (onlineUsers.get(socket.userId) || 0) + 1);
  if (wasOffline) {
    db.listFriends(socket.userId).forEach(f => io.to(`user:${f.friendId}`).emit('presence', { userId: socket.userId, online: true }));
  }

  socket.on('send_message', ({ toUserId, body }) => {
    const message = db.saveMessage(socket.userId, toUserId, body);
    io.to(`user:${toUserId}`).emit('new_message', message);
    io.to(`user:${socket.userId}`).emit('new_message', message); // echo to sender's other tabs
  });

  // ---------- Ping / Wave — instant, no history, just a real-time nudge ----------
  socket.on('send_ping', ({ toUserId }) => {
    if (!db.isFriend(socket.userId, toUserId)) return; // pings are friends-only
    const fromProfile = db.getProfile(socket.userId);
    io.to(`user:${toUserId}`).emit('ping_received', { fromProfile });
  });

  socket.on('disconnect', () => {
    const remaining = (onlineUsers.get(socket.userId) || 1) - 1;
    if (remaining <= 0) {
      onlineUsers.delete(socket.userId);
      db.listFriends(socket.userId).forEach(f => io.to(`user:${f.friendId}`).emit('presence', { userId: socket.userId, online: false }));
    } else {
      onlineUsers.set(socket.userId, remaining);
    }
  });
});

// Catch-all — anything that isn't an API call or a known static asset falls
// through to index.html so the client-side router (script.js) can take over.
// Without this, refreshing or sharing a deep link like /projects/abc123
// would 404 instead of loading the app and letting JS render that route.
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/socket.io')) {
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  console.warn(`404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

server.listen(PORT, () => console.log(`Knight server running on port ${PORT}`));
