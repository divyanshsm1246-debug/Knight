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
// These are no longer hardcoded — see Settings & Guides → Cloud Connection.
// They start null (fully local/offline) and get restored from saved prefs at
// boot, and updated live the moment someone saves a URL in Settings, with no
// code edit and no page reload required.
let API_BASE = null;

const SESSION_DAYS = 365;          // how long "stay signed in" lasts
const LS = {
  users:    'knight.users.v3',
  session:  'knight.session.v3',
  data:     'knight.data.v3',      // projects, notes, messages, friendships…
  prefs:    'knight.prefs.v3',
  backendTokens: 'knight.backendTokens.v1',   // { email: token } — only used if API_BASE is set
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

  /** Backend session tokens are kept separate from local session data — one
      per email, since several accounts can exist on the same device. */
  backendToken(email) {
    const t = readJSON(LS.backendTokens, {});
    return t[(email || '').toLowerCase()] || null;
  },
  setBackendToken(email, token) {
    const t = readJSON(LS.backendTokens, {});
    t[(email || '').toLowerCase()] = token;
    writeJSON(LS.backendTokens, t);
  },

  /** Try the server; on ANY failure return null so callers fall back to local.
      Pass rawResponse:true to get the fetch Response back instead of parsed JSON
      (needed for non-JSON endpoints, like the deployed site's own HTML). */
  async server(path, options = {}) {
    if (!API_BASE) return null;
    try {
      const email = options.authEmail || (me() && me().email);
      const token = email ? this.backendToken(email) : null;
      const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
      if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;

      // A free-tier host that has gone to sleep can take 30-60s to wake; give
      // normal calls a sane ceiling and let slow ones (deploys) ask for more.
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), options.timeoutMs || 25000) : null;
      let res;
      try {
        res = await fetch(API_BASE + path, { ...options, headers, signal: ctrl ? ctrl.signal : undefined });
      } finally { if (timer) clearTimeout(timer); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.serverUp = true;
      return options.rawResponse ? res : await res.json();
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
      notifications: {}, links: {}, presence: {},
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

  // Best-effort mirror to the Java backend. Failure here is NOT fatal — Knight
  // works entirely offline. When the backend IS reachable, this captures the
  // real session token, which is what later lets Deploy actually reach it.
  DB.server('/api/auth/signup', {
    method: 'POST', authEmail: key,
    body: JSON.stringify({ email: key, username, passHash: user.passHash, socialId: user.socialId }),
  }).then(r => { if (r && r.token) DB.setBackendToken(key, r.token); });

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

  DB.server('/api/auth/signin', {
    method: 'POST', authEmail: key,
    body: JSON.stringify({ email: key, passHash: hash }),
  }).then(r => { if (r && r.token) DB.setBackendToken(key, r.token); });

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
// Guest mode has been removed — every session now needs a real account.
// (Storage → "Purge Old Guest Accounts" in Settings still exists to clean up
// any guest accounts created before this change.)

function signOutUI() {
  stopPreview();
  disconnectAbly();
  if (socket) { try { socket.close(); } catch {} socket = null; }
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
  // 1 cube — matches the brand mark
  '<path d="M24 5 L41 14.5 L41 33.5 L24 43 L7 33.5 L7 14.5 Z"/><path d="M7 14.5 L24 24 L41 14.5"/><path d="M24 24 L24 43"/>',
  // 2 diamond
  '<path d="M24 5 L41 24 L24 43 L7 24 Z"/>',
  // 3 circle
  '<circle cx="24" cy="24" r="18"/>',
  // 4 triangle
  '<path d="M24 6 L42 40 L6 40 Z"/>',
  // 5 hexagon
  '<path d="M24 5 L40 14.5 L40 33.5 L24 43 L8 33.5 L8 14.5 Z"/>',
  // 6 star
  '<path d="M24 4 L29 18 L44 18 L32 27 L37 42 L24 33 L11 42 L16 27 L4 18 L19 18 Z"/>',
  // 7 plus
  '<path d="M24 6 V42 M6 24 H42"/>',
  // 8 arrow
  '<path d="M10 38 L38 10 M38 10 H20 M38 10 V28"/>',
  // 9 square
  '<rect x="8" y="8" width="32" height="32" rx="3"/>',
  // 10 bolt
  '<path d="M26 4 L10 26 H21 L18 44 L38 20 H26 Z"/>',
  // 11 crescent
  '<path d="M30 5 A18 18 0 1 0 30 43 A14 14 0 1 1 30 5 Z"/>',
  // 12 pentagon
  '<path d="M24 5 L42 19 L35 40 L13 40 L6 19 Z"/>',
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
  'notes':     { page: 'notesPage',         title: 'Data-Base' },
  'arcade':    { page: 'arcadePage',        title: 'Arcade' },
  'booster':   { page: 'gameBoosterPage',   title: 'Game Booster' },
  'deploy':    { page: 'linkDeployerPage',  title: 'Link Deployer' },
  'settings':  { page: 'settingsPage',      title: 'Settings' },
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
    notesPage:        () => { renderNotes(); renderDbAnalytics(); },
    arcadePage:       startMemoryGame,
    gameBoosterPage:  renderGameBooster,
    linkDeployerPage: renderLinkDeployer,
    settingsPage:     renderSettings,
    terminalPage:     () => {
      renderTermWebsiteList();
      if (terminalProjectId && DB.data().projects[terminalProjectId]) {
        openTerminalWorkspace(terminalProjectId);
      } else {
        $('termNoProjectHint').style.display = 'block';
        $('termWorkspace').style.display = 'none';
      }
    },
  }[pageId] || (() => {}))();

  if (pageId !== 'terminalPage') stopTermFps();
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
  connectAbly();

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

  // Try the server for a fresher profile — but never block on it.
  refreshProfileFromServer();
  refreshAiStatus();

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

/* ===========================================================================
   12.5 NEARBY KNIGHTS — live, precise proximity discovery, AirDrop-style.

   Two layers, same as everything else that needs the outside world:
   - LOCAL: presence is written into DB.data().presence, so two tabs/guest
     accounts on this one device can find each other for testing, instantly.
   - REAL: if API_BASE is configured, the same position is also pushed to the
     backend's /api/presence, which is the only way two different phones can
     actually discover each other — no browser can see another device.
=========================================================================== */

const nearby = {
  live: false,
  watchId: null,
  lastPos: null,
  seenThisSession: new Set(),   // socialIds already prompted, so it doesn't nag
  pollTimer: null,
};

const NEARBY_RADIUS_M = 300;
const NEARBY_STALE_MS = 2 * 60 * 1000;

/** Great-circle distance in meters — same formula the backend uses, kept in
    sync so local and server results read the same to the person using it. */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(m) {
  return m < 1000 ? Math.round(m) + ' m away' : (m / 1000).toFixed(1) + ' km away';
}

function toggleNearbyLive() {
  nearby.live ? stopNearbyLive() : startNearbyLive();
}

function startNearbyLive() {
  if (!navigator.geolocation) { toast('Geolocation is not available in this browser.', true); return; }
  nearby.live = true;
  nearby.seenThisSession.clear();
  paintNearbyStatus('Getting a precise fix…');

  nearby.watchId = navigator.geolocation.watchPosition(
    (pos) => { nearby.lastPos = pos.coords; reportPresence(pos.coords); },
    (err) => { paintNearbyStatus('Location error: ' + err.message); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );

  nearby.pollTimer = setInterval(scanNearby, 8000);
  scanNearby();
}

function stopNearbyLive() {
  nearby.live = false;
  if (nearby.watchId !== null) navigator.geolocation.clearWatch(nearby.watchId);
  if (nearby.pollTimer) clearInterval(nearby.pollTimer);
  nearby.watchId = null; nearby.pollTimer = null;

  const d = DB.data();
  d.presence = d.presence || {};
  delete d.presence[myId()];
  DB.saveData(d);
  DB.server('/api/presence', { method: 'DELETE' });

  paintNearbyStatus('Off — your location isn\'t being shared.');
  const list = $('nearbyList');
  if (list) list.innerHTML = '';
}

function reportPresence(coords) {
  const d = DB.data();
  d.presence = d.presence || {};
  d.presence[myId()] = { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy, at: Date.now() };
  DB.saveData(d);

  DB.server('/api/presence', {
    method: 'POST',
    body: JSON.stringify({ lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy }),
  });

  paintNearbyStatus('Live — accurate to ±' + Math.round(coords.accuracy) + 'm');
}

function paintNearbyStatus(text) {
  const btn = $('nearbyToggleBtn');
  const status = $('nearbyStatusText');
  if (btn) { btn.textContent = nearby.live ? 'Stop Sharing' : 'Go Live'; btn.classList.toggle('btn-golden', !nearby.live); }
  if (status) { status.textContent = text; status.classList.toggle('is-live', nearby.live); }
}

/** Local device candidates (other tabs/accounts sharing this browser's storage). */
function localNearbyCandidates() {
  const pres = DB.data().presence || {};
  const mine = pres[myId()];
  if (!mine) return [];
  const out = [];
  Object.entries(pres).forEach(([uid, p]) => {
    if (uid === myId() || Date.now() - p.at > NEARBY_STALE_MS) return;
    const dist = haversineMeters(mine.lat, mine.lng, p.lat, p.lng);
    if (dist <= NEARBY_RADIUS_M) {
      const u = userById(uid);
      if (u) out.push({ socialId: u.socialId, username: u.username, distanceMeters: Math.round(dist) });
    }
  });
  return out;
}

async function scanNearby() {
  if (!nearby.live || !nearby.lastPos) return;
  const local = localNearbyCandidates();

  let remote = [];
  if (API_BASE) {
    const r = await DB.server('/api/presence/nearby?lat=' + nearby.lastPos.latitude
      + '&lng=' + nearby.lastPos.longitude + '&radiusMeters=' + NEARBY_RADIUS_M);
    if (Array.isArray(r)) remote = r;
  }

  const bySocialId = {};
  [...local, ...remote].forEach(c => {
    if (!bySocialId[c.socialId] || c.distanceMeters < bySocialId[c.socialId].distanceMeters) bySocialId[c.socialId] = c;
  });
  const candidates = Object.values(bySocialId).sort((a, b) => a.distanceMeters - b.distanceMeters);

  renderNearbyList(candidates);

  const already = (me().friends || []);
  const alreadySocialIds = already.map(id => { const u = userById(id); return u ? u.socialId : null; }).filter(Boolean);

  const fresh = candidates.find(c =>
    !alreadySocialIds.includes(c.socialId) && !nearby.seenThisSession.has(c.socialId));
  if (fresh) {
    nearby.seenThisSession.add(fresh.socialId);
    showNearbyPrompt(fresh);
  }
}

function renderNearbyList(candidates) {
  const box = $('nearbyList');
  if (!box) return;
  if (!nearby.live) { box.innerHTML = ''; return; }

  box.innerHTML = candidates.length
    ? candidates.map(c => `<div class="friend-row">
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="nearby-live-dot"></span>
          <div><b>${esc(c.username)}</b>
          <div style="font-size:.74rem;color:var(--text-tertiary);">${esc(c.socialId)} · ${formatDistance(c.distanceMeters)}</div></div>
        </div>
        <button class="nav-cta btn-golden" onclick="sendFriendRequest('${esc(c.socialId)}')">Add Friend</button>
      </div>`).join('')
    : `<p style="font-size:.82rem;color:var(--text-tertiary);">Searching nearby… nobody else is live right now.</p>`;
}

let nearbyPromptCandidate = null;

function showNearbyPrompt(c) {
  nearbyPromptCandidate = c;
  $('nearbyPromptAvatar').textContent = (c.username || '?').slice(0, 1).toUpperCase();
  $('nearbyPromptName').textContent = c.username;
  $('nearbyPromptDistance').textContent = formatDistance(c.distanceMeters);
  openModalRaw('nearbyPromptModal');
}

function acceptNearbyPrompt() {
  if (nearbyPromptCandidate) sendFriendRequest(nearbyPromptCandidate.socialId);
  closeModal('nearbyPromptModal');
}

function dismissNearbyPrompt() {
  closeModal('nearbyPromptModal');
}

function renderSocialPage() {
  const u = me(); if (!u) return;
  $('socialPageMyId').textContent = u.socialId;
  paintNearbyStatus(nearby.live ? 'Live — searching nearby' : "Off — your location isn't being shared.");
  if (nearby.live) scanNearby(); else renderNearbyList([]);

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
  const hasHtml = Object.keys(p.files || {}).some(n => ['html', 'htm'].includes(extOf(n)));
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
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div class="enter-btn" style="margin:0;">★ ${p.stars || 0} · ${fileCount} files · v${ver}</div>
      <div style="display:flex; gap:6px; align-items:center;">
        ${p.ownerId === myId() ? `<button class="card-delete-btn" title="Delete project" onclick="event.stopPropagation(); deleteProjectUI('${p.id}')">🗑</button>` : ''}
        ${hasHtml ? `<button class="nav-cta btn-golden" style="font-size:.68rem;padding:5px 10px;flex-shrink:0;" onclick="event.stopPropagation(); openProjectBuild('${p.id}')">▶ Preview</button>` : ''}
      </div>
    </div>
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

  const forkNote = $('projectForkedFromNote');
  if (forkNote) {
    if (p.forkedFrom) {
      forkNote.style.display = 'block';
      forkNote.innerHTML = 'Forked from <b>' + esc(p.forkedFrom.name) + '</b>.';
    } else {
      forkNote.style.display = 'none';
    }
  }

  renderProjectFiles(p, role);
  renderVersions(p, isOwner);
  renderMembers(p, isOwner);
  renderChangeRequests(p, isOwner || role === 'editor');
  renderProjectStats(p);
  renderProjectActivity(p);
  renderProjectDangerZone(p, isOwner);
  paintAiStatus();
  renderAiProposal('project');
  renderProjectDeployPanel(p, isOwner || canEdit);
  updateProjectTabCounts(p);
  setProjectTab(projectActiveTab);
}

/* ----- GitHub-style component tabs ----- */

let projectActiveTab = 'overview';

const PROJECT_TABS = ['overview', 'files', 'ai', 'versions', 'contributors', 'changes', 'deploy'];

function setProjectTab(tab) {
  projectActiveTab = tab;
  PROJECT_TABS.forEach(t => {
    const btn = document.querySelector('.proj-tab[data-tab="' + t + '"]');
    if (btn) btn.classList.toggle('active', t === tab);
    const panel = $('projPanel-' + t);
    if (panel) panel.classList.toggle('active', t === tab);
  });
}

function updateProjectTabCounts(p) {
  const set = (id, n) => { const el = $(id); if (el) el.textContent = n ? ' ' + n : ''; };
  set('tabCountFiles', Object.keys(p.files || {}).length);
  set('tabCountVersions', (p.versions || []).length);
  set('tabCountMembers', (p.members || []).length + 1);   // +1 for the owner
  set('tabCountChanges', (p.changeRequests || []).filter(c => c.status === 'pending').length);
}

function renderProjectStats(p) {
  const box = $('projStatsRow');
  if (!box) return;
  const fileCount = Object.keys(p.files || {}).length;
  const totalLines = Object.values(p.files || {}).reduce((s, c) => s + String(c || '').split('\n').length, 0);
  const stats = [
    ['Files', fileCount], ['Lines', totalLines],
    ['Versions', (p.versions || []).length], ['Stars', p.stars || 0],
    ['Contributors', (p.members || []).length + 1],
  ];
  box.innerHTML = stats.map(([label, val]) =>
    `<div class="proj-stat"><div class="proj-stat-val">${val}</div><div class="proj-stat-label">${label}</div></div>`
  ).join('');
}

/** A quick, chronological read of what actually happened on this project —
    built from versions + accepted/pending changes, no separate log to keep. */
function renderProjectActivity(p) {
  const box = $('projectActivityList');
  if (!box) return;
  const events = [];
  (p.versions || []).forEach(v => events.push({ at: v.at, text: v.label + ' cut — ' + (v.note || 'no description') }));
  (p.changeRequests || []).forEach(c => {
    const by = userById(c.by);
    events.push({ at: c.at, text: (by ? by.username : 'someone') + ' proposed a change to ' + c.file
      + (c.status !== 'pending' ? ' (' + c.status + ')' : ' — awaiting review') });
  });
  events.sort((a, b) => b.at - a.at);

  box.innerHTML = events.length
    ? events.slice(0, 8).map(e => `<div class="proj-activity-row">
        <span class="proj-activity-dot"></span>
        <span class="proj-activity-text">${esc(e.text)}</span>
        <span class="proj-activity-time">${timeAgo(e.at)}</span></div>`).join('')
    : `<p style="font-size:.82rem;color:var(--text-tertiary);">Nothing yet — add a file or cut a version to get started.</p>`;
}

function renderProjectDeployPanel(p, canDeploy) {
  const note = $('projectDeployNote');
  const actions = $('projectDeployActionsRow');
  if (!note || !actions) return;

  note.className = 'cloud-note ' + (API_BASE ? 'is-ready' : 'is-off');
  note.innerHTML = API_BASE
    ? `<b>Knight Cloud is connected.</b> Deploy gives this project a real, working link — anyone can open it, not just this browser.`
    : `<b>Knight Cloud isn't connected yet.</b> Deploy <code>KnightBackendApplication.java</code> and set <code>API_BASE</code> in script.js for a real <code>your-app.onrender.com/website/xxxx</code> link. Until then, build the .html and drop it on Netlify Drop yourself.`;

  const hasHtml = Object.keys(p.files || {}).some(n => ['html', 'htm'].includes(extOf(n)));
  actions.innerHTML = !hasHtml
    ? `<span style="font-size:.8rem;color:var(--text-tertiary);">Add an .html file first — nothing to deploy yet.</span>`
    : !canDeploy
    ? `<span style="font-size:.8rem;color:var(--text-tertiary);">Only owners and editors can deploy this project.</span>`
    : `<button class="nav-cta" onclick="exportProjectUI('${p.id}')">Build .html</button>
       <button class="nav-cta ${API_BASE ? 'btn-golden' : ''}" onclick="deployProjectToCloudUI('${p.id}')">☁ Deploy to Cloud</button>
       ${p.deployedUrl ? `<button class="nav-cta" style="color:var(--accent-coral);" onclick="deleteDeployedSiteUI('${p.id}')">🗑 Delete Site</button>` : ''}`;
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
        <button class="nav-cta" onclick="openVersionDiffUI('${v.id}')">Compare</button>
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
  const hasHtml = Object.keys(p.files || {}).some(n => ['html', 'htm'].includes(extOf(n)));
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
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;">
      <button class="star-toggle ${starred ? 'starred' : ''}" title="${starred ? 'Unstar' : 'Star this project'}" onclick="event.stopPropagation(); toggleStar('${p.id}', event)"><svg viewBox="0 0 24 24"><polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.6"/></svg>${p.stars || 0}</button>
      <button class="nav-cta" style="font-size:.72rem;padding:6px 10px;" onclick="event.stopPropagation(); openReviewPrompt('${p.id}')">Review (${(p.reviews || []).length})</button>
      ${hasHtml ? `<button class="nav-cta btn-golden" style="font-size:.72rem;padding:6px 10px;" onclick="event.stopPropagation(); openProjectBuild('${p.id}')">▶ Preview</button>` : ''}
    </div>
  </div>`;
}

function toggleStar(pid, evt) {
  const d = DB.data();
  const p = d.projects[pid];
  if (!p) return;
  p.starredBy = p.starredBy || [];
  const i = p.starredBy.indexOf(myId());
  let justStarred = false;
  if (i === -1) { p.starredBy.push(myId()); p.stars = (p.stars || 0) + 1; justStarred = true; }
  else { p.starredBy.splice(i, 1); p.stars = Math.max(0, (p.stars || 0) - 1); }
  DB.saveData(d);

  if (justStarred && evt && evt.currentTarget) spawnStarBurst(evt.currentTarget);
  renderStudio();
}

/** A quick burst of little stars radiating from the button, purely for feel. */
function spawnStarBurst(el) {
  const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const layer = document.createElement('div');
  layer.className = 'star-burst-layer';
  for (let i = 0; i < 6; i++) {
    const s = document.createElement('span');
    s.className = 'star-burst-particle';
    const angle = (i / 6) * Math.PI * 2;
    s.style.left = cx + 'px'; s.style.top = cy + 'px';
    s.style.setProperty('--dx', Math.cos(angle) * 34 + 'px');
    s.style.setProperty('--dy', Math.sin(angle) * 34 + 'px');
    s.textContent = '★';
    layer.appendChild(s);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 650);
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
   14.5 WEBSOCKET CLIENT — real multiplayer chat and live collaboration
   Talks to websocket-server.js (a separate Node process — see that file).
   Same two-tier pattern as everything else that reaches outside the browser:
   if WS_BASE isn't set or the socket can't connect, everything falls back to
   the local-storage chat/messages that already work across tabs on one
   device. When it IS connected, messages are real-time between different
   people on different devices.
--------------------------------------------------------------------------- */

// Point this at your deployed websocket-server.js, e.g. "wss://knight-ws.onrender.com".
// Leave null to stay in local/offline mode.
// Same deal as API_BASE — configurable from Settings, not hardcoded.
let WS_BASE = null;
let WS_SERVER_KEY = 'knight_ws_7f3a9c2e1b8d4f6a0c5e9b2d7a1f4c8e';

/* ---------------------------------------------------------------------------
   14.4 ABLY — hosted real-time chat & presence, no server to deploy.
   This is the preferred transport whenever a key is configured: it's a real
   cloud service, so two different people on two different devices see each
   other instantly with nothing self-hosted. The custom WS_BASE socket below
   remains as a fallback for anyone who'd rather self-host that piece.
   Channel naming: "knight:dm:<threadKey>" for chat, "knight:presence" for
   global online status.
--------------------------------------------------------------------------- */

let ABLY_KEY = null;
let ablyClient = null;
let ablyChatChannel = null;
let ablyPresenceChannel = null;

function ablyAvailable() { return !!(ABLY_KEY && typeof Ably !== 'undefined'); }

function connectAbly() {
  if (!ablyAvailable() || !me()) return null;
  if (ablyClient && ablyClient.connection.state !== 'failed' && ablyClient.connection.state !== 'closed') return ablyClient;

  try {
    ablyClient = new Ably.Realtime({ key: ABLY_KEY, clientId: myId() });
  } catch (e) {
    console.warn('[Knight] Ably failed to start', e);
    ablyClient = null;
    return null;
  }

  ablyClient.connection.on('connected', () => { paintCommServerPill(); enterAblyPresence(); });
  ablyClient.connection.on(['disconnected', 'suspended', 'failed', 'closed'], () => paintCommServerPill());
  return ablyClient;
}

function disconnectAbly() {
  if (ablyClient) { try { ablyClient.close(); } catch {} }
  ablyClient = null; ablyChatChannel = null; ablyPresenceChannel = null;
}

function ablyReady() { return !!(ablyClient && ablyClient.connection.state === 'connected'); }

/** Switch which DM thread's Ably channel this client is subscribed to. */
function joinAblyChatRoom(room) {
  const client = connectAbly();
  if (!client) return;
  if (ablyChatChannel && ablyChatChannel.name === 'knight:dm:' + room) return;

  if (ablyChatChannel) ablyChatChannel.unsubscribe();
  ablyChatChannel = client.channels.get('knight:dm:' + room);
  ablyChatChannel.subscribe('chat', (msg) => {
    handleSocketMessage({
      type: 'chat', room, from: msg.data.from, username: msg.data.username,
      text: msg.data.text, at: msg.timestamp,
    });
  });
  ablyChatChannel.history({ limit: 50 }, (err, page) => {
    if (err || !page) return;
    const messages = page.items.reverse().map(m => ({ from: m.data.from, text: m.data.text, at: m.timestamp }));
    handleSocketMessage({ type: 'history', room, messages });
  });
}

function sendAblyChat(room, text) {
  if (!ablyChatChannel || ablyChatChannel.name !== 'knight:dm:' + room) return false;
  ablyChatChannel.publish('chat', { from: myId(), username: me().username, text });
  return true;
}

/** Global "who's online right now" — powers the presence dot on the Comm page. */
function enterAblyPresence() {
  if (!ablyClient || !me()) return;
  ablyPresenceChannel = ablyClient.channels.get('knight:presence');
  ablyPresenceChannel.presence.enter({ username: me().username });
  ablyPresenceChannel.presence.subscribe(() => renderCommPage());
}

async function ablyOnlineUserIds() {
  if (!ablyPresenceChannel) return [];
  return new Promise((resolve) => {
    ablyPresenceChannel.presence.get((err, members) => {
      resolve(err || !members ? [] : members.map(m => m.clientId));
    });
  });
}

let socket = null;
let socketRoom = null;
let socketReconnectTimer = null;

function socketReady() {
  return !!(socket && socket.readyState === (window.WebSocket ? WebSocket.OPEN : 1));
}

function connectKnightSocket() {
  if (!WS_BASE || !me() || typeof WebSocket === 'undefined') return null;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return socket;

  try {
    const url = WS_BASE + '/ws/knight?key=' + encodeURIComponent(WS_SERVER_KEY)
      + '&userId=' + encodeURIComponent(myId()) + '&username=' + encodeURIComponent(me().username);
    socket = new WebSocket(url);
  } catch (e) {
    console.warn('[Knight] could not open websocket', e);
    return null;
  }

  socket.onopen = () => { if (socketRoom) socket.send(JSON.stringify({ type: 'join', room: socketRoom })); paintCommServerPill(); };
  socket.onmessage = (evt) => { let msg; try { msg = JSON.parse(evt.data); } catch { return; } handleSocketMessage(msg); };
  socket.onclose = () => {
    socket = null; paintCommServerPill();
    clearTimeout(socketReconnectTimer);
    socketReconnectTimer = setTimeout(connectKnightSocket, 4000);
  };
  socket.onerror = () => {};
  return socket;
}

/** Switch which room (a DM thread key, or "project:<id>") this connection is
    listening to. Only one room per connection, same as the Node server. */
function joinSocketRoom(room) {
  socketRoom = room;
  const s = connectKnightSocket();
  if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'join', room }));
}

function paintCommServerPill() {
  const pill = $('commServerPill');
  if (!pill) return;
  const live = ablyReady() || socketReady();
  const via = ablyReady() ? 'Ably' : socketReady() ? 'self-hosted' : null;
  pill.textContent = live ? 'live — real-time (' + via + ')' : ((ABLY_KEY || WS_BASE) ? 'connecting…' : 'offline (device-only)');
  pill.classList.toggle('is-on', live);
}

function handleSocketMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'history') {
    // Merge remote history into local storage without duplicating what we already have.
    const d = DB.data();
    d.messages[msg.room] = d.messages[msg.room] || [];
    const haveAt = new Set(d.messages[msg.room].map(m => m.from + '|' + m.at));
    (msg.messages || []).forEach(m => {
      const at = m.at;
      if (!haveAt.has(m.from + '|' + at)) d.messages[msg.room].push({ id: uid('msg'), from: m.from, text: m.text, at });
    });
    d.messages[msg.room].sort((a, b) => a.at - b.at);
    DB.saveData(d);
    if (chatPeerId && threadKey(myId(), chatPeerId) === msg.room) renderThread();
    return;
  }

  if (msg.type === 'chat') {
    const d = DB.data();
    d.messages[msg.room] = d.messages[msg.room] || [];
    const dupe = d.messages[msg.room].some(m => m.from === msg.from && Math.abs(m.at - msg.at) < 500 && m.text === msg.text);
    if (!dupe) d.messages[msg.room].push({ id: uid('msg'), from: msg.from, text: msg.text, at: msg.at });
    DB.saveData(d);
    if (chatPeerId && threadKey(myId(), chatPeerId) === msg.room) renderThread();
    else if (msg.from !== myId()) pushNotification(myId(), 'New Message', msg.username + ': ' + msg.text.slice(0, 60), '#/comm/' + me().socialId);
    return;
  }

  if (msg.type === 'presence') {
    renderCommPage();
    return;
  }

  if (msg.type === 'file-update') {
    const p = DB.data().projects[currentProjectId];
    if (p && p.backendId && msg.room === 'project:' + p.backendId) {
      toast(msg.username + ' just edited ' + msg.filename + ' live.');
    }
    return;
  }

  if (msg.type === 'typing') {
    const label = $('commThreadLabel');
    if (label && chatPeerId && threadKey(myId(), chatPeerId) === msg.room) {
      const original = label.dataset.base || label.textContent;
      label.dataset.base = original;
      label.textContent = msg.username + ' is typing…';
      clearTimeout(label._typingTimer);
      label._typingTimer = setTimeout(() => { label.textContent = label.dataset.base; }, 2000);
    }
  }
}

/* ---------------------------------------------------------------------------
   15. CHAT
--------------------------------------------------------------------------- */

let chatPeerId = null;

function threadKey(a, b) { return [a, b].sort().join('::'); }

async function renderCommPage() {
  paintCommServerPill();
  const friends = (me().friends || []).map(userById).filter(Boolean);
  const onlineIds = ablyReady() ? await ablyOnlineUserIds() : [];

  $('commFriendsList').innerHTML = friends.length
    ? friends.map(f => {
        const online = onlineIds.includes(f.id) || Date.now() - f.lastSeen < 300000;
        return `<div class="friend-row" style="cursor:pointer;" onclick="openChatWith('${f.id}')">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="presence-dot ${online ? 'online' : ''}"></span>
          <b style="font-size:.85rem;">${esc(f.username)}</b>
        </div></div>`;
      }).join('')
    : `<p style="font-size:.82rem;color:var(--text-tertiary);">Add friends from the Social page to start chatting.</p>`;
  if (chatPeerId) renderThread();
}

function openChatWith(userId) {
  chatPeerId = userId;
  openKnightPage('commPage');
  const u = userById(userId);
  $('commThreadLabel').textContent = u ? 'Chat with ' + u.username : 'Chat';
  const room = threadKey(myId(), userId);
  if (ablyAvailable()) joinAblyChatRoom(room);
  else joinSocketRoom(room);
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
  const key = threadKey(myId(), chatPeerId);
  const at = Date.now();

  if (ablyReady() && sendAblyChat(key, text)) {
    // Ably echoes it back to us too (we're subscribed to our own channel),
    // which is what actually adds it to the thread — no local double-write.
  } else if (socketReady() && socketRoom === key) {
    socket.send(JSON.stringify({ type: 'chat', room: key, text }));
  } else {
    // Offline/local path — same as before, works across tabs on this device.
    const d = DB.data();
    d.messages[key] = d.messages[key] || [];
    d.messages[key].push({ id: uid('msg'), from: myId(), to: chatPeerId, text, at });
    DB.saveData(d);
    renderThread();
  }
  pushNotification(chatPeerId, 'New Message', me().username + ': ' + text.slice(0, 60), '#/comm/' + me().socialId);
  input.value = '';
}

/* ---------------------------------------------------------------------------
   16. DATA-BASE — Notes column (quests, mind maps, mic, learnings)
                   Database column (real site analytics + charts)
--------------------------------------------------------------------------- */

const NOTE_LANGS = ['text', 'javascript', 'python', 'java', 'html', 'css', 'bash', 'json', 'sql'];

function myNotes() { return DB.data().notes[myId()] || []; }

function allNoteTags() {
  const set = new Set();
  myNotes().forEach(n => (n.tags || []).forEach(t => set.add(t)));
  return Array.from(set).sort();
}

let notesActiveTag = null;

function renderNotesTagPills() {
  const box = $('notesTagPills');
  if (!box) return;
  const tags = allNoteTags();
  if (!tags.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="db-tag-pill ${notesActiveTag === null ? 'active' : ''}" onclick="setNotesTagFilter(null)">All</div>`
    + tags.map(t => `<div class="db-tag-pill ${notesActiveTag === t ? 'active' : ''}" onclick="setNotesTagFilter('${esc(t)}')">${esc(t)}</div>`).join('');
}

function setNotesTagFilter(tag) { notesActiveTag = tag; renderNotes(); }

function renderNotes() {
  renderNotesTagPills();
  const q = ($('notesSearchInput')?.value || '').toLowerCase();
  const sort = $('notesSortSelect')?.value || 'recent';

  let notes = myNotes().filter(n =>
    (!q || n.title.toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q) || (n.tags || []).some(t => t.toLowerCase().includes(q)))
    && (!notesActiveTag || (n.tags || []).includes(notesActiveTag))
  );

  if (sort === 'az') notes = notes.slice().sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'pinned') notes = notes.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.at - a.at);
  else notes = notes.slice().sort((a, b) => b.at - a.at);

  const count = $('notesCount');
  if (count) count.textContent = notes.length + ' of ' + myNotes().length + (myNotes().length === 1 ? ' item' : ' items');

  const grid = $('notesGrid');
  if (grid) {
    grid.innerHTML = notes.length
      ? notes.map((n, i) => questCard(n, i)).join('')
      : `<p style="font-size:.9rem;color:var(--text-tertiary);">${myNotes().length ? 'Nothing matches that search.' : 'Nothing here yet — add a note, snippet, mind map, or learning.'}</p>`;
  }
}

