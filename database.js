// ============================================================
// KNIGHT — database.js
// A real, working data layer. No Supabase, no mock data.
//
// Storage: a single JSON file on disk, loaded into memory at
// boot and written back after every mutation. This is genuine
// persistence, not a fake in-memory demo — restart the server
// and your data is still there, AS LONG AS the disk itself
// persists (see the note in render.yaml about Render's default
// ephemeral filesystem).
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'data.json');

const EMPTY_DB = {
  users: [],            // { id, email, passwordHash, createdAt }
  profiles: [],         // { userId, socialId, username, role, bio, github, twitter, device, level, followers, projects, commits, avatar, isAdmin, camSettings, socialSettings }
  friendRequests: [],    // { id, fromUserId, toSocialId, status }
  friends: [],           // { userId, friendId }
  projects: [],          // { id, ownerId, name, description, category, stars, deployedUrl, createdAt }
  projectFiles: [],       // { id, projectId, filename, content, language, updatedBy, updatedAt }
  projectMembers: [],     // { projectId, userId, role }
  changeRequests: [],     // { id, projectId, fileId, requestedBy, summary, status, createdAt }
  notes: [],              // { id, userId, title, content, createdAt }
  chatMessages: [],       // { id, fromUser, toUser, body, createdAt }
  credentials: [],        // { id (credentialID, base64url), userId, publicKey (base64), counter, deviceType, backedUp, transports, nickname, createdAt }
  projectStars: []        // { projectId, userId, createdAt } — one row per user who starred a project
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
  const loaded = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // Merge so older data.json files (from before a schema addition, e.g. credentials)
  // don't crash the server with "cannot read property of undefined".
  return { ...EMPTY_DB, ...loaded };
}

let db = load();
function persist() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function id() { return crypto.randomUUID(); }
function socialId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "KNT-";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------- USERS / PROFILES ----------
function findUserByEmail(email) {
  // Guest accounts have email:null — guard against them or this crashes
  // every future signup/login the moment one guest account exists.
  return db.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
}
function findUserById(userId) {
  return db.users.find(u => u.id === userId);
}
function createUser(email, passwordHash) {
  const user = { id: id(), email, passwordHash, createdAt: new Date().toISOString() };
  db.users.push(user);
  persist();
  return user;
}
function createGuestUser() {
  const user = { id: id(), email: null, passwordHash: null, createdAt: new Date().toISOString(), guest: true };
  db.users.push(user);
  persist();
  return user;
}
function createProfile(userId, { username, role = 'Coder', device = 'Windows' }) {
  const profile = {
    userId, socialId: socialId(), username, role, bio: '', github: '', twitter: '',
    device, level: 1, followers: 0, projects: 0, commits: 0, avatar: null, isAdmin: false,
    camSettings: { deviceId: '', micId: '', mirror: true },
    socialSettings: { allowFriendRequests: true, autoAcceptFriends: false, showSocialIdOnCard: true }
  };
  db.profiles.push(profile);
  persist();
  return profile;
}
function getProfile(userId) {
  return db.profiles.find(p => p.userId === userId);
}
function getProfileBySocialId(sid) {
  return db.profiles.find(p => p.socialId === sid);
}
function updateProfile(userId, updates) {
  const p = getProfile(userId);
  if (!p) throw new Error('Profile not found');
  Object.assign(p, updates);
  persist();
  return p;
}

function getPublicProfile(sid, viewerUserId) {
  const profile = getProfileBySocialId(sid);
  if (!profile) return null;
  const friends = isFriend(profile.userId, viewerUserId);
  const projects = listProjects({ viewerUserId }).filter(p => p.ownerId === profile.userId);
  return {
    userId: profile.userId, socialId: profile.socialId, username: profile.username, role: profile.role,
    bio: profile.bio, github: profile.github, twitter: profile.twitter, avatar: profile.avatar,
    level: profile.level, followers: profile.followers, projects: profile.projects, commits: profile.commits,
    isFriend: friends, isSelf: profile.userId === viewerUserId,
    publicProjects: projects.map(p => ({ id: p.id, name: p.name, description: p.description, category: p.category, tags: p.tags, stars: p.stars, version: p.version }))
  };
}

