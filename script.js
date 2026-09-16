/* ============================================================================
   KNIGHT — application engine
   ----------------------------------------------------------------------------
   Everything the app needs lives here: authentication, session persistence,
   the local database, URL routing, and every page's behaviour.

   HOW THE DATA LAYER WORKS
   -----------------------
   Knight talks to ONE object: `DB`. That object has two backends:

     1. LOCAL  (default)  — the browser's own storage. Works instantly, offline,
                            with zero server setup. Accounts persist forever on
                            that device/browser.
     2. SERVER (optional) — your Java Spring Boot backend. Flip it on by setting
                            API_BASE below to your deployed URL.

   Crucially: if SERVER mode is on and the server is unreachable or returns an
   error, Knight does NOT throw "couldn't fetch account from server" at the user
   and stop. It falls back to LOCAL, keeps you signed in, and quietly retries
   later. That is the fix for the bug you described.
============================================================================ */

'use strict';

/* ---------------------------------------------------------------------------
   1. CONFIG
--------------------------------------------------------------------------- */

// Leave as null to run fully locally with no server at all.
// Set to e.g. "https://knight-backend.onrender.com" once you deploy the Java file.
const API_BASE = null;

const SESSION_DAYS = 365;          // how long "stay signed in" lasts
const LS = {
  users:    'knight.users.v3',
  session:  'knight.session.v3',
  data:     'knight.data.v3',      // projects, notes, messages, friendships…
  prefs:    'knight.prefs.v3',
};

/* ---------------------------------------------------------------------------
   2. SMALL UTILITIES
--------------------------------------------------------------------------- */

const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const uid = (prefix = 'id') =>
  prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

function socialId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return 'KNT-' + out;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

/** SHA-256 → hex. Used so raw passwords are never stored anywhere. */
async function sha256(text) {
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for very old / non-secure contexts (file:// on some browsers).
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
  return 'weak' + Math.abs(h).toString(16);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : structuredCloneSafe(fallback);
  } catch (e) {
    console.warn('[Knight] storage read failed for', key, e);
    return structuredCloneSafe(fallback);
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[Knight] storage write failed for', key, e);
    toast('Storage is full — some changes may not be saved.', true);
    return false;
  }
}

function structuredCloneSafe(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function toast(msg, isError = false) {
  const el = $('toast'); const span = $('toastMsg');
  if (!el || !span) return;
  span.textContent = msg;
  el.style.borderColor = isError ? 'var(--accent-coral)' : '';
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ---------------------------------------------------------------------------
   3. DATABASE LAYER
--------------------------------------------------------------------------- */

const DB = {
  serverUp: false,

  /** Try the server; on ANY failure return null so callers fall back to local. */
  async server(path, options = {}) {
    if (!API_BASE) return null;
    try {
      const res = await fetch(API_BASE + path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.serverUp = true;
      return await res.json();
    } catch (e) {
      if (this.serverUp) console.warn('[Knight] server unreachable, using local data.', e);
      this.serverUp = false;
      return null;                 // <- never throws at the UI
    }
  },

  users()          { return readJSON(LS.users, {}); },
  saveUsers(u)     { return writeJSON(LS.users, u); },

  data() {
    return readJSON(LS.data, {
      projects: {}, notes: {}, messages: {}, friendRequests: [],
      notifications: {}, links: {},
    });
  },
  saveData(d) {
    const ok = writeJSON(LS.data, d);
    bus.post('data-changed');
    return ok;
  },

  prefs()        { return readJSON(LS.prefs, {}); },
  savePrefs(p)   { return writeJSON(LS.prefs, p); },
};

/** Cross-tab live sync — this is what makes chat "multiplayer" between tabs. */
const bus = {
  ch: ('BroadcastChannel' in window) ? new BroadcastChannel('knight') : null,
  post(type, payload) { try { this.ch && this.ch.postMessage({ type, payload }); } catch {} },
  on(fn) {
    if (this.ch) this.ch.onmessage = (e) => fn(e.data || {});
    window.addEventListener('storage', () => fn({ type: 'data-changed' }));
  },
};

/* ---------------------------------------------------------------------------
   4. SESSION + CURRENT USER
   The "Cannot read properties of undefined (reading 'userId')" crash came from
   code reading session.userId before a session existed. Every read now goes
   through these guarded helpers, which return null instead of exploding.
--------------------------------------------------------------------------- */

let CURRENT = null;   // the live user object, or null when signed out

function getSession() {
  const s = readJSON(LS.session, null);
  if (!s || !s.userId || !s.expires) return null;
  if (Date.now() > s.expires) { localStorage.removeItem(LS.session); return null; }
  return s;
}

function setSession(userId) {
  writeJSON(LS.session, {
    userId,
    token: uid('tok'),
    expires: Date.now() + SESSION_DAYS * 86400000,
  });
}

function clearSession() { localStorage.removeItem(LS.session); CURRENT = null; }

/** Safe accessor — use this everywhere instead of touching CURRENT directly. */
function me() { return CURRENT || null; }
function myId() { return CURRENT ? CURRENT.id : null; }
function requireAuth() {
  if (!CURRENT) { toast('Sign in first.', true); return false; }
  return true;
}

function newUserRecord({ email, username, role, avatar, passHash, guest }) {
  return {
    id: uid('usr'),
    email: (email || '').toLowerCase(),
    username: username || 'knight',
    role: role || 'Coder',
    avatar: avatar || null,
    avatarIndex: 0,
    passHash: passHash || null,
    guest: !!guest,
    socialId: socialId(),
    bio: '',
    github: '', twitter: '',
    level: 1, followers: 0, projects: 0, commits: 0,
    friends: [],
    passkeys: [],
    createdAt: Date.now(),
    lastSeen: Date.now(),
    admin: false,
  };
}

/* ---------------------------------------------------------------------------
   5. AUTHENTICATION
--------------------------------------------------------------------------- */

let authMode = 'signin';   // 'signin' | 'signup'
let pendingAvatar = null;
let pendingRole = 'Coder';

function authError(msg) {
  const el = $('authError');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; return; }
  el.textContent = msg;
  el.style.display = 'block';
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('signup-fields').style.display = signup ? 'block' : 'none';
  $('authTitle').textContent = signup ? 'Create your account' : 'Welcome back';
  $('authDesc').textContent = signup
    ? 'One account, saved on this device and restored every time you return.'
    : 'Enter your credentials to access your persistent workspace.';
  $('submitBtn').textContent = signup ? 'Create Account' : 'Authenticate';
  $('tab-signin').classList.toggle('active', !signup);
  $('tab-signup').classList.toggle('active', signup);
  $('password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  authError('');
}

async function doSignUp(email, password) {
  const users = DB.users();
  const key = email.toLowerCase();

  if (users[key]) throw new Error('An account with that email already exists. Try signing in.');
  if (password.length < 6) throw new Error('Passphrase must be at least 6 characters.');

  const username = ($('username').value || '').trim() || email.split('@')[0];
  const user = newUserRecord({
    email: key,
    username,
    role: pendingRole,
    avatar: pendingAvatar,
    passHash: await sha256(password + key),
  });

  // First ever account on this browser becomes admin — handy for testing.
  user.admin = Object.keys(users).length === 0;

  users[key] = user;
  DB.saveUsers(users);

  // Best-effort mirror to the Java backend. Failure here is NOT fatal.
  DB.server('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email: key, username, passHash: user.passHash, socialId: user.socialId }),
  });

  seedNotifications(user.id, true);
  return user;
}

async function doSignIn(email, password) {
  const users = DB.users();
  const key = email.toLowerCase();
  const user = users[key];

  if (!user) throw new Error('No account found for that email. Switch to Sign Up to create one.');
  const hash = await sha256(password + key);
  if (user.passHash !== hash) throw new Error('Incorrect passphrase. Try again.');
  return user;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  authError('');
  const btn = $('submitBtn');
  const email = ($('email').value || '').trim();
  const password = $('password').value || '';

  if (!email || !password) { authError('Email and passphrase are both required.'); return; }

  btn.disabled = true;
  btn.textContent = authMode === 'signup' ? 'Creating…' : 'Authenticating…';

  try {
    const user = authMode === 'signup'
      ? await doSignUp(email, password)
      : await doSignIn(email, password);

    setSession(user.id);
    enterApp(user, { fresh: true });
    toast(authMode === 'signup' ? 'Account created. Welcome to Knight.' : 'Welcome back, ' + user.username + '.');
  } catch (err) {
    authError(err.message || 'Something went wrong. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'signup' ? 'Create Account' : 'Authenticate';
  }
}

/** Guest bypass — a real, working, throwaway account. */
function signInAsGuest() {
  const users = DB.users();
  const n = Object.values(users).filter(u => u.guest).length + 1;
  const user = newUserRecord({
    email: 'guest-' + Date.now() + '@local',
    username: 'guest_' + n,
    role: 'Both',
    guest: true,
  });
  users[user.email] = user;
  DB.saveUsers(users);
  setSession(user.id);
  seedNotifications(user.id, true);
  enterApp(user, { fresh: true });
  toast('Guest session started — create an account any time to keep your work.');
}

function signOutUI() {
  clearSession();
  location.hash = '';
  $('dashboard').style.display = 'none';
  $$('.knight-page').forEach(p => p.classList.remove('active'));
  $$('.modal-overlay').forEach(m => m.classList.remove('active'));
  $('auth').style.display = 'flex';
  setAuthMode('signin');
  $('password').value = '';
  toast('Signed out.');
}

/* ----- Passkeys (real WebAuthn, stored on your device) --------------------- */

function webAuthnAvailable() {
  return !!(window.PublicKeyCredential && navigator.credentials && location.protocol === 'https:' || location.hostname === 'localhost');
}

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function addPasskeyUI() {
  if (!requireAuth()) return;
  if (!window.PublicKeyCredential) {
    toast('This browser does not support passkeys.', true);
    return;
  }
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Knight', id: location.hostname },
        user: {
          id: new TextEncoder().encode(myId()),
          name: CURRENT.email,
          displayName: CURRENT.username,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        timeout: 60000,
        attestation: 'none',
      },
    });
    if (!cred) throw new Error('Cancelled');

    const users = DB.users();
    const u = users[CURRENT.email];
    u.passkeys = u.passkeys || [];
    u.passkeys.push({
      id: b64(cred.rawId),
      label: 'Passkey on ' + (detectDevice() || 'this device'),
      createdAt: Date.now(),
    });
    DB.saveUsers(users);
    CURRENT = u;
    renderPasskeys();
    toast('Passkey added. You can now sign in without your passphrase.');
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Passkey setup cancelled.' : 'Could not add passkey: ' + e.message, true);
  }
}

