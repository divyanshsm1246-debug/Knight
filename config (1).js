/* ============================================================================
   KNIGHT — site-wide cloud configuration
   ----------------------------------------------------------------------------
   Deploy this file next to index.html. Every visitor to your site loads it,
   so everyone gets real multiplayer automatically — nobody has to open
   Settings and paste anything. (Settings > Cloud Connection still works and
   overrides these values for that one browser, which is handy for testing a
   different backend without redeploying.)

   Fill in only what you actually have. Leave a value as "" and that feature
   simply stays in local/offline mode.

   ABOUT THE ABLY KEY
   -------------------
   Anything in this file is public: every visitor can read it in their
   browser. Ably supports that for client-side apps, but the key you put here
   should be capability-restricted in the Ably dashboard (Settings > API Keys
   > your key > Capabilities): allow only  publish, subscribe, presence  on
   the channel pattern  knight:*  and nothing else (no channel-metadata, no
   push-admin, no statistics). Then the worst a leaked key can do is chat
   in your own channels. Never put an unrestricted root key here.
============================================================================ */

window.KNIGHT_CONFIG = {
  // Your deployed Java backend, e.g. "https://knight-backend.onrender.com"
  apiBase: "",

  // Optional self-hosted WebSocket relay (websocket-server.js). Not needed if
  // you use Ably below.
  wsBase: "",
  wsServerKey: "",

  // Ably: "appId.keyId:secret". Capability-restricted, see the note above.
  ablyKey: "",
};