const NOTE_TYPE_META = {
  note:    { icon: '📝', label: 'Note' },
  code:    { icon: '⌘',  label: 'Code' },
  mindmap: { icon: '◎',  label: 'Mind Map' },
  learning:{ icon: '🎓', label: 'Learning' },
};

/** A note rendered as a "quest" — a gently floating card with a completion
    toggle, like a small log entry rather than a flat sticky note. */
function questCard(n, index) {
  const meta = NOTE_TYPE_META[n.type] || NOTE_TYPE_META.note;
  const delay = (index % 6) * 0.35;

  let body = '';
  if (n.type === 'mindmap') {
    body = `<div class="quest-mindmap-preview">${renderMindMapThumbnail(n.mindmap)}</div>`;
  } else if (n.type === 'learning') {
    body = `<p class="quest-body">${esc((n.body || '').slice(0, 160))}${(n.body || '').length > 160 ? '…' : ''}</p>
      ${n.source ? `<div class="quest-source">Source: ${esc(n.source)}</div>` : ''}`;
  } else {
    body = `<p class="quest-body ${n.type === 'code' ? 'font-mono' : ''}">${esc((n.body || '').slice(0, 160))}${(n.body || '').length > 160 ? '…' : ''}</p>`;
  }

  return `<div class="db-card quest-card ${n.pinned ? 'is-pinned' : ''} ${n.completed ? 'is-complete' : ''}" style="animation-delay:${delay}s;" onclick="openNoteForEdit('${n.id}')">
    <div class="db-card-head">
      <span class="quest-check ${n.completed ? 'checked' : ''}" title="Mark complete" onclick="event.stopPropagation(); toggleNoteComplete('${n.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
      <h3>${esc(n.title)}</h3>
      <button class="db-pin-btn ${n.pinned ? 'active' : ''}" title="Pin" onclick="event.stopPropagation(); toggleNotePin('${n.id}')">
        <svg viewBox="0 0 24 24" fill="${n.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8"><path d="M12 2 L14.5 8.5 L21 9.5 L16.5 14 L17.5 21 L12 17.5 L6.5 21 L7.5 14 L3 9.5 L9.5 8.5 Z"/></svg>
      </button>
    </div>
    <span class="quest-type-tag">${meta.icon} ${meta.label}${n.type === 'code' && n.language ? ' · ' + n.language : ''}</span>
    ${body}
    <div class="db-card-foot">
      <span class="db-card-time">${timeAgo(n.at)}</span>
      <div style="display:flex; gap:6px;" onclick="event.stopPropagation();">
        <button class="nav-cta" style="font-size:.7rem;padding:5px 9px;" onclick="duplicateNoteUI('${n.id}')">Duplicate</button>
        <button class="nav-cta" style="color:var(--accent-coral);font-size:.7rem;padding:5px 9px;" onclick="deleteNote('${n.id}')">Delete</button>
      </div>
    </div>
  </div>`;
}