async function signInWithPasskey() {
  if (!window.PublicKeyCredential) { authError('This browser does not support passkeys.'); return; }
  const users = DB.users();
  const withKeys = Object.values(users).filter(u => (u.passkeys || []).length);
  if (!withKeys.length) {
    authError('No passkeys registered on this device yet. Sign in once, then add one in Settings → Security.');
    return;
  }
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        userVerification: 'preferred',
        timeout: 60000,
        allowCredentials: withKeys.flatMap(u =>
          u.passkeys.map(k => ({
            type: 'public-key',
            id: Uint8Array.from(atob(k.id.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
          }))
        ),
      },
    });
    if (!assertion) throw new Error('Cancelled');
    const usedId = b64(assertion.rawId);
    const user = withKeys.find(u => u.passkeys.some(k => k.id === usedId));
    if (!user) throw new Error('That passkey is not linked to an account here.');
    setSession(user.id);
    enterApp(user, { fresh: true });
    toast('Signed in with passkey.');
  } catch (e) {
    authError(e.name === 'NotAllowedError' ? 'Passkey sign-in cancelled.' : e.message);
  }
}

function renderPasskeys() {
  const box = $('passkeysList');
  if (!box) return;
  const keys = (me() && me().passkeys) || [];
  if (!keys.length) {
    box.innerHTML = `<p style="color:var(--text-tertiary); font-size:.85rem;">No passkeys yet. Add one to sign in with Face ID, Touch ID, Windows Hello, or a security key.</p>`;
    return;
  }
  box.innerHTML = keys.map(k => `
    <div class="friend-row">
      <div>
        <div style="font-weight:600; font-size:.88rem;">${esc(k.label)}</div>
        <div style="font-size:.74rem; color:var(--text-tertiary);">Added ${timeAgo(k.createdAt)}</div>
      </div>
      <button class="nav-cta" style="color:var(--accent-coral);" onclick="removePasskey('${k.id}')">Remove</button>
    </div>`).join('');
}

function removePasskey(id) {
  if (!requireAuth()) return;
  const users = DB.users();
  const u = users[CURRENT.email];
  u.passkeys = (u.passkeys || []).filter(k => k.id !== id);
  DB.saveUsers(users);
  CURRENT = u;
  renderPasskeys();
  toast('Passkey removed.');
}

/* ---------------------------------------------------------------------------
   6. AVATARS
--------------------------------------------------------------------------- */

const AVATAR_EMBLEMS = ['⚔️', '🛡️', '👑', '🐉', '🦅', '🔥', '⚡', '🌑', '💎', '🎯', '🧿', '🪐'];

