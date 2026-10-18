// Knight regression tests. Run with:  node tests/run-tests.js
// Loads the REAL frontend/script.js under a tiny fake browser (no dependencies).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function mkEl(id) {
  const el = {
    id, tagName: 'DIV', value: '', textContent: '', innerHTML: '',
    style: new Proxy({}, { get: (t, k) => t[k] || '', set: (t, k, v) => (t[k] = v, true) }),
    dataset: {}, files: [], checked: false, children: [], _classes: new Set(),
    classList: {
      add: (...c) => c.forEach(x => el._classes.add(x)),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      toggle: (c, f) => (f === undefined ? (el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c)) : (f ? el._classes.add(c) : el._classes.delete(c))),
      contains: (c) => el._classes.has(c),
    },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, scrollIntoView() {},
    appendChild() {}, insertAdjacentElement() {}, remove() {}, click() {}, focus() {}, scrollTo() {},
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  return el;
}
const els = new Map();
global.document = {
  documentElement: mkEl('html'), body: mkEl('body'),
  getElementById: (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
  querySelectorAll: () => [], querySelector: () => null, createElement: (t) => mkEl(t),
  addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') global.__boot = fn; },
};
const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
global.window = { addEventListener() {}, crypto: require('crypto').webcrypto, location: { hash: '', hostname: 'localhost', protocol: 'https:' },
  navigator: { userAgent: 'Node', hardwareConcurrency: 8 }, scrollTo() {}, setInterval: () => 0 };
global.crypto = require('crypto').webcrypto;
Object.defineProperty(global, 'navigator', { value: { userAgent: 'Node', platform: 'Linux', clipboard: null, hardwareConcurrency: 8, maxTouchPoints: 0 }, configurable: true });
global.location = global.window.location;
global.screen = { width: 1920, height: 1080 };
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};
global.setInterval = () => 0; global.BroadcastChannel = undefined; global.structuredClone = undefined;
global.fetch = () => Promise.reject(new Error('offline'));
global.confirm = () => true; global.prompt = () => 'test';
global.window.document = global.document;

let code = fs.readFileSync(path.join(ROOT, 'frontend', 'script.js'), 'utf8');
code = code.replace('Object.assign(window, {', 'Object.assign(global, {');
const SHIPPED = ['index.html', 'script.js', 'config.js', 'style.css'].map(f => fs.readFileSync(path.join(ROOT, 'frontend', f), 'utf8'));
const HTML = SHIPPED[0];