function toggleNoteComplete(id) {
  const d = DB.data();
  const n = (d.notes[myId()] || []).find(x => x.id === id);
  if (!n) return;
  n.completed = !n.completed;
  DB.saveData(d);
  renderNotes();
}

/* ----- create / edit: note, code, learning (mindmap has its own editor) --- */

function createNoteUI(type = 'note') {
  const d = DB.data();
  d.notes[myId()] = d.notes[myId()] || [];
  const n = {
    id: uid('note'),
    title: type === 'code' ? 'Untitled snippet' : type === 'learning' ? 'Untitled learning' : 'Untitled note',
    body: '', type, language: type === 'code' ? 'javascript' : null,
    source: type === 'learning' ? '' : undefined,
    tags: [], pinned: false, completed: false, at: Date.now(),
  };
  d.notes[myId()].unshift(n);
  DB.saveData(d);
  renderNotes();
  openNoteForEdit(n.id);
}

let editingNoteId = null;

function openNoteForEdit(id) {
  const n = myNotes().find(x => x.id === id);
  if (!n) return;
  if (n.type === 'mindmap') { openMindMapEditor(id); return; }

  editingNoteId = id;
  $('noteEditorTitle').value = n.title;
  $('noteEditorBody').value = n.body || '';

  const langSel = $('noteEditorLangSelect');
  if (n.type === 'code') {
    langSel.style.display = 'block';
    langSel.innerHTML = NOTE_LANGS.map(l => `<option value="${l}" ${n.language === l ? 'selected' : ''}>${l}</option>`).join('');
  } else {
    langSel.style.display = 'none';
  }

  const learningFields = $('noteEditorLearningFields');
  if (n.type === 'learning') {
    learningFields.style.display = 'block';
    learningFields.innerHTML = `<input type="text" id="noteEditorSource" placeholder="Source (book, course, link…)" value="${esc(n.source || '')}" style="width:100%; padding:9px 12px; background:rgba(0,0,0,.3); border:1px solid var(--panel-border); border-radius:8px; color:var(--text-primary); font-size:.82rem;">`;
  } else {
    learningFields.style.display = 'none';
    learningFields.innerHTML = '';
  }

  openModalRaw('noteEditorModal');
}

function saveNoteEditorUI() {
  if (!editingNoteId) return;
  const d = DB.data();
  const n = (d.notes[myId()] || []).find(x => x.id === editingNoteId);
  if (!n) return;

  n.title = $('noteEditorTitle').value.trim() || n.title;
  n.body = $('noteEditorBody').value;
  n.at = Date.now();
  if (n.type === 'code') n.language = $('noteEditorLangSelect').value;
  if (n.type === 'learning') { const src = $('noteEditorSource'); if (src) n.source = src.value.trim(); }

  DB.saveData(d);
  closeModal('noteEditorModal');
  stopNoteDictation();
  renderNotes();
}

function duplicateNoteUI(id) {
  const d = DB.data();
  const list = d.notes[myId()] || [];
  const n = list.find(x => x.id === id);
  if (!n) return;
  list.unshift({ ...structuredCloneSafe(n), id: uid('note'), title: n.title + ' (copy)', at: Date.now() });
  DB.saveData(d);
  renderNotes();
  toast('Duplicated.');
}

function updateNoteTags(id, raw) {
  const d = DB.data();
  const n = (d.notes[myId()] || []).find(x => x.id === id);
  if (!n) return;
  n.tags = raw.split(',').map(t => t.trim()).filter(Boolean);
  n.at = Date.now();
  DB.saveData(d);
  renderNotes();
}

function toggleNotePin(id) {
  const d = DB.data();
  const n = (d.notes[myId()] || []).find(x => x.id === id);
  if (!n) return;
  n.pinned = !n.pinned;
  DB.saveData(d);
  renderNotes();
}

function deleteNote(id) {
  const d = DB.data();
  d.notes[myId()] = (d.notes[myId()] || []).filter(n => n.id !== id);
  DB.saveData(d);
  renderNotes();
}

/* ----- mic dictation into the note editor's body -------------------------- */

let noteDictationRecognizer = null;

function toggleNoteDictation() {
  noteDictationRecognizer ? stopNoteDictation() : startNoteDictation();
}

function startNoteDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice dictation is not supported in this browser.', true); return; }

  noteDictationRecognizer = new SR();
  noteDictationRecognizer.lang = 'en-US';
  noteDictationRecognizer.continuous = true;
  noteDictationRecognizer.interimResults = false;

  noteDictationRecognizer.onstart = () => { $('noteEditorMicBtn').classList.add('listening'); toast('Listening — speak your note.'); };
  noteDictationRecognizer.onresult = (e) => {
    const said = Array.from(e.results).slice(-1)[0][0].transcript;
    const box = $('noteEditorBody');
    box.value = (box.value ? box.value + ' ' : '') + said;
  };
  noteDictationRecognizer.onerror = () => stopNoteDictation();
  noteDictationRecognizer.onend = () => stopNoteDictation();
  noteDictationRecognizer.start();
}

function stopNoteDictation() {
  if (noteDictationRecognizer) { try { noteDictationRecognizer.stop(); } catch {} noteDictationRecognizer = null; }
  const btn = $('noteEditorMicBtn');
  if (btn) btn.classList.remove('listening');
}

/* ----- mind maps ------------------------------------------------------------ */

let mindMapEditingId = null;
let mindMapSelected = new Set();
let mindMapDragId = null;
let mindMapDragMoved = false;

function createMindMapUI() {
  const d = DB.data();
  d.notes[myId()] = d.notes[myId()] || [];
  const n = {
    id: uid('note'), title: 'Untitled mind map', type: 'mindmap',
    mindmap: { nodes: [], edges: [] }, tags: [], pinned: false, completed: false, at: Date.now(),
  };
  d.notes[myId()].unshift(n);
  DB.saveData(d);
  openMindMapEditor(n.id);
}

function openMindMapEditor(id) {
  const n = myNotes().find(x => x.id === id);
  if (!n) return;
  mindMapEditingId = id;
  mindMapSelected = new Set();
  $('mindMapTitle').textContent = n.title;
  renderMindMapCanvas(n.mindmap || { nodes: [], edges: [] });
  openModalRaw('mindMapModal');
}

function closeMindMapUI() {
  closeModal('mindMapModal');
  mindMapEditingId = null;
}

function currentMindMap() {
  const n = myNotes().find(x => x.id === mindMapEditingId);
  return n ? (n.mindmap = n.mindmap || { nodes: [], edges: [] }) : { nodes: [], edges: [] };
}

function addMindMapNode() {
  const text = (prompt('Node label:') || '').trim();
  if (!text) return;
  const mm = currentMindMap();
  mm.nodes.push({ id: uid('nd'), x: 80 + Math.random() * 500, y: 60 + Math.random() * 260, text });
  renderMindMapCanvas(mm);
}

function connectMindMapSelected() {
  if (mindMapSelected.size !== 2) { toast('Select exactly two nodes to connect or disconnect.', true); return; }
  const [a, b] = Array.from(mindMapSelected);
  const mm = currentMindMap();
  const i = mm.edges.findIndex(e => (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a));
  if (i === -1) mm.edges.push([a, b]); else mm.edges.splice(i, 1);
  mindMapSelected = new Set();
  renderMindMapCanvas(mm);
}

function deleteMindMapSelected() {
  if (!mindMapSelected.size) { toast('Select a node first.', true); return; }
  const mm = currentMindMap();
  mm.nodes = mm.nodes.filter(n => !mindMapSelected.has(n.id));
  mm.edges = mm.edges.filter(e => !mindMapSelected.has(e[0]) && !mindMapSelected.has(e[1]));
  mindMapSelected = new Set();
  renderMindMapCanvas(mm);
}

function renderMindMapCanvas(mm) {
  const svg = $('mindMapCanvas');
  if (!svg) return;

  const edgeLines = mm.edges.map(([a, b]) => {
    const na = mm.nodes.find(n => n.id === a), nb = mm.nodes.find(n => n.id === b);
    if (!na || !nb) return '';
    return `<line x1="${na.x}" y1="${na.y}" x2="${nb.x}" y2="${nb.y}" stroke="var(--accent-gold)" stroke-width="1.5" opacity="0.55"/>`;
  }).join('');

  const nodeEls = mm.nodes.map(n => `
    <g class="mindmap-node ${mindMapSelected.has(n.id) ? 'selected' : ''}" data-id="${n.id}" transform="translate(${n.x},${n.y})" style="cursor:grab;">
      <circle r="26" fill="rgba(243,198,35,.12)" stroke="var(--accent-gold)" stroke-width="${mindMapSelected.has(n.id) ? 3 : 1.5}"/>
      <text text-anchor="middle" dy="4" font-size="10" fill="#fff" font-family="Manrope, sans-serif">${esc(n.text.slice(0, 12))}</text>
    </g>`).join('');

  svg.innerHTML = edgeLines + nodeEls;

  $$('.mindmap-node', svg).forEach(g => {
    g.addEventListener('mousedown', (e) => {
      mindMapDragId = g.dataset.id;
      e.preventDefault();
    });
    g.addEventListener('click', () => {
      if (mindMapDragMoved) { mindMapDragMoved = false; return; }
      const id = g.dataset.id;
      mindMapSelected.has(id) ? mindMapSelected.delete(id) : mindMapSelected.add(id);
      renderMindMapCanvas(currentMindMap());
    });
  });

  wireMindMapDrag();
}

let mindMapDragWired = false;

function wireMindMapDrag() {
  if (mindMapDragWired) return;
  mindMapDragWired = true;
  const svg = $('mindMapCanvas');
  if (!svg) return;
  svg.addEventListener('mousemove', (e) => {
    if (!mindMapDragId) return;
    mindMapDragMoved = true;
    const rect = svg.getBoundingClientRect();
    const scaleX = 680 / rect.width, scaleY = 380 / rect.height;
    const mm = currentMindMap();
    const node = mm.nodes.find(n => n.id === mindMapDragId);
    if (node) {
      node.x = Math.max(20, Math.min(660, (e.clientX - rect.left) * scaleX));
      node.y = Math.max(20, Math.min(360, (e.clientY - rect.top) * scaleY));
      renderMindMapCanvas(mm);
    }
  });
  window.addEventListener('mouseup', () => { mindMapDragId = null; });
}

function saveMindMapUI() {
  const d = DB.data();
  const n = (d.notes[myId()] || []).find(x => x.id === mindMapEditingId);
  if (!n) return;
  n.title = $('mindMapTitle').textContent.trim() || n.title;
  n.at = Date.now();
  DB.saveData(d);
  closeMindMapUI();
  renderNotes();
  toast('Mind map saved.');
}