function avatarMarkup(user, size = 40) {
  if (!user) return '';
  if (user.avatar) {
    return `<img src="${esc(user.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
  }
  const emblem = AVATAR_EMBLEMS[(user.avatarIndex || 0) % AVATAR_EMBLEMS.length];
  return `<span style="font-size:${Math.round(size * 0.5)}px; line-height:1;">${emblem}</span>`;
}

function buildAvatarGrid(gridId, onPick, selected = 0) {
  const grid = $(gridId);
  if (!grid) return;
  grid.innerHTML = AVATAR_EMBLEMS.map((e, i) =>
    `<div class="avatar-item ${i === selected ? 'selected' : ''}" data-index="${i}">${e}</div>`
  ).join('');
  $$('.avatar-item', grid).forEach(item => {
    item.onclick = () => {
      $$('.avatar-item', grid).forEach(x => x.classList.remove('selected'));
      item.classList.add('selected');
      onPick(parseInt(item.dataset.index, 10));
    };
  });
}

function readImageFile(input, cb) {
  const f = input.files && input.files[0];
  if (!f) return;
  if (f.size > 1.5 * 1024 * 1024) { toast('Pick an image under 1.5 MB.', true); return; }
  const r = new FileReader();
  r.onload = () => cb(r.result);
  r.readAsDataURL(f);
}

/* ---------------------------------------------------------------------------
   7. ROUTER — real URLs with IDs, plus a proper 404 page
   Routes look like:  #/terminal/KNT-AB12CD   ·   #/home/KNT-AB12CD
                      #/project/<projectId>   ·   #/studio/KNT-AB12CD
--------------------------------------------------------------------------- */

const ROUTES = {
  'home':      { page: null,                title: 'Dashboard' },
  'terminal':  { page: 'terminalPage',      title: 'Terminal' },
  'projects':  { page: 'projectsPage',      title: 'Projects' },
  'project':   { page: 'projectDetailPage', title: 'Project' },
  'studio':    { page: 'studioPage',        title: 'Studio' },
  'comm':      { page: 'commPage',          title: 'Communication' },
  'social':    { page: 'socialPage',        title: 'Social' },
  'notes':     { page: 'notesPage',         title: 'Notes' },
  'arcade':    { page: 'arcadePage',        title: 'Arcade' },
  'booster':   { page: 'gameBoosterPage',   title: 'Game Booster' },
  'deploy':    { page: 'linkDeployerPage',  title: 'Link Deployer' },
  'guide':     { page: 'guidePage',         title: 'Guide' },
  'settings':  { page: 'settingsPage',      title: 'Settings' },
  'shortcuts': { page: 'shortcutPage',      title: 'Shortcuts' },
  'admin':     { page: 'adminPage',         title: 'Admin' },
};

const PAGE_TO_ROUTE = Object.fromEntries(
  Object.entries(ROUTES).filter(([, v]) => v.page).map(([k, v]) => [v.page, k])
);

let suppressRoute = false;

function navigate(routeName, id) {
  suppressRoute = true;
  const slug = id || (me() ? me().socialId : 'guest');
  location.hash = '#/' + routeName + '/' + slug;
  setTimeout(() => { suppressRoute = false; }, 0);
}

function show404(badPath) {
  $$('.knight-page').forEach(p => p.classList.remove('active'));
  $('dashboard').style.display = 'none';
  const page = $('notFoundPage');
  $('notFoundPath').textContent = badPath || location.hash || '/';
  page.classList.add('active');
  window.scrollTo(0, 0);
}

function handleRoute() {
  if (suppressRoute) return;
  if (!me()) return;                       // routing only applies once signed in

  const raw = (location.hash || '').replace(/^#\/?/, '');
  if (!raw) { openDashboard(); return; }

  const [routeName, id] = raw.split('/');
  const route = ROUTES[routeName];

  if (!route) { show404('/' + raw); return; }

  if (routeName === 'home') { openDashboard(); return; }

  if (routeName === 'project') {
    const proj = DB.data().projects[id];
    if (!proj) { show404('/project/' + (id || '')); return; }
    openProjectDetail(id, true);
    return;
  }

  if (routeName === 'admin' && !me().admin) { show404('/admin'); return; }

  openKnightPage(route.page, true);
}

function openDashboard() {
  $$('.knight-page').forEach(p => p.classList.remove('active'));
  $('notFoundPage').classList.remove('active');
  $('dashboard').style.display = 'block';
  window.scrollTo(0, 0);
}

function goHome() { navigate('home'); openDashboard(); }

/* ---------------------------------------------------------------------------
   8. PAGE OPEN / CLOSE
--------------------------------------------------------------------------- */

function openKnightPage(pageId, fromRouter = false) {
  if (!requireAuth()) return;
  const page = $(pageId);
  if (!page) { show404(); return; }

  $$('.knight-page').forEach(p => p.classList.remove('active'));
  $('notFoundPage').classList.remove('active');
  $('dashboard').style.display = 'none';
  page.classList.add('active');
  window.scrollTo(0, 0);

  if (!fromRouter && PAGE_TO_ROUTE[pageId]) navigate(PAGE_TO_ROUTE[pageId]);

  // Lazy render per page
  ({
    projectsPage:     renderProjectsList,
    studioPage:       renderStudio,
    socialPage:       renderSocialPage,
    commPage:         renderCommPage,
    notesPage:        renderNotes,
    arcadePage:       startMemoryGame,
    gameBoosterPage:  renderGameBooster,
    linkDeployerPage: renderLinkDeployer,
    shortcutPage:     renderShortcuts,
    settingsPage:     renderSettings,
    adminPage:        renderAdmin,
  }[pageId] || (() => {}))();
}

function closeKnightPage(pageId) {
  const p = $(pageId);
  if (p) p.classList.remove('active');
  goHome();
}

function openModal(id) {
  if (id !== 'notificationsModal' && !requireAuth()) return;
  const m = $(id);
  if (!m) return;
  m.classList.add('active');
  if (id === 'profileModal') renderProfileModal();
  if (id === 'editProfileModal') fillEditProfile();
  if (id === 'notificationsModal') renderNotifications();
}

function closeModal(id) { const m = $(id); if (m) m.classList.remove('active'); }

/* ---------------------------------------------------------------------------
   9. ENTERING THE APP
--------------------------------------------------------------------------- */

function enterApp(user, { fresh = false } = {}) {
  CURRENT = user;

  // Touch lastSeen
  const users = DB.users();
  if (users[user.email]) {
    users[user.email].lastSeen = Date.now();
    DB.saveUsers(users);
  }

  $('auth').style.display = 'none';
  $('dashboard').style.display = 'block';

  applyDevice(DB.prefs().device || detectDevice());
  renderHeader();
  renderNotifBadge();
  renderPasskeys();
  applyPrefsToUI();
  $('adminCard').style.display = user.admin ? 'block' : 'none';

  // Try the server for a fresher profile — but never block on it.
  refreshProfileFromServer();

  if (fresh) {
    const def = DB.prefs().defaultPage;
    if (def && $(def)) { openKnightPage(def); return; }
    goHome();
  } else {
    handleRoute();
  }
}

async function refreshProfileFromServer() {
  const data = await DB.server('/api/profile?email=' + encodeURIComponent(me() ? me().email : ''));
  if (!data || !data.username) return;      // silent, local stays authoritative
  const users = DB.users();
  const u = users[CURRENT.email];
  if (!u) return;
  u.username = data.username || u.username;
  DB.saveUsers(users);
  CURRENT = u;
  renderHeader();
}

function renderHeader() {
  const u = me();
  if (!u) return;
  $('dashUsernameText').textContent = u.username;
  $('headerSocialIdChip').textContent = u.socialId;
  $('dashUserAvatar').innerHTML = avatarMarkup(u, 40);
  $('headerDeviceName').textContent = DB.prefs().device || detectDevice();
}

/* ---------------------------------------------------------------------------
   10. PROFILE
--------------------------------------------------------------------------- */

function renderProfileModal() {
  const u = me(); if (!u) return;
  $('modalUsername').textContent = u.username;
  $('modalRoleBadge').textContent = u.role;
  $('userLevelVal').textContent = u.level;
  $('socialIdChip').textContent = u.socialId;
  $('modalAvatar').innerHTML = avatarMarkup(u, 64);
  $('modalBio').textContent = u.bio || 'No bio yet — add one from Edit Profile.';
  $('statFollowers').textContent = u.followers;
  $('statProjects').textContent = Object.values(DB.data().projects).filter(p => p.ownerId === u.id).length;
  $('statCommits').textContent = u.commits;

  const links = [];
  if (u.github) links.push(`<a class="profile-link-tag" href="${esc(u.github)}" target="_blank" rel="noopener">GitHub</a>`);
  if (u.twitter) links.push(`<a class="profile-link-tag" href="https://x.com/${esc(u.twitter.replace('@', ''))}" target="_blank" rel="noopener">${esc(u.twitter)}</a>`);
  $('modalLinksList').innerHTML = links.join('') ||
    `<span style="font-size:.8rem;color:var(--text-tertiary);">No links added yet.</span>`;
}

function fillEditProfile() {
  const u = me(); if (!u) return;
  $('editUsernameInput').value = u.username;
  $('editRoleSelect').value = ['Coder','Gamer','Architect','Designer','Full-Stack'].includes(u.role) ? u.role : 'Coder';
  $('editBioInput').value = u.bio || '';
  $('editGithubInput').value = u.github || '';
  $('editTwitterInput').value = u.twitter || '';
  $('editAvatarPreviewWrap').innerHTML = avatarMarkup(u, 64);
  buildAvatarGrid('editAvatarGrid', (i) => {
    const users = DB.users(); const usr = users[CURRENT.email];
    usr.avatarIndex = i; usr.avatar = null;
    DB.saveUsers(users); CURRENT = usr;
    $('editAvatarPreviewWrap').innerHTML = avatarMarkup(usr, 64);
  }, u.avatarIndex || 0);
}

function saveProfile(e) {
  e.preventDefault();
  if (!requireAuth()) return;
  const users = DB.users();
  const u = users[CURRENT.email];
  u.username = ($('editUsernameInput').value || '').trim() || u.username;
  u.role     = $('editRoleSelect').value;
  u.bio      = $('editBioInput').value.trim();
  u.github   = $('editGithubInput').value.trim();
  u.twitter  = $('editTwitterInput').value.trim();
  DB.saveUsers(users);
  CURRENT = u;

  DB.server('/api/profile', {
    method: 'PUT',
    body: JSON.stringify({ email: u.email, username: u.username, avatarIndex: u.avatarIndex }),
  });

  renderHeader(); renderProfileModal();
  closeModal('editProfileModal');
  toast('Profile saved.');
}

function copySocialId() {
  if (!requireAuth()) return;
  navigator.clipboard?.writeText(me().socialId)
    .then(() => toast('Social ID copied.'))
    .catch(() => toast('Could not access the clipboard.', true));
}

function incrementStat(kind) {
  if (!requireAuth()) return;
  const users = DB.users(); const u = users[CURRENT.email];
  if (kind === 'followers') u.followers++;
  if (kind === 'commits') u.commits++;
  u.level = 1 + Math.floor((u.commits + u.followers) / 10);
  DB.saveUsers(users); CURRENT = u;
  renderProfileModal();
}

function extractDataSheet() {
  if (!requireAuth()) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    user: { ...me(), passHash: undefined },
    projects: Object.values(DB.data().projects).filter(p => p.ownerId === myId()),
    notes: DB.data().notes[myId()] || [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'knight-' + me().username + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Data sheet exported.');
}

/* ---------------------------------------------------------------------------
   11. PUBLIC PROFILES + SOCIAL
--------------------------------------------------------------------------- */

let viewingProfileId = null;

function userBySocialId(sid) {
  return Object.values(DB.users()).find(u => u.socialId.toUpperCase() === String(sid || '').trim().toUpperCase()) || null;
}
function userById(id) {
  return Object.values(DB.users()).find(u => u.id === id) || null;
}

function openPublicProfile(user) {
  if (!user) { toast('No Knight found with that Social ID.', true); return; }
  viewingProfileId = user.id;
  $('ppUsername').textContent = user.username;
  $('ppRole').textContent = user.role;
  $('ppSocialId').textContent = user.socialId;
  $('ppAvatar').innerHTML = avatarMarkup(user, 64);
  $('ppBio').textContent = user.bio || 'This Knight has not written a bio yet.';
  $('ppLevel').textContent = user.level;
  $('ppFollowers').textContent = user.followers;
  $('ppCommits').textContent = user.commits;

  const isMe = user.id === myId();
  const isFriend = (me().friends || []).includes(user.id);
  $('ppPingBtn').style.display = isMe ? 'none' : 'inline-block';
  $('ppMessageBtn').style.display = (!isMe && isFriend) ? 'inline-block' : 'none';
  $('ppAddFriendBtn').style.display = (!isMe && !isFriend) ? 'inline-block' : 'none';
  $('ppPresenceDot').classList.toggle('online', Date.now() - user.lastSeen < 300000);

  const pub = Object.values(DB.data().projects).filter(p => p.ownerId === user.id && p.visibility === 'public');
  $('ppProjects').textContent = pub.length;
  $('ppProjectsList').innerHTML = pub.length
    ? pub.map(p => `<div class="friend-row"><div><b>${esc(p.name)}</b><div style="font-size:.74rem;color:var(--text-tertiary);">★ ${p.stars || 0} · ${esc(p.category)}</div></div><button class="nav-cta" onclick="closeModal('publicProfileModal'); openProjectDetail('${p.id}')">Open</button></div>`).join('')
    : `<p style="font-size:.8rem;color:var(--text-tertiary);">No public projects.</p>`;

  openModalRaw('publicProfileModal');
}

function openModalRaw(id) { const m = $(id); if (m) m.classList.add('active'); }

function viewProfileFromSocialPage() {
  openPublicProfile(userBySocialId($('socialAddFriendInput').value));
}

function sendFriendRequest(sid) {
  if (!requireAuth()) return;
  const target = userBySocialId(sid);
  if (!target) { toast('No Knight found with that Social ID.', true); return; }
  if (target.id === myId()) { toast('That is your own Social ID.', true); return; }
  if ((me().friends || []).includes(target.id)) { toast('You are already friends.'); return; }

  const d = DB.data();
  const dupe = d.friendRequests.some(r => r.from === myId() && r.to === target.id && r.status === 'pending');
  if (dupe) { toast('Request already pending.'); return; }

  d.friendRequests.push({ id: uid('req'), from: myId(), to: target.id, status: 'pending', at: Date.now() });
  DB.saveData(d);
  pushNotification(target.id, 'Friend Request', me().username + ' wants to connect.', '#/social/' + target.socialId);
  toast('Friend request sent to ' + target.username + '.');
  renderSocialPage();
}

function sendFriendRequestUI()            { sendFriendRequest($('friendSocialIdInput').value); }
function sendFriendRequestFromSocialPage(){ sendFriendRequest($('socialAddFriendInput').value); }
function addFriendFromProfileUI() {
  const u = userById(viewingProfileId);
  if (u) { sendFriendRequest(u.socialId); closeModal('publicProfileModal'); }
}

function respondToRequest(reqId, accept) {
  const d = DB.data();
  const req = d.friendRequests.find(r => r.id === reqId);
  if (!req) return;
  req.status = accept ? 'accepted' : 'declined';

  if (accept) {
    const users = DB.users();
    const a = Object.values(users).find(u => u.id === req.from);
    const b = Object.values(users).find(u => u.id === req.to);
    if (a && b) {
      a.friends = Array.from(new Set([...(a.friends || []), b.id]));
      b.friends = Array.from(new Set([...(b.friends || []), a.id]));
      DB.saveUsers(users);
      CURRENT = users[CURRENT.email];
      pushNotification(a.id, 'Friend Request Accepted', b.username + ' accepted your request.', '#/social/' + a.socialId);
    }
  }
  DB.saveData(d);
  renderSocialPage();
  toast(accept ? 'Friend added.' : 'Request declined.');
}

function renderSocialPage() {
  const u = me(); if (!u) return;
  $('socialPageMyId').textContent = u.socialId;

  const d = DB.data();
  const incoming = d.friendRequests.filter(r => r.to === u.id && r.status === 'pending');
  $('socialIncomingRequests').innerHTML = incoming.length
    ? incoming.map(r => {
        const from = userById(r.from);
        return `<div class="friend-row">
          <div><b>${esc(from ? from.username : 'Unknown')}</b>
          <div style="font-size:.74rem;color:var(--text-tertiary);">${from ? esc(from.socialId) : ''} · ${timeAgo(r.at)}</div></div>
          <div style="display:flex;gap:8px;">
            <button class="nav-cta btn-golden" onclick="respondToRequest('${r.id}',true)">Accept</button>
            <button class="nav-cta" style="color:var(--accent-coral)" onclick="respondToRequest('${r.id}',false)">Decline</button>
          </div></div>`;
      }).join('')
    : `<p style="font-size:.85rem;color:var(--text-tertiary);">No incoming requests.</p>`;

  renderSocialFriendsList();
}

function renderSocialFriendsList() {
  const u = me(); if (!u) return;
  const q = ($('socialFriendSearchInput')?.value || '').toLowerCase();
  const friends = (u.friends || []).map(userById).filter(Boolean)
    .filter(f => f.username.toLowerCase().includes(q) || f.socialId.toLowerCase().includes(q));

  $('socialFriendsListFull').innerHTML = friends.length
    ? friends.map(f => `<div class="friend-row">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;overflow:hidden;">${avatarMarkup(f, 34)}</div>
          <div><b>${esc(f.username)}</b><div style="font-size:.74rem;color:var(--text-tertiary);">${esc(f.socialId)} · ${esc(f.role)}</div></div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="nav-cta" onclick="openPublicProfile(userById('${f.id}'))">Profile</button>
          <button class="nav-cta btn-golden" onclick="openChatWith('${f.id}')">Message</button>
        </div></div>`).join('')
    : `<p style="font-size:.85rem;color:var(--text-tertiary);">${q ? 'No friends match that search.' : 'No friends yet — share your Social ID above.'}</p>`;
}

function sendPingUI() {
  const u = userById(viewingProfileId);
  if (!u) return;
  pushNotification(u.id, 'Ping 👋', me().username + ' pinged you.', '#/social/' + u.socialId);
  toast('Ping sent to ' + u.username + '.');
}

function messageFromProfileUI() {
  const u = userById(viewingProfileId);
  if (u) { closeModal('publicProfileModal'); openChatWith(u.id); }
}

/* ---------------------------------------------------------------------------
   12. NOTIFICATIONS
--------------------------------------------------------------------------- */

function pushNotification(userId, title, desc, route) {
  const d = DB.data();
  d.notifications[userId] = d.notifications[userId] || [];
  d.notifications[userId].unshift({ id: uid('ntf'), title, desc, route, read: false, at: Date.now() });
  DB.saveData(d);
  if (userId === myId()) renderNotifBadge();
}

function seedNotifications(userId, isNew) {
  if (!isNew) return;
  pushNotification(userId, 'Welcome to Knight', 'Your account is saved on this device — you will stay signed in.', '#/home');
}

function renderNotifications() {
  const box = $('notificationsContainer');
  const list = (DB.data().notifications[myId()] || []);
  box.innerHTML = list.length
    ? list.map(n => `<div class="notif-item ${n.read ? '' : 'unread'}" onclick="openNotification('${n.id}')">
        <div class="notif-title">${esc(n.title)}</div>
        <div class="notif-desc">${esc(n.desc)}</div>
        <div class="notif-time">${timeAgo(n.at)}</div></div>`).join('')
    : `<p style="font-size:.85rem;color:var(--text-tertiary);">Nothing here yet.</p>`;
}

function openNotification(id) {
  const d = DB.data();
  const list = d.notifications[myId()] || [];
  const n = list.find(x => x.id === id);
  if (!n) return;
  n.read = true;
  DB.saveData(d);
  renderNotifications(); renderNotifBadge();
  if (n.route) { closeModal('notificationsModal'); location.hash = n.route; }
}

function clearNotifications() {
  const d = DB.data();
  d.notifications[myId()] = [];
  DB.saveData(d);
  renderNotifications(); renderNotifBadge();
  toast('Alerts cleared.');
}

function renderNotifBadge() {
  const unread = (DB.data().notifications[myId()] || []).filter(n => !n.read).length;
  const b = $('notifBadge');
  if (!b) return;
  b.textContent = unread;
  b.classList.toggle('hidden', unread === 0);
}

/* ---------------------------------------------------------------------------
   13. PROJECTS
--------------------------------------------------------------------------- */

let currentProjectId = null;
let currentFileName = null;

function myRoleOn(p) {
  if (!p || !me()) return null;
  if (p.ownerId === myId()) return 'owner';
  const m = (p.members || []).find(x => x.userId === myId());
  return m ? m.role : null;
}

function canSeeProject(p) {
  if (!p) return false;
  if (p.ownerId === myId()) return true;
  if (myRoleOn(p)) return true;
  if (p.visibility === 'public') return true;
  if (p.visibility === 'friends') return (me().friends || []).includes(p.ownerId);
  if (p.visibility === 'selected') return (p.visibleTo || []).includes(me().socialId);
  return false;
}

function createProjectUI() {
  if (!requireAuth()) return;
  const name = ($('newProjName').value || '').trim();
  if (!name) { toast('Give the project a name.', true); return; }

  const d = DB.data();
  const p = {
    id: uid('prj'),
    ownerId: myId(),
    name,
    description: $('newProjDesc').value.trim(),
    category: $('newProjCategory').value,
    tags: $('newProjTags').value.split(',').map(t => t.trim()).filter(Boolean),
    visibility: $('newProjVisibility').value,
    visibleTo: $('newProjVisibleTo').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    location: pendingLocation,
    locationLabel: $('newProjLocationLabel').value.trim(),
    files: {},
    versions: [{ id: uid('ver'), label: 'Version 1', note: 'Initial version', at: Date.now(), snapshot: {} }],
    members: [],
    changeRequests: [],
    stars: 0, starredBy: [], reviews: [],
    joinCode: uid('key').toUpperCase().slice(0, 12),
    joinCodeEnabled: false,
    joinCodeRole: 'viewer',
    deployedUrl: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  d.projects[p.id] = p;
  DB.saveData(d);

  pendingLocation = null;
  ['newProjName','newProjDesc','newProjTags','newProjVisibleTo','newProjLocationLabel'].forEach(i => $(i).value = '');
  $('newProjLocationStatus').textContent = '';

  closeModal('newProjectModal');
  renderProjectsList();
  toast('Project created at Version 1.');
  openProjectDetail(p.id);
}

function renderProjectsList() {
  const d = DB.data();
  const mine = Object.values(d.projects).filter(p => p.ownerId === myId() || myRoleOn(p));
  const grid = $('myProjectsGrid');
  grid.innerHTML = mine.length
    ? mine.sort((a, b) => b.updatedAt - a.updatedAt).map(p => projectCard(p, true)).join('')
    : `<p style="font-size:.9rem;color:var(--text-tertiary);">No projects yet. Hit “+ New Project” to create your first one.</p>`;
}

function projectCard(p, showRole) {
  const role = myRoleOn(p);
  const fileCount = Object.keys(p.files || {}).length;
  const ver = (p.versions || []).length;
  const owner = userById(p.ownerId);
  return `<div class="dash-card theme-blue" tabindex="0" onclick="openProjectDetail('${p.id}')">
    <div class="icon-box"><svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
    <h3>${esc(p.name)}</h3>
    <p>${esc(p.description || 'No description.')}</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;">
      <span class="social-id-chip" style="font-size:.62rem;">${esc(p.category)}</span>
      <span class="social-id-chip" style="font-size:.62rem;">${esc(p.visibility)}</span>
      ${showRole && role ? `<span class="social-id-chip" style="font-size:.62rem;">${esc(role)}</span>` : ''}
      ${!showRole && owner ? `<span class="social-id-chip" style="font-size:.62rem;">by ${esc(owner.username)}</span>` : ''}
    </div>
    <div class="enter-btn">★ ${p.stars || 0} · ${fileCount} files · v${ver}</div>
  </div>`;
}

function openProjectDetail(id, fromRouter = false) {
  const p = DB.data().projects[id];
  if (!p) { show404('/project/' + id); return; }
  if (!canSeeProject(p)) { toast('You do not have access to that project.', true); return; }

  currentProjectId = id;
  if (!fromRouter) navigate('project', id);

  $$('.knight-page').forEach(x => x.classList.remove('active'));
  $('notFoundPage').classList.remove('active');
  $('dashboard').style.display = 'none';
  $('projectDetailPage').classList.add('active');
  window.scrollTo(0, 0);

  const role = myRoleOn(p) || 'visitor';
  $('projectDetailTitle').textContent = p.name;
  $('projectDetailRoleBadge').textContent = role;
  $('projectDetailDesc').textContent = p.description || 'No description.';
  $('projectDetailTags').innerHTML = [p.category, ...(p.tags || [])]
    .map(t => `<span class="social-id-chip" style="font-size:.66rem;margin-right:6px;">${esc(t)}</span>`).join('');

  const isOwner  = role === 'owner';
  const canEdit  = isOwner || role === 'editor';
  const canPropose = canEdit || role === 'contributor';

  $('addFileRow').style.display     = canPropose ? 'flex' : 'none';
  $('cutVersionRow').style.display  = canEdit ? 'flex' : 'none';
  $('inviteMemberRow').style.display = isOwner ? 'flex' : 'none';
  $('joinCodeSection').style.display = isOwner ? 'block' : 'none';
  $('joinCodeSectionLabel').style.display = isOwner ? 'block' : 'none';

  if (isOwner) {
    $('joinCodeDisplay').value = p.joinCode;
    $('joinCodeEnabledToggle').checked = !!p.joinCodeEnabled;
    $('joinCodeRoleSelect').value = p.joinCodeRole || 'viewer';
  }
  $('deployedUrlInput').value = p.deployedUrl || '';

  renderProjectFiles(p, role);
  renderVersions(p, isOwner);
  renderMembers(p, isOwner);
  renderChangeRequests(p, isOwner || role === 'editor');
}

function renderProjectFiles(p, role) {
  const canEdit = role === 'owner' || role === 'editor';
  const canPropose = canEdit || role === 'contributor';
  const names = Object.keys(p.files || {});
  $('projectFilesList').innerHTML = names.length
    ? names.map(n => `<div class="friend-row">
        <div><b style="font-family:'JetBrains Mono',monospace;font-size:.85rem;">${esc(n)}</b>
        <div style="font-size:.72rem;color:var(--text-tertiary);">${(p.files[n] || '').split('\n').length} lines</div></div>
        <button class="nav-cta" onclick="openFileEditor('${esc(n)}')">${canPropose ? 'Open' : 'View'}</button>
      </div>`).join('')
    : `<p style="font-size:.85rem;color:var(--text-tertiary);">No files yet.</p>`;
}

function addProjectFileUI() {
  const p = DB.data().projects[currentProjectId];
  const role = myRoleOn(p);
  if (!['owner', 'editor', 'contributor'].includes(role)) { toast('You cannot add files here.', true); return; }
  const name = ($('newFileNameInput').value || '').trim();
  if (!name) { toast('Enter a filename.', true); return; }
  if (p.files[name] !== undefined) { toast('That file already exists.', true); return; }

  const d = DB.data();
  d.projects[currentProjectId].files[name] = '';
  d.projects[currentProjectId].updatedAt = Date.now();
  DB.saveData(d);
  $('newFileNameInput').value = '';
  openProjectDetail(currentProjectId, true);
  toast('File added.');
}

function openFileEditor(name) {
  const p = DB.data().projects[currentProjectId];
  if (!p) return;
  currentFileName = name;
  const role = myRoleOn(p);
  const canEdit = role === 'owner' || role === 'editor';
  const isContributor = role === 'contributor';

  $('fileEditorTitle').textContent = name;
  $('fileEditorContent').value = p.files[name] ?? '';
  $('fileEditorContent').readOnly = !(canEdit || isContributor);
  $('fileEditorDeleteBtn').style.display = canEdit ? 'inline-block' : 'none';
  $('fileEditorSaveBtn').style.display = (canEdit || isContributor) ? 'block' : 'none';
  $('fileEditorSaveBtn').textContent = isContributor ? 'Propose Change' : 'Save';
  $('fileEditorRoleHint').textContent =
    canEdit ? 'You can edit and delete files in this project.'
    : isContributor ? 'As a Contributor your edit becomes a Change Request the owner reviews. You cannot delete files.'
    : 'Read-only — you are a Viewer on this project.';

  openModalRaw('fileEditorModal');
}

function saveFileEditorUI() {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  const role = myRoleOn(p);
  const content = $('fileEditorContent').value;

  if (role === 'owner' || role === 'editor') {
    p.files[currentFileName] = content;
    p.updatedAt = Date.now();
    DB.saveData(d);
    toast('File saved.');
  } else if (role === 'contributor') {
    p.changeRequests.push({
      id: uid('cr'), by: myId(), file: currentFileName,
      before: p.files[currentFileName] ?? '', after: content,
      status: 'pending', at: Date.now(),
    });
    DB.saveData(d);
    pushNotification(p.ownerId, 'New Change Request', me().username + ' proposed an edit to ' + currentFileName + '.', '#/project/' + p.id);
    toast('Change request submitted for review.');
  } else {
    toast('You have read-only access.', true);
    return;
  }
  closeModal('fileEditorModal');
  openProjectDetail(currentProjectId, true);
}

function deleteFileEditorUI() {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  const role = myRoleOn(p);
  if (role !== 'owner' && role !== 'editor') { toast('Only owners and editors can delete files.', true); return; }
  if (!confirm('Delete ' + currentFileName + '? This cannot be undone.')) return;
  delete p.files[currentFileName];
  p.updatedAt = Date.now();
  DB.saveData(d);
  closeModal('fileEditorModal');
  openProjectDetail(currentProjectId, true);
  toast('File deleted.');
}

/* ----- Versions ----------------------------------------------------------- */

function renderVersions(p, canManage) {
  $('versionsList').innerHTML = (p.versions || []).slice().reverse().map(v => `
    <div class="friend-row">
      <div><b>${esc(v.label)}</b>
      <div style="font-size:.74rem;color:var(--text-tertiary);">${esc(v.note || '')} · ${timeAgo(v.at)} · ${Object.keys(v.snapshot || {}).length} files</div></div>
      ${canManage ? `<button class="nav-cta" onclick="restoreVersion('${v.id}')">Restore</button>` : ''}
    </div>`).join('');
}

function cutVersionUI() {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  const role = myRoleOn(p);
  if (role !== 'owner' && role !== 'editor') { toast('Only owners and editors can cut versions.', true); return; }
  const n = (p.versions || []).length + 1;
  p.versions.push({
    id: uid('ver'), label: 'Version ' + n,
    note: $('versionNoteInput').value.trim() || 'Snapshot',
    at: Date.now(), snapshot: structuredCloneSafe(p.files),
  });
  p.updatedAt = Date.now();
  DB.saveData(d);
  $('versionNoteInput').value = '';
  openProjectDetail(currentProjectId, true);
  toast('Version ' + n + ' created.');
}

function restoreVersion(vid) {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  const v = (p.versions || []).find(x => x.id === vid);
  if (!v) return;
  if (!confirm('Restore ' + v.label + '? Current files will be replaced (a new version is cut first).')) return;
  p.versions.push({
    id: uid('ver'), label: 'Version ' + (p.versions.length + 1),
    note: 'Auto-snapshot before restoring ' + v.label,
    at: Date.now(), snapshot: structuredCloneSafe(p.files),
  });
  p.files = structuredCloneSafe(v.snapshot || {});
  p.updatedAt = Date.now();
  DB.saveData(d);
  openProjectDetail(currentProjectId, true);
  toast(v.label + ' restored.');
}

/* ----- Members + invites -------------------------------------------------- */

function renderMembers(p, isOwner) {
  const owner = userById(p.ownerId);
  const rows = [`<div class="friend-row"><div><b>${esc(owner ? owner.username : 'Owner')}</b>
    <div style="font-size:.74rem;color:var(--text-tertiary);">owner · full control</div></div></div>`];

  (p.members || []).forEach(m => {
    const u = userById(m.userId);
    rows.push(`<div class="friend-row">
      <div><b>${esc(u ? u.username : 'Unknown')}</b>
      <div style="font-size:.74rem;color:var(--text-tertiary);">${esc(m.role)} · ${u ? esc(u.socialId) : ''}</div></div>
      ${isOwner ? `<div style="display:flex;gap:8px;">
        <select onchange="changeMemberRole('${m.userId}', this.value)" style="max-width:130px;">
          <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option>
          <option value="contributor" ${m.role === 'contributor' ? 'selected' : ''}>Contributor</option>
          <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option>
        </select>
        <button class="nav-cta" style="color:var(--accent-coral)" onclick="removeMember('${m.userId}')">Remove</button>
      </div>` : ''}
    </div>`);
  });
  $('projectMembersList').innerHTML = rows.join('');
}

function addProjectMemberUI() {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  if (myRoleOn(p) !== 'owner') { toast('Only the owner can invite people.', true); return; }
  const target = userBySocialId($('newMemberSocialId').value);
  if (!target) { toast('No Knight found with that Social ID.', true); return; }
  if (target.id === p.ownerId) { toast('That is the project owner.', true); return; }
  if ((p.members || []).some(m => m.userId === target.id)) { toast('Already a member.', true); return; }

  p.members.push({ userId: target.id, role: $('newMemberRole').value, at: Date.now() });
  DB.saveData(d);
  pushNotification(target.id, 'Added to a project', me().username + ' added you to ' + p.name + '.', '#/project/' + p.id);
  $('newMemberSocialId').value = '';
  openProjectDetail(currentProjectId, true);
  toast(target.username + ' invited.');
}

function changeMemberRole(userId, role) {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  const m = (p.members || []).find(x => x.userId === userId);
  if (m) { m.role = role; DB.saveData(d); toast('Role updated to ' + role + '.'); }
}

function removeMember(userId) {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  p.members = (p.members || []).filter(m => m.userId !== userId);
  DB.saveData(d);
  openProjectDetail(currentProjectId, true);
  toast('Member removed.');
}

function saveJoinCodeSettingsUI() {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  if (!p || myRoleOn(p) !== 'owner') return;
  p.joinCodeEnabled = $('joinCodeEnabledToggle').checked;
  p.joinCodeRole = $('joinCodeRoleSelect').value;
  DB.saveData(d);
  toast('Invite passkey settings saved.');
}

function copyJoinCodeUI() {
  navigator.clipboard?.writeText($('joinCodeDisplay').value)
    .then(() => toast('Invite passkey copied.'))
    .catch(() => toast('Clipboard unavailable.', true));
}

function regenerateJoinCodeUI() {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  p.joinCode = uid('key').toUpperCase().slice(0, 12);
  DB.saveData(d);
  $('joinCodeDisplay').value = p.joinCode;
  toast('Passkey regenerated — old links no longer work.');
}

function joinProjectByCodeUI() {
  const code = ($('joinProjectCodeInput').value || '').trim().toUpperCase();
  if (!code) return;
  const d = DB.data();
  const p = Object.values(d.projects).find(x => x.joinCode === code && x.joinCodeEnabled);
  if (!p) { toast('That passkey is not valid or has been revoked.', true); return; }
  if (p.ownerId === myId() || (p.members || []).some(m => m.userId === myId())) {
    toast('You already have access.'); openProjectDetail(p.id); return;
  }
  p.members.push({ userId: myId(), role: p.joinCodeRole || 'viewer', at: Date.now() });
  DB.saveData(d);
  pushNotification(p.ownerId, 'Someone joined', me().username + ' joined ' + p.name + ' via passkey.', '#/project/' + p.id);
  $('joinProjectCodeInput').value = '';
  toast('Joined ' + p.name + ' as ' + (p.joinCodeRole || 'viewer') + '.');
  openProjectDetail(p.id);
}

/* ----- Change requests ---------------------------------------------------- */

function renderChangeRequests(p, canReview) {
  const pending = (p.changeRequests || []).filter(c => c.status === 'pending');
  $('changeRequestsList').innerHTML = pending.length
    ? pending.map(c => {
        const by = userById(c.by);
        return `<div style="background:rgba(0,0,0,.25);border:1px solid var(--panel-border);border-radius:14px;padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
            <div><b>${esc(c.file)}</b>
            <div style="font-size:.74rem;color:var(--text-tertiary);">by ${esc(by ? by.username : 'unknown')} · ${timeAgo(c.at)}</div></div>
            ${canReview ? `<div style="display:flex;gap:8px;">
              <button class="nav-cta btn-golden" onclick="reviewChange('${c.id}',true)">Accept</button>
              <button class="nav-cta" style="color:var(--accent-coral)" onclick="reviewChange('${c.id}',false)">Reject</button></div>` : ''}
          </div>
          <div class="cr-diff-label">proposed content</div>
          <pre class="cr-diff">${esc(c.after.slice(0, 600) || '(empty file)')}</pre>
        </div>`;
      }).join('')
    : `<p style="font-size:.85rem;color:var(--text-tertiary);">No pending change requests.</p>`;
}

function reviewChange(crId, accept) {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  const cr = (p.changeRequests || []).find(c => c.id === crId);
  if (!cr) return;
  cr.status = accept ? 'accepted' : 'rejected';
  if (accept) {
    p.files[cr.file] = cr.after;
    p.updatedAt = Date.now();
    const owner = userById(myId());
    if (owner) {
      const users = DB.users();
      users[owner.email].commits = (users[owner.email].commits || 0) + 1;
      DB.saveUsers(users);
      CURRENT = users[owner.email];
    }
  }
  DB.saveData(d);
  pushNotification(cr.by, accept ? 'Change Accepted' : 'Change Rejected',
    'Your edit to ' + cr.file + ' was ' + (accept ? 'merged' : 'rejected') + '.', '#/project/' + p.id);
  openProjectDetail(currentProjectId, true);
  toast(accept ? 'Change merged into the file.' : 'Change rejected.');
}

function saveDeployedUrlUI() {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  p.deployedUrl = $('deployedUrlInput').value.trim();
  DB.saveData(d);
  toast('Deployment link saved.');
}

/* ----- Location ----------------------------------------------------------- */

let pendingLocation = null;

function attachLocationUI() {
  const status = $('newProjLocationStatus');
  if (!navigator.geolocation) { status.textContent = 'Geolocation is not available in this browser.'; return; }
  status.textContent = 'Requesting your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      pendingLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      status.textContent = 'Location attached (' + pendingLocation.lat.toFixed(2) + ', ' + pendingLocation.lng.toFixed(2) + ').';
    },
    (err) => { status.textContent = 'Location denied or unavailable: ' + err.message; }
  );
}

/* ---------------------------------------------------------------------------
   14. STUDIO
--------------------------------------------------------------------------- */

let studioTab = 'categories';
let studioCategory = 'All';

function setStudioTab(tab) {
  studioTab = tab;
  $$('.studio-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('studioCategoryPills').style.display = tab === 'categories' ? 'flex' : 'none';
  renderStudio();
}

function visibleProjectsForStudio() {
  return Object.values(DB.data().projects).filter(canSeeProject);
}

function renderStudio() {
  const cats = ['All', 'General', 'Web', 'Game', 'AI/ML', 'Tool', 'Mobile'];
  $('studioCategoryPills').innerHTML = cats.map(c =>
    `<div class="studio-category-pill ${c === studioCategory ? 'active' : ''}" onclick="pickStudioCategory('${c}')">${c}</div>`
  ).join('');

  const q = ($('studioSearchInput')?.value || '').toLowerCase();
  const sort = $('studioSortSelect')?.value || 'stars';
  let list = visibleProjectsForStudio();

  if (studioTab === 'yours')   list = list.filter(p => p.ownerId === myId());
  if (studioTab === 'socials') list = list.filter(p => (me().friends || []).includes(p.ownerId));
  if (studioTab === 'trending') {
    list = list.filter(p => p.visibility === 'public')
      .sort((a, b) => trendScore(b) - trendScore(a)).slice(0, 12);
  }
  if (studioTab === 'near') {
    list = list.filter(p => p.locationLabel || p.location);
  }
  if (studioTab === 'categories' && studioCategory !== 'All') {
    list = list.filter(p => p.category === studioCategory);
  }
  if (q) {
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      (p.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  if (studioTab !== 'trending') {
    list.sort((a, b) => sort === 'stars' ? (b.stars || 0) - (a.stars || 0) : b.createdAt - a.createdAt);
  }

  const hint = $('studioEmptyHint');
  if (!list.length) {
    hint.style.display = 'block';
    hint.textContent = studioTab === 'near'
      ? 'No projects nearby yet — attach a location when you create a project so it shows up here.'
      : 'Nothing matches yet. Create a public project and it will appear here.';
  } else hint.style.display = 'none';

  $('studioGrid').innerHTML = list.map(p => studioCard(p)).join('');
}

function trendScore(p) {
  const ageDays = (Date.now() - p.createdAt) / 86400000;
  return ((p.stars || 0) * 10 + (p.reviews || []).length * 4) / Math.pow(ageDays + 2, 0.7);
}

function pickStudioCategory(c) { studioCategory = c; renderStudio(); }

function studioCard(p) {
  const owner = userById(p.ownerId);
  const starred = (p.starredBy || []).includes(myId());
  return `<div class="dash-card theme-blue studio-card" tabindex="0">
    <div onclick="openProjectDetail('${p.id}')">
      <div class="icon-box"><svg viewBox="0 0 24 24"><path d="M12 2 20 6.5 V17.5 L12 22 L4 17.5 V6.5 Z"/></svg></div>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.description || 'No description.')}</p>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;">
        <span class="social-id-chip" style="font-size:.62rem;">${esc(p.category)}</span>
        ${owner ? `<span class="social-id-chip" style="font-size:.62rem;">${esc(owner.username)}</span>` : ''}
        ${p.locationLabel ? `<span class="social-id-chip" style="font-size:.62rem;">📍 ${esc(p.locationLabel)}</span>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
      <button class="star-toggle ${starred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleStar('${p.id}')">★ ${p.stars || 0}</button>
      <button class="nav-cta" style="font-size:.72rem;padding:6px 10px;" onclick="event.stopPropagation(); openReviewPrompt('${p.id}')">Review (${(p.reviews || []).length})</button>
    </div>
  </div>`;
}

