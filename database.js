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
  profiles: [],         // { userId, socialId, username, role, bio, github, twitter, device, level, followers, projects, commits, avatar, isAdmin }
  friendRequests: [],    // { id, fromUserId, toSocialId, status }
  friends: [],           // { userId, friendId }
  projects: [],          // { id, ownerId, name, description, category, stars, deployedUrl, createdAt }
  projectFiles: [],       // { id, projectId, filename, content, language, updatedBy, updatedAt }
  projectMembers: [],     // { projectId, userId, role }
  changeRequests: [],     // { id, projectId, fileId, requestedBy, summary, status, createdAt }
  notes: [],              // { id, userId, title, content, createdAt }
  chatMessages: []        // { id, fromUser, toUser, body, createdAt }
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
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
  return db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
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
    device, level: 1, followers: 0, projects: 0, commits: 0, avatar: null, isAdmin: false
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

// ---------- FRIENDS ----------
function sendFriendRequest(fromUserId, toSocialId) {
  const target = getProfileBySocialId(toSocialId);
  if (!target) throw new Error('No user found with that Social ID');
  const req = { id: id(), fromUserId, toSocialId, status: 'pending', createdAt: new Date().toISOString() };
  db.friendRequests.push(req);
  persist();
  return { req, targetUserId: target.userId };
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
function createProject(ownerId, { name, description, category }) {
  const p = { id: id(), ownerId, name, description: description || '', category: category || 'General', stars: 0, deployedUrl: null, createdAt: new Date().toISOString() };
  db.projects.push(p);
  persist();
  return p;
}
function listProjects({ search = '', category = '', order = 'stars' } = {}) {
  let list = db.projects.slice();
  if (search) list = list.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  if (category) list = list.filter(p => p.category === category);
  list.sort((a, b) => order === 'createdAt' ? new Date(b.createdAt) - new Date(a.createdAt) : b.stars - a.stars);
  return list;
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
function submitChangeRequest(projectId, fileId, requestedBy, summary) {
  const r = { id: id(), projectId, fileId, requestedBy, summary, status: 'pending', createdAt: new Date().toISOString() };
  db.changeRequests.push(r);
  persist();
  return r;
}
function listChangeRequests(projectId) {
  return db.changeRequests.filter(r => r.projectId === projectId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(r => ({ ...r, profile: getProfile(r.requestedBy) }));
}
function resolveChangeRequest(requestId, status) {
  const r = db.changeRequests.find(r => r.id === requestId);
  if (!r) throw new Error('Request not found');
  r.status = status;
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
  findUserByEmail, createUser, createGuestUser,
  createProfile, getProfile, getProfileBySocialId, updateProfile,
  sendFriendRequest, listIncomingRequests, acceptFriendRequest, listFriends,
  createProject, listProjects, getProject, setDeployedUrl, starProject, getUserRoleOnProject,
  listProjectFiles, upsertProjectFile, addMemberBySocialId, listMembers,
  submitChangeRequest, listChangeRequests, resolveChangeRequest,
  listNotes, createNote, updateNote, deleteNote,
  saveMessage, loadThread
};