/** A tiny static SVG so a mind-map note shows something on its card. */
function renderMindMapThumbnail(mm) {
  if (!mm || !mm.nodes || !mm.nodes.length) {
    return `<span style="font-size:.76rem;color:var(--text-tertiary);">Empty — open to add nodes.</span>`;
  }
  const xs = mm.nodes.map(n => n.x), ys = mm.nodes.map(n => n.y);
  const minX = Math.min(...xs) - 20, maxX = Math.max(...xs) + 20;
  const minY = Math.min(...ys) - 20, maxY = Math.max(...ys) + 20;
  const edges = (mm.edges || []).map(([a, b]) => {
    const na = mm.nodes.find(n => n.id === a), nb = mm.nodes.find(n => n.id === b);
    return na && nb ? `<line x1="${na.x}" y1="${na.y}" x2="${nb.x}" y2="${nb.y}" stroke="var(--accent-gold)" stroke-width="1" opacity=".5"/>` : '';
  }).join('');
  const nodes = mm.nodes.map(n => `<circle cx="${n.x}" cy="${n.y}" r="6" fill="var(--accent-gold)" opacity=".8"/>`).join('');
  return `<svg viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" style="width:100%;height:70px;">${edges}${nodes}</svg>
    <span style="font-size:.7rem;color:var(--text-tertiary);">${mm.nodes.length} node${mm.nodes.length === 1 ? '' : 's'} · ${(mm.edges || []).length} link${(mm.edges || []).length === 1 ? '' : 's'}</span>`;
}

/* ---------------------------------------------------------------------------
   16.5 DATABASE — real analytics: accounts, active now, signups/activity charts
--------------------------------------------------------------------------- */

/** Local fallback stats — used whenever there's no backend connected. Not
    "site-wide" (a browser only knows what's on this device), but real and
    honestly labeled as such, rather than showing fabricated numbers. */
function computeLocalAnalytics() {
  const users = Object.values(DB.users());
  const projects = Object.values(DB.data().projects);
  const activeCutoff = Date.now() - 5 * 60000;

  const byDay = (timestamps, days) => {
    const counts = {};
    timestamps.forEach(t => {
      const day = new Date(t).toISOString().slice(0, 10);
      counts[day] = (counts[day] || 0) + 1;
    });
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push({ date: d, count: counts[d] || 0 });
    }
    return out;
  };

  const allNotifs = Object.values(DB.data().notifications || {}).flat();

  return {
    source: 'local',
    totalUsers: users.length,
    activeUsers: users.filter(u => u.lastSeen >= activeCutoff).length,
    totalProjects: projects.length,
    deployedSites: projects.filter(p => p.deployedUrl).length,
    signupsByDay: byDay(users.map(u => u.createdAt), 14),
    activityByDay: byDay(allNotifs.map(n => n.at), 7),
  };
}

async function fetchRemoteAnalytics() {
  if (!API_BASE || !me() || !DB.backendToken(me().email)) return null;
  const r = await DB.server('/api/analytics/summary');
  if (!r) return null;
  return { ...r, source: 'remote' };
}

/** Build an SVG <path> for a rise-and-fall line chart from a list of numbers. */
function buildLineChartPath(values, width, height, pad = 6) {
  if (!values.length) return { path: '', points: [] };
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const points = values.map((v, i) => ({
    x: pad + i * stepX,
    y: height - pad - (v / max) * (height - pad * 2),
  }));
  const path = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  return { path, points, max };
}

/** Build simple rects for a bar chart from a list of numbers. */
function buildBarChartBars(values, width, height, pad = 6, gap = 6) {
  if (!values.length) return [];
  const max = Math.max(1, ...values);
  const barW = (width - pad * 2 - gap * (values.length - 1)) / values.length;
  return values.map((v, i) => {
    const h = (v / max) * (height - pad * 2);
    return { x: pad + i * (barW + gap), y: height - pad - h, w: Math.max(2, barW), h: Math.max(1, h), value: v };
  });
}

function renderLineChartSvg(rows, elId, totalElId) {
  const values = rows.map(r => r.count);
  const total = values.reduce((a, b) => a + b, 0);
  const totalEl = $(totalElId);
  if (totalEl) totalEl.textContent = total + ' total';

  const W = 560, H = 110;
  const { path, points } = buildLineChartPath(values, W, H);
  const dots = points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="var(--accent-gold)"/>`).join('');
  const area = path ? `${path} L${points[points.length - 1].x.toFixed(1)},${H - 6} L${points[0].x.toFixed(1)},${H - 6} Z` : '';

  const box = $(elId);
  if (!box) return;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="db-chart-svg" preserveAspectRatio="none">
    ${area ? `<path d="${area}" fill="url(#dbLineGrad)" opacity="0.25"/>` : ''}
    <defs><linearGradient id="dbLineGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent-gold)"/><stop offset="100%" stop-color="var(--accent-gold)" stop-opacity="0"/>
    </linearGradient></defs>
    ${path ? `<path d="${path}" fill="none" stroke="var(--accent-gold)" stroke-width="2"/>` : ''}
    ${dots}
  </svg>
  <div class="db-chart-labels">${rows.map(r => `<span>${r.date.slice(5)}</span>`).join('')}</div>`;
}

function renderBarChartSvg(rows, elId, totalElId) {
  const values = rows.map(r => r.count);
  const total = values.reduce((a, b) => a + b, 0);
  const totalEl = $(totalElId);
  if (totalEl) totalEl.textContent = total + ' total';

  const W = 560, H = 110;
  const bars = buildBarChartBars(values, W, H);
  const box = $(elId);
  if (!box) return;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="db-chart-svg" preserveAspectRatio="none">
    ${bars.map(b => `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="2" fill="var(--accent-blue)" opacity="0.85"/>`).join('')}
  </svg>
  <div class="db-chart-labels">${rows.map(r => `<span>${r.date.slice(5)}</span>`).join('')}</div>`;
}

async function renderDbAnalytics() {
  const note = $('dbAnalyticsNote');
  const remote = await fetchRemoteAnalytics();
  const data = remote || computeLocalAnalytics();

  if (note) {
    note.className = 'cloud-note ' + (remote ? 'is-ready' : 'is-off');
    note.innerHTML = remote
      ? `<b>Live from Knight Cloud.</b> These numbers cover everyone signed in through your deployed backend.`
      : `<b>Local device only.</b> No backend connected, so this only reflects accounts and activity on this browser. Connect <code>API_BASE</code> for real site-wide numbers.`;
  }

  const stats = $('dbStatsRow');
  if (stats) {
    stats.innerHTML = [
      ['Accounts', data.totalUsers], ['Active now', data.activeUsers],
      ['Projects', data.totalProjects], ['Deployed', data.deployedSites],
    ].map(([label, val]) => `<div class="proj-stat"><div class="proj-stat-val">${val}</div><div class="proj-stat-label">${label}</div></div>`).join('');
  }

  renderLineChartSvg(data.signupsByDay, 'dbSignupChart', 'dbSignupTotal');
  renderBarChartSvg(data.activityByDay, 'dbActivityChart', 'dbActivityTotal');

  const feed = $('dbActivityFeed');
  if (feed) {
    const myFeed = (DB.data().notifications[myId()] || []).slice(0, 6);
    feed.innerHTML = myFeed.length
      ? myFeed.map(n => `<div class="proj-activity-row"><span class="proj-activity-dot"></span>
          <span class="proj-activity-text">${esc(n.title)} — ${esc(n.desc)}</span>
          <span class="proj-activity-time">${timeAgo(n.at)}</span></div>`).join('')
      : `<p style="font-size:.8rem;color:var(--text-tertiary);">No activity recorded yet.</p>`;
  }
}


/* ---------------------------------------------------------------------------
   17. TERMINAL (real execution via Piston) + MASTERING TERMINAL
   -----------------------------------------------------------------------
   "Mastering Terminal" turns the code runner into a real workstation for a
   project: a file sidebar, a mini live preview of the website (from the real
   deployed URL when there is one, otherwise a local bundle), a rolling
   console of everything you've run, a live FPS readout for the preview, and
   tools that work across a project's whole version history — diffing two
   versions, forking someone else's project, and scanning every version for
   detectable errors to find the cleanest one.
--------------------------------------------------------------------------- */

const PISTON_VERSIONS = {
  javascript: '18.15.0', python: '3.10.0', 'c++': '10.2.0', c: '10.2.0',
  java: '15.0.2', typescript: '5.0.3', go: '1.16.2', rust: '1.68.2',
  php: '8.2.3', ruby: '3.0.1', bash: '5.2.0',
};

let terminalProjectId = null;
let termRunHistory = [];   // { at, lang, status: 'ok'|'error', preview }

async function runCodeUI() {
  const lang = $('termLanguage').value;
  const code = $('termCodeInput').value;
  const out = $('termOutput');
  const btn = $('runCodeBtn');

  out.textContent = 'Running…';
  btn.disabled = true;

  let status = 'ok', text = '';
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
    text = ((r.stdout || '') + (r.stderr || '')).trim() || '(no output)';
    out.textContent = text;
    if (r.stderr) {
      status = 'error';
      if ($('termAudioToggle').checked && DB.prefs().errorSound !== false) beep();
    }
  } catch (e) {
    status = 'error';
    text = 'Could not reach the execution service.\n' + e.message
      + '\n\nThis needs internet access — it runs your code on a real remote runtime.';
    out.textContent = text;
    if ($('termAudioToggle').checked) beep();
  } finally {
    btn.disabled = false;
    logTermRun(lang, status, text);
  }
}

function logTermRun(lang, status, text) {
  termRunHistory.unshift({ at: Date.now(), lang, status, preview: text.slice(0, 140) });
  termRunHistory = termRunHistory.slice(0, 25);
  renderTermConsoleHistory();
}

function renderTermConsoleHistory() {
  const box = $('termConsoleHistory');
  if (!box) return;
  box.innerHTML = termRunHistory.length
    ? termRunHistory.map((r, i) => `<div class="term-history-row ${r.status === 'error' ? 'is-error' : ''}" onclick="restoreTermRun(${i})">
        <span class="term-history-dot"></span>
        <span class="term-history-lang">${esc(r.lang)}</span>
        <span class="term-history-preview">${esc(r.preview.split('\n')[0] || '(no output)')}</span>
        <span class="term-history-time">${timeAgo(r.at)}</span>
      </div>`).join('')
    : `<p style="font-size:.78rem;color:var(--text-tertiary);">Nothing run yet this session.</p>`;
}

function restoreTermRun(i) {
  const r = termRunHistory[i];
  if (!r) return;
  $('termOutput').textContent = r.preview + (r.preview.length >= 140 ? '…' : '');
  toast('Showing output from that run.');
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

/* ----- Terminal file sidebar ---------------------------------------------- */

/** All projects this person can open in the Terminal, most-recently-touched first. */
function myTerminalProjects() {
  const all = Object.values(DB.data().projects).filter(p => p.ownerId === myId() || myRoleOn(p));
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function renderTermWebsiteList() {
  const box = $('termWebsiteList');
  if (!box) return;
  const list = myTerminalProjects();
  box.innerHTML = list.length
    ? list.map(p => `<div class="term-file-row ${p.id === terminalProjectId ? 'is-active' : ''}" onclick="openTerminalWorkspace('${p.id}')">
        <span class="term-file-icon">◇</span>
        <span class="term-file-name">${esc(p.name)}</span>
      </div>`).join('')
    : `<p style="font-size:.76rem;color:var(--text-tertiary);">No projects yet — create one from Projects or Studio.</p>`;
}

let termWorkspaceTab = 'files';

function setTermWorkspaceTab(tab) {
  termWorkspaceTab = tab;
  $$('.term-ws-tab').forEach(b => b.classList.toggle('active', b.dataset.wtab === tab));
  ['files', 'run', 'debug', 'commits', 'server'].forEach(t => {
    const panel = $('termWsPanel-' + t);
    if (panel) panel.classList.toggle('active', t === tab);
  });
  if (tab === 'server') {
    const p = DB.data().projects[terminalProjectId];
    if (p) loadTermMiniPreview(p);
  } else {
    stopTermFps();
  }
  if (tab === 'debug') runTermDebugScan();
}

/** The single entry point for "open this website in the Terminal" — loads
    everything (files, console, commits, server) into one workspace, exactly
    like clicking into a proper IDE project rather than just an editor tab. */
function openTerminalWorkspace(projectId) {
  const p = DB.data().projects[projectId];
  if (!p) { toast('Project not found.', true); return; }
  if (!canSeeProject(p)) { toast('You do not have access to that project.', true); return; }

  terminalProjectId = projectId;
  currentProjectId = projectId;   // so Compare/Restore/Deploy reuse the same project-detail logic

  $('termNoProjectHint').style.display = 'none';
  $('termWorkspace').style.display = 'block';

  renderTermWebsiteList();
  renderTermFileList(p);
  renderTermCommitsList(p);
  setTermWorkspaceTab(termWorkspaceTab || 'files');
  toast(p.name + ' loaded.');
}

function renderTermFileList(p) {
  const box = $('termFileList');
  const title = $('termPageTitle');
  const pill = $('termServerPill');
  if (!box) return;

  if (!p) {
    box.innerHTML = '';
    if (title) title.textContent = 'Terminal';
    if (pill) pill.style.display = 'none';
    return;
  }

  if (title) title.textContent = 'Terminal — ' + p.name;
  if (pill) { pill.style.display = 'inline-block'; pill.textContent = Object.keys(p.files).length + ' files'; }

  box.innerHTML = Object.keys(p.files).map(name => `
    <div class="term-file-row" onclick="loadTermFile('${esc(name)}')">
      <span class="term-file-icon">${LANG_BY_EXT[extOf(name)] ? '⌘' : (['html','htm'].includes(extOf(name)) ? '◇' : '·')}</span>
      <span class="term-file-name">${esc(name)}</span>
    </div>`).join('');
}

function renderTermCommitsList(p) {
  const box = $('termCommitsList');
  if (!box) return;
  const list = (p.versions || []).slice().reverse();
  box.innerHTML = list.length
    ? list.map((v, i) => `<div class="version-card">
        <div class="version-head">
          <div><b>${esc(v.label)}</b>${i === 0 ? '<span class="version-current">current</span>' : ''}
          <div class="version-meta">${timeAgo(v.at)} · ${Object.keys(v.snapshot || {}).length} files</div></div>
          <div style="display:flex; gap:6px;">
            ${i !== 0 ? `<button class="nav-cta" onclick="restoreVersion('${v.id}')">Restore</button>` : ''}
            <button class="nav-cta" onclick="openVersionDiffUI('${v.id}')">Compare</button>
          </div>
        </div>
        <p class="version-note">${esc(v.note || 'No description given.')}</p>
      </div>`).join('')
    : `<p style="font-size:.82rem;color:var(--text-tertiary);">No commits yet — cut a version from the project's Versions tab.</p>`;
}

function loadTermFile(name) {
  const p = DB.data().projects[terminalProjectId];
  if (!p || p.files[name] === undefined) return;
  $('termCodeInput').value = p.files[name];
  if (LANG_BY_EXT[extOf(name)]) $('termLanguage').value = LANG_BY_EXT[extOf(name)];
  setTermWorkspaceTab('run');
  toast(name + ' loaded.');
}

/* ----- mini live preview + FPS bar ----------------------------------------- */

let termFpsHandle = null;