function toggleStar(pid) {
  const d = DB.data();
  const p = d.projects[pid];
  if (!p) return;
  p.starredBy = p.starredBy || [];
  const i = p.starredBy.indexOf(myId());
  if (i === -1) { p.starredBy.push(myId()); p.stars = (p.stars || 0) + 1; }
  else { p.starredBy.splice(i, 1); p.stars = Math.max(0, (p.stars || 0) - 1); }
  DB.saveData(d);
  renderStudio();
}

function openReviewPrompt(pid) {
  const text = prompt('Leave a short review:');
  if (!text) return;
  const d = DB.data();
  const p = d.projects[pid];
  p.reviews = p.reviews || [];
  p.reviews.push({ by: myId(), text: text.slice(0, 300), at: Date.now() });
  DB.saveData(d);
  pushNotification(p.ownerId, 'New Review', me().username + ' reviewed ' + p.name + '.', '#/project/' + p.id);
  renderStudio();
  toast('Review posted.');
}

function startVoiceSearchUI() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice search is not supported in this browser.', true); return; }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.onstart = () => { $('studioMicBtn').classList.add('listening'); toast('Listening…'); };
  rec.onend   = () => $('studioMicBtn').classList.remove('listening');
  rec.onerror = (e) => { $('studioMicBtn').classList.remove('listening'); toast('Voice error: ' + e.error, true); };
  rec.onresult = (e) => {
    const said = e.results[0][0].transcript;
    $('studioSearchInput').value = said;
    renderStudio();
    toast('Searched for "' + said + '"');
  };
  rec.start();
}

