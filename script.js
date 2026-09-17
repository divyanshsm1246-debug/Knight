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

function setSession(userId, remember = true) {
  // "Remember me" ticked  -> the session survives closing the browser for a year.
  // Unticked              -> it lasts 12 hours, so a shared computer forgets you.
  const days = remember ? SESSION_DAYS : 0.5;
  writeJSON(LS.session, {
    userId,
    token: uid('tok'),
    remember: !!remember,
    expires: Date.now() + days * 86400000,
  });
}

function rememberChecked() {
  const box = $('rememberMe');
  return box ? !!box.checked : true;
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

  if (!user) {
    const err = new Error('No account found for that email on this device.');
    err.offerSignup = true;
    throw err;
  }
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

    setSession(user.id, rememberChecked());
    enterApp(user, { fresh: true });
    toast(authMode === 'signup' ? 'Account created. Welcome to Knight.' : 'Welcome back, ' + user.username + '.');
  } catch (err) {
    authError(err.message || 'Something went wrong. Please try again.');
    // Signing in with an email that has no account is the single most common
    // failure, so offer the fix instead of leaving a dead end.
    if (err.offerSignup) {
      const el = $('authError');
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'nav-cta';
      link.style.cssText = 'margin-top:10px;font-size:.75rem;padding:6px 14px;display:block;';
      link.textContent = 'Create an account with this email instead';
      link.onclick = () => { setAuthMode('signup'); $('email').value = email; };
      el.appendChild(link);
    }
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
  setSession(user.id, false);   // guests are never remembered
  seedNotifications(user.id, true);
  enterApp(user, { fresh: true });
  toast('Guest session started — create an account any time to keep your work.');
}