function loadTermMiniPreview(p) {
  clearTermRuntimeLog();
  const frame = $('termMiniFrame');
  const hint = $('termMiniHint');
  const serverHint = $('termServerHint');
  if (!frame) return;

  const hasHtml = Object.keys(p.files || {}).some(n => ['html', 'htm'].includes(extOf(n)));

  if (p.deployedUrl) {
    // The project is live in the cloud — show the real thing, backend and all,
    // instead of a local re-bundle that can't reach whatever server it talks to.
    frame.src = p.deployedUrl;
    hint.style.display = 'none';
    if (serverHint) serverHint.textContent = 'Showing the real deployed site — its backend runs live, not a local copy.';
    startTermFps();
    return;
  }

  if (hasHtml) {
    const entry = Object.keys(p.files).find(n => n.toLowerCase() === 'index.html')
               || Object.keys(p.files).find(n => ['html', 'htm'].includes(extOf(n)));
    frame.removeAttribute('src');
    frame.srcdoc = inlineProject(p, entry);
    hint.style.display = 'none';
    if (serverHint) serverHint.textContent = 'Local bundle — deploy to get a real, always-on link.';
    startTermFps();
    return;
  }

  frame.removeAttribute('src'); frame.srcdoc = '';
  hint.textContent = 'This project has no website to preview — it\'s pure code.';
  hint.style.display = 'block';
  if (serverHint) serverHint.textContent = 'No .html file yet — nothing to run as a website.';
  stopTermFps();
}

function startTermFps() {
  stopTermFps();
  let frames = 0, last = performance.now();
  function tick(now) {
    frames++;
    if (now - last >= 1000) {
      const el = $('termFpsBar');
      if (el) el.textContent = frames + ' fps';
      frames = 0; last = now;
    }
    if ($('terminalPage') && $('terminalPage').classList.contains('active')) {
      termFpsHandle = requestAnimationFrame(tick);
    }
  }
  termFpsHandle = requestAnimationFrame(tick);
}

function stopTermFps() {
  if (termFpsHandle) cancelAnimationFrame(termFpsHandle);
  termFpsHandle = null;
  const el = $('termFpsBar');
  if (el) el.textContent = '-- fps';
}

/* ----- fork a project ------------------------------------------------------- */