// ---------- FRIENDS ----------
function sendFriendRequest(fromUserId, toSocialId) {
  const target = getProfileBySocialId(toSocialId);
  if (!target) throw new Error('No user found with that Social ID');
  if (target.userId === fromUserId) throw new Error("You can't send a friend request to yourself");
  const already = db.friends.find(f => f.userId === fromUserId && f.friendId === target.userId);
  if (already) throw new Error('You are already friends');
  const social = target.socialSettings || {};
  if (social.allowFriendRequests === false) throw new Error('This user is not accepting friend requests right now');

  if (social.autoAcceptFriends) {
    // Real auto-accept path — skip the pending state entirely.
    db.friends.push({ userId: fromUserId, friendId: target.userId });
    db.friends.push({ userId: target.userId, friendId: fromUserId });
    const req = { id: id(), fromUserId, toSocialId, status: 'accepted', createdAt: new Date().toISOString() };
    db.friendRequests.push(req);
    persist();
    return { req, targetUserId: target.userId, autoAccepted: true };
  }

  const req = { id: id(), fromUserId, toSocialId, status: 'pending', createdAt: new Date().toISOString() };
  db.friendRequests.push(req);
  persist();
  return { req, targetUserId: target.userId, autoAccepted: false };
}
function listIncomingRequests(mySocialId) {
  return db.friendRequests
    .filter(r => r.toSocialId === mySocialId && r.status === 'pending')
    .map(r => ({ ...r, fromProfile: getProfile(r.fromUserId) }));
}
function acceptFriendRequest(requestId, myUserId) {
  const req = db.friendRequests.find(r => r.id === requestId);
  if (!req) throw new Error('Request not found');
  req.status = 'accepted';
  db.friends.push({ userId: myUserId, friendId: req.fromUserId });
  db.friends.push({ userId: req.fromUserId, friendId: myUserId });
  persist();
  return req.fromUserId;
}
function listFriends(userId) {
  return db.friends.filter(f => f.userId === userId).map(f => ({ friendId: f.friendId, profile: getProfile(f.friendId) }));
}

// ---------- PROJECTS ----------
function generateJoinCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function createProject(ownerId, { name, description, category, tags, visibility, visibleTo, location }) {
  const p = {
    id: id(), ownerId, name, description: description || '', category: category || 'General',
    tags: Array.isArray(tags) ? tags.filter(Boolean).slice(0, 8) : [],
    visibility: ['public', 'private', 'friends', 'selected'].includes(visibility) ? visibility : 'public',
    visibleTo: visibility === 'selected' && Array.isArray(visibleTo) ? visibleTo : [],
    location: (location && typeof location.lat === 'number' && typeof location.lng === 'number')
      ? { lat: location.lat, lng: location.lng, label: (location.label || '').slice(0, 60) } : null,
    stars: 0, deployedUrl: null, version: 1,
    versionHistory: [{ version: 1, note: 'Initial version', createdAt: new Date().toISOString(), files: [] }],
    joinCode: generateJoinCode(), joinCodeEnabled: true, joinCodeRole: 'contributor',
    createdAt: new Date().toISOString()
  };
  db.projects.push(p);
  persist();
  return p;
}