/* ---------------------------------------------------------------------------
   15. CHAT
--------------------------------------------------------------------------- */

let chatPeerId = null;

function threadKey(a, b) { return [a, b].sort().join('::'); }

function renderCommPage() {
  const friends = (me().friends || []).map(userById).filter(Boolean);
  $('commFriendsList').innerHTML = friends.length
    ? friends.map(f => `<div class="friend-row" style="cursor:pointer;" onclick="openChatWith('${f.id}')">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="presence-dot ${Date.now() - f.lastSeen < 300000 ? 'online' : ''}"></span>
          <b style="font-size:.85rem;">${esc(f.username)}</b>
        </div></div>`).join('')
    : `<p style="font-size:.82rem;color:var(--text-tertiary);">Add friends from the Social page to start chatting.</p>`;
  if (chatPeerId) renderThread();
}

function openChatWith(userId) {
  chatPeerId = userId;
  openKnightPage('commPage');
  const u = userById(userId);
  $('commThreadLabel').textContent = u ? 'Chat with ' + u.username : 'Chat';
  renderThread();
}

function renderThread() {
  if (!chatPeerId) return;
  const msgs = DB.data().messages[threadKey(myId(), chatPeerId)] || [];
  const box = $('commThread');
  box.innerHTML = msgs.length
    ? msgs.map(m => {
        const mine = m.from === myId();
        return `<div style="align-self:${mine ? 'flex-end' : 'flex-start'};max-width:75%;background:${mine ? 'rgba(243,198,35,.14)' : 'rgba(255,255,255,.06)'};border:1px solid var(--panel-border);border-radius:14px;padding:10px 14px;">
          <div style="font-size:.86rem;">${esc(m.text)}</div>
          <div style="font-size:.66rem;color:var(--text-tertiary);margin-top:4px;">${timeAgo(m.at)}</div></div>`;
      }).join('')
    : `<p style="font-size:.82rem;color:var(--text-tertiary);">No messages yet. Say hello.</p>`;
  box.scrollTop = box.scrollHeight;
}