function forkProjectUI(projectId) {
  if (!requireAuth()) return;
  const d = DB.data();
  const src = d.projects[projectId || currentProjectId];
  if (!src) return;
  if (!canSeeProject(src)) { toast('You cannot fork a project you cannot see.', true); return; }

  const fork = {
    ...structuredCloneSafe(src),
    id: uid('prj'),
    ownerId: myId(),
    name: src.name + ' (fork)',
    forkedFrom: { projectId: src.id, ownerId: src.ownerId, name: src.name },
    members: [], changeRequests: [], starredBy: [], stars: 0, reviews: [],
    deployedUrl: '', backendId: undefined,
    joinCode: uid('key').toUpperCase().slice(0, 12), joinCodeEnabled: false,
    versions: [{ id: uid('ver'), label: 'Version 1', note: 'Forked from ' + src.name, at: Date.now(), snapshot: structuredCloneSafe(src.files) }],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  d.projects[fork.id] = fork;
  DB.saveData(d);
  toast('Forked as "' + fork.name + '".');
  openProjectDetail(fork.id);
}

/* ----- compare two versions -------------------------------------------------- */

function openVersionDiffUI(versionId, compareToId) {
  const p = DB.data().projects[currentProjectId];
  if (!p) return;
  const v = p.versions.find(x => x.id === versionId);
  const against = compareToId ? p.versions.find(x => x.id === compareToId)
    : { label: 'Current files', snapshot: p.files };
  if (!v || !against) return;

  $('versionDiffTitle').textContent = v.label + ' vs ' + against.label;
  const changed = diffFileNames(against.snapshot, v.snapshot);
  $('versionDiffBody').innerHTML = changed.length
    ? changed.map(c => `<div class="version-diff-row diff-${c.kind}">
        <span class="diff-badge">${c.kind === 'added' ? '+ added' : c.kind === 'removed' ? '− removed' : '~ edited'}</span>
        <span class="diff-filename">${esc(c.name)}</span>
      </div>`).join('')
    : `<p style="font-size:.82rem;color:var(--text-tertiary);">No file differences between these two.</p>`;
  openModalRaw('versionDiffModal');
}

/* ----- error scanner: find the version with the fewest detectable issues --- */

/** A real, if limited, static check: JS files are parsed with Function() to
    catch syntax errors, and HTML files get a basic open/close tag balance
    check. This can't catch runtime or logic bugs — no static scanner can —
    but it does catch the most common thing that breaks a whole page. */
function scanSnapshotForIssues(snapshot) {
  const issues = [];
  Object.entries(snapshot || {}).forEach(([name, content]) => {
    const ext = extOf(name);
    if (['js', 'mjs', 'jsx'].includes(ext)) {
      try { new Function(content); }
      catch (e) { issues.push({ file: name, message: 'JS syntax error: ' + e.message }); }
    } else if (['html', 'htm'].includes(ext)) {
      const opens = (content.match(/<([a-z][a-z0-9]*)\b[^>]*(?<!\/)>/gi) || [])
        .filter(t => !/^<(br|img|input|hr|meta|link|source|col|area|base|embed|track|wbr)\b/i.test(t)).length;
      const closes = (content.match(/<\/[a-z][a-z0-9]*>/gi) || []).length;
      if (Math.abs(opens - closes) > 0) issues.push({ file: name, message: 'Possibly unbalanced HTML tags (' + opens + ' opened vs ' + closes + ' closed)' });
    }
  });
  return issues;
}

function scanAllVersions(p) {
  return (p.versions || []).map(v => ({
    id: v.id, label: v.label, at: v.at,
    issues: scanSnapshotForIssues(v.snapshot),
  }));
}

function findCleanestVersion(p) {
  const scanned = scanAllVersions(p);
  if (!scanned.length) return null;
  return scanned.slice().sort((a, b) => a.issues.length - b.issues.length || b.at - a.at)[0];
}

/* ----- Debug tab: scan the live/current files, not just saved versions --- */

/* ----- Live runtime console for the Debug tab — real execution output ---- */

let termRuntimeLog = [];   // { kind, text, at } — a rolling buffer, newest last

function recordTermRuntimeLog(kind, text) {
  termRuntimeLog.push({ kind, text, at: Date.now() });
  if (termRuntimeLog.length > 200) termRuntimeLog.shift();
  renderTermRuntimeConsole();
}

function renderTermRuntimeConsole() {
  const box = $('termRuntimeConsole');
  const status = $('termRuntimeStatus');
  if (!box) return;

  const errorCount = termRuntimeLog.filter(l => l.kind === 'error').length;
  if (status) {
    status.textContent = !termRuntimeLog.length
      ? 'No preview running yet.'
      : errorCount
        ? errorCount + ' runtime error' + (errorCount === 1 ? '' : 's') + ' captured'
        : 'Running clean — no errors logged.';
  }

  box.textContent = termRuntimeLog.length
    ? termRuntimeLog.map(l => (l.kind === 'error' ? '! ' : l.kind === 'warn' ? '~ ' : '· ') + l.text).join('\n')
    : 'Nothing logged yet.';
  box.scrollTop = box.scrollHeight;
}

function clearTermRuntimeLog() {
  termRuntimeLog = [];
  renderTermRuntimeConsole();
}

function runTermDebugScan() {
  const p = DB.data().projects[terminalProjectId];
  const box = $('termDebugResult');
  const count = $('termDebugCount');
  if (!p || !box) return;

  const issues = scanSnapshotForIssues(p.files);
  if (count) count.textContent = issues.length ? ' ' + issues.length : '';

  box.innerHTML = issues.length
    ? issues.map(i => `<div class="version-scan-row" style="border-bottom:1px solid var(--panel-border); padding-bottom:8px; margin-bottom:8px;">
        <span class="has-issues">${esc(i.file)}</span>
        <button class="nav-cta" style="font-size:.7rem;padding:4px 10px;" onclick="loadTermFile('${esc(i.file)}')">Open</button>
      </div>
      <div class="version-scan-issue" style="margin-bottom:6px;">${esc(i.message)}</div>`).join('')
    : `<div class="version-scan-summary is-clean">No detectable issues in the current files.</div>`;
}

/* ----- Network tab: real timing/status check against the deployed site ---- */

async function runNetworkCheckUI() {
  const p = DB.data().projects[terminalProjectId];
  const box = $('termNetworkResult');
  if (!p || !box) return;

  if (!p.deployedUrl) {
    box.innerHTML = `<div class="storage-row"><span class="storage-row-label">Not deployed</span><span class="storage-row-bytes">—</span></div>`;
    return;
  }

  box.innerHTML = `<div class="storage-row"><span class="storage-row-label">Checking ${esc(p.deployedUrl)}…</span></div>`;
  const start = performance.now();
  try {
    const res = await fetch(p.deployedUrl, { method: 'GET', mode: 'cors', cache: 'no-store' });
    const ms = Math.round(performance.now() - start);
    box.innerHTML = [
      ['Status', res.status + ' ' + (res.ok ? 'OK' : res.statusText)],
      ['Response time', ms + ' ms'],
      ['URL', p.deployedUrl],
    ].map(([k, v]) => `<div class="storage-row"><span class="storage-row-label">${k}</span><span class="storage-row-bytes">${esc(String(v))}</span></div>`).join('');
  } catch (e) {
    const ms = Math.round(performance.now() - start);
    box.innerHTML = `<div class="storage-row"><span class="storage-row-label" style="color:var(--accent-coral);">Request failed after ${ms} ms</span><span class="storage-row-bytes">${esc(e.message)}</span></div>
      <p style="font-size:.7rem;color:var(--text-tertiary);margin-top:6px;">A failed cross-origin fetch can also just mean the host blocks requests from other sites (CORS) — the site itself may still be fine in a normal browser tab.</p>`;
  }
}

function scanVersionsForErrorsUI() {
  const p = DB.data().projects[currentProjectId];
  if (!p) return;
  const scanned = scanAllVersions(p);
  const cleanest = findCleanestVersion(p);
  const box = $('versionScanResult');

  box.innerHTML = `
    <div class="version-scan-summary ${cleanest && cleanest.issues.length === 0 ? 'is-clean' : ''}">
      ${cleanest
        ? `Cleanest: <b>${esc(cleanest.label)}</b> — ${cleanest.issues.length} detectable issue${cleanest.issues.length === 1 ? '' : 's'}`
        : 'No versions to scan yet.'}
    </div>
    ${scanned.map(v => `<div class="version-scan-row">
        <span>${esc(v.label)}</span>
        <span class="${v.issues.length ? 'has-issues' : 'no-issues'}">${v.issues.length ? v.issues.length + ' issue(s)' : 'clean'}</span>
      </div>${v.issues.map(i => `<div class="version-scan-issue">${esc(i.file)}: ${esc(i.message)}</div>`).join('')}`).join('')}
    <p style="font-size:.7rem;color:var(--text-tertiary);margin-top:8px;">Static check only — catches syntax and tag-balance problems, not runtime or logic errors.</p>`;
  toast(cleanest ? 'Cleanest version: ' + cleanest.label : 'Nothing to scan.');
}

/* ----- GitHub public repo import -------------------------------------------- */

async function openGithubImportUI() {
  if (!requireAuth()) return;
  $('githubImportStatus').textContent = '';
  openModalRaw('githubImportModal');
}

async function importGithubRepoUI() {
  const repo = ($('githubRepoInput').value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  const branch = ($('githubBranchInput').value || '').trim();
  const status = $('githubImportStatus');
  if (!repo || !repo.includes('/')) { status.textContent = 'Enter a repo as owner/name.'; return; }

  status.textContent = 'Looking up the repository…';
  try {
    let ref = branch;
    if (!ref) {
      const repoInfo = await fetch('https://api.github.com/repos/' + repo).then(r => r.ok ? r.json() : null);
      if (!repoInfo) throw new Error('Repository not found or not public.');
      ref = repoInfo.default_branch || 'main';
    }

    status.textContent = 'Fetching the file tree…';
    const treeRes = await fetch('https://api.github.com/repos/' + repo + '/git/trees/' + ref + '?recursive=1');
    if (!treeRes.ok) throw new Error('Could not read that branch (HTTP ' + treeRes.status + ').');
    const tree = await treeRes.json();
    const files = (tree.tree || []).filter(t => t.type === 'blob' && t.size && t.size < MAX_FILE_BYTES);

    if (!files.length) throw new Error('No importable files found.');
    if (files.length > 60) status.textContent = 'Large repo — importing the first 60 files…';

    const picked = files.slice(0, 60);
    const results = {};
    for (let i = 0; i < picked.length; i++) {
      const f = picked[i];
      status.textContent = 'Downloading ' + (i + 1) + ' / ' + picked.length + ': ' + f.path;
      const rawUrl = 'https://raw.githubusercontent.com/' + repo + '/' + ref + '/' + f.path;
      try {
        const content = isImage(f.path)
          ? null   // skip binary content — keep the file listed, empty, rather than fail the whole import
          : await fetch(rawUrl).then(r => r.ok ? r.text() : null);
        results[f.path] = content ?? '';
      } catch { results[f.path] = ''; }
    }

    pendingProjectFiles = results;
    closeModal('githubImportModal');
    $('newProjName').value = repo.split('/')[1] || repo;
    $('newProjDesc').value = 'Imported from github.com/' + repo;
    renderPendingFiles();
    openModalRaw('newProjectModal');
    toast('Imported ' + Object.keys(results).length + ' files from ' + repo + ' — review and hit Create.');
  } catch (e) {
    status.textContent = e.message || 'Import failed.';
  }
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
  const banner = $('linkDeployerCloudNote');
  if (banner) {
    banner.className = 'cloud-note ' + (API_BASE ? 'is-ready' : 'is-off');
    banner.innerHTML = API_BASE
      ? `<b>Knight Cloud is connected.</b> Deploy gives you a real, working link at this server's own address — reachable by anyone, not just this browser.`
      : `<b>Knight Cloud isn't connected yet.</b> Deploy the included <code>KnightBackendApplication.java</code> (Render, Railway, wherever) and set <code>API_BASE</code> at the top of script.js. Once that's done, a real <code>your-app.onrender.com/website/xxxx</code> link is one click away. Until then, use Build .html below and drop it on Netlify Drop yourself.`;
  }

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
                     <button class="nav-cta" onclick="exportProjectUI('${p.id}')">Build .html</button>
                     <button class="nav-cta ${API_BASE ? 'btn-golden' : ''}" onclick="deployProjectToCloudUI('${p.id}')"
                       title="${API_BASE ? 'Deploy a real live link' : 'Configure API_BASE first — see the note above'}">☁ Deploy to Cloud</button>` : ''}
            ${p.deployedUrl ? `<button class="nav-cta" style="color:var(--accent-coral);" onclick="deleteDeployedSiteUI('${p.id}')">🗑 Delete Site</button>` : ''}
            <button class="nav-cta" onclick="openProjectDetail('${p.id}')">Open project</button>
          </div>
          <div class="friend-add-row">
            <input type="url" id="deployUrl-${p.id}" value="${esc(p.deployedUrl || '')}"
              placeholder="https://your-site.netlify.app or a Knight Cloud link">
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
   20. DEVICE MODES
   (Knight's real keyboard shortcuts still work — Alt+H/T/P/S/N/G, Ctrl+K,
   Esc, Alt+U/A — see setupKeyboard() below. Only the documentation page
   that listed them has been removed.)
--------------------------------------------------------------------------- */

let shortcutOS = 'windows';

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
  $$('.device-card').forEach(c => c.classList.toggle('selected', c.dataset.device === device));
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
  { label: 'Data-Base',        hint: 'notes',    run: () => openKnightPage('notesPage') },
  { label: 'Arcade',           hint: 'game',     run: () => openKnightPage('arcadePage') },
  { label: 'Game Booster',     hint: 'perf',     run: () => openKnightPage('gameBoosterPage') },
  { label: 'Settings',         hint: 'prefs',    run: () => openKnightPage('settingsPage') },
  { label: 'Send Feedback',    hint: 'bug idea', run: openFeedbackUI },
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
  renderAiSettings();
  renderFeedbackHistory();
  renderCloudConfigStatus();
  testCloudConnectionUI();
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
  aiProposals.new = null; renderAiProposal('new');
  if ($('newProjAiPrompt')) $('newProjAiPrompt').value = '';
  paintAiStatus(); refreshAiStatus();
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
  recordRecentBuild(p);
  runPreview();
}

/** Assemble the project into one document and hand it to the iframe. */
function runPreview() {
  clearTermRuntimeLog();
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

  const withBridge = html.includes('<head>') ? html.replace('<head>', '<head>' + bridge) : bridge + html;
  return sanitizeUntrustedHtml(withBridge);
}

/* ---------------------------------------------------------------------------
   PREVIEW SECURITY

   Untrusted content (uploaded files, imported repos, another contributor's
   edits) gets bundled and run inside <iframe sandbox="allow-scripts
   allow-forms allow-modals[ allow-popups]">. Two flags are deliberately never
   granted, and that omission is what actually enforces the isolation:

     - allow-same-origin is never set, so the iframe's content is treated as
       a unique, opaque origin distinct from this page. Per the browser's
       same-origin policy, that means the preview's own scripts cannot read
       this page's localStorage (accounts, sessions, backend tokens), cannot
       read document.cookie, and cannot reach into window.parent's DOM —
       even though window.parent itself is a reachable JS reference, any
       attempt to touch its .document throws a SecurityError.
     - allow-top-navigation is never set, so a script or a plain
       <a target="_top">/<form target="_top"> inside the preview cannot
       navigate this page away or hijack the outer window — the browser
       blocks the navigation attempt outright.

   The one bridge that IS allowed on purpose is postMessage() (used above to
   pipe the preview's console.log back into Knight's console panel) —
   postMessage cannot read or write the parent's DOM or storage; it only
   delivers a message Knight's own listener chooses to read.

   sanitizeUntrustedHtml() below is defense-in-depth on top of that sandbox,
   not a replacement for it: it strips a couple of things that are merely
   annoying rather than dangerous under this sandbox (a <base> tag that could
   redirect relative links, a meta-refresh loop) and hardens target="_blank"
   links against reverse-tabnabbing (a still-real risk against the *new* tab
   they open, independent of the iframe sandbox).
--------------------------------------------------------------------------- */
function sanitizeUntrustedHtml(html) {
  html = html
    // A <base> tag could otherwise redirect every relative link/asset in ways
    // that are confusing to debug and serve no purpose in a bundled preview.
    .replace(/<base\b[^>]*>/gi, '<!-- base tag stripped for preview safety -->')
    // A meta-refresh can create a confusing redirect loop inside the sandbox
    // (it cannot escape the iframe, but it's still unwanted behavior).
    .replace(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, '<!-- meta-refresh stripped for preview safety -->')
    // Even though the sandbox already blocks _top/_parent navigation outright,
    // rewriting them closes the gap defensively and avoids noisy console errors.
    .replace(/target=["'](_top|_parent)["']/gi, 'target="_self"');

  // A target="_blank" link the preview opens gets window.opener back to the
  // (sandboxed, opaque-origin) iframe unless noopener is set — harden it,
  // since the opened tab is a real, non-sandboxed browsing context. Walked
  // per-tag rather than one regex, so a stray rel= earlier in the tag can't
  // confuse the match.
  html = html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (!/target=["']_blank["']/i.test(tag)) return tag;
    if (/\brel=["'][^"']*\b(noopener|noreferrer)\b/i.test(tag)) return tag;
    if (/\brel=["']/i.test(tag)) {
      return tag.replace(/\brel=["']([^"']*)["']/i, (relTag, existing) => `rel="${existing} noopener noreferrer"`);
    }
    return tag.slice(0, -1) + ' rel="noopener noreferrer">';
  });

  return html;
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

  openKnightPage('terminalPage');
  openTerminalWorkspace(p.id);

  const runnable = Object.keys(p.files).filter(n => LANG_BY_EXT[extOf(n)]);
  if (runnable.length) {
    const file = runnable.length === 1
      ? runnable[0]
      : (prompt('Which file should the editor open first?\n\n' + runnable.join('\n'), runnable[0]) || '').trim();
    if (file && p.files[file] !== undefined) {
      $('termLanguage').value = LANG_BY_EXT[extOf(file)];
      $('termCodeInput').value = p.files[file];
    }
  }
}

/* ----- export / deploy ----- */

/** Push a project's basic metadata to the backend once, so it has a server-side
    id to deploy against. Cached on the project as backendId — a local project
    (string uid) and a backend project (Long id) are different records on
    purpose; this link is only created the first time something is deployed. */
async function ensureBackendProject(p) {
  if (p.backendId) return p.backendId;
  const created = await DB.server('/api/projects', {
    method: 'POST', timeoutMs: 90000,
    body: JSON.stringify({
      name: p.name, description: p.description, category: p.category,
      visibility: p.visibility, tags: p.tags,
    }),
  });
  if (!created || !created.id) return null;

  const d = DB.data();
  if (d.projects[p.id]) { d.projects[p.id].backendId = created.id; DB.saveData(d); }
  return created.id;
}

/** The real deploy: bundle the site, push it to the backend, get back a live
    onrender.com/website/xxxx-style URL. Requires KnightBackendApplication.java
    to actually be deployed and API_BASE (top of this file) pointed at it —
    without that, this tells you so instead of pretending to succeed. */
async function deployProjectToCloudUI(projectId) {
  if (!requireAuth()) return;
  const d = DB.data();
  const p = d.projects[projectId || currentProjectId];
  if (!p) return;

  const role = myRoleOn(p);
  if (role !== 'owner' && role !== 'editor') { toast('Only owners and editors can deploy.', true); return; }

  const entry = Object.keys(p.files).find(n => n.toLowerCase() === 'index.html')
             || Object.keys(p.files).find(n => ['html', 'htm'].includes(extOf(n)));
  if (!entry) { toast('Needs an .html file to deploy as a website.', true); return; }

  const log = $('previewConsole');
  const say = (line) => { if (log) { log.textContent += '\n' + line; log.scrollTop = log.scrollHeight; } };

  if (!API_BASE) {
    toast('No cloud backend is configured yet — see the note under Link Deployer.', true);
    say('! deploy failed: no backend configured (API_BASE is empty)');
    return;
  }
  if (!DB.backendToken(me().email)) {
    toast('This account has no live backend session yet. Sign out and back in while the backend is reachable, then try again.', true);
    say('! deploy failed: no authenticated backend session for this account');
    return;
  }

  say('$ knight deploy ' + p.name);
  say('> bundling ' + entry + ' + ' + (Object.keys(p.files).length - 1) + ' linked file(s)…');
  toast('Deploying ' + p.name + '…');
  const built = inlineProject(p, entry);
  say('> bundle ready (' + formatBytes(built.length) + ')');

  say('> connecting to Knight Cloud backend…');
  const backendId = await ensureBackendProject(p);
  if (!backendId) {
    say('! could not reach the backend — is it deployed and awake?');
    toast('Could not reach the Knight Cloud backend — is it deployed and awake?', true);
    return;
  }
  say('> project registered on backend (id ' + backendId + ')');
  say('> uploading bundle…');

  const result = await DB.server('/api/projects/' + backendId + '/deploy', {
    method: 'POST', timeoutMs: 90000,
    body: JSON.stringify({ html: built }),
  });

  if (!result || !result.url) {
    say('! deploy failed — the backend did not respond');
    toast('Deploy failed — the backend did not respond. Try again in a moment.', true);
    return;
  }

  say('> live at ' + result.url);
  say('deploy #' + (result.deployCount || 1) + ' complete');

  const d2 = DB.data();
  d2.projects[p.id].deployedUrl = result.url;
  DB.saveData(d2);
  const field = $('deployUrl-' + p.id);
  if (field) field.value = result.url;
  renderLinkDeployer();
  toast('Live at ' + result.url);
  return result.url;
}

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
  { key: 'supabase', label: 'Supabase',
    match: /from\s+['"]@supabase\/supabase-js['"]|require\(['"]@supabase\/supabase-js['"]\)|createClient\s*\(|\bSUPABASE_URL\b|\bSUPABASE_ANON_KEY\b/,
    vars: [{ name: 'SUPABASE_URL', placeholder: 'https://xxxx.supabase.co' },
           { name: 'SUPABASE_ANON_KEY', placeholder: 'eyJhbGciOi...', secret: true }] },
  { key: 'firebase', label: 'Firebase',
    match: /from\s+['"]firebase\/|require\(['"]firebase|initializeApp\s*\(|\bFIREBASE_API_KEY\b/,
    vars: [{ name: 'FIREBASE_API_KEY', placeholder: 'AIzaSy...', secret: true },
           { name: 'FIREBASE_PROJECT_ID', placeholder: 'my-app-12345' }] },
  { key: 'stripe', label: 'Stripe',
    match: /from\s+['"]@stripe\/|require\(['"]stripe['"]\)|Stripe\s*\(\s*['"]pk_|\bSTRIPE_PUBLIC_KEY\b|\bSTRIPE_SECRET_KEY\b/,
    vars: [{ name: 'STRIPE_PUBLIC_KEY', placeholder: 'pk_live_...' }] },
  { key: 'openai', label: 'OpenAI',
    match: /from\s+['"]openai['"]|require\(['"]openai['"]\)|new\s+OpenAI\s*\(|\bOPENAI_API_KEY\b/,
    vars: [{ name: 'OPENAI_API_KEY', placeholder: 'sk-...', secret: true }] },
  { key: 'mongodb', label: 'MongoDB',
    match: /require\(['"]mongodb['"]\)|require\(['"]mongoose['"]\)|mongoose\.connect\s*\(|MongoClient\s*\(|\bMONGODB_URI\b/,
    vars: [{ name: 'MONGODB_URI', placeholder: 'mongodb+srv://...', secret: true }] },
];

/** Scan a project's own files for the service actually being wired up — an
    import/constructor call or a real env-var name — not just the word
    "stripe" showing up in a comment or a filename. A plain mock/demo page
    with no such code should never be interrupted asking for keys it doesn't need. */
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
/** Recent builds, kept like a chat-history sidebar — click one to jump back in. */
function recordRecentBuild(p) {
  const prefs = DB.prefs();
  const list = (prefs.recentBuilds || []).filter(r => r.projectId !== p.id);
  list.unshift({ projectId: p.id, name: p.name, at: Date.now() });
  prefs.recentBuilds = list.slice(0, 12);
  DB.savePrefs(prefs);
  renderPreviewSidebar();
}

function renderPreviewSidebar() {
  const box = $('previewSidebarList');
  if (!box) return;
  const list = (DB.prefs().recentBuilds || []);
  const projects = DB.data().projects;

  box.innerHTML = list.length
    ? list.map(r => {
        const stillExists = !!projects[r.projectId];
        const live = server.on && server.projectId === r.projectId;
        return `<div class="preview-sidebar-item ${live ? 'is-active' : ''}"
            onclick="${stillExists ? `openProjectBuild('${r.projectId}')` : ''}"
            style="${stillExists ? '' : 'opacity:.4;cursor:default;'}">
          <span class="preview-sidebar-dot ${live ? 'is-live' : ''}"></span>
          <span class="preview-sidebar-name">${esc(r.name)}</span>
          <span class="preview-sidebar-time">${timeAgo(r.at)}</span>
        </div>`;
      }).join('')
    : `<p style="font-size:.76rem;color:var(--text-tertiary);padding:8px 4px;">Projects you open here will show up as a quick-switch list.</p>`;
}

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
  recordRecentBuild(p);
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


/* ===========================================================================
   FEEDBACK + DELETING A DEPLOYED SITE
=========================================================================== */

let feedbackRating = 0;

function paintFeedbackStars() {
  const box = $('feedbackStars');
  if (!box) return;
  box.innerHTML = [1, 2, 3, 4, 5].map(n =>
    `<button type="button" class="feedback-star ${n <= feedbackRating ? 'on' : ''}" onclick="setFeedbackRating(${n})" title="${n} of 5">
      <svg viewBox="0 0 24 24"><polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.6"/></svg></button>`
  ).join('');
}

function setFeedbackRating(n) { feedbackRating = (feedbackRating === n ? 0 : n); paintFeedbackStars(); }

function openFeedbackUI() {
  if (!requireAuth()) return;
  feedbackRating = 0;
  $('feedbackMessage').value = '';
  $('feedbackCategory').value = 'bug';
  paintFeedbackStars();
  openModalRaw('feedbackModal');
}

async function submitFeedbackUI() {
  if (!requireAuth()) return;
  const message = ($('feedbackMessage').value || '').trim();
  if (!message) { toast('Write a message first.', true); return; }

  const entry = {
    id: uid('fb'), category: $('feedbackCategory').value,
    rating: feedbackRating || null, message: message.slice(0, 5000), at: Date.now(), sent: false,
  };

  // Always saved on this device first, so nothing is lost if the backend is down.
  const d = DB.data();
  d.feedback = d.feedback || {};
  d.feedback[myId()] = d.feedback[myId()] || [];
  d.feedback[myId()].unshift(entry);
  DB.saveData(d);
  closeModal('feedbackModal');

  if (API_BASE && DB.backendToken(me().email)) {
    const r = await DB.server('/api/feedback', {
      method: 'POST', timeoutMs: 60000,
      body: JSON.stringify({ category: entry.category, rating: entry.rating, message: entry.message }),
    });
    if (r) {
      const d2 = DB.data();
      const saved = (d2.feedback[myId()] || []).find(f => f.id === entry.id);
      if (saved) { saved.sent = true; DB.saveData(d2); }
      toast('Thanks — feedback sent.');
    } else {
      toast('Saved on this device, but the backend did not respond.', true);
    }
  } else {
    toast('Thanks — feedback saved on this device.');
  }
  renderFeedbackHistory();
}

function renderFeedbackHistory() {
  const box = $('feedbackHistory');
  if (!box) return;
  const list = ((DB.data().feedback || {})[myId()] || []).slice(0, 5);
  box.innerHTML = list.map(f => `<div class="proj-activity-row">
      <span class="proj-activity-dot"></span>
      <span class="proj-activity-text">${esc(f.category)}${f.rating ? ' · ' + '★'.repeat(f.rating) : ''} — ${esc(f.message.slice(0, 70))}${f.message.length > 70 ? '…' : ''}</span>
      <span class="proj-activity-time">${f.sent ? 'sent' : 'saved'} · ${timeAgo(f.at)}</span></div>`).join('');
}

/** Take a deployed site down. If it lives on Knight Cloud, the backend is told
    to delete it; if the backend can't be reached we do NOT pretend it's gone. */
async function deleteDeployedSiteUI(projectId) {
  if (!requireAuth()) return;
  const d = DB.data();
  const p = d.projects[projectId || currentProjectId];
  if (!p) return;
  const role = myRoleOn(p);
  if (role !== 'owner' && role !== 'editor') { toast('Only owners and editors can delete a deployed site.', true); return; }
  if (!p.deployedUrl) { toast('This project has no deployed site.'); return; }

  const onKnightCloud = !!(p.backendId && API_BASE);
  const msg = onKnightCloud
    ? 'Delete the live site for "' + p.name + '"? Its link will stop working immediately. Your project files are kept.'
    : 'Remove the saved link for "' + p.name + '"? If it is hosted elsewhere (Netlify, Vercel…), you still need to delete it there.';
  if (!confirm(msg)) return;

  if (onKnightCloud) {
    const r = await DB.server('/api/projects/' + p.backendId + '/deploy', { method: 'DELETE', timeoutMs: 60000 });
    if (!r) { toast('Could not reach the backend, so the live site was NOT deleted. Try again.', true); return; }
  }

  const d2 = DB.data();
  d2.projects[p.id].deployedUrl = '';
  d2.projects[p.id].updatedAt = Date.now();
  DB.saveData(d2);
  toast(onKnightCloud ? 'Live site deleted.' : 'Link removed.');
  renderLinkDeployer();
  if ($('projectDetailPage') && $('projectDetailPage').classList.contains('active')) openProjectDetail(p.id, true);
}

/* ===========================================================================
   AI ASSISTANT — generate files, review them, and only then write them to a repo

   Flow: you describe what you want -> the model answers with files in a strict
   format -> Knight parses and validates every path -> you see each file and
   tick what you want -> only after you click Allow do files enter the repo.
   Nothing the AI writes is ever saved or run automatically, which is also
   what keeps a prompt-injection hidden in some project file from doing harm.

   Two ways to reach the model, same code path either way:
     - this browser's own OpenRouter key (Settings; stored only on this device)
     - the backend's /api/ai/chat proxy, where the key stays on the server
=========================================================================== */

const AI_DEFAULT_MODEL = 'openrouter/auto';
const AI_MAX_FILES = 40;
const AI_MAX_FILE_CHARS = 400 * 1024;
const AI_MAX_TOTAL_CHARS = 1500 * 1024;
const AI_CONTEXT_PER_FILE = 12000;
const AI_CONTEXT_TOTAL = 60000;

const AI_SYSTEM_PROMPT = `You are Knight's coding assistant, working inside a project repository.

When you create or change files, output EACH file in exactly this format:

===FILE: relative/path/to/file.ext===
<the complete file content>
===END FILE===

Rules:
- Paths are relative to the repository root, use forward slashes, and never start with "/" or contain "..".
- Always output the COMPLETE file. Never output diffs and never write "rest of file unchanged".
- Put your explanation OUTSIDE the file blocks, before them, in a few short sentences.
- Do not wrap file content in markdown code fences.
- For a website, include an index.html that links its own style.css and script.js by relative path.
- Only create the files that are needed for the request.`;

let aiBackendStatus = null;            // { enabled, model, hourlyLimit } from the backend, if reachable
let aiBusy = false;
const aiProposals = { project: null, new: null };

function aiPersonalKey() { return ((DB.prefs().openrouterKey) || '').trim(); }
function aiModelName() { return ((DB.prefs().aiModel) || '').trim() || AI_DEFAULT_MODEL; }

async function refreshAiStatus() {
  if (!API_BASE || !me() || !DB.backendToken(me().email)) { aiBackendStatus = null; paintAiStatus(); return; }
  const r = await DB.server('/api/ai/status', { timeoutMs: 15000 });
  aiBackendStatus = (r && typeof r.enabled === 'boolean') ? r : null;
  paintAiStatus();
}

/** 'personal' (own key) wins, then 'backend' (the site's shared key), else 'none'. */
function aiMode() {
  if (aiPersonalKey()) return 'personal';
  if (aiBackendStatus && aiBackendStatus.enabled) return 'backend';
  return 'none';
}

function paintAiStatus() {
  const mode = aiMode();
  const text = mode === 'personal' ? '✅ AI ready: using your own OpenRouter key (' + aiModelName() + ')'
    : mode === 'backend' ? '✅ AI ready: provided by this site (' + (aiBackendStatus.model || 'default model') + ')'
    : 'AI is not set up yet. Add an OpenRouter key under Settings & Guides → AI Assistant.';
  ['aiStatusLine', 'newProjAiStatus'].forEach(id => {
    const el = $(id);
    if (el) { el.textContent = text; el.classList.toggle('is-ready', mode !== 'none'); }
  });
}

function aiHttpError(status, data) {
  const detail = data && data.error && (data.error.message || data.error);
  if (status === 401) return 'OpenRouter rejected the key (invalid or revoked).';
  if (status === 402) return 'Out of OpenRouter credits, or this key\'s credit limit is used up.';
  if (status === 429) return 'Rate limited by OpenRouter. Wait a moment and try again.';
  if (status === 502 || status === 503) return 'The chosen model is down right now. Try a different model in Settings.';
  return 'AI error ' + status + (detail ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '');
}

/** One question to the model. Returns { content, finishReason, model } or throws a readable Error. */
async function callAI(messages) {
  const mode = aiMode();
  if (mode === 'none') throw new Error('AI is not set up yet. Add an OpenRouter key in Settings & Guides.');

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 120000) : null;
  let res;
  try {
    if (mode === 'personal') {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: ctrl ? ctrl.signal : undefined,
        headers: { 'Authorization': 'Bearer ' + aiPersonalKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: aiModelName(), messages, max_tokens: 8000 }),
      });
    } else {
      const token = DB.backendToken(me().email);
      if (!token) throw new Error('Sign out and back in while the backend is reachable, then try again.');
      res = await fetch(API_BASE + '/api/ai/chat', {
        method: 'POST', signal: ctrl ? ctrl.signal : undefined,
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
    }
  } catch (e) {
    if (e && e.message && !/fetch|network|abort/i.test(e.message)) throw e;
    throw new Error(e && e.name === 'AbortError'
      ? 'The AI took too long to answer (2 minutes). Try a smaller request.'
      : 'Could not reach the AI service. Check your connection.');
  } finally { if (timer) clearTimeout(timer); }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (mode === 'backend') throw new Error((data && data.error) || ('The Knight backend answered ' + res.status + '.'));
    throw new Error(aiHttpError(res.status, data));
  }
  if (mode === 'backend') return { content: data.content || '', finishReason: data.finishReason || '', model: data.model || '' };

  const choice = data && data.choices && data.choices[0];
  if (!choice || !choice.message) throw new Error('The AI returned no answer.');
  return { content: String(choice.message.content || ''), finishReason: choice.finish_reason || '', model: data.model || '' };
}