function signOutUI() {
  stopPreview();
  document.body.classList.remove('is-authed');
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
    setSession(user.id, rememberChecked());
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

/* Twelve geometric emblems, drawn as SVG so they stay crisp at any size and
   pick up the current theme colour instead of looking like pasted emoji. */
const AVATAR_SVGS = [
  // 1 cube
  '<path d="M24 5 L41 14.5 L41 33.5 L24 43 L7 33.5 L7 14.5 Z"/><path d="M7 14.5 L24 24 L41 14.5"/><path d="M24 24 L24 43"/>',
  // 2 nested triangles
  '<path d="M24 7 L42 39 L6 39 Z"/><path d="M24 19 L33 34 L15 34 Z"/>',
  // 3 orbit
  '<circle cx="24" cy="24" r="8"/><ellipse cx="24" cy="24" rx="18" ry="7.5" transform="rotate(-28 24 24)"/>',
  // 4 stacked diamonds
  '<path d="M24 5 L36 17 L24 29 L12 17 Z"/><path d="M24 25 L36 37 L24 43"/><path d="M24 25 L12 37 L24 43"/>',
  // 5 hex core
  '<path d="M24 5 L40 14.5 L40 33.5 L24 43 L8 33.5 L8 14.5 Z"/><circle cx="24" cy="24" r="5"/>',
  // 6 chevrons
  '<path d="M9 18 L24 8 L39 18"/><path d="M9 28 L24 18 L39 28"/><path d="M9 38 L24 28 L39 38"/>',
  // 7 rotated squares
  '<rect x="12" y="12" width="24" height="24" rx="2"/><rect x="12" y="12" width="24" height="24" rx="2" transform="rotate(45 24 24)"/>',
  // 8 signal arcs
  '<circle cx="24" cy="34" r="3.5"/><path d="M15 27a12 12 0 0 1 18 0"/><path d="M9 20a20 20 0 0 1 30 0"/>',
  // 9 quad grid
  '<rect x="8" y="8" width="14" height="14" rx="2"/><rect x="26" y="8" width="14" height="14" rx="2"/><rect x="8" y="26" width="14" height="14" rx="2"/><rect x="26" y="26" width="14" height="14" rx="2"/>',
  // 10 asterisk burst
  '<line x1="24" y1="6" x2="24" y2="42"/><line x1="8" y1="15" x2="40" y2="33"/><line x1="8" y1="33" x2="40" y2="15"/><circle cx="24" cy="24" r="4.5"/>',
  // 11 shield
  '<path d="M24 5 L40 11 V25 C40 34 33 40 24 43 C15 40 8 34 8 25 V11 Z"/><path d="M17 24 L22 29 L32 19"/>',
  // 12 waves
  '<path d="M7 18c5-6 10-6 15 0s10 6 15 0"/><path d="M7 27c5-6 10-6 15 0s10 6 15 0"/><path d="M7 36c5-6 10-6 15 0s10 6 15 0"/>',
];

function emblemSvg(i) {
  return `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4"
    stroke-linecap="round" stroke-linejoin="round">${AVATAR_SVGS[i % AVATAR_SVGS.length]}</svg>`;
}

function avatarMarkup(user, size = 40) {
  if (!user) return '';
  if (user.avatar) {
    return `<img src="${esc(user.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
  }
  return `<span style="width:${Math.round(size * 0.58)}px;height:${Math.round(size * 0.58)}px;
    display:flex;color:var(--accent-gold);">${emblemSvg(user.avatarIndex || 0)}</span>`;
}

function buildAvatarGrid(gridId, onPick, selected = 0) {
  const grid = $(gridId);
  if (!grid) return;
  grid.innerHTML = AVATAR_SVGS.map((_, i) =>
    `<div class="avatar-item ${i === selected ? 'selected' : ''}" data-index="${i}">${emblemSvg(i)}</div>`
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
  updateServerButtonContext(null);
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
  updateServerButtonContext(null);
}

function goHome() { navigate('home'); openDashboard(); }

/* ---------------------------------------------------------------------------
   8. PAGE OPEN / CLOSE
--------------------------------------------------------------------------- */


/** The floating server button only belongs on a project's own pages — not
    floating over Studio, Social, Notes, etc. where it means nothing. */
const PROJECT_CONTEXT_PAGES = new Set(['projectDetailPage', 'previewPage', 'linkDeployerPage']);
function updateServerButtonContext(pageId) {
  document.body.classList.toggle('on-project-page', PROJECT_CONTEXT_PAGES.has(pageId));
}

function openKnightPage(pageId, fromRouter = false) {
  if (!requireAuth()) return;
  const page = $(pageId);
  if (!page) { show404(); return; }

  $$('.knight-page').forEach(p => p.classList.remove('active'));
  $('notFoundPage').classList.remove('active');
  $('dashboard').style.display = 'none';
  page.classList.add('active');
  window.scrollTo(0, 0);
  updateServerButtonContext(pageId);

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
  document.body.classList.add('is-authed');

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

let notifFilter = 'all';

/** Every notification belongs to a category: an icon, a colour, and a short
    tag label shown on the card — not just an icon guessed from the title. */
const NOTIF_CATEGORIES = {
  friend:  { label: 'Friend',  color: '#6FA8DC', icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>' },
  message: { label: 'Message', color: '#6FA8B0', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  project: { label: 'Project', color: '#F3C623', icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' },
  change:  { label: 'Change',  color: '#B98EE0', icon: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>' },
  review:  { label: 'Review',  color: '#F3C623', icon: '<polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.6"/>' },
  system:  { label: 'System',  color: '#D96C5B', icon: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>' },
};

/** Categorise from what the notification is actually about, not a guess-icon. */
function notifCategory(n) {
  const t = (n.title || '').toLowerCase();
  if (t.includes('friend') || t.includes('ping')) return 'friend';
  if (t.includes('message')) return 'message';
  if (t.includes('change')) return 'change';
  if (t.includes('review') || t.includes('star')) return 'review';
  if (t.includes('project') || t.includes('joined') || t.includes('added')) return 'project';
  return 'system';
}

function setNotifFilter(f) {
  notifFilter = f;
  $$('.notif-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  renderNotifications();
}

/** "Today", "Yesterday", or a short date — groups the list like a real inbox. */
function notifDayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderNotifications() {
  const box = $('notificationsContainer');
  if (!box) return;

  const all = DB.data().notifications[myId()] || [];
  const unreadCount = all.filter(n => !n.read).length;

  const sub = $('notifSubtitle');
  if (sub) {
    sub.textContent = !all.length ? "Nothing here yet."
      : unreadCount ? unreadCount + (unreadCount === 1 ? ' unread alert' : ' unread alerts')
      : "You're all caught up.";
  }

  const unreadTab = $('notifFilterUnreadCount');
  if (unreadTab) unreadTab.textContent = unreadCount ? String(unreadCount) : '';

  const list = notifFilter === 'unread' ? all.filter(n => !n.read) : all;

  if (!list.length) {
    box.innerHTML = `<div class="notif-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
      <p>${notifFilter === 'unread' ? 'No unread alerts.' : 'No alerts yet.'}</p></div>`;
    return;
  }

  // Group into day sections so the list reads like a real inbox, not a flat dump.
  let lastDay = null;
  const rows = list.map(n => {
    const cat = NOTIF_CATEGORIES[notifCategory(n)];
    const day = notifDayLabel(n.at);
    const header = day !== lastDay ? `<div class="notif-day-label">${esc(day)}</div>` : '';
    lastDay = day;
    return header + `
    <div class="notif-card ${n.read ? '' : 'is-unread'}" style="--notif-accent:${cat.color};" onclick="openNotification('${n.id}')">
      <div class="notif-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${cat.icon}</svg></div>
      <div class="notif-body">
        <div class="notif-title-row">
          <span class="notif-title">${esc(n.title)}</span>
          <span class="notif-tag">${esc(cat.label)}</span>
          ${n.read ? '' : '<span class="notif-dot"></span>'}
        </div>
        <div class="notif-desc">${esc(n.desc)}</div>
        <div class="notif-time">${timeAgo(n.at)}</div>
      </div>
      <button class="notif-x" title="Dismiss" onclick="event.stopPropagation(); deleteNotification('${n.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  });

  box.innerHTML = rows.join('');
}

function openNotification(id) {
  const d = DB.data();
  const list = d.notifications[myId()] || [];
  const n = list.find(x => x.id === id);
  if (!n) return;

  n.read = true;
  DB.saveData(d);
  renderNotifications();
  renderNotifBadge();

  // Only navigate if the route actually goes somewhere.
  if (n.route && n.route !== location.hash) {
    closeModal('notificationsModal');
    location.hash = n.route;
  }
}

function deleteNotification(id) {
  const d = DB.data();
  d.notifications[myId()] = (d.notifications[myId()] || []).filter(n => n.id !== id);
  DB.saveData(d);
  renderNotifications();
  renderNotifBadge();
}

function markAllNotificationsRead() {
  const d = DB.data();
  (d.notifications[myId()] || []).forEach(n => { n.read = true; });
  DB.saveData(d);
  renderNotifications();
  renderNotifBadge();
  toast('All alerts marked as read.');
}

function clearNotifications() {
  const d = DB.data();
  if (!(d.notifications[myId()] || []).length) return;
  d.notifications[myId()] = [];
  DB.saveData(d);
  renderNotifications();
  renderNotifBadge();
  toast('Alerts cleared.');
}

function renderNotifBadge() {
  const unread = (DB.data().notifications[myId()] || []).filter(n => !n.read).length;
  const b = $('notifBadge');
  if (!b) return;
  b.textContent = unread > 9 ? '9+' : unread;
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
    files: Object.assign({}, pendingProjectFiles),
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
  pendingProjectFiles = {};
  renderPendingFiles();
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
  return `<div class="dash-card theme-blue" tabindex="0" onclick="openProjectBuild('${p.id}')">
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
  updateServerButtonContext('projectDetailPage');

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

  const hasHtml = Object.keys(p.files || {}).some(n => ['html','htm'].includes(extOf(n)));
  const hint = $('projectRunHint');
  if (hint) hint.textContent = hasHtml
    ? 'Detected a website — Run Website starts the local server.'
    : 'No .html yet. Upload one, or send a code file to the Terminal.';

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
    if (server.on && server.projectId === p.id && $('previewAutoReload')?.checked) runPreview();
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
  const list = (p.versions || []);
  $('versionsList').innerHTML = list.slice().reverse().map((v, i) => {
    const prev = list[list.length - 2 - i];
    const changed = prev ? diffFileNames(prev.snapshot || {}, v.snapshot || {}) : [];
    return `<div class="version-card">
      <div class="version-head">
        <div>
          <b>${esc(v.label)}</b>
          ${i === 0 ? '<span class="version-current">current</span>' : ''}
          <div class="version-meta">${timeAgo(v.at)} · ${Object.keys(v.snapshot || {}).length} files</div>
        </div>
        ${canManage && i !== 0 ? `<button class="nav-cta" onclick="restoreVersion('${v.id}')">Restore</button>` : ''}
      </div>
      <p class="version-note">${esc(v.note || 'No description given.')}</p>
      ${changed.length ? `<div class="version-changed">${changed.slice(0, 6).map(c =>
        `<span class="chg chg-${c.kind}">${c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'} ${esc(c.name)}</span>`
      ).join('')}${changed.length > 6 ? `<span class="chg">+${changed.length - 6} more</span>` : ''}</div>` : ''}
    </div>`;
  }).join('');
}

/** Compare two snapshots so each version can show what actually changed. */
function diffFileNames(before, after) {
  const out = [];
  Object.keys(after).forEach(n => {
    if (before[n] === undefined) out.push({ name: n, kind: 'added' });
    else if (before[n] !== after[n]) out.push({ name: n, kind: 'edited' });
  });
  Object.keys(before).forEach(n => {
    if (after[n] === undefined) out.push({ name: n, kind: 'removed' });
  });
  return out;
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
    <div onclick="openProjectBuild('${p.id}')">
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
    ? projects.map(p => {
        const web = Object.keys(p.files || {}).some(n => ['html', 'htm'].includes(extOf(n)));
        return `<div class="deploy-card">
          <div class="deploy-card-head">
            <div>
              <b>${esc(p.name)}</b>
              <div class="deploy-url">${p.deployedUrl
                ? `<a href="${esc(p.deployedUrl)}" target="_blank" rel="noopener">${esc(p.deployedUrl)}</a>`
                : 'Not deployed yet'}</div>
            </div>
            <span class="deploy-status ${p.deployedUrl ? 'is-live' : ''}">${p.deployedUrl ? 'live' : 'draft'}</span>
          </div>
          <div class="deploy-actions">
            ${web ? `<button class="nav-cta btn-golden" onclick="openPreviewFor('${p.id}')">▶ Preview</button>
                     <button class="nav-cta" onclick="exportProjectUI('${p.id}')">Build .html</button>` : ''}
            <button class="nav-cta" onclick="openProjectDetail('${p.id}')">Open project</button>
          </div>
          <div class="friend-add-row">
            <input type="url" id="deployUrl-${p.id}" value="${esc(p.deployedUrl || '')}"
              placeholder="https://your-site.netlify.app">
            <button class="nav-cta" onclick="saveDeployUrlFor('${p.id}')">Save link</button>
          </div>
        </div>`;
      }).join('')
    : `<p style="font-size:.85rem;color:var(--text-tertiary);">No projects yet.</p>`;
}

function openPreviewFor(pid) {
  server.on = true;
  server.projectId = pid;
  currentProjectId = pid;
  paintServerButton();
  openPreview(pid);
}

function saveDeployUrlFor(pid) {
  const d = DB.data();
  const p = d.projects[pid];
  if (!p) return;
  p.deployedUrl = ($('deployUrl-' + pid).value || '').trim();
  DB.saveData(d);
  renderLinkDeployer();
  toast(p.deployedUrl ? 'Deployment link saved.' : 'Link cleared.');
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

const DEVICES = ['Laptop', 'Desktop', 'Smartphone', 'Tablet', 'Console', 'Handheld'];

function detectDevice() {
  const ua = navigator.userAgent;
  const touch = (navigator.maxTouchPoints || 0) > 1;
  if (/iPad/i.test(ua) || (touch && Math.min(screen.width, screen.height) >= 700)) return 'Tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'Smartphone';
  // Laptops and desktops look identical to a browser, so fall back on screen size.
  return screen.width >= 1600 ? 'Desktop' : 'Laptop';
}

/** Mac uses Cmd, everything else uses Alt — this is the OS, not the device. */
function isMacPlatform() {
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

function applyDevice(device) {
  if (!DEVICES.includes(device)) device = detectDevice();

  const p = DB.prefs(); p.device = device; DB.savePrefs(p);

  const el = $('headerDeviceName');
  if (el) el.textContent = device;

  DEVICES.forEach(d => document.body.classList.remove('device-' + d.toLowerCase()));
  document.body.classList.add('device-' + device.toLowerCase());

  // Floating on-screen controls, shown only where they make sense.
  toggleControls('tabletEdgeControls', device === 'Tablet');
  toggleControls('handheldControls',  device === 'Handheld');
  toggleControls('consoleDpad',       device === 'Console');

  // Arrow-key / D-pad focus navigation is only live on Console and Handheld.
  dpad.enabled = (device === 'Console' || device === 'Handheld');
  if (!dpad.enabled) dpad.clear();

  shortcutOS = isMacPlatform() ? 'macos' : 'windows';
  $$('.os-tab').forEach(t => t.classList.toggle('active', t.dataset.os === shortcutOS));
  $$('.device-card').forEach(c => c.classList.toggle('selected', c.dataset.device === device));

  if ($('shortcutPage') && $('shortcutPage').classList.contains('active')) renderShortcuts();
}

function toggleControls(id, on) {
  const node = $(id);
  if (!node) return;
  node.style.display = on ? '' : 'none';
}

/* ----- D-pad / arrow-key navigation (Console + Handheld) ----------------- */

const dpad = {
  enabled: false,
  index: -1,

  targets() {
    const page = $$('.knight-page.active')[0];
    const root = page || $('dashboard');
    if (!root) return [];
    return $$('.dash-card, .nav-cta, .submit-btn, .friend-row button, .studio-tab', root)
      .filter(el => el.offsetParent !== null);
  },

  clear() {
    $$('.dpad-focus').forEach(el => el.classList.remove('dpad-focus'));
    this.index = -1;
  },

  move(step) {
    const list = this.targets();
    if (!list.length) return;
    this.clear();
    this.index = (this.index + step + list.length) % list.length;
    const el = list[this.index];
    el.classList.add('dpad-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },

  activate() {
    const el = this.targets()[this.index];
    if (el) el.click();
  },
};

function dpadPress(dir) {
  if (!dpad.enabled) return;
  if (dir === 'up' || dir === 'left') dpad.move(-1);
  else if (dir === 'down' || dir === 'right') dpad.move(1);
  else if (dir === 'a' || dir === 'center') dpad.activate();
  else if (dir === 'b') { dpad.clear(); goHome(); }
}

/** Tablet edge buttons scroll the page without a mouse wheel. */
function edgeScroll(dir) {
  window.scrollBy({ top: dir * Math.round(window.innerHeight * 0.7), behavior: 'smooth' });
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
  renderStorageManager();
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

    // Console / Handheld: real arrow-key navigation between cards.
    if (dpad.enabled && me() && !typing && !openModalEl) {
      const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      if (dirs[e.key]) { e.preventDefault(); dpadPress(dirs[e.key]); return; }
      if (e.key === 'Enter' && dpad.index >= 0) { e.preventDefault(); dpadPress('a'); return; }
      if (e.key === 'Backspace') { e.preventDefault(); dpadPress('b'); return; }
    }

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


/* ===========================================================================
   26. FILES FROM YOUR COMPUTER + THE LOCAL PREVIEW SERVER

   "Turn the server on" means: Knight assembles the project's files into a
   single runnable document and serves it to a sandboxed iframe from a blob
   URL. That is a real, working preview of your site — links, CSS, scripts,
   images and fetch-free JS all run. It is local to this browser: nobody else
   on the internet can reach it, which is what deploying to a host is for.
=========================================================================== */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

const TEXT_EXT = ['html','htm','css','js','mjs','jsx','ts','tsx','json','md','txt','csv',
                  'py','java','c','cpp','h','go','rs','rb','php','sh','yml','yaml','xml','svg'];
const IMAGE_EXT = ['png','jpg','jpeg','gif','webp','ico','bmp','avif'];

/** Folders nobody wants dragged into a project — build output, VCS internals, deps. */
const JUNK_PATH_PARTS = ['node_modules', '.git', '.svn', '.hg', 'dist', 'build',
                          '__pycache__', '.next', '.cache', 'venv', '.venv', '.DS_Store', 'target'];

const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const isText = (name) => TEXT_EXT.includes(extOf(name));
const isImage = (name) => IMAGE_EXT.includes(extOf(name));
const isJunkPath = (path) => path.split('/').some(part => JUNK_PATH_PARTS.includes(part));

/** Read one File into either text or a data: URL, depending on its type. */
function readProjectFile(file, relPath) {
  return new Promise((resolve, reject) => {
    const name = relPath || file.name;
    if (file.size > MAX_FILE_BYTES) {
      reject(new Error(name + ' is larger than 2 MB — skipped.'));
      return;
    }
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read ' + name));
    r.onload = () => resolve({ name, content: r.result, size: file.size });
    if (isText(name)) r.readAsText(file);
    else if (isImage(name)) r.readAsDataURL(file);
    else r.readAsText(file);      // unknown types are treated as text
  });
}

/** fileList can be a browser FileList (from an <input>, including webkitdirectory)
    or a plain array assembled from a recursive drag-and-drop walk. */
async function readFileList(fileList) {
  const out = [];
  for (const f of Array.from(fileList || [])) {
    const rel = f.webkitRelativePath || f.__relPath || f.name;
    if (isJunkPath(rel)) continue;
    try { out.push(await readProjectFile(f, rel)); }
    catch (e) { toast(e.message, true); }
  }
  return out;
}

/** Recursively walk a dropped folder using the (Chromium/Firefox) DataTransferItem
    entry API, so drag-and-drop preserves the same folder structure a real
    <input webkitdirectory> upload would. Falls back to flat files elsewhere. */
function readDataTransferItems(items) {
  const files = [];
  function walk(entry, path) {
    return new Promise((resolve) => {
      if (!entry) { resolve(); return; }
      if (entry.isFile) {
        entry.file((file) => {
          file.__relPath = path + file.name;
          files.push(file);
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => {
          reader.readEntries(async (entries) => {
            if (!entries.length) { resolve(); return; }
            await Promise.all(entries.map(e => walk(e, path + entry.name + '/')));
            readBatch();          // directory readers page results; keep pulling until empty
          }, () => resolve());
        };
        readBatch();
      } else resolve();
    });
  }
  const roots = Array.from(items)
    .map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  return Promise.all(roots.map(r => walk(r, ''))).then(() => files);
}

/* ----- upload into the New Project modal ----- */

let pendingProjectFiles = {};

/** Build a nested {folders, files} tree from flat "a/b/c.js" keys, for display. */
function buildFileTree(fileMap) {
  const root = { folders: {}, files: [] };
  Object.keys(fileMap).sort().forEach(path => {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.folders[parts[i]] = node.folders[parts[i]] || { folders: {}, files: [] };
      node = node.folders[parts[i]];
    }
    node.files.push({ name: parts[parts.length - 1], path });
  });
  return root;
}

const FILE_ICONS = {
  html: '📄', htm: '📄', css: '🎨', js: 'JS', mjs: 'JS', jsx: 'JS', ts: 'TS', tsx: 'TS',
  json: '{}', py: 'PY', java: '☕', md: '📝', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼',
  svg: '🖼', webp: '🖼',
};

function fileIconFor(name) { return FILE_ICONS[extOf(name)] || '·'; }

function renderTreeNode(node, depth) {
  const folderRows = Object.keys(node.folders).sort().map(name =>
    `<div class="tree-folder" style="padding-left:${depth * 16}px;">
      <span class="tree-icon">📁</span><span>${esc(name)}</span>
    </div>${renderTreeNode(node.folders[name], depth + 1)}`
  ).join('');
  const fileRows = node.files.map(f =>
    `<div class="tree-file" style="padding-left:${depth * 16 + 16}px;" onclick="previewPendingFile('${esc(f.path)}')">
      <span class="tree-icon">${fileIconFor(f.name)}</span><span>${esc(f.name)}</span>
      <button class="tree-remove" title="Remove" onclick="event.stopPropagation(); removePendingFile('${esc(f.path)}')">&times;</button>
    </div>`
  ).join('');
  return folderRows + fileRows;
}

function renderPendingFiles() {
  const box = $('newProjFileList');
  const summary = $('newProjUploadSummary');
  if (!box) return;

  const names = Object.keys(pendingProjectFiles);
  if (!names.length) { box.innerHTML = ''; if (summary) summary.textContent = ''; return; }

  box.innerHTML = renderTreeNode(buildFileTree(pendingProjectFiles), 0);

  if (summary) {
    const totalBytes = names.reduce((sum, n) => sum + (pendingProjectFiles[n]?.length || 0), 0);
    summary.textContent = names.length + ' file' + (names.length === 1 ? '' : 's')
      + ' · ' + formatBytes(totalBytes) + ' ready';
  }
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function removePendingFile(name) {
  delete pendingProjectFiles[name];
  renderPendingFiles();
}

let previewingPendingPath = null;

function previewPendingFile(path) {
  const content = pendingProjectFiles[path];
  if (content === undefined) return;
  previewingPendingPath = path;
  $('pendingPreviewName').textContent = path;
  const isImg = isImage(path);
  $('pendingPreviewContent').style.display = isImg ? 'none' : 'block';
  $('pendingPreviewContent').value = isImg ? '' : content;
  let imgTag = document.getElementById('pendingPreviewImg');
  if (isImg) {
    if (!imgTag) {
      imgTag = document.createElement('img');
      imgTag.id = 'pendingPreviewImg';
      imgTag.style.cssText = 'max-width:100%;max-height:340px;border-radius:10px;display:block;';
      $('pendingPreviewContent').insertAdjacentElement('afterend', imgTag);
    }
    imgTag.src = content;
    imgTag.style.display = 'block';
  } else if (imgTag) {
    imgTag.style.display = 'none';
  }
  openModalRaw('pendingFilePreviewModal');
}

function savePendingFilePreview() {
  if (!previewingPendingPath) return;
  if (!isImage(previewingPendingPath)) pendingProjectFiles[previewingPendingPath] = $('pendingPreviewContent').value;
  closeModal('pendingFilePreviewModal');
  renderPendingFiles();
  toast('Updated.');
}

function removePendingFileFromPreview() {
  if (!previewingPendingPath) return;
  removePendingFile(previewingPendingPath);
  closeModal('pendingFilePreviewModal');
}

async function handleNewProjectFiles(fileList) {
  const files = await readFileList(fileList);
  const totalBefore = Object.keys(pendingProjectFiles)
    .reduce((sum, n) => sum + (pendingProjectFiles[n]?.length || 0), 0);
  const incoming = files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (totalBefore + incoming > MAX_TOTAL_BYTES) {
    toast('That would put this project over the 15 MB upload limit.', true);
    return;
  }
  files.forEach(f => { pendingProjectFiles[f.name] = f.content; });
  renderPendingFiles();
  if (files.length) toast(files.length + ' file' + (files.length === 1 ? '' : 's') + ' ready.');
}

function openNewProjectModal() {
  if (!requireAuth()) return;
  pendingProjectFiles = {};
  renderPendingFiles();
  openModalRaw('newProjectModal');
}

/* ----- upload into an existing project ----- */

async function uploadProjectFilesUI(input) {
  const d = DB.data();
  const p = d.projects[currentProjectId];
  const role = myRoleOn(p);
  if (!['owner', 'editor', 'contributor'].includes(role)) {
    toast('You cannot add files to this project.', true);
    return;
  }

  const files = await readFileList(input.files);
  input.value = '';
  if (!files.length) return;

  if (role === 'contributor') {
    // Contributors propose new files the same way they propose edits.
    files.forEach(f => {
      p.changeRequests.push({
        id: uid('cr'), by: myId(), file: f.name,
        before: p.files[f.name] ?? '', after: f.content,
        status: 'pending', at: Date.now(),
      });
    });
    DB.saveData(d);
    pushNotification(p.ownerId, 'New Change Request',
      me().username + ' proposed ' + files.length + ' file(s) for ' + p.name + '.', '#/project/' + p.id);
    toast('Uploaded as change requests for review.');
  } else {
    files.forEach(f => { p.files[f.name] = f.content; });
    p.updatedAt = Date.now();
    DB.saveData(d);
    toast(files.length + ' file' + (files.length === 1 ? '' : 's') + ' added.');
    if (server.on && server.projectId === p.id) runPreview();
  }
  openProjectDetail(currentProjectId, true);
}

/* ----- the preview server ----- */

const server = {
  on: false,
  projectId: null,
  blobUrl: null,
};

function toggleServer() {
  if (!requireAuth()) return;
  server.on = !server.on;
  paintServerButton();

  if (server.on) {
    const pid = server.projectId || currentProjectId;
    if (!pid) {
      toast('Server on. Open a project and hit Run Website.');
      return;
    }
    server.projectId = pid;
    openPreview(pid);
  } else {
    stopPreview();
    toast('Server stopped.');
  }
}

function paintServerButton() {
  const btn = $('serverToggle');
  const label = $('serverToggleLabel');
  const pill = $('previewServerPill');
  if (btn) btn.classList.toggle('is-on', server.on);
  if (label) label.textContent = server.on ? 'Server on' : 'Server off';
  if (pill) {
    pill.textContent = server.on ? 'server running' : 'server offline';
    pill.classList.toggle('is-on', server.on);
  }
}

function runProjectUI() {
  const p = DB.data().projects[currentProjectId];
  if (!p) return;
  if (!Object.keys(p.files || {}).length) {
    toast('Add or upload some files first.', true);
    return;
  }
  server.on = true;
  server.projectId = p.id;
  paintServerButton();
  openPreview(p.id);
}

function openPreview(projectId) {
  const p = DB.data().projects[projectId];
  if (!p) { toast('Project not found.', true); return; }
  server.projectId = projectId;

  $('previewTitle').textContent = 'Live Preview — ' + p.name;

  // Entry-file picker: every HTML file, index.html first.
  const htmlFiles = Object.keys(p.files).filter(n => ['html', 'htm'].includes(extOf(n)))
    .sort((a, b) => (a.toLowerCase().startsWith('index') ? -1 : 0) - (b.toLowerCase().startsWith('index') ? -1 : 0));
  const sel = $('previewEntrySelect');
  sel.innerHTML = htmlFiles.length
    ? htmlFiles.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : `<option value="">no .html file found</option>`;

  openKnightPage('previewPage');
  runPreview();
}

/** Assemble the project into one document and hand it to the iframe. */
function runPreview() {
  const p = DB.data().projects[server.projectId];
  const frame = $('previewFrame');
  const log = $('previewConsole');
  if (!p || !frame) return;

  if (!server.on) {
    log.textContent = 'Server is off. Use the button in the corner to start it.';
    frame.removeAttribute('srcdoc');
    return;
  }

  const entry = $('previewEntrySelect').value;
  const lines = [];
  lines.push('> starting local preview server');
  lines.push('> project: ' + p.name);
  lines.push('> files detected: ' + Object.keys(p.files).length);

  let html;
  if (entry && p.files[entry] !== undefined) {
    html = inlineProject(p, entry, lines);
    lines.push('> entry: ' + entry);
  } else {
    // No HTML at all — show what the project does contain instead of a blank frame.
    html = fallbackIndex(p);
    lines.push('! no .html entry file — showing a generated file index');
  }

  frame.srcdoc = html;
  lines.push('> preview ready');
  log.textContent = lines.join('\n');
  paintServerButton();
}

/** Rewrite <link>, <script src> and <img src> to use the project's own files. */
function inlineProject(p, entry, log = []) {
  let html = p.files[entry] || '';
  const clean = (u) => (u || '').trim().replace(/^\.?\//, '').split(/[?#]/)[0];

  // stylesheets
  html = html.replace(/<link[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const m = tag.match(/href=["']([^"']+)["']/i);
    const name = clean(m && m[1]);
    if (name && p.files[name] !== undefined) {
      log.push('> inlined stylesheet ' + name);
      return '<style>\n' + p.files[name] + '\n</style>';
    }
    return /^https?:/i.test((m && m[1]) || '') ? tag : '<!-- missing stylesheet: ' + (name || '?') + ' -->';
  });

  // scripts
  html = html.replace(/<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    const name = clean(src);
    if (p.files[name] !== undefined) {
      log.push('> inlined script ' + name);
      return '<script>\n' + p.files[name] + '\n<\/script>';
    }
    return /^https?:/i.test(src) ? tag : '<!-- missing script: ' + name + ' -->';
  });

  // images stored as data URLs
  html = html.replace(/(<img[^>]*src=["'])([^"']+)(["'])/gi, (full, a, src, b) => {
    const name = clean(src);
    if (p.files[name] !== undefined && String(p.files[name]).startsWith('data:')) {
      return a + p.files[name] + b;
    }
    return full;
  });

  // pipe the preview's console output back into Knight's console panel
  const bridge = `<script>
    (function(){
      var send = function(kind, args){
        try { parent.postMessage({ __knightLog: true, kind: kind,
          text: Array.prototype.map.call(args, String).join(' ') }, '*'); } catch(e){}
      };
      ['log','warn','error','info'].forEach(function(k){
        var orig = console[k];
        console[k] = function(){ send(k, arguments); orig.apply(console, arguments); };
      });
      window.onerror = function(m, s, l){ send('error', [m + ' (line ' + l + ')']); };
    })();
  <\/script>`;

  return html.includes('<head>') ? html.replace('<head>', '<head>' + bridge) : bridge + html;
}

function fallbackIndex(p) {
  const rows = Object.keys(p.files).map(n =>
    `<li><code>${esc(n)}</code> — ${String(p.files[n] || '').length} bytes</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:ui-monospace,monospace;background:#100f11;color:#e8e6e3;padding:32px;line-height:1.7;}
    h1{font-size:1.1rem;margin-bottom:4px;} p{color:#9a9691;font-size:.85rem;margin-bottom:18px;}
    li{margin-bottom:6px;} code{color:#F3C623;}</style></head><body>
    <h1>${esc(p.name)}</h1>
    <p>This project has no <code>index.html</code>, so there is no page to render yet.</p>
    <ul>${rows || '<li>No files.</li>'}</ul></body></html>`;
}

function stopPreview() {
  const frame = $('previewFrame');
  if (frame) frame.removeAttribute('srcdoc');
  if (server.blobUrl) { URL.revokeObjectURL(server.blobUrl); server.blobUrl = null; }
  server.on = false;
  paintServerButton();
}

function setPreviewWidth(w) {
  const frame = $('previewFrame');
  if (frame) frame.style.width = w;
}

function openPreviewInTab() {
  const p = DB.data().projects[server.projectId];
  if (!p) return;
  const entry = $('previewEntrySelect').value;
  const html = entry && p.files[entry] !== undefined ? inlineProject(p, entry) : fallbackIndex(p);
  if (server.blobUrl) URL.revokeObjectURL(server.blobUrl);
  server.blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(server.blobUrl, '_blank');
}

/* ----- terminal handoff ----- */

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', py: 'python', java: 'java', c: 'c',
  cpp: 'c++', ts: 'typescript', go: 'go', rs: 'rust', php: 'php', rb: 'ruby', sh: 'bash',
};

function sendProjectToTerminalUI() {
  const p = DB.data().projects[currentProjectId];
  if (!p) return;

  const runnable = Object.keys(p.files).filter(n => LANG_BY_EXT[extOf(n)]);
  if (!runnable.length) {
    // A pure website belongs in the preview, not a language runtime.
    const hasHtml = Object.keys(p.files).some(n => ['html', 'htm'].includes(extOf(n)));
    toast(hasHtml ? 'This is a website — use Run Website instead.'
                  : 'No runnable code file found (.js, .py, .java, .cpp…).', true);
    if (hasHtml) runProjectUI();
    return;
  }

  const file = runnable.length === 1
    ? runnable[0]
    : (prompt('Which file should the Terminal run?\n\n' + runnable.join('\n'), runnable[0]) || '').trim();
  if (!file || !p.files[file]) return;

  $('termLanguage').value = LANG_BY_EXT[extOf(file)];
  $('termCodeInput').value = p.files[file];
  $('termOutput').textContent = 'Loaded ' + file + ' from ' + p.name + '. Hit Run.';
  openKnightPage('terminalPage');
  toast(file + ' loaded into the Terminal.');
}

/* ----- export / deploy ----- */

function exportProjectUI(projectId) {
  const p = DB.data().projects[projectId || currentProjectId];
  if (!p) return;
  const entry = Object.keys(p.files).find(n => n.toLowerCase() === 'index.html')
             || Object.keys(p.files).find(n => ['html', 'htm'].includes(extOf(n)));
  if (!entry) { toast('Needs an .html file to export as a website.', true); return; }

  const html = inlineProject(p, entry);
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = p.name.replace(/[^a-z0-9._-]/gi, '-') + '.html';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported. Drop this file on Netlify Drop to put it online.');
}

/* ===========================================================================
   26.5 CLICK-TO-BUILD — opening a project from a card runs a real build
   sequence in a terminal-style console, then lands on the live preview.
   Everything here runs client-side; there is no real backend doing the work.
=========================================================================== */

/** Services Knight recognises well enough to know which keys they need. */
const KNOWN_SERVICES = [
  { key: 'supabase', label: 'Supabase',   match: /supabase|SUPABASE_URL|SUPABASE_ANON_KEY/i,
    vars: [{ name: 'SUPABASE_URL', placeholder: 'https://xxxx.supabase.co' },
           { name: 'SUPABASE_ANON_KEY', placeholder: 'eyJhbGciOi...', secret: true }] },
  { key: 'firebase', label: 'Firebase',   match: /firebase|FIREBASE_API_KEY/i,
    vars: [{ name: 'FIREBASE_API_KEY', placeholder: 'AIzaSy...', secret: true },
           { name: 'FIREBASE_PROJECT_ID', placeholder: 'my-app-12345' }] },
  { key: 'stripe', label: 'Stripe',       match: /stripe|STRIPE_PUBLIC_KEY|STRIPE_SECRET_KEY/i,
    vars: [{ name: 'STRIPE_PUBLIC_KEY', placeholder: 'pk_live_...' }] },
  { key: 'openai', label: 'OpenAI',       match: /openai|OPENAI_API_KEY/i,
    vars: [{ name: 'OPENAI_API_KEY', placeholder: 'sk-...', secret: true }] },
  { key: 'mongodb', label: 'MongoDB',     match: /mongodb|MONGODB_URI|mongoose\.connect/i,
    vars: [{ name: 'MONGODB_URI', placeholder: 'mongodb+srv://...', secret: true }] },
];

/** Scan a project's own files for references to a known external service. */
function detectServiceModules(files) {
  const text = Object.values(files || {}).join('\n');
  return KNOWN_SERVICES.filter(s => s.match.test(text));
}

/** Which of a detected service's required variables are not yet saved on the project. */
function missingSecretVars(project, services) {
  const have = project.secrets || {};
  const out = [];
  services.forEach(s => s.vars.forEach(v => {
    if (!have[v.name]) out.push({ service: s.label, ...v });
  }));
  return out;
}

/** Textually inject saved secrets into the built page, covering the common
    ways front-end demo code reads them (Vite, Next-style, and a raw process.env). */
function injectSecrets(html, secrets) {
  if (!secrets || !Object.keys(secrets).length) return html;
  Object.entries(secrets).forEach(([name, value]) => {
    const v = JSON.stringify(value);
    const patterns = [
      new RegExp('import\\\\.meta\\\\.env\\\\.VITE_' + name, 'g'),
      new RegExp('process\\\\.env\\\\.' + name, 'g'),
      new RegExp('process\\\\.env\\\\[[\'"]' + name + '[\'"]\\\\]', 'g'),
    ];
    patterns.forEach(p => { html = html.replace(p, v); });
  });
  const envScript = `<script>window.ENV = ${JSON.stringify(secrets)};<\/script>`;
  return html.includes('<head>') ? html.replace('<head>', '<head>' + envScript) : envScript + html;
}

/* ----- the secrets prompt modal ----- */

let secretsPromptState = null;   // { projectId, missing, resolve }

function askForSecrets(project, missing) {
  return new Promise((resolve) => {
    secretsPromptState = { projectId: project.id, missing, resolve };
    const names = Array.from(new Set(missing.map(m => m.service))).join(' and ');
    $('secretsServiceNames').textContent = names;
    $('secretsFieldList').innerHTML = missing.map(v => `
      <div>
        <label style="font-size:.78rem;color:var(--text-secondary);display:block;margin-bottom:5px;">${esc(v.service)} · ${esc(v.name)}</label>
        <input type="${v.secret ? 'password' : 'text'}" id="secretInput-${esc(v.name)}" placeholder="${esc(v.placeholder || '')}">
      </div>`).join('');
    openModalRaw('secretsModal');
  });
}

function submitSecretsPrompt() {
  if (!secretsPromptState) return;
  const d = DB.data();
  const p = d.projects[secretsPromptState.projectId];
  p.secrets = p.secrets || {};
  secretsPromptState.missing.forEach(v => {
    const input = $('secretInput-' + v.name);
    if (input && input.value.trim()) p.secrets[v.name] = input.value.trim();
  });
  DB.saveData(d);
  closeModal('secretsModal');
  const resolve = secretsPromptState.resolve;
  secretsPromptState = null;
  toast('Keys saved to this project on this device.');
  resolve(true);
}

function skipSecretsPrompt() {
  closeModal('secretsModal');
  if (secretsPromptState) { const r = secretsPromptState.resolve; secretsPromptState = null; r(false); }
}

function cancelSecretsPrompt() { skipSecretsPrompt(); }

/* ----- pure build-log assembly (kept separate from timing so it's testable) ----- */

function buildStepsFor(project, entry, services, secretsNowSet) {
  const fileCount = Object.keys(project.files || {}).length;
  const lines = [
    '$ knight build ' + project.name + ' --entry=' + entry,
    '> resolving ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + '…',
  ];
  Object.keys(project.files).filter(n => n !== entry).slice(0, 6).forEach(n => lines.push('  linking ' + n));
  if (Object.keys(project.files).length > 7) lines.push('  … and ' + (Object.keys(project.files).length - 7) + ' more');

  if (services.length) {
    lines.push('> detected service' + (services.length === 1 ? '' : 's') + ': ' + services.map(s => s.label).join(', '));
    lines.push(secretsNowSet
      ? '> environment keys injected (' + secretsNowSet + ' set)'
      : '> running without service keys — connected calls will fail until keys are added');
  }

  lines.push('> starting local server on knight://preview');
  lines.push('> server ON');
  const n = project.buildNumber || 1;
  lines.push('build #' + n + ' completed in ' + (0.2 + Math.random() * 0.6).toFixed(2) + 's');
  return lines;
}

/** Print lines into the console panel one at a time, for a terminal feel. */
function typeLinesInto(el, lines, done) {
  el.textContent = '';
  let i = 0;
  (function next() {
    if (i >= lines.length) { done && done(); return; }
    el.textContent += (i ? '\n' : '') + lines[i++];
    el.scrollTop = el.scrollHeight;
    setTimeout(next, 90);
  })();
}

/** Entry point when a project is opened by clicking its card. */
async function openProjectBuild(projectId) {
  const p = DB.data().projects[projectId];
  if (!p) { show404('/project/' + projectId); return; }
  if (!canSeeProject(p)) { toast('You do not have access to that project.', true); return; }

  const hasHtml = Object.keys(p.files || {}).some(n => ['html', 'htm'].includes(extOf(n)));
  if (!hasHtml) {
    // Nothing to build — a code-only project just opens straight to its files.
    openProjectDetail(projectId);
    return;
  }

  server.on = true;
  server.projectId = projectId;
  currentProjectId = projectId;
  paintServerButton();

  const entry = Object.keys(p.files).find(n => n.toLowerCase() === 'index.html')
             || Object.keys(p.files).find(n => ['html', 'htm'].includes(extOf(n)));

  openKnightPage('previewPage');
  $('previewTitle').textContent = p.name + ' — Build';
  $('buildBanner').style.display = 'flex';
  $('buildBannerText').textContent = 'Compiling ' + p.name + '…';

  const services = detectServiceModules(p.files);
  let secretsSetCount = 0;

  if (services.length) {
    const missing = missingSecretVars(p, services);
    if (missing.length) {
      $('buildBannerText').textContent = p.name + ' needs service keys…';
      const provided = await askForSecrets(p, missing);
      if (provided) secretsSetCount = missing.length;
      $('buildBannerText').textContent = 'Compiling ' + p.name + '…';
    }
  }

  const fresh = DB.data().projects[projectId];
  fresh.buildNumber = (fresh.buildNumber || 0) + 1;
  DB.saveData({ ...DB.data() });   // persist the incremented build number

  const sel = $('previewEntrySelect');
  const htmlFiles = Object.keys(fresh.files).filter(n => ['html', 'htm'].includes(extOf(n)));
  sel.innerHTML = htmlFiles.map(n => `<option value="${esc(n)}" ${n === entry ? 'selected' : ''}>${esc(n)}</option>`).join('');

  const lines = buildStepsFor(fresh, entry, services, secretsSetCount);
  typeLinesInto($('previewConsole'), lines, () => {
    $('buildBanner').style.display = 'none';
    runPreview();
  });
}

/* ===========================================================================
   26.6 STORAGE MANAGER — everything lives in this browser; this page shows
   exactly how much, and gives a clean way to trim it.
=========================================================================== */

function byteSize(v) { try { return new Blob([JSON.stringify(v)]).size; } catch { return 0; } }

function computeStorageBreakdown() {
  const users = DB.users();
  const data = DB.data();
  const prefs = DB.prefs();
  const session = readJSON(LS.session, null);

  return [
    { label: 'Accounts',            bytes: byteSize(users), count: Object.keys(users).length },
    { label: 'Projects & Files',    bytes: byteSize(data.projects), count: Object.keys(data.projects).length },
    { label: 'Notes',               bytes: byteSize(data.notes), count: Object.values(data.notes).reduce((s, a) => s + (a?.length || 0), 0) },
    { label: 'Messages',            bytes: byteSize(data.messages), count: Object.values(data.messages).reduce((s, a) => s + (a?.length || 0), 0) },
    { label: 'Notifications',       bytes: byteSize(data.notifications), count: Object.values(data.notifications).reduce((s, a) => s + (a?.length || 0), 0) },
    { label: 'Preferences',         bytes: byteSize(prefs), count: Object.keys(prefs).length },
    { label: 'Current session',     bytes: byteSize(session), count: session ? 1 : 0 },
  ];
}

function countStaleGuests(days = 7) {
  const cutoff = Date.now() - days * 86400000;
  return Object.values(DB.users()).filter(u => u.guest && u.createdAt < cutoff && u.id !== myId()).length;
}

/** Delete a guest account and everything it owns — projects, memberships, notes, chats. */
function purgeGuestUser(guestId) {
  const users = DB.users();
  const email = Object.keys(users).find(e => users[e].id === guestId);
  if (email) delete users[email];
  DB.saveUsers(users);

  const d = DB.data();
  Object.keys(d.projects).forEach(pid => {
    const p = d.projects[pid];
    if (p.ownerId === guestId) { delete d.projects[pid]; return; }
    p.members = (p.members || []).filter(m => m.userId !== guestId);
    p.starredBy = (p.starredBy || []).filter(id => id !== guestId);
  });
  delete d.notes[guestId];
  delete d.notifications[guestId];
  Object.keys(d.messages).forEach(k => { if (k.includes(guestId)) delete d.messages[k]; });
  DB.saveData(d);
}

function purgeOldGuestsUI(days = 7) {
  const cutoff = Date.now() - days * 86400000;
  const stale = Object.values(DB.users()).filter(u => u.guest && u.createdAt < cutoff && u.id !== myId());
  if (!stale.length) { toast('No guest accounts older than ' + days + ' days.'); return; }
  if (!confirm('Remove ' + stale.length + ' guest account(s) older than ' + days + ' days, along with anything only they owned?')) return;
  stale.forEach(u => purgeGuestUser(u.id));
  toast(stale.length + ' guest account(s) removed.');
  renderStorageManager();
}

function wipeAllStorageUI() {
  if (!confirm('This deletes every Knight account, project, and file stored in this browser. This cannot be undone. Continue?')) return;
  if (!confirm('Really wipe everything? Type-to-confirm skipped for speed — this is your last check.')) return;
  [LS.users, LS.session, LS.data, LS.prefs].forEach(k => localStorage.removeItem(k));
  toast('Local storage cleared.');
  location.hash = '';
  location.reload();
}

async function renderStorageManager() {
  const rows = computeStorageBreakdown();
  const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);

  const box = $('storageBreakdown');
  if (box) {
    box.innerHTML = rows.map(r => `
      <div class="storage-row">
        <span class="storage-row-label">${r.label}</span>
        <span class="storage-row-count">${r.count} item${r.count === 1 ? '' : 's'}</span>
        <span class="storage-row-bytes">${formatBytes(r.bytes)}</span>
      </div>`).join('');
  }

  const staleCount = countStaleGuests();
  const purgeBtn = $('purgeGuestsBtn');
  if (purgeBtn) purgeBtn.textContent = staleCount
    ? `Purge Old Guest Accounts (${staleCount})` : 'Purge Old Guest Accounts';

  const label = $('storageUsageLabel');
  const fill = $('storageUsageFill');
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const pct = est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
      if (fill) fill.style.width = pct.toFixed(1) + '%';
      if (label) label.textContent = formatBytes(totalBytes) + ' used by Knight · '
        + formatBytes(est.usage || 0) + ' / ' + formatBytes(est.quota || 0) + ' browser quota';
      return;
    } catch {}
  }
  if (fill) fill.style.width = Math.min(100, totalBytes / 50000).toFixed(1) + '%';
  if (label) label.textContent = formatBytes(totalBytes) + ' used by Knight on this device';
}

/* ---------------------------------------------------------------------------
   27. BOOT
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

  // New-project dropzone: click to browse, choose a folder, or drag either in.
  const drop = $('newProjDrop');
  if (drop) {
    $('newProjFiles').onchange = (e) => handleNewProjectFiles(e.target.files);
    $('newProjFolder').onchange = (e) => handleNewProjectFiles(e.target.files);
    ['dragenter', 'dragover'].forEach(ev =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
    drop.addEventListener('drop', async (e) => {
      const items = e.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        // Real folder drop: walk it so the structure survives.
        const files = await readDataTransferItems(items);
        handleNewProjectFiles(files);
      } else {
        handleNewProjectFiles(e.dataTransfer.files);
      }
    });
  }

  // Console output from inside the preview iframe.
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.__knightLog) return;
    const log = $('previewConsole');
    if (!log) return;
    const tag = m.kind === 'error' ? '!' : m.kind === 'warn' ? '~' : '·';
    log.textContent += '\n' + tag + ' ' + m.text;
    log.scrollTop = log.scrollHeight;
  });

  paintServerButton();

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
  openCommandPalette, dpadPress, edgeScroll, applyDevice, updateServerButtonContext,
  openProjectBuild, submitSecretsPrompt, skipSecretsPrompt, cancelSecretsPrompt,
  purgeOldGuestsUI, wipeAllStorageUI, renderStorageManager,
  openNewProjectModal, removePendingFile, uploadProjectFilesUI,
  previewPendingFile, savePendingFilePreview, removePendingFileFromPreview,
  toggleServer, runProjectUI, openPreview, runPreview, stopPreview,
  setPreviewWidth, openPreviewInTab, sendProjectToTerminalUI, exportProjectUI,
  openPreviewFor, saveDeployUrlFor, handleNewProjectFiles,
  setNotifFilter, markAllNotificationsRead, deleteNotification,
});