function sendChatMessageUI() {
  if (!chatPeerId) { toast('Pick a friend first.', true); return; }
  const input = $('commMessageInput');
  const text = (input.value || '').trim();
  if (!text) return;
  const d = DB.data();
  const key = threadKey(myId(), chatPeerId);
  d.messages[key] = d.messages[key] || [];
  d.messages[key].push({ id: uid('msg'), from: myId(), to: chatPeerId, text, at: Date.now() });
  DB.saveData(d);
  pushNotification(chatPeerId, 'New Message', me().username + ': ' + text.slice(0, 60), '#/comm/' + me().socialId);
  input.value = '';
  renderThread();
}

/* ---------------------------------------------------------------------------
   16. NOTES
--------------------------------------------------------------------------- */

function renderNotes() {
  const notes = DB.data().notes[myId()] || [];
  $('notesGrid').innerHTML = notes.length
    ? notes.map(n => `<div class="dash-card theme-neutral" style="cursor:default;">
        <h3 contenteditable="true" onblur="updateNote('${n.id}','title',this.textContent)">${esc(n.title)}</h3>
        <textarea onblur="updateNote('${n.id}','body',this.value)" style="width:100%;min-height:120px;background:rgba(0,0,0,.3);border:1px solid var(--panel-border);border-radius:10px;padding:10px;color:var(--text-primary);font-family:'JetBrains Mono',monospace;font-size:.8rem;resize:vertical;">${esc(n.body)}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <span style="font-size:.7rem;color:var(--text-tertiary);">${timeAgo(n.at)}</span>
          <button class="nav-cta" style="color:var(--accent-coral);font-size:.72rem;padding:6px 10px;" onclick="deleteNote('${n.id}')">Delete</button>
        </div></div>`).join('')
    : `<p style="font-size:.9rem;color:var(--text-tertiary);">No notes yet.</p>`;
}

function createNoteUI() {
  const d = DB.data();
  d.notes[myId()] = d.notes[myId()] || [];
  d.notes[myId()].unshift({ id: uid('note'), title: 'Untitled note', body: '', at: Date.now() });
  DB.saveData(d);
  renderNotes();
}

function updateNote(id, field, value) {
  const d = DB.data();
  const n = (d.notes[myId()] || []).find(x => x.id === id);
  if (!n) return;
  n[field] = value; n.at = Date.now();
  DB.saveData(d);
}

function deleteNote(id) {
  const d = DB.data();
  d.notes[myId()] = (d.notes[myId()] || []).filter(n => n.id !== id);
  DB.saveData(d);
  renderNotes();
}

/* ---------------------------------------------------------------------------
   17. TERMINAL (real execution via Piston)
--------------------------------------------------------------------------- */

const PISTON_VERSIONS = {
  javascript: '18.15.0', python: '3.10.0', 'c++': '10.2.0', c: '10.2.0',
  java: '15.0.2', typescript: '5.0.3', go: '1.16.2', rust: '1.68.2',
  php: '8.2.3', ruby: '3.0.1', bash: '5.2.0',
};

async function runCodeUI() {
  const lang = $('termLanguage').value;
  const code = $('termCodeInput').value;
  const out = $('termOutput');
  const btn = $('runCodeBtn');

  out.textContent = 'Running…';
  btn.disabled = true;

  try {
    const res = await fetch('https://emkc.org/api/v2/piston/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: lang,
        version: PISTON_VERSIONS[lang] || '*',
        files: [{ name: lang === 'java' ? 'Main.java' : 'main', content: code }],
      }),
    });
    const data = await res.json();
    const r = data.run || {};
    const text = (r.stdout || '') + (r.stderr || '');
    out.textContent = text.trim() || '(no output)';
    if (r.stderr && $('termAudioToggle').checked && DB.prefs().errorSound !== false) beep();
  } catch (e) {
    out.textContent = 'Could not reach the execution service.\n' + e.message +
      '\n\nThis needs internet access — it runs your code on a real remote runtime.';
    if ($('termAudioToggle').checked) beep();
  } finally {
    btn.disabled = false;
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 180; o.type = 'square';
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.start(); o.stop(ctx.currentTime + 0.3);
  } catch {}
}

/* ---------------------------------------------------------------------------
   18. ARCADE — memory match
--------------------------------------------------------------------------- */

let memState = null;

function startMemoryGame() {
  const symbols = ['⚔️','🛡️','👑','🐉','🦅','🔥','⚡','💎'];
  const deck = [...symbols, ...symbols]
    .map(s => ({ s, id: uid('c'), flipped: false, matched: false }))
    .sort(() => Math.random() - 0.5);
  memState = { deck, first: null, lock: false, moves: 0, matches: 0 };
  $('memoryMoves').textContent = '0';
  $('memoryMatches').textContent = '0';
  renderMemory();
}

function renderMemory() {
  $('memoryBoard').innerHTML = memState.deck.map((c, i) => `
    <div onclick="flipCard(${i})" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:1.8rem;
      background:${c.flipped || c.matched ? 'rgba(243,198,35,.12)' : 'rgba(255,255,255,.05)'};
      border:1px solid ${c.matched ? 'var(--accent-gold)' : 'var(--panel-border)'};
      border-radius:14px;cursor:pointer;transition:.2s;user-select:none;">
      ${c.flipped || c.matched ? c.s : ''}
    </div>`).join('');
}