// ---------- STARS (real, one per user — not a fake counter) ----------
function getStarCount(projectId) {
  return db.projectStars.filter(s => s.projectId === projectId).length;
}
function hasUserStarred(projectId, userId) {
  return !!db.projectStars.find(s => s.projectId === projectId && s.userId === userId);
}
function toggleProjectStar(projectId, userId) {
  const existing = db.projectStars.find(s => s.projectId === projectId && s.userId === userId);
  if (existing) {
    db.projectStars = db.projectStars.filter(s => s !== existing);
  } else {
    db.projectStars.push({ projectId, userId, createdAt: new Date().toISOString() });
  }
  persist();
  return { starred: !existing, count: getStarCount(projectId) };
}
function withComputedStars(p, viewerUserId) {
  return { ...p, stars: getStarCount(p.id), starredByMe: viewerUserId ? hasUserStarred(p.id, viewerUserId) : false };
}
function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Simple, honest trending score — rewards stars, decays with age, so a
// popular week-old project doesn't bury something great from an hour ago.
function trendingScore(p) {
  const ageHours = Math.max(1, (Date.now() - new Date(p.createdAt).getTime()) / 36e5);
  return (getStarCount(p.id) + 1) / Math.pow(ageHours + 2, 1.3);
}
function listTrendingProjects(viewerUserId) {
  return db.projects.filter(p => canViewProject(p, viewerUserId))
    .sort((a, b) => trendingScore(b) - trendingScore(a))
    .map(p => withComputedStars(p, viewerUserId));
}
function listSocialsProjects(userId) {
  const friendIds = new Set(db.friends.filter(f => f.userId === userId).map(f => f.friendId));
  return db.projects.filter(p => friendIds.has(p.ownerId) && canViewProject(p, userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(p => withComputedStars(p, userId));
}
function listNearProjects(lat, lng, radiusKm, viewerUserId) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return [];
  return db.projects
    .filter(p => p.location && canViewProject(p, viewerUserId))
    .map(p => ({ ...withComputedStars(p, viewerUserId), distanceKm: haversineKm({ lat, lng }, p.location) }))
    .filter(p => p.distanceKm <= (radiusKm || 200))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
function regenerateJoinCode(projectId) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  p.joinCode = generateJoinCode();
  persist();
  return p;
}
function updateJoinCodeSettings(projectId, { enabled, role }) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  if (typeof enabled === 'boolean') p.joinCodeEnabled = enabled;
  if (['viewer', 'contributor', 'editor'].includes(role)) p.joinCodeRole = role;
  persist();
  return p;
}
function joinProjectByCode(userId, code) {
  const p = db.projects.find(pr => pr.joinCode === (code || '').trim().toLowerCase());
  if (!p) throw new Error('Invalid or expired passkey');
  if (!p.joinCodeEnabled) throw new Error('This project is not accepting new members right now');
  if (p.ownerId === userId) throw new Error("You already own this project");
  const existing = db.projectMembers.find(m => m.projectId === p.id && m.userId === userId);
  if (existing) { existing.role = existing.role; persist(); return { project: p, role: existing.role, alreadyMember: true }; }
  db.projectMembers.push({ projectId: p.id, userId, role: p.joinCodeRole });
  persist();
  return { project: p, role: p.joinCodeRole, alreadyMember: false };
}
function isFriend(userA, userB) {
  return !!db.friends.find(f => f.userId === userA && f.friendId === userB);
}
function canViewProject(project, viewerUserId) {
  if (!project) return false;
  if (project.visibility === 'public' || !project.visibility) return true;
  if (!viewerUserId) return false;
  if (project.ownerId === viewerUserId) return true;
  if (db.projectMembers.find(m => m.projectId === project.id && m.userId === viewerUserId)) return true;
  if (project.visibility === 'friends') return isFriend(project.ownerId, viewerUserId);
  if (project.visibility === 'selected') return (project.visibleTo || []).includes(viewerUserId);
  return false;
}
function listProjects({ search = '', category = '', order = 'stars', viewerUserId = null } = {}) {
  let list = db.projects.filter(p => canViewProject(p, viewerUserId));
  if (search) list = list.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  if (category) list = list.filter(p => p.category === category);
  list.sort((a, b) => order === 'createdAt' ? new Date(b.createdAt) - new Date(a.createdAt) : getStarCount(b.id) - getStarCount(a.id));
  return list.map(p => withComputedStars(p, viewerUserId));
}
// Owned projects + projects you were invited onto as a member — this is
// what the "Projects Manager" screen shows, as opposed to public discovery.
function listMyProjects(userId) {
  const memberProjectIds = new Set(db.projectMembers.filter(m => m.userId === userId).map(m => m.projectId));
  return db.projects
    .filter(p => p.ownerId === userId || memberProjectIds.has(p.id))
    .map(p => ({ ...withComputedStars(p, userId), myRole: p.ownerId === userId ? 'owner' : getUserRoleOnProject(p.id, userId) }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function getProject(projectId) {
  return db.projects.find(p => p.id === projectId);
}
function setDeployedUrl(projectId, url) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  p.deployedUrl = url;
  persist();
  return p;
}
function starProject(projectId, stars) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  p.stars = stars;
  persist();
  return p;
}
function createVersionSnapshot(projectId, note) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  const files = listProjectFiles(projectId).map(f => ({ filename: f.filename, content: f.content, language: f.language }));
  p.version = (p.version || 1) + 1;
  const snapshot = { version: p.version, note: note || `Version ${p.version}`, createdAt: new Date().toISOString(), files };
  p.versionHistory = p.versionHistory || [];
  p.versionHistory.push(snapshot);
  persist();
  return snapshot;
}
function listVersions(projectId) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  return (p.versionHistory || []).map(v => ({ version: v.version, note: v.note, createdAt: v.createdAt, fileCount: v.files.length }));
}
function restoreVersion(projectId, versionNumber, restoredBy) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  const snap = (p.versionHistory || []).find(v => v.version === Number(versionNumber));
  if (!snap) throw new Error('Version not found');
  snap.files.forEach(f => upsertProjectFile(projectId, f.filename, f.content, f.language, restoredBy));
  persist();
  return snap;
}
function getUserRoleOnProject(projectId, userId) {
  const p = getProject(projectId);
  if (p && p.ownerId === userId) return 'owner';
  const m = db.projectMembers.find(m => m.projectId === projectId && m.userId === userId);
  return m ? m.role : null;
}
function listProjectFiles(projectId) {
  return db.projectFiles.filter(f => f.projectId === projectId);
}
function upsertProjectFile(projectId, filename, content, language, userId) {
  let f = db.projectFiles.find(f => f.projectId === projectId && f.filename === filename);
  if (f) {
    f.content = content; f.language = language; f.updatedBy = userId; f.updatedAt = new Date().toISOString();
  } else {
    f = { id: id(), projectId, filename, content, language, updatedBy: userId, updatedAt: new Date().toISOString() };
    db.projectFiles.push(f);
  }
  persist();
  return f;
}
function getProjectFile(fileId) {
  return db.projectFiles.find(f => f.id === fileId);
}
function deleteProjectFile(projectId, fileId) {
  const before = db.projectFiles.length;
  db.projectFiles = db.projectFiles.filter(f => !(f.id === fileId && f.projectId === projectId));
  persist();
  return db.projectFiles.length < before;
}
function addMemberBySocialId(projectId, sid, role) {
  const profile = getProfileBySocialId(sid);
  if (!profile) throw new Error('No user found with that Social ID');
  const existing = db.projectMembers.find(m => m.projectId === projectId && m.userId === profile.userId);
  if (existing) { existing.role = role; }
  else db.projectMembers.push({ projectId, userId: profile.userId, role });
  persist();
  return profile.userId;
}
function listMembers(projectId) {
  return db.projectMembers.filter(m => m.projectId === projectId).map(m => ({ ...m, profile: getProfile(m.userId) }));
}
function submitChangeRequest(projectId, { fileId, filename, language, requestedBy, summary, proposedContent }) {
  const existingFile = fileId ? getProjectFile(fileId) : db.projectFiles.find(f => f.projectId === projectId && f.filename === filename);
  const r = {
    id: id(), projectId,
    fileId: existingFile ? existingFile.id : null,
    filename: existingFile ? existingFile.filename : (filename || 'untitled'),
    language: language || existingFile?.language || 'plaintext',
    requestedBy,
    summary: summary || '',
    originalContent: existingFile ? existingFile.content : '',
    proposedContent: proposedContent || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.changeRequests.push(r);
  persist();
  return r;
}
function getChangeRequest(requestId) {
  return db.changeRequests.find(r => r.id === requestId);
}
function listChangeRequests(projectId) {
  return db.changeRequests.filter(r => r.projectId === projectId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(r => ({ ...r, profile: getProfile(r.requestedBy) }));
}
function resolveChangeRequest(requestId, status) {
  const r = db.changeRequests.find(r => r.id === requestId);
  if (!r) throw new Error('Request not found');
  if (r.status !== 'pending') throw new Error('This request was already resolved');
  r.status = status;
  r.resolvedAt = new Date().toISOString();
  if (status === 'approved') {
    // This is the step the old code was missing — "approving" used to just
    // flip a status flag and never touched the actual file.
    upsertProjectFile(r.projectId, r.filename, r.proposedContent, r.language, r.requestedBy);
  }
  persist();
  return r;
}

// ---------- NOTES ----------
function listNotes(userId) {
  return db.notes.filter(n => n.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function createNote(userId, title, content) {
  const n = { id: id(), userId, title, content, createdAt: new Date().toISOString() };
  db.notes.push(n);
  persist();
  return n;
}
function updateNote(noteId, title, content) {
  const n = db.notes.find(n => n.id === noteId);
  if (!n) throw new Error('Note not found');
  if (title !== undefined) n.title = title;
  if (content !== undefined) n.content = content;
  persist();
  return n;
}
function deleteNote(noteId) {
  db.notes = db.notes.filter(n => n.id !== noteId);
  persist();
}

// ---------- PASSKEYS / WEBAUTHN CREDENTIALS ----------
function getCredentialsByUser(userId) {
  return db.credentials.filter(c => c.userId === userId);
}
function getCredentialById(credentialId) {
  return db.credentials.find(c => c.id === credentialId);
}
function addCredential(userId, cred) {
  const record = {
    id: cred.id,
    userId,
    publicKey: cred.publicKey,
    counter: cred.counter || 0,
    deviceType: cred.deviceType || 'unknown',
    backedUp: !!cred.backedUp,
    transports: cred.transports || [],
    nickname: cred.nickname || 'Passkey',
    createdAt: new Date().toISOString()
  };
  db.credentials.push(record);
  persist();
  return record;
}
function updateCredentialCounter(credentialId, counter) {
  const c = getCredentialById(credentialId);
  if (c) { c.counter = counter; persist(); }
  return c;
}
function deleteCredential(credentialId, userId) {
  const before = db.credentials.length;
  db.credentials = db.credentials.filter(c => !(c.id === credentialId && c.userId === userId));
  persist();
  return db.credentials.length < before;
}

// ---------- CHAT ----------
function saveMessage(fromUser, toUser, body) {
  const m = { id: id(), fromUser, toUser, body, createdAt: new Date().toISOString() };
  db.chatMessages.push(m);
  persist();
  return m;
}
function loadThread(userA, userB) {
  return db.chatMessages
    .filter(m => (m.fromUser === userA && m.toUser === userB) || (m.fromUser === userB && m.toUser === userA))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

module.exports = {
  findUserByEmail, findUserById, createUser, createGuestUser,
  createProfile, getProfile, getProfileBySocialId, updateProfile,
  sendFriendRequest, listIncomingRequests, acceptFriendRequest, listFriends, isFriend,
  createProject, listProjects, listMyProjects, getProject, canViewProject, setDeployedUrl, starProject, getUserRoleOnProject,
  toggleProjectStar, getStarCount, hasUserStarred, listTrendingProjects, listSocialsProjects, listNearProjects,
  regenerateJoinCode, updateJoinCodeSettings, joinProjectByCode, getPublicProfile,
  createVersionSnapshot, listVersions, restoreVersion,
  listProjectFiles, upsertProjectFile, getProjectFile, deleteProjectFile, addMemberBySocialId, listMembers,
  submitChangeRequest, listChangeRequests, resolveChangeRequest, getChangeRequest,
  listNotes, createNote, updateNote, deleteNote,
  saveMessage, loadThread,
  getCredentialsByUser, getCredentialById, addCredential, updateCredentialCounter, deleteCredential
};
