/* ===========================================================================
   PUTER GUARD

   Puter's AI (puter.ai.chat) runs on puter.com's servers, not Knight's.
   Before any prompt leaves the browser for Puter, this file strips out
   anything that looks like a secret — API keys, tokens, passwords, database
   connection strings, private keys — so an accidental paste or a file that
   contains one doesn't get sent along with it.

   This does NOT touch the OpenRouter paths (your own key, or the site's
   backend key): those already go straight to OpenRouter over HTTPS and
   aren't routed through Puter at all, so there's nothing for this file to do
   there.

   Limits, honestly stated:
   - This is pattern matching, not understanding. It catches things SHAPED
     like common secrets. It will miss secrets in unusual formats, and it
     will occasionally redact something that only looks like one (a long
     hash used as an ID, for instance). When in doubt it redacts — a false
     positive just costs a few blanked-out characters, a false negative
     leaks a real secret, so this errs toward over-redacting.
   - It cannot stop Puter (or any third party you send prompts to) from
     retaining or logging whatever text IS sent. It only reduces what goes
     out in the first place. For anything truly sensitive, the right move
     is still "don't paste it into an AI chat," key rotation if it ever was
     pasted, and using a server-side key (OpenRouter via the backend) so the
     prompt never has a reason to carry a credential.
   - It runs client-side, so a determined user could disable it in devtools
     for their OWN session — it protects people from accidental leaks, not
     from someone deliberately bypassing their own browser's JS.

   Load this file AFTER the Puter <script> tag (order doesn't actually
   matter — it polls for `puter` to exist — but keeping them together makes
   the pairing obvious when someone reads index.html).
=========================================================================== */
(function () {
  'use strict';

  const REDACT = '[redacted by Knight before sending to Puter — looked like a';

  // Each pattern is deliberately broad for the reason explained above.
  const PATTERNS = [
    [/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]+?-----END [^-]+PRIVATE KEY-----/g, 'private key'],
    [/\bsk-or-v1-[a-zA-Z0-9]{16,}\b/g, 'OpenRouter key'],
    [/\bsk-[a-zA-Z0-9_-]{16,}\b/g, 'API key'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'GitHub token'],
    [/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'Google API key'],
    [/\bAKIA[0-9A-Z]{12,}\b/g, 'AWS access key'],
    [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, 'Slack token'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'JWT'],
    [/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s]+@[^\s"'`]+/gi, 'database connection string'],
    [/((?:api[_-]?key|secret|token|password|passwd|pwd|auth)\s*[:=]\s*)["']?[^\s"'`,;]{6,}/gi, 'key=value secret'],
    [/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, 'bearer token'],
    [/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{3,4}\b/g, 'card-like number'],
    [/\b\d{3}-\d{2}-\d{4}\b/g, 'SSN-like number'],
    // Generic long base64/hex blobs catch most remaining key formats, so
    // they run last and only against whatever the specific patterns above
    // left behind.
    [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, 'long token'],
    [/\b[0-9a-f]{32,}\b/gi, 'long hex token'],
  ];

  function sanitizeText(text) {
    if (typeof text !== 'string' || !text) return { text, hits: 0 };
    let hits = 0;
    let out = text;
    for (const [re, label] of PATTERNS) {
      out = out.replace(re, () => { hits++; return REDACT + ' ' + label + ']'; });
    }
    return { text: out, hits };
  }

  function sanitizeValue(v, acc) {
    if (typeof v === 'string') { const r = sanitizeText(v); acc.hits += r.hits; return r.text; }
    if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, acc));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = sanitizeValue(v[k], acc);
      return o;
    }
    return v;
  }

  /** Deep-clones `input` (a messages array or a plain string prompt) and redacts secrets in it.
      Returns { value, hits } — `value` is safe to send, `hits` is how many redactions were made. */
  function sanitize(input) {
    const acc = { hits: 0 };
    const value = sanitizeValue(input, acc);
    return { value, hits: acc.hits };
  }

  /** Wraps puter.ai.chat so every call — from anywhere in the app, now or added later — is
      sanitized automatically. Returns true once wrapped (idempotent; safe to call repeatedly). */
  function wrap() {
    if (typeof puter === 'undefined' || !puter.ai || typeof puter.ai.chat !== 'function') return false;
    if (puter.ai.chat.__knightGuarded) return true;
    const real = puter.ai.chat.bind(puter.ai);
    const guarded = function (promptOrMessages, options) {
      const { value, hits } = sanitize(promptOrMessages);
      if (hits && typeof toast === 'function') {
        toast('Removed ' + hits + ' item' + (hits === 1 ? '' : 's') + ' that looked like a secret before sending to Puter.');
      }
      return real(value, options);
    };
    guarded.__knightGuarded = true;
    puter.ai.chat = guarded;
    return true;
  }

  // puter.js loads asynchronously, so keep trying briefly until puter.ai.chat exists.
  if (!wrap()) {
    let tries = 0;
    const t = setInterval(() => { if (wrap() || ++tries > 100) clearInterval(t); }, 100); // gives up after ~10s
  }

  // Exposed for testing in the console, or for other code (e.g. a future
  // provider) that wants the same redaction before sending text elsewhere.
  window.PuterGuard = { sanitize };
})();