function flipCard(i) {
  if (!memState || memState.lock) return;
  const c = memState.deck[i];
  if (c.flipped || c.matched) return;
  c.flipped = true;
  renderMemory();

  if (memState.first === null) { memState.first = i; return; }

  memState.moves++;
  $('memoryMoves').textContent = memState.moves;
  const a = memState.deck[memState.first];

  if (a.s === c.s) {
    a.matched = c.matched = true;
    memState.matches++;
    $('memoryMatches').textContent = memState.matches;
    memState.first = null;
    renderMemory();
    if (memState.matches === 8) {
      toast('Cleared in ' + memState.moves + ' moves!');
      incrementStat('commits');
    }
  } else {
    memState.lock = true;
    setTimeout(() => {
      a.flipped = c.flipped = false;
      memState.first = null; memState.lock = false;
      renderMemory();
    }, 700);
  }
}

/* ---------------------------------------------------------------------------
   19. GAME BOOSTER + LINK DEPLOYER
--------------------------------------------------------------------------- */

function renderGameBooster() {
  const nav = navigator;
  const cards = [
    ['CPU Threads', (nav.hardwareConcurrency || '—') + ' logical cores'],
    ['Device Memory', nav.deviceMemory ? nav.deviceMemory + ' GB (approx.)' : 'Not exposed'],
    ['Network', nav.connection ? (nav.connection.effectiveType || '—') + ' · ' + (nav.connection.downlink || '?') + ' Mbps' : 'Not exposed'],
    ['Screen', screen.width + '×' + screen.height + ' @ ' + (window.devicePixelRatio || 1) + 'x'],
    ['Platform', nav.platform || '—'],
    ['Live FPS', '<span id="fpsVal">measuring…</span>'],
  ];
  $('gameBoosterGrid').innerHTML = cards.map(([k, v]) =>
    `<div class="dash-card theme-orange" style="cursor:default;"><h3 style="font-size:.95rem;">${k}</h3><p style="font-size:1.05rem;color:var(--text-primary);">${v}</p></div>`
  ).join('');

  const tips = [];
  if ((nav.hardwareConcurrency || 8) <= 4) tips.push('Only a few CPU threads — close background tabs before heavy games.');
  if (nav.deviceMemory && nav.deviceMemory <= 4) tips.push('Limited memory — lower in-game texture quality.');
  if (nav.connection && ['slow-2g','2g','3g'].includes(nav.connection.effectiveType)) tips.push('Slow connection detected — avoid online multiplayer right now.');
  if ((window.devicePixelRatio || 1) > 2) tips.push('Very high DPI screen — running games at native resolution will cost FPS.');
  if (!tips.length) tips.push('Your browser reports a healthy setup for web games.');
  $('gameBoosterTips').innerHTML = tips.map(t =>
    `<div style="background:rgba(0,0,0,.25);border:1px solid var(--panel-border);border-radius:12px;padding:12px;font-size:.85rem;color:var(--text-secondary);">${t}</div>`
  ).join('');

  measureFPS();
}

function measureFPS() {
  let frames = 0;
  const start = performance.now();
  function tick(now) {
    frames++;
    if (now - start >= 1000) {
      const el = $('fpsVal');
      if (el) el.textContent = frames + ' FPS';
      return;
    }
    if ($('gameBoosterPage').classList.contains('active')) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderLinkDeployer() {
  const projects = Object.values(DB.data().projects).filter(p => p.ownerId === myId());
  $('linkDeployerList').innerHTML = projects.length
    ? projects.map(p => `<div class="friend-row">
        <div><b>${esc(p.name)}</b>
        <div style="font-size:.74rem;color:var(--text-tertiary);">${p.deployedUrl ? esc(p.deployedUrl) : 'No link saved yet'}</div></div>
        <div style="display:flex;gap:8px;">
          ${p.deployedUrl ? `<a class="nav-cta" href="${esc(p.deployedUrl)}" target="_blank" rel="noopener">Visit</a>` : ''}
          <button class="nav-cta" onclick="openProjectDetail('${p.id}')">Edit</button>
        </div></div>`).join('')
    : `<p style="font-size:.85rem;color:var(--text-tertiary);">No projects yet.</p>`;
}

/* ---------------------------------------------------------------------------
   20. SHORTCUTS + DEVICE MODES
--------------------------------------------------------------------------- */

const SHORTCUTS = [
  { cat: 'Navigation', win: 'Alt + H', mac: '⌘ + H', desc: 'Return to the dashboard' },
  { cat: 'Navigation', win: 'Alt + T', mac: '⌘ + T', desc: 'Open the Terminal' },
  { cat: 'Navigation', win: 'Alt + P', mac: '⌘ + P', desc: 'Open Projects Manager' },
  { cat: 'Navigation', win: 'Alt + S', mac: '⌘ + S', desc: 'Open Studio' },
  { cat: 'Navigation', win: 'Alt + N', mac: '⌘ + N', desc: 'Open Notes' },
  { cat: 'Navigation', win: 'Alt + G', mac: '⌘ + G', desc: 'Open Social & Friends' },
  { cat: 'Tools',      win: 'Ctrl + K', mac: '⌘ + K', desc: 'Command palette' },
  { cat: 'Tools',      win: 'Alt + B', mac: '⌘ + B', desc: 'Open Game Booster' },
  { cat: 'Tools',      win: 'Alt + M', mac: '⌘ + M', desc: 'Open Communication' },
  { cat: 'Modals',     win: 'Esc',     mac: 'Esc',   desc: 'Close any open modal or page' },
  { cat: 'Modals',     win: 'Alt + U', mac: '⌘ + U', desc: 'Open your profile card' },
  { cat: 'Modals',     win: 'Alt + A', mac: '⌘ + A', desc: 'Open system alerts' },
];

let shortcutOS = 'windows';

function renderShortcuts() {
  const q = ($('shortcutSearchInput')?.value || '').toLowerCase();
  const list = SHORTCUTS.filter(s => s.desc.toLowerCase().includes(q) || s.cat.toLowerCase().includes(q));
  $('shortcutCount').textContent = list.length + ' of ' + SHORTCUTS.length + ' shortcuts';

  const byCat = {};
  list.forEach(s => { (byCat[s.cat] = byCat[s.cat] || []).push(s); });

  $('shortcutGrid').innerHTML = Object.entries(byCat).map(([cat, items]) =>
    `<div class="shortcut-category-label" style="grid-column:1/-1;">${cat}</div>` +
    items.map(s => `<div class="shortcut-card">
      <div class="shortcut-keys">${shortcutOS === 'windows' ? s.win : s.mac}</div>
      <div class="shortcut-desc">${s.desc}</div></div>`).join('')
  ).join('');
}

function detectDevice() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'Tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'Smartphone';
  if (/Mac/i.test(ua)) return 'MacBook';
  return 'Windows';
}

function applyDevice(device) {
  const p = DB.prefs(); p.device = device; DB.savePrefs(p);
  const el = $('headerDeviceName');
  if (el) el.textContent = device;

  // The stylesheet drives the on-screen controls from body classes.
  ['windows','macbook','smartphone','tablet','console','handheld','headphones']
    .forEach(d => document.body.classList.remove('device-' + d));
  document.body.classList.add('device-' + device.toLowerCase());
  shortcutOS = device === 'MacBook' ? 'macos' : 'windows';
  $$('.os-tab').forEach(t => t.classList.toggle('active', t.dataset.os === shortcutOS));
  $$('.device-card').forEach(c => c.classList.toggle('selected', c.dataset.device === device));
}

function openDeviceSetup() { closeModal('profileModal'); openModalRaw('deviceModal'); }

/* ---------------------------------------------------------------------------
   21. COMMAND PALETTE
--------------------------------------------------------------------------- */

const CMDS = [
  { label: 'Dashboard',        hint: 'home',     run: goHome },
  { label: 'Terminal',         hint: 'run code', run: () => openKnightPage('terminalPage') },
  { label: 'Projects Manager', hint: 'projects', run: () => openKnightPage('projectsPage') },
  { label: 'Studio',           hint: 'discover', run: () => openKnightPage('studioPage') },
  { label: 'Communication',    hint: 'chat',     run: () => openKnightPage('commPage') },
  { label: 'Social & Friends', hint: 'friends',  run: () => openKnightPage('socialPage') },
  { label: 'Notes = Codes',    hint: 'notes',    run: () => openKnightPage('notesPage') },
  { label: 'Arcade',           hint: 'game',     run: () => openKnightPage('arcadePage') },
  { label: 'Game Booster',     hint: 'perf',     run: () => openKnightPage('gameBoosterPage') },
  { label: 'Settings',         hint: 'prefs',    run: () => openKnightPage('settingsPage') },
  { label: 'Shortcuts',        hint: 'keys',     run: () => openKnightPage('shortcutPage') },
  { label: 'My Profile',       hint: 'account',  run: () => openModal('profileModal') },
  { label: 'Sign Out',         hint: 'log out',  run: signOutUI },
];

function openCommandPalette() {
  if (!requireAuth()) return;
  openModalRaw('commandPaletteModal');
  $('cmdkInput').value = '';
  renderCmdk();
  setTimeout(() => $('cmdkInput').focus(), 50);
}

function renderCmdk() {
  const q = ($('cmdkInput').value || '').toLowerCase();
  const list = CMDS.filter(c => c.label.toLowerCase().includes(q) || c.hint.includes(q));
  $('cmdkResults').innerHTML = list.map((c, i) =>
    `<div class="cmdk-item" data-i="${CMDS.indexOf(c)}">
      <span>${esc(c.label)}</span><span class="cmdk-item-hint">${esc(c.hint)}</span></div>`
  ).join('') || `<div class="cmdk-item"><span style="color:var(--text-tertiary);">No matches</span></div>`;

  $$('#cmdkResults .cmdk-item').forEach(el => {
    el.onclick = () => {
      const c = CMDS[parseInt(el.dataset.i, 10)];
      closeModal('commandPaletteModal');
      if (c) c.run();
    };
  });
}

/* ---------------------------------------------------------------------------
   22. SETTINGS / CAMERA / PREFS
--------------------------------------------------------------------------- */

let camStream = null;

function renderSettings() {
  const p = DB.prefs();
  $('defaultPageSelect').value = p.defaultPage || '';
  $('settingsErrorSoundToggle').checked = p.errorSound !== false;
  $('settingsCompactToggle').checked = !!p.compact;
  $('socialAllowRequestsToggle').checked = p.allowRequests !== false;
  $('socialAutoAcceptToggle').checked = !!p.autoAccept;
  $('socialShowIdToggle').checked = p.showId !== false;
  $('siteReduceMotionToggle').checked = !!p.reduceMotion;
  $('siteNotifyToggle').checked = !!p.desktopNotify;
  $('camMirrorToggle').checked = p.camMirror !== false;
  renderPasskeys();
  applyDevice(p.device || detectDevice());
}

function bindPrefToggles() {
  const map = {
    settingsErrorSoundToggle: 'errorSound',
    settingsCompactToggle: 'compact',
    socialAllowRequestsToggle: 'allowRequests',
    socialAutoAcceptToggle: 'autoAccept',
    socialShowIdToggle: 'showId',
    siteReduceMotionToggle: 'reduceMotion',
    siteNotifyToggle: 'desktopNotify',
    camMirrorToggle: 'camMirror',
  };
  Object.entries(map).forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.onchange = () => {
      const p = DB.prefs(); p[key] = el.checked; DB.savePrefs(p);
      applyPrefsToUI();
      if (key === 'desktopNotify' && el.checked && 'Notification' in window) Notification.requestPermission();
      toast('Preference saved.');
    };
  });
  const dp = $('defaultPageSelect');
  if (dp) dp.onchange = () => {
    const p = DB.prefs(); p.defaultPage = dp.value; DB.savePrefs(p);
    toast(dp.value ? 'Default page set.' : 'Default page reset to Dashboard.');
  };
}