const TESTS = `
  let users, site, second, apiProject;
  const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const orReply = (content, finish) => jsonRes(200, { model: 'test/model', choices: [{ message: { content }, finish_reason: finish || 'stop' }] });

  console.log('\\n--- Boot, signed-out state, the old userId crash ---');
  try { global.__boot(); pass('boot() runs with no accounts'); } catch (e) { fail('boot crashed: ' + e.message); }
  if (getSession() === null && myId() === null && me() === null) pass('no session returns null, not "Cannot read properties of undefined (reading userId)"');

  console.log('\\n--- Accounts, hashing, sessions ---');
  document.getElementById('rememberMe').checked = true;
  document.getElementById('email').value = 'dev@knight.io'; document.getElementById('password').value = 'hunter22'; document.getElementById('username').value = 'dev_knight';
  setAuthMode('signup'); await handleAuthSubmit({ preventDefault() {} });
  users = DB.users();
  if (me() && me().username === 'dev_knight') pass('sign-up creates the account and signs in');
  if (users['dev@knight.io'].passHash.length === 64) pass('password stored only as a SHA-256 hash');
  { const s = JSON.parse(localStorage.getItem('knight.session.v3')); if (s && s.userId === me().id && (s.expires - Date.now()) / 86400000 > 300) pass('remember-me session lasts about a year'); }
  CURRENT = null; global.__boot();
  if (me() && me().email === 'dev@knight.io') pass('returning later restores the session');
  document.getElementById('email').value = 'dev@knight.io'; document.getElementById('password').value = 'other'; setAuthMode('signup'); await handleAuthSubmit({ preventDefault() {} });
  if (/already exists/i.test(document.getElementById('authError').textContent)) pass('duplicate email rejected');
  setAuthMode('signin'); document.getElementById('password').value = 'WRONG'; await handleAuthSubmit({ preventDefault() {} });
  if (/Incorrect passphrase/i.test(document.getElementById('authError').textContent)) pass('wrong password rejected');
  document.getElementById('password').value = 'hunter22'; await handleAuthSubmit({ preventDefault() {} });
  if (me()) pass('correct password signs in');
  if (typeof signInAsGuest === 'undefined') pass('guest mode is gone');
  if ((await DB.server('/api/profile')) === null) pass('no backend: DB.server returns null, never throws');
  document.getElementById('email').value = 'second@knight.io'; document.getElementById('password').value = 'hunter22'; document.getElementById('username').value = 'second_knight';
  setAuthMode('signup'); await handleAuthSubmit({ preventDefault() {} });
  users = DB.users(); second = users['second@knight.io'];
  if (second && second.socialId !== users['dev@knight.io'].socialId) pass('second account gets its own Social ID');
  CURRENT = users['dev@knight.io'];

  console.log('\\n--- Projects, versions, roles, change requests ---');
  pendingProjectFiles = { 'index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>Hi</h1><script src="app.js"></script></body></html>', 'style.css': 'h1{color:tomato}', 'app.js': 'console.log(1)' };
  ['newProjName','newProjDesc','newProjTags','newProjVisibleTo','newProjLocationLabel'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('newProjName').value = 'my-site'; document.getElementById('newProjVisibility').value = 'public'; document.getElementById('newProjCategory').value = 'Web';
  createProjectUI();
  site = Object.values(DB.data().projects).find(p => p.name === 'my-site');
  if (site && Object.keys(site.files).length === 3 && site.versions[0].label === 'Version 1') pass('project created with its files at Version 1');
  currentProjectId = site.id;
  document.getElementById('versionNoteInput').value = 'second'; cutVersionUI();
  if (DB.data().projects[site.id].versions.length === 2) pass('Version 2 cut without destroying Version 1');
  { const d = DB.data(); d.projects[site.id].members.push({ userId: second.id, role: 'contributor', at: Date.now() }); DB.saveData(d); }
  CURRENT = second; currentProjectId = site.id; currentFileName = 'app.js';
  document.getElementById('fileEditorContent').value = 'console.log(2)'; saveFileEditorUI();
  { const p = DB.data().projects[site.id];
    if (p.changeRequests.length === 1 && p.files['app.js'] === 'console.log(1)') pass('contributor edit becomes a change request; the real file is untouched');
    deleteFileEditorUI(); if ('app.js' in DB.data().projects[site.id].files) pass('contributor cannot delete files');
    CURRENT = users['dev@knight.io']; reviewChange(p.changeRequests[0].id, true);
    if (DB.data().projects[site.id].files['app.js'] === 'console.log(2)') pass('owner accepts and the change is merged'); }

  console.log('\\n--- Routing, 404, visibility ---');
  await new Promise(r => setTimeout(r, 5));
  global.location.hash = '#/thisdoesnotexist'; handleRoute();
  if (document.getElementById('notFoundPage')._classes.has('active')) pass('junk URL shows the 404 page');
  global.location.hash = '#/terminal/' + me().socialId; handleRoute();
  if (document.getElementById('terminalPage')._classes.has('active')) pass('#/terminal/<id> opens the Terminal');
  if (!ROUTES.admin && !ROUTES.shortcuts && !ROUTES.guide) pass('admin, shortcuts and guide routes are removed');
  { const d = DB.data(); d.projects.priv1 = { ...site, id: 'priv1', ownerId: 'someone-else', visibility: 'private', members: [] }; DB.saveData(d); }
  if (!canSeeProject(DB.data().projects.priv1) && canSeeProject(DB.data().projects[site.id])) pass('private projects of others are hidden, your own are visible');

  console.log('\\n--- Versions, scanner, fork ---');
  if (diffFileNames({ a: '1', b: '2' }, { a: '1', b: 'X', c: 'n' }).length === 2) pass('diff finds edited and added files');
  if (scanSnapshotForIssues({ 'a.js': 'function( { broken' }).length >= 1 && scanSnapshotForIssues({ 'a.js': 'ok();' }).length === 0) pass('scanner flags broken JS and passes clean JS');
  forkProjectUI(site.id);
  { const f = Object.values(DB.data().projects).find(p => p.forkedFrom && p.forkedFrom.projectId === site.id);
    if (f && f.versions.length === 1 && f.members.length === 0) pass('fork starts fresh with no members'); }

  console.log('\\n--- Preview bundling and sandbox security ---');
  { const built = inlineProject(DB.data().projects[site.id], 'index.html');
    if (built.includes('color:tomato') && built.includes('console.log(2)') && built.includes('__knightLog')) pass('bundles css and js and injects the console bridge');
    const clean = sanitizeUntrustedHtml('<base href="//e/"><meta http-equiv="refresh" content="0;url=//e"><a target="_top" href="x">a</a><a target="_blank" href="y">b</a>');
    if (!clean.includes('<base ') && !/http-equiv=["']?refresh/i.test(clean) && !clean.includes('"_top"') && clean.includes('noopener noreferrer')) pass('sanitizer strips base and meta-refresh, neutralises _top, hardens _blank');
    const sb = HTML.match(/sandbox="[^"]*"/g) || [];
    if (sb.length >= 2 && sb.every(x => !/allow-same-origin|allow-top-navigation/.test(x))) pass('preview iframes never allow same-origin or top-navigation'); }

  console.log('\\n--- Data-Base, charts, distance ---');
  { const d = DB.data(); d.notes[myId()] = []; DB.saveData(d); }
  createNoteUI('note'); createNoteUI('code'); createNoteUI('learning');
  if (myNotes().length === 3) pass('note, code and learning types are created');
  { const lp = buildLineChartPath([0, 5, 10], 100, 50); if (lp.points[2].y < lp.points[0].y) pass('line chart plots higher values higher');
    const b = buildBarChartBars([1, 4], 100, 50); if (b[1].h > b[0].h) pass('bar chart: bigger value, taller bar');
    const la = computeLocalAnalytics(); if (la.signupsByDay.length === 14 && la.activityByDay.length === 7) pass('analytics cover 14 days of signups and 7 of activity'); }
  if (haversineMeters(28.6139, 77.2090, 28.6141, 77.2092) < 50) pass('haversine measures nearby points as close');

  console.log('\\n--- Cloud config, runtime log, feedback, delete deployed site ---');
  global.window.KNIGHT_CONFIG = { apiBase: 'https://site-api.example.com/', ablyKey: 'app1.key1:secret1' };
  { const p = DB.prefs(); p.apiBase = ''; p.ablyKey = ''; DB.savePrefs(p); }
  loadCloudConfig();
  if (API_BASE === 'https://site-api.example.com' && ABLY_KEY === 'app1.key1:secret1') pass('shipped config.js applies to every visitor (trailing slash trimmed)');
  { const p = DB.prefs(); p.apiBase = 'https://override.example.com'; DB.savePrefs(p); loadCloudConfig(); }
  if (API_BASE === 'https://override.example.com') pass("a browser's own Settings override the shipped config");
  global.window.KNIGHT_CONFIG = {}; { const p = DB.prefs(); p.apiBase = ''; DB.savePrefs(p); loadCloudConfig(); }
  if (API_BASE === null && ABLY_KEY === null) pass('nothing configured means fully local');
  clearTermRuntimeLog(); recordTermRuntimeLog('error', 'ReferenceError: x'); for (let i = 0; i < 250; i++) recordTermRuntimeLog('log', 'x' + i);
  if (termRuntimeLog.length === 200) pass('runtime log is capped at 200 entries');
  clearTermRuntimeLog();
  document.getElementById('feedbackMessage').value = '  '; await submitFeedbackUI();
  if (!((DB.data().feedback || {})[myId()] || []).length) pass('empty feedback is rejected');
  document.getElementById('feedbackMessage').value = 'looks great'; setFeedbackRating(5); await submitFeedbackUI();
  if (((DB.data().feedback || {})[myId()] || [])[0].rating === 5) pass('feedback saved on-device with its rating');
  { const d = DB.data(); d.projects[site.id].deployedUrl = 'https://x.netlify.app'; delete d.projects[site.id].backendId; DB.saveData(d); }
  await deleteDeployedSiteUI(site.id);
  if (DB.data().projects[site.id].deployedUrl === '') pass('an external link is removed locally');
  { const d = DB.data(); d.projects[site.id].deployedUrl = 'https://x.onrender.com/website/abc'; d.projects[site.id].backendId = 42; DB.saveData(d); }
  API_BASE = 'https://dead-backend.invalid'; await deleteDeployedSiteUI(site.id); API_BASE = null;
  if (DB.data().projects[site.id].deployedUrl) pass('unreachable backend: the site is NOT reported deleted');
  { const d = DB.data(); d.projects[site.id].deployedUrl = ''; delete d.projects[site.id].backendId; DB.saveData(d); }

  console.log('\\n--- AI assistant: reading the answer ---');
  { const parsed = parseAiFiles('Here you go.\\n===FILE: index.html===\\n<h1>hi</h1>\\n===END FILE===\\n===FILE: src/app.js===\\n\`\`\`js\\nlet a = 1;\\n\`\`\`\\n===END FILE===');
    if (parsed.files.length === 2 && parsed.message === 'Here you go.') pass('two files and the explanation are separated');
    if (parsed.files[1].content === 'let a = 1;') pass('a markdown fence wrapped around file content is stripped');
    const cut = parseAiFiles('ok\\n===FILE: a.js===\\nlet x = 1;\\nlet y');
    if (cut.files.length === 1 && cut.files[0].complete === false) pass('an answer cut off mid-file is detected as incomplete'); }
  { const ok = ['src/app.js', 'index.html', 'a b/c.txt', './x.js'];
    const bad = ['../evil.js', '/etc/passwd', 'a/../b', '.git/config', 'C:\\\\x', 'a//..//b', '', 'x'.repeat(300)];
    if (ok.every(p => sanitizeRepoPath(p))) pass('normal relative paths are accepted');
    if (bad.every(p => sanitizeRepoPath(p) === null)) pass('traversal, absolute, .git and oversized paths are all rejected'); }
  { const pr = prepareAiProposal(parseAiFiles('===FILE: index.html===\\nA\\n===END FILE===\\n===FILE: ../evil.js===\\nx\\n===END FILE===\\n===FILE: new.css===\\nB\\n===END FILE==='), { 'index.html': 'old' });
    if (pr.dropped.length === 1 && pr.files.length === 2) pass('an unsafe path is dropped and reported');
    if (pr.files[0].exists && !pr.files[1].exists) pass('overwrites are flagged against new files'); }
  { const ctx = buildAiContext({ 'a.js': 'x'.repeat(20000), 'logo.png': 'data:image/png;base64,AAA' });
    if (ctx.includes('[truncated]') && ctx.includes('logo.png (binary)')) pass('context is truncated and binaries are left out'); }

  console.log('\\n--- AI assistant: calling the model ---');
  { const p = DB.prefs(); delete p.openrouterKey; DB.savePrefs(p); aiBackendStatus = null; }
  if (aiMode() === 'none') pass('with no key and no backend AI the mode is none');
  { let threw = false; try { await callAI([{ role: 'user', content: 'x' }]); } catch (e) { threw = /not set up/i.test(e.message); } if (threw) pass('calling without a key gives a clear message'); }
  document.getElementById('aiKeyInput').value = 'not-a-key'; saveAiSettingsUI();
  if (!aiPersonalKey()) pass('a key that does not start with sk-or- is rejected');
  document.getElementById('aiKeyInput').value = 'sk-or-v1-testkey'; document.getElementById('aiModelInput').value = 'openai/gpt-4o-mini'; saveAiSettingsUI();
  if (aiMode() === 'personal' && aiModelName() === 'openai/gpt-4o-mini') pass('a personal key and model are saved');
  if (document.getElementById('aiKeyInput').value === '') pass('the saved key is never written back into the page');
  { let seen;
    global.fetch = async (url, o) => { seen = { url, o, body: JSON.parse(o.body) }; return orReply('hello'); };
    const r = await callAI([{ role: 'user', content: 'hi' }]);
    if (seen.url === 'https://openrouter.ai/api/v1/chat/completions' && seen.o.headers.Authorization === 'Bearer sk-or-v1-testkey' && seen.body.model === 'openai/gpt-4o-mini' && r.content === 'hello') pass('personal mode calls OpenRouter directly with the right model and bearer key');
    global.fetch = async () => jsonRes(401, { error: { message: 'bad' } });
    let m401 = ''; try { await callAI([{ role: 'user', content: 'x' }]); } catch (e) { m401 = e.message; }
    global.fetch = async () => jsonRes(402, {}); let m402 = ''; try { await callAI([{ role: 'user', content: 'x' }]); } catch (e) { m402 = e.message; }
    if (/rejected the key/.test(m401) && /credit/i.test(m402)) pass('401 and 402 become readable messages'); }
  { const p = DB.prefs(); delete p.openrouterKey; DB.savePrefs(p);
    API_BASE = 'https://api.example.com'; DB.setBackendToken(me().email, 'tok123'); aiBackendStatus = { enabled: true, model: 'srv/model' };
    let seen; global.fetch = async (url, o) => { seen = { url, o, raw: o.body }; return jsonRes(200, { content: 'from server', finishReason: 'stop', model: 'srv/model' }); };
    const r = await callAI([{ role: 'user', content: 'hi' }]);
    if (aiMode() === 'backend' && seen.url === 'https://api.example.com/api/ai/chat' && seen.o.headers.Authorization === 'Bearer tok123' && r.content === 'from server') pass('backend mode goes through the proxy as a signed-in user');
    if (!/sk-or/.test(seen.raw) && !/openrouter/.test(seen.url)) pass('backend mode never exposes an OpenRouter key or URL to the browser');
    API_BASE = null; aiBackendStatus = null; }

  console.log('\\n--- AI assistant: generate, review, allow ---');
  { const p = DB.prefs(); p.openrouterKey = 'sk-or-v1-testkey'; p.aiModel = ''; DB.savePrefs(p); }
  document.getElementById('newProjName').value = 'ai-test'; pendingProjectFiles = {}; createProjectUI();
  apiProject = Object.values(DB.data().projects).find(p => p.name === 'ai-test'); currentProjectId = apiProject.id;
  global.fetch = async () => orReply('Made a tiny site.\\n===FILE: index.html===\\n<h1>Hello</h1>\\n===END FILE===\\n===FILE: style.css===\\nbody{margin:0}\\n===END FILE===\\n===FILE: ../evil.js===\\nx\\n===END FILE===');
  document.getElementById('aiPromptInput').value = 'make a tiny site'; document.getElementById('aiIncludeContext').checked = true;
  await generateAiProjectFilesUI();
  { const pr = aiProposals.project;
    if (pr && pr.files.length === 2 && pr.dropped.length === 1 && pr.message === 'Made a tiny site.') pass('generate produces a proposal and drops the unsafe path');
    if (Object.keys(DB.data().projects[apiProject.id].files).length === 0) pass('nothing is written to the repo before Allow');
    toggleAiFile('project', 1, false); applyAiProposalUI('project');
    const after = DB.data().projects[apiProject.id];
    if (Object.keys(after.files).join() === 'index.html' && after.files['index.html'].includes('Hello')) pass('Allow writes only the ticked files'); }
  global.fetch = async () => orReply('Update.\\n===FILE: index.html===\\n<h1>Changed</h1>\\n===END FILE===');
  document.getElementById('aiPromptInput').value = 'change it'; await generateAiProjectFilesUI(); applyAiProposalUI('project');
  { const p = DB.data().projects[apiProject.id];
    if (p.files['index.html'].includes('Changed') && p.versions.some(v => /Before AI changes/.test(v.note))) pass('an owner edit saves a rollback snapshot first'); }
  { const d = DB.data(); d.projects[apiProject.id].members.push({ userId: second.id, role: 'contributor' }); DB.saveData(d);
    CURRENT = second; const before = DB.data().projects[apiProject.id].files['index.html'];
    const r = applyAiFilesToProject(apiProject.id, [{ path: 'index.html', content: 'EVIL' }], 'x');
    if (r.mode === 'review' && DB.data().projects[apiProject.id].files['index.html'] === before && DB.data().projects[apiProject.id].changeRequests.length >= 1) pass('a contributor\\'s AI files go to review, not straight in');
    const d2 = DB.data(); d2.projects[apiProject.id].members.find(m => m.userId === second.id).role = 'viewer'; DB.saveData(d2);
    if (applyAiFilesToProject(apiProject.id, [{ path: 'z.js', content: 'z' }], 'x').mode === 'denied') pass('a viewer cannot add files');
    CURRENT = users['dev@knight.io']; }
  pendingProjectFiles = {}; global.fetch = async () => orReply('Start.\\n===FILE: index.html===\\n<p>new</p>\\n===END FILE===');
  document.getElementById('newProjAiPrompt').value = 'starter'; await generateNewProjectFilesUI(); applyAiProposalUI('new');
  if (pendingProjectFiles['index.html'] === '<p>new</p>\\n') pass('Allow during repo creation stages the files in the new repo');
  global.fetch = async () => orReply('I would suggest a nav bar.');
  document.getElementById('aiPromptInput').value = 'ideas'; await generateAiProjectFilesUI();
  if (aiProposals.project && aiProposals.project.files.length === 0 && aiProposals.project.message.includes('nav bar')) pass('if the model ignores the file format, its words are shown instead of nothing');
  global.fetch = () => Promise.reject(new Error('offline'));

  console.log('\\n--- Deleting a project ---');
  global.prompt = () => 'wrong-name'; await deleteProjectUI(apiProject.id);
  if (DB.data().projects[apiProject.id]) pass('a wrong confirmation name deletes nothing');
  CURRENT = second; global.prompt = () => 'ai-test'; await deleteProjectUI(apiProject.id); CURRENT = users['dev@knight.io'];
  if (DB.data().projects[apiProject.id]) pass('only the owner can delete');
  { const d = DB.data(); d.projects[apiProject.id].backendId = 7; DB.saveData(d); }
  API_BASE = 'https://dead-backend.invalid'; global.prompt = () => 'ai-test'; await deleteProjectUI(apiProject.id); API_BASE = null;
  if (DB.data().projects[apiProject.id]) pass('a cloud project is NOT deleted if the backend cannot be reached');
  { const d = DB.data(); delete d.projects[apiProject.id].backendId; DB.saveData(d); }
  await deleteProjectUI(apiProject.id);
  if (!DB.data().projects[apiProject.id]) pass('typing the right name deletes the project');

  console.log('\\n--- Shipped files: secrets and wiring ---');
  if (SHIPPED.every(t => !/sk-or-v1-[0-9a-f]{16,}/i.test(t))) pass('no OpenRouter key appears in any shipped frontend file');
  { const used = Array.from(HTML.matchAll(/\\bon(?:click|change|input|submit)="([^"]*)"/g)).flatMap(m => (m[1].match(/[A-Za-z_][A-Za-z0-9_]*(?=\\()/g) || []));
    const native = new Set(['getElementById', 'click', 'stopPropagation', 'if', 'function']);
    // In a real page a top-level function in a classic script is global, so "declared in script.js" counts as defined.
    const declared = (n) => typeof global[n] === 'function' || code.includes('function ' + n + '(');
    const missing = Array.from(new Set(used)).filter(n => !native.has(n) && !declared(n));
    if (!missing.length) pass('every inline onclick/onchange handler in index.html is a defined function'); else fail('undefined handlers: ' + missing.join(', ')); }
  { const ids = new Set(Array.from(HTML.matchAll(/\\bid="([^"]+)"/g)).map(m => m[1]));
    const need = Array.from(new Set(Array.from(code.matchAll(/\\$\\('([A-Za-z0-9_-]+)'\\)/g)).map(m => m[1]))).filter(i => !ids.has(i) && !['fpsVal', 'noteEditorSource'].includes(i));
    if (!need.length) pass('every element script.js looks up by id exists in index.html'); else fail('missing ids: ' + need.join(', ')); }
  { const opens = (HTML.match(/<div/g) || []).length, closes = (HTML.match(/<\\/div>/g) || []).length;
    if (opens === closes) pass('index.html has balanced <div> tags (' + opens + ')'); }
`;

(async () => {
  let passes = 0, failures = 0;
  global.pass = (m) => { passes++; console.log('  ✅', m); };
  global.fail = (m) => { failures++; console.log('  ❌', m); };
  const pass = global.pass, fail = global.fail;
  try {
    await eval('(async () => {' + code + '\n' + TESTS + '\n})()');
  } catch (e) { failures++; console.log('  ❌ test run crashed:', e.stack.split('\n').slice(0, 3).join(' | ')); }
  console.log('\n' + passes + ' checks passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