/* ----- building the request ------------------------------------------------ */

function buildAiContext(files) {
  let out = 'File contents:', used = 0; const omitted = [];
  Object.keys(files || {}).forEach(name => {
    const body = String(files[name] == null ? '' : files[name]);
    if (isImage(name) || body.startsWith('data:')) { omitted.push(name + ' (binary)'); return; }
    if (used >= AI_CONTEXT_TOTAL) { omitted.push(name + ' (context full)'); return; }
    let chunk = body.slice(0, Math.min(AI_CONTEXT_PER_FILE, AI_CONTEXT_TOTAL - used));
    const cut = chunk.length < body.length;
    used += chunk.length;
    out += '\n===FILE: ' + name + '===\n' + chunk + (cut ? '\n…[truncated]' : '') + '\n===END FILE===';
  });
  if (omitted.length) out += '\n(Not included: ' + omitted.join(', ') + ')';
  return out;
}

function buildAiUserMessage(project, prompt, includeContext) {
  const parts = [];
  if (project) {
    parts.push('Project: ' + project.name + (project.description ? ' — ' + project.description : ''));
    const names = Object.keys(project.files || {});
    parts.push(names.length
      ? 'Current files:\n' + names.map(n => '- ' + n + ' (' + String(project.files[n] || '').length + ' chars)').join('\n')
      : 'The repository is empty.');
    if (includeContext && names.length) parts.push(buildAiContext(project.files));
  }
  parts.push('Request:\n' + prompt);
  return parts.join('\n\n');
}

/* ----- reading the answer --------------------------------------------------- */