function applyPrefsToUI() {
  const p = DB.prefs();
  document.body.classList.toggle('reduce-motion', !!p.reduceMotion);
  document.body.classList.toggle('compact', !!p.compact);
  const chip = $('headerSocialIdChip');
  if (chip) chip.style.display = p.showId === false ? 'none' : 'inline-block';
}

function resetLocalPrefsUI() {
  if (!confirm('Reset local preferences? Your account, projects, and notes are NOT touched.')) return;
  localStorage.removeItem(LS.prefs);
  applyDevice(detectDevice());
  renderSettings(); applyPrefsToUI();
  toast('Preferences reset.');
}

async function requestCameraAccessUI() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const v = $('camPreview');
    v.srcObject = camStream;
    v.style.display = 'block';
    v.style.transform = $('camMirrorToggle').checked ? 'scaleX(-1)' : 'none';
    const devices = await navigator.mediaDevices.enumerateDevices();
    $('camDeviceSelect').innerHTML = devices.filter(d => d.kind === 'videoinput')
      .map(d => `<option value="${d.deviceId}">${esc(d.label || 'Camera')}</option>`).join('') || '<option>No cameras</option>';
    $('micDeviceSelect').innerHTML = devices.filter(d => d.kind === 'audioinput')
      .map(d => `<option value="${d.deviceId}">${esc(d.label || 'Microphone')}</option>`).join('') || '<option>No microphones</option>';
    $('camPermissionHint').textContent = 'Access granted — pick your devices below.';
  } catch (e) {
    $('camPermissionHint').textContent = 'Access denied or unavailable: ' + e.message;
    toast('Camera access denied.', true);
  }
}

function saveCameraSettingsUI() {
  const p = DB.prefs();
  p.camId = $('camDeviceSelect').value;
  p.micId = $('micDeviceSelect').value;
  p.camMirror = $('camMirrorToggle').checked;
  DB.savePrefs(p);
  const v = $('camPreview');
  if (v) v.style.transform = p.camMirror ? 'scaleX(-1)' : 'none';
  toast('Camera settings saved.');
}

function stopCameraPreviewUI() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  const v = $('camPreview');
  v.srcObject = null; v.style.display = 'none';
  $('camPermissionHint').textContent = 'Preview stopped.';
}

/* ---------------------------------------------------------------------------
   23. ADMIN
--------------------------------------------------------------------------- */

function renderAdmin() {
  if (!me() || !me().admin) { $('adminBody').innerHTML = '<p>Access denied.</p>'; return; }
  const users = Object.values(DB.users());
  const d = DB.data();
  const projects = Object.values(d.projects);
  $('adminBody').innerHTML = `
    <div class="dash-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin-bottom:20px;">
      ${[['Accounts', users.length], ['Projects', projects.length],
         ['Public projects', projects.filter(p => p.visibility === 'public').length],
         ['Guest sessions', users.filter(u => u.guest).length]]
        .map(([k, v]) => `<div class="dash-card theme-neutral" style="cursor:default;"><h3 style="font-size:.9rem;">${k}</h3><p style="font-size:1.4rem;color:var(--text-primary);">${v}</p></div>`).join('')}
    </div>
    <div class="shortcut-category-label">Accounts</div>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:720px;">
      ${users.map(u => `<div class="friend-row"><div><b>${esc(u.username)}</b>
        <div style="font-size:.74rem;color:var(--text-tertiary);">${esc(u.socialId)} · ${esc(u.email)} · joined ${timeAgo(u.createdAt)}${u.guest ? ' · guest' : ''}${u.admin ? ' · admin' : ''}</div></div></div>`).join('')}
    </div>`;
}

/* ---------------------------------------------------------------------------
   24. KEYBOARD — only active when signed in
   (This is the fix for people triggering Alt shortcuts on the sign-in screen.)
--------------------------------------------------------------------------- */

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    const openModalEl = $$('.modal-overlay.active')[0];

    if (e.key === 'Escape') {
      if (openModalEl) { openModalEl.classList.remove('active'); return; }
      if ($$('.knight-page.active')[0] && me()) { goHome(); return; }
      return;
    }

    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (me()) openCommandPalette();
      return;
    }

    // Everything below requires a signed-in user. Without this guard, Alt+key
    // on the sign-in screen used to fire app navigation.
    if (!me() || typing) return;

    const mod = shortcutOS === 'macos' ? e.metaKey : e.altKey;
    if (!mod) return;

    const map = {
      h: goHome,
      t: () => openKnightPage('terminalPage'),
      p: () => openKnightPage('projectsPage'),
      s: () => openKnightPage('studioPage'),
      n: () => openKnightPage('notesPage'),
      g: () => openKnightPage('socialPage'),
      b: () => openKnightPage('gameBoosterPage'),
      m: () => openKnightPage('commPage'),
      u: () => openModal('profileModal'),
      a: () => openModal('notificationsModal'),
    };
    const fn = map[e.key.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
  });
}

/* ---------------------------------------------------------------------------
   25. BOOT
--------------------------------------------------------------------------- */

function boot() {
  // Auth tabs
  $('tab-signin').onclick = () => setAuthMode('signin');
  $('tab-signup').onclick = () => setAuthMode('signup');
  $('knightForm').onsubmit = handleAuthSubmit;
  $('guestBtn').onclick = signInAsGuest;
  $('passkeyLoginBtn').onclick = signInWithPasskey;

  // Signup avatar + role
  buildAvatarGrid('authAvatarGrid', (i) => {
    pendingAvatar = null;
    $('authAvatarPreviewWrap').innerHTML = `<span style="font-size:24px;">${AVATAR_EMBLEMS[i]}</span>`;
  });
  $('authAvatarUpload').onchange = (e) => {
    readImageFile(e.target, (src) => {
      pendingAvatar = src;
      $('authAvatarPreviewWrap').innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;">`;
    });
  };
  $$('#roleTabs .role-tab').forEach(t => {
    t.onclick = () => {
      $$('#roleTabs .role-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      pendingRole = t.dataset.role;
    };
  });

  // Edit profile
  $('editProfileForm').onsubmit = saveProfile;
  $('editAvatarUpload').onchange = (e) => {
    readImageFile(e.target, (src) => {
      const users = DB.users(); const u = users[CURRENT.email];
      u.avatar = src; DB.saveUsers(users); CURRENT = u;
      $('editAvatarPreviewWrap').innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;">`;
      renderHeader();
    });
  };

  // Device pickers
  $$('.device-card').forEach(c => { c.onclick = () => { applyDevice(c.dataset.device); toast(c.dataset.device + ' mode active.'); }; });

  // Studio + shortcuts inputs
  $('studioSearchInput').oninput = renderStudio;
  $('studioSortSelect').onchange = renderStudio;
  $('shortcutSearchInput').oninput = renderShortcuts;
  $$('.os-tab').forEach(t => { t.onclick = () => { shortcutOS = t.dataset.os; $$('.os-tab').forEach(x => x.classList.remove('active')); t.classList.add('active'); renderShortcuts(); }; });
  $('cmdkInput').oninput = renderCmdk;
  $('commMessageInput').onkeydown = (e) => { if (e.key === 'Enter') sendChatMessageUI(); };

  // Close modal on backdrop click
  $$('.modal-overlay').forEach(m => {
    m.onclick = (e) => { if (e.target === m) m.classList.remove('active'); };
  });

  bindPrefToggles();
  setupKeyboard();
  window.addEventListener('hashchange', handleRoute);

  // Live cross-tab updates
  bus.on(({ type }) => {
    if (type !== 'data-changed') return;
    if (CURRENT) {
      const fresh = DB.users()[CURRENT.email];
      if (fresh) CURRENT = fresh;
    }
    renderNotifBadge();
    if ($('commPage').classList.contains('active')) renderThread();
    if ($('studioPage').classList.contains('active')) renderStudio();
    if ($('socialPage').classList.contains('active')) renderSocialPage();
  });

  // Keep presence fresh
  setInterval(() => {
    if (!CURRENT) return;
    const users = DB.users();
    if (users[CURRENT.email]) { users[CURRENT.email].lastSeen = Date.now(); DB.saveUsers(users); }
  }, 60000);

  // ---- Restore an existing session: this is the "still signed in" behaviour ----
  const session = getSession();
  if (session) {
    const user = userById(session.userId);
    if (user) {
      enterApp(user, { fresh: false });
      handleRoute();
      return;
    }
    clearSession();   // session pointed at a deleted account
  }

  $('auth').style.display = 'flex';
  $('dashboard').style.display = 'none';
  setAuthMode('signin');
}

document.addEventListener('DOMContentLoaded', boot);

/* Expose the handlers that index.html calls via inline onclick attributes. */
Object.assign(window, {
  openKnightPage, closeKnightPage, openModal, closeModal, openModalRaw,
  signOutUI, goHome, show404,
  copySocialId, incrementStat, extractDataSheet, openDeviceSetup,
  openPublicProfile, userById, viewProfileFromSocialPage,
  sendFriendRequestUI, sendFriendRequestFromSocialPage, addFriendFromProfileUI,
  respondToRequest, renderSocialFriendsList, sendPingUI, messageFromProfileUI,
  clearNotifications, openNotification,
  createProjectUI, openProjectDetail, addProjectFileUI, openFileEditor,
  saveFileEditorUI, deleteFileEditorUI, cutVersionUI, restoreVersion,
  addProjectMemberUI, changeMemberRole, removeMember,
  saveJoinCodeSettingsUI, copyJoinCodeUI, regenerateJoinCodeUI, joinProjectByCodeUI,
  reviewChange, saveDeployedUrlUI, attachLocationUI,
  setStudioTab, pickStudioCategory, toggleStar, openReviewPrompt, startVoiceSearchUI,
  openChatWith, sendChatMessageUI,
  createNoteUI, updateNote, deleteNote,
  runCodeUI, startMemoryGame, flipCard,
  addPasskeyUI, removePasskey,
  requestCameraAccessUI, saveCameraSettingsUI, stopCameraPreviewUI, resetLocalPrefsUI,
  openCommandPalette,
});