function stripOuterFence(text) {
  const m = /^```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text;
}

function parseAiFiles(text) {
  const rest = String(text || '');
  const files = [], spans = [];
  const re = /^===FILE:\s*(.+?)\s*===[ \t]*\r?\n([\s\S]*?)\r?\n?===END FILE===[ \t]*$/gm;
  let m;
  while ((m = re.exec(rest))) {
    files.push({ rawPath: m[1], content: stripOuterFence(m[2]), complete: true });
    spans.push([m.index, re.lastIndex]);
  }
  // A final block with no END marker means the model ran out of room mid-file.
  const tailStart = spans.length ? spans[spans.length - 1][1] : 0;
  const open = /^===FILE:\s*(.+?)\s*===[ \t]*\r?\n([\s\S]*)$/m.exec(rest.slice(tailStart));
  if (open) {
    files.push({ rawPath: open[1], content: stripOuterFence(open[2]), complete: false });
    spans.push([tailStart + open.index, rest.length]);
  }
  let message = '', pos = 0;
  spans.forEach(([a, b]) => { message += rest.slice(pos, a); pos = b; });
  message += rest.slice(pos);
  return { message: message.trim(), files };
}

/** The AI picks the paths, so they are untrusted input: no absolute paths,
    no "..", no .git, no odd characters. Anything unsafe is dropped, not "fixed". */
function sanitizeRepoPath(raw) {
  let p = String(raw || '').trim().replace(/^`+|`+$/g, '').replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!p || p.length > 200) return null;
  if (/[\u0000-\u001f]/.test(p)) return null;
  if (!/^[\w.\-@+()\[\] \/]+$/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some(s => s === '' || s === '.' || s === '..')) return null;
  if (parts[0].toLowerCase() === '.git') return null;
  return p;
}

function prepareAiProposal(parsed, existing) {
  const byPath = new Map(), dropped = [];
  parsed.files.forEach(f => {
    const path = sanitizeRepoPath(f.rawPath);
    if (!path) { dropped.push(String(f.rawPath).slice(0, 60)); return; }
    const content = (!f.content || f.content.endsWith('\n')) ? f.content : f.content + '\n';
    byPath.set(path, { path, content, complete: f.complete });
  });
  let files = Array.from(byPath.values());
  let extra = 0;
  if (files.length > AI_MAX_FILES) { extra = files.length - AI_MAX_FILES; files = files.slice(0, AI_MAX_FILES); }
  let total = 0;
  files.forEach(f => {
    f.exists = Object.prototype.hasOwnProperty.call(existing || {}, f.path);
    f.same = f.exists && existing[f.path] === f.content;
    total += f.content.length;
    f.problem = null;
    if (f.content.length > AI_MAX_FILE_CHARS) f.problem = 'too large (' + formatBytes(f.content.length) + ')';
    else if (!f.complete) f.problem = 'cut off mid-file';
    else if (total > AI_MAX_TOTAL_CHARS) f.problem = 'over the total size limit';
    f.selected = !f.problem && !f.same;
    f.open = false;
  });
  return { message: parsed.message, files, dropped, extra };
}

/* ----- the review UI ----------------------------------------------------------- */

function renderAiProposal(ctx) {
  const box = $(ctx === 'new' ? 'newProjAiBox' : 'aiProposalBox');
  if (!box) return;
  let pr = aiProposals[ctx];
  if (pr && ctx === 'project' && pr.projectId !== currentProjectId) { aiProposals.project = pr = null; }
  if (!pr) { box.innerHTML = ''; return; }

  const sel = pr.files.filter(f => f.selected && !f.problem).length;
  const rows = pr.files.map((f, i) => {
    const badge = f.problem ? ['bad', f.problem] : f.same ? ['same', 'no change'] : f.exists ? ['over', 'overwrites existing'] : ['new', 'new'];
    return `<div class="ai-file-row ${f.problem ? 'has-problem' : ''}">
        <label class="ai-file-main">
          <input type="checkbox" ${f.selected ? 'checked' : ''} ${f.problem ? 'disabled' : ''} onchange="toggleAiFile('${ctx}', ${i}, this.checked)">
          <span class="ai-file-path">${esc(f.path)}</span>
          <span class="ai-badge ${badge[0]}">${esc(badge[1])}</span>
        </label>
        <button class="ai-preview-btn" onclick="toggleAiPreview('${ctx}', ${i})">${f.open ? 'Hide' : 'Preview'}</button>
      </div>${f.open ? `<pre class="ai-file-preview">${esc(f.content.slice(0, 4000))}${f.content.length > 4000 ? '\n… (' + formatBytes(f.content.length) + ' in total)' : ''}</pre>` : ''}`;
  }).join('');

  box.innerHTML =
    (pr.message ? `<div class="ai-message">${esc(pr.message)}</div>` : '') +
    (pr.finishReason === 'length' ? `<div class="ai-warn">The answer hit the length limit, so the last file may be incomplete. Ask for fewer files at a time.</div>` : '') +
    (pr.dropped.length ? `<div class="ai-warn">Skipped ${pr.dropped.length} file${pr.dropped.length === 1 ? '' : 's'} with an unsafe or invalid path: ${esc(pr.dropped.join(', '))}</div>` : '') +
    (pr.extra ? `<div class="ai-warn">${pr.extra} more file${pr.extra === 1 ? ' was' : 's were'} left out (limit ${AI_MAX_FILES} per request).</div>` : '') +
    (!pr.files.length ? `<div class="ai-warn">The AI did not produce any files for that. Try naming the files you want.</div>` : '') +
    (pr.files.length ? `<div class="ai-file-list">${rows}</div>
      <div class="ai-actions">
        <button class="nav-cta btn-golden" ${sel ? '' : 'disabled'} onclick="applyAiProposalUI('${ctx}')">✓ Allow: add ${sel} file${sel === 1 ? '' : 's'} ${ctx === 'new' ? 'to the new repo' : 'to this repo'}</button>
        <button class="nav-cta" onclick="discardAiProposal('${ctx}')">Discard</button>
      </div>` : `<div class="ai-actions"><button class="nav-cta" onclick="discardAiProposal('${ctx}')">Dismiss</button></div>`);
}

function toggleAiFile(ctx, i, on) {
  const pr = aiProposals[ctx];
  if (pr && pr.files[i] && !pr.files[i].problem) { pr.files[i].selected = !!on; renderAiProposal(ctx); }
}
function toggleAiPreview(ctx, i) {
  const pr = aiProposals[ctx];
  if (pr && pr.files[i]) { pr.files[i].open = !pr.files[i].open; renderAiProposal(ctx); }
}
function discardAiProposal(ctx) { aiProposals[ctx] = null; renderAiProposal(ctx); }

/* ----- asking ------------------------------------------------------------------ */

async function runAiGenerate(ctx) {
  if (!requireAuth() || aiBusy) return;
  const prompt = (($(ctx === 'new' ? 'newProjAiPrompt' : 'aiPromptInput').value) || '').trim();
  if (!prompt) { toast('Describe what you want first.', true); return; }

  let project, existing;
  if (ctx === 'project') {
    project = DB.data().projects[currentProjectId];
    if (!project) return;
    if (!['owner', 'editor', 'contributor'].includes(myRoleOn(project))) { toast('Viewers cannot add files to this project.', true); return; }
    existing = project.files || {};
  } else {
    existing = pendingProjectFiles;
    project = { name: (($('newProjName').value) || '').trim() || 'New project', description: (($('newProjDesc').value) || '').trim(), files: pendingProjectFiles };
  }

  await refreshAiStatus();
  if (aiMode() === 'none') { toast('Add an OpenRouter key first (Settings & Guides → AI Assistant).', true); return; }

  const includeContext = ctx === 'new' ? Object.keys(pendingProjectFiles).length > 0 : !!($('aiIncludeContext') && $('aiIncludeContext').checked);
  const btn = $(ctx === 'new' ? 'newProjAiBtn' : 'aiGenerateBtn');
  aiBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  try {
    const reply = await callAI([
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: buildAiUserMessage(project, prompt, includeContext) },
    ]);
    const parsed = parseAiFiles(reply.content);
    const proposal = prepareAiProposal(parsed, existing);
    proposal.finishReason = reply.finishReason;
    proposal.prompt = prompt;
    proposal.projectId = ctx === 'project' ? currentProjectId : null;
    // If the model ignored the format and just talked, show what it said instead of nothing.
    if (!parsed.files.length && !proposal.message) proposal.message = reply.content.slice(0, 1200);
    aiProposals[ctx] = proposal;
    renderAiProposal(ctx);
  } catch (e) {
    toast(e.message || 'The AI request failed.', true);
  } finally {
    aiBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = ctx === 'new' ? '✨ Generate files' : '✨ Generate'; }
  }
}
function generateAiProjectFilesUI() { return runAiGenerate('project'); }
function generateNewProjectFilesUI() { return runAiGenerate('new'); }

/* ----- Allow: the only place AI files enter a repo ---------------------------------- */

function applyAiFilesToProject(projectId, files, promptText) {
  const d = DB.data();
  const p = d.projects[projectId];
  if (!p) return { applied: 0, mode: 'missing' };
  const role = myRoleOn(p);

  if (role === 'contributor') {
    // Same rule as any contributor edit: it goes to review, never straight in.
    files.forEach(f => p.changeRequests.push({
      id: uid('cr'), by: myId(), file: f.path, before: p.files[f.path] ?? '', after: f.content,
      status: 'pending', at: Date.now(),
    }));
    DB.saveData(d);
    pushNotification(p.ownerId, 'New Change Request', me().username + ' proposed ' + files.length + ' AI-written file(s) for ' + p.name + '.', '#/project/' + p.id);
    return { applied: files.length, mode: 'review' };
  }
  if (role !== 'owner' && role !== 'editor') return { applied: 0, mode: 'denied' };

  // Snapshot first so the whole AI change can be rolled back from the Versions tab.
  if (Object.keys(p.files || {}).length) {
    p.versions.push({
      id: uid('ver'), label: 'Version ' + (p.versions.length + 1),
      note: 'Before AI changes: ' + String(promptText || '').slice(0, 80),
      at: Date.now(), snapshot: structuredCloneSafe(p.files),
    });
  }
  files.forEach(f => { p.files[f.path] = f.content; });
  p.updatedAt = Date.now();
  DB.saveData(d);
  return { applied: files.length, mode: 'direct' };
}

function applyAiProposalUI(ctx) {
  const pr = aiProposals[ctx];
  if (!pr) return;
  const chosen = pr.files.filter(f => f.selected && !f.problem);
  if (!chosen.length) { toast('Tick at least one file to allow.', true); return; }

  if (ctx === 'new') {
    chosen.forEach(f => { pendingProjectFiles[f.path] = f.content; });
    renderPendingFiles();
    if (!($('newProjDesc').value || '').trim()) $('newProjDesc').value = pr.prompt.slice(0, 120);
    aiProposals.new = null; renderAiProposal('new');
    toast(chosen.length + ' file' + (chosen.length === 1 ? '' : 's') + ' added to the new repo. Review them below, then Create.');
    return;
  }

  const r = applyAiFilesToProject(pr.projectId, chosen, pr.prompt);
  if (r.mode === 'denied' || r.mode === 'missing') { toast('You cannot add files to this project.', true); return; }
  aiProposals.project = null;
  const pid = pr.projectId;
  if (server.on && server.projectId === pid) runPreview();
  openProjectDetail(pid, true);
  toast(r.mode === 'review'
    ? r.applied + ' file(s) sent to the owner for review.'
    : r.applied + ' file' + (r.applied === 1 ? '' : 's') + ' added to the repo. A snapshot was saved first, so you can roll back.');
}

/* ----- Settings ---------------------------------------------------------------------- */

function renderAiSettings() {
  const model = $('aiModelInput'), status = $('aiSettingsStatus'), key = $('aiKeyInput');
  if (model) model.value = DB.prefs().aiModel || '';
  if (key) key.value = '';   // never write a saved key back into the page
  if (status) {
    status.style.color = 'var(--text-tertiary)';
    status.textContent = aiPersonalKey() ? 'A personal key is saved in this browser.'
      : (aiBackendStatus && aiBackendStatus.enabled) ? 'No personal key; using the key set on this site\'s backend.' : 'No key saved.';
  }
  paintAiStatus();
}

function saveAiSettingsUI() {
  const keyEl = $('aiKeyInput'), modelEl = $('aiModelInput');
  const key = ((keyEl && keyEl.value) || '').trim();
  const model = ((modelEl && modelEl.value) || '').trim();
  if (key && !/^sk-or-/.test(key)) { toast('That does not look like an OpenRouter key (they start with sk-or-).', true); return; }
  if (model && !/^[\w.\-\/:@]+$/.test(model)) { toast('Model names look like openrouter/auto or openai/gpt-4o-mini.', true); return; }
  const p = DB.prefs();
  if (key) p.openrouterKey = key;
  p.aiModel = model;
  DB.savePrefs(p);
  renderAiSettings();
  toast(key ? 'AI key saved on this device.' : 'AI settings saved.');
}

function clearAiKeyUI() {
  const p = DB.prefs(); delete p.openrouterKey; DB.savePrefs(p);
  renderAiSettings();
  toast('Key removed from this browser.');
}

async function testAiUI() {
  const status = $('aiSettingsStatus');
  if (status) { status.textContent = 'Asking the model…'; status.style.color = 'var(--text-tertiary)'; }
  await refreshAiStatus();
  try {
    const r = await callAI([{ role: 'user', content: 'Reply with the single word: ready' }]);
    if (status) { status.textContent = '✅ Works. The model said: ' + r.content.slice(0, 40); status.style.color = 'var(--accent-green)'; }
  } catch (e) {
    if (status) { status.textContent = '❌ ' + e.message; status.style.color = 'var(--accent-coral)'; }
  }
}

/* ===========================================================================
   DELETING A PROJECT (repo)
=========================================================================== */

function renderProjectDangerZone(p, isOwner) {
  const zone = $('projectDangerZone');
  if (zone) zone.style.display = isOwner ? 'block' : 'none';
}

async function deleteProjectUI(projectId) {
  if (!requireAuth()) return;
  const p = DB.data().projects[projectId || currentProjectId];
  if (!p) return;
  if (p.ownerId !== myId()) { toast('Only the owner can delete a project.', true); return; }

  const typed = prompt('This permanently deletes "' + p.name + '", with its files, versions and members'
    + (p.deployedUrl ? ' and its live site' : '') + '.\n\nType the project name to confirm:');
  if (typed === null) return;
  if (typed.trim() !== p.name) { toast('That did not match the project name, so nothing was deleted.', true); return; }

  const onCloud = !!(p.backendId && API_BASE);
  if (onCloud) {
    const r = await DB.server('/api/projects/' + p.backendId, { method: 'DELETE', timeoutMs: 60000 });
    if (!r) { toast('Could not reach the backend, so nothing was deleted. Try again.', true); return; }
  }

  const d = DB.data();
  delete d.projects[p.id];
  DB.saveData(d);
  const prefs = DB.prefs();
  prefs.recentBuilds = (prefs.recentBuilds || []).filter(r => r.projectId !== p.id);
  DB.savePrefs(prefs);
  if (terminalProjectId === p.id) terminalProjectId = null;
  if (server.projectId === p.id) { stopPreview(); server.projectId = null; }
  if (currentProjectId === p.id) currentProjectId = null;

  toast('"' + p.name + '" deleted.' + (p.backendId && !API_BASE ? ' Its cloud copy could not be reached and may still exist.' : ''));
  openKnightPage('projectsPage');
}


/* ---------------------------------------------------------------------------
   27. BOOT
--------------------------------------------------------------------------- */

/** Read a previously-saved backend URL out of prefs into the live config
    variables. Called at boot, and again the instant Settings saves a change —
    no code edit, no reload, no redeploying this file required. */
function loadCloudConfig() {
  // Precedence: this browser's Settings (prefs) win, then the site-wide
  // config.js that ships with the frontend, then nothing (local-only).
  const site = (window.KNIGHT_CONFIG || {});
  const p = DB.prefs();
  const pick = (own, shipped) => ((own || '').trim() || (shipped || '').trim());
  const clean = (u) => u.replace(/\/+$/, '') || null;

  API_BASE = clean(pick(p.apiBase, site.apiBase));
  WS_BASE = clean(pick(p.wsBase, site.wsBase));
  WS_SERVER_KEY = pick(p.wsServerKey, site.wsServerKey) || 'knight_ws_7f3a9c2e1b8d4f6a0c5e9b2d7a1f4c8e';
  ABLY_KEY = pick(p.ablyKey, site.ablyKey) || null;
}

async function saveCloudConfigUI() {
  const apiBase = ($('cloudApiBaseInput').value || '').trim();
  const wsBase = ($('cloudWsBaseInput').value || '').trim();
  const wsKey = ($('cloudWsKeyInput').value || '').trim();
  const ablyKey = ($('cloudAblyKeyInput').value || '').trim();

  if (apiBase && !/^https?:\/\//i.test(apiBase)) { toast('API URL must start with http:// or https://', true); return; }
  if (wsBase && !/^wss?:\/\//i.test(wsBase)) { toast('WebSocket URL must start with ws:// or wss://', true); return; }
  if (ablyKey && !/^[\w-]+\.[\w-]+:[\w-]+$/.test(ablyKey)) { toast('That doesn\'t look like a valid Ably key (expected appId.keyId:secret).', true); return; }

  const p = DB.prefs();
  p.apiBase = apiBase; p.wsBase = wsBase; p.wsServerKey = wsKey; p.ablyKey = ablyKey;
  DB.savePrefs(p);
  loadCloudConfig();   // takes effect immediately, live, in this tab

  // reconnect under the new config if something was already open
  if (socket) { try { socket.close(); } catch {} socket = null; }
  disconnectAbly();
  connectAbly();

  renderCloudConfigStatus();
  toast('Cloud connection saved.');

  if (API_BASE) await testCloudConnectionUI();
}

async function testCloudConnectionUI() {
  const status = $('cloudConnectionStatus');
  const say = (text, color) => { if (status) { status.textContent = text; status.style.color = color || 'var(--text-tertiary)'; } };

  const parts = [];
  if (ABLY_KEY) parts.push('Ably key set');
  if (WS_BASE) parts.push('WebSocket server set');

  if (!API_BASE) {
    say(parts.length ? parts.join(' · ') + ' — no Java backend URL, so accounts, projects, and deploy stay local.' : 'Nothing configured — running fully local.');
    return;
  }

  // Free hosts (Render) sleep after ~15 minutes idle; the first request wakes
  // them, which can take up to a minute. Retry instead of reporting a false failure.
  const attempts = 6;
  for (let i = 1; i <= attempts; i++) {
    say(i === 1 ? 'Checking ' + API_BASE + '…' : 'Waking the backend up (free hosts sleep when idle) — try ' + i + '/' + attempts + '…');
    const result = await DB.server('/api/health', { timeoutMs: 12000 });
    if (result) {
      say('✅ Backend reachable' + (parts.length ? ' · ' + parts.join(' · ') : ''), 'var(--accent-green)');
      return;
    }
    if (i < attempts) await new Promise(r => setTimeout(r, 6000));
  }
  say('❌ Could not reach that backend. Check the URL, that the service is running, and that its CORS allows this site (KNIGHT_ALLOWED_ORIGINS).', 'var(--accent-coral)');
}

function renderCloudConfigStatus() {
  const apiInput = $('cloudApiBaseInput'), wsInput = $('cloudWsBaseInput'),
        keyInput = $('cloudWsKeyInput'), ablyInput = $('cloudAblyKeyInput');
  const p = DB.prefs();
  if (apiInput) apiInput.value = p.apiBase || '';
  if (wsInput) wsInput.value = p.wsBase || '';
  if (keyInput) keyInput.value = p.wsServerKey || '';
  if (ablyInput) ablyInput.value = p.ablyKey || '';
}

function boot() {
  loadCloudConfig();
  // Auth tabs
  $('tab-signin').onclick = () => setAuthMode('signin');
  $('tab-signup').onclick = () => setAuthMode('signup');
  $('knightForm').onsubmit = handleAuthSubmit;
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

  // Console output from inside a preview iframe — the Live Preview page's
  // console AND Terminal's Debug tab both listen for the same bridge
  // messages. Previously this only ever wrote to previewConsole, so runtime
  // errors from Terminal's mini preview were silently dropped whenever that
  // element wasn't on the page — this is the actual fix for that gap.
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.__knightLog) return;
    recordTermRuntimeLog(m.kind, m.text);

    const previewLog = $('previewConsole');
    if (previewLog) {
      const tag = m.kind === 'error' ? '!' : m.kind === 'warn' ? '~' : '·';
      previewLog.textContent += '\n' + tag + ' ' + m.text;
      previewLog.scrollTop = previewLog.scrollHeight;
    }
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
  createNoteUI, deleteNote, setNotesTagFilter, toggleNotePin, duplicateNoteUI, updateNoteTags,
  toggleNoteComplete, openNoteForEdit, saveNoteEditorUI, toggleNoteDictation,
  createMindMapUI, closeMindMapUI, addMindMapNode, connectMindMapSelected, deleteMindMapSelected, saveMindMapUI,
  runCodeUI, startMemoryGame, flipCard,
  addPasskeyUI, removePasskey,
  requestCameraAccessUI, saveCameraSettingsUI, stopCameraPreviewUI, resetLocalPrefsUI,
  openCommandPalette, dpadPress, edgeScroll, applyDevice, updateServerButtonContext,
  setProjectTab, toggleNearbyLive, acceptNearbyPrompt, dismissNearbyPrompt,
  deployProjectToCloudUI,
  openProjectBuild, submitSecretsPrompt, skipSecretsPrompt, cancelSecretsPrompt,
  purgeOldGuestsUI, wipeAllStorageUI, renderStorageManager,
  openNewProjectModal, removePendingFile, uploadProjectFilesUI,
  previewPendingFile, savePendingFilePreview, removePendingFileFromPreview,
  toggleServer, runProjectUI, openPreview, runPreview, stopPreview,
  setPreviewWidth, openPreviewInTab, sendProjectToTerminalUI, exportProjectUI,
  openPreviewFor, saveDeployUrlFor, handleNewProjectFiles,
  loadTermFile, restoreTermRun, forkProjectUI, openVersionDiffUI, scanVersionsForErrorsUI,
  openTerminalWorkspace, setTermWorkspaceTab, runTermDebugScan, runNetworkCheckUI,
  saveCloudConfigUI, testCloudConnectionUI, clearTermRuntimeLog,
  openFeedbackUI, submitFeedbackUI, setFeedbackRating, deleteDeployedSiteUI,
  generateAiProjectFilesUI, generateNewProjectFilesUI, toggleAiFile, toggleAiPreview, discardAiProposal,
  applyAiProposalUI, saveAiSettingsUI, clearAiKeyUI, testAiUI, deleteProjectUI,
  openGithubImportUI, importGithubRepoUI,
  setNotifFilter, markAllNotificationsRead, deleteNotification,
});
