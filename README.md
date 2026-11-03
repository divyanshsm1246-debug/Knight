# Knight — deploy guide

```
wrangler.jsonc     tells Cloudflare to publish ONLY ./frontend
render.yaml        Render blueprint for the Java backend
frontend/          the website (index.html, script.js, style.css, config.js, _headers)
backend/           Java Spring Boot API (Dockerfile + Maven)
websocket/         optional self-hosted WebSocket relay (not needed if you use Ably)
```

## 1. Database (free, keeps accounts forever)
Render's free disk is wiped whenever the service sleeps, so accounts need a real database.
Create a free project at **neon.tech**, copy the connection string
(`postgresql://user:password@host/dbname?sslmode=require`).

## 2. Backend on Render
New → Blueprint → pick this repo. When asked, set:
- `DATABASE_URL` = the Neon string from step 1
- `KNIGHT_ALLOWED_ORIGINS` = your Cloudflare site URL, e.g. `https://knight.yourname.workers.dev`

Open `https://<your-service>.onrender.com/api/health` — it should answer `{"status":"up",...}`
(the first request after idle takes 30-60 s while the free service wakes up).

## 3. Website on Cloudflare
Workers & Pages → Create → connect this repo. Leave the build command empty;
the deploy command is `npx wrangler deploy`. `wrangler.jsonc` does the rest.

## 4. Connect them
Edit `frontend/config.js`: set `apiBase` to your Render URL and `ablyKey` to your
capability-restricted Ably key, commit, and Cloudflare redeploys automatically.
Everyone who opens the site is now connected.

The first account created on a fresh database becomes the site owner.

## AI assistant (optional)
Open a project -> **AI** tab, or use the AI box when creating a repo. The AI proposes files, you
tick the ones you want and click **Allow**; only then do they enter the repo (owners/editors
write directly after a rollback snapshot; contributors' files go to review).
- Everyone on the site: set `OPENROUTER_API_KEY` in Render (optionally `OPENROUTER_MODEL`, `AI_HOURLY_LIMIT`).
  The key stays on the server; each user is limited per hour.
- Just you: paste your own OpenRouter key in Settings & Guides -> AI Assistant (saved only in your browser).
- Never put a key in `config.js` or any file in `frontend/`: every visitor can read those.

## Deleting
A project's owner can delete it from the project's Overview tab (type the name to confirm) or the
trash button on its card. If it is deployed on Knight Cloud, the live site is deleted with it.

## Tests
`node tests/run-tests.js` runs the app's logic checks (no install needed).

## New in this version
- `frontend/notes.html` and `frontend/arcade.html` are the Notes and Arcade apps. Knight shows them inside its own
  Notes and Arcade pages. `_headers` now allows this (`X-Frame-Options: SAMEORIGIN`). They load Tailwind from a CDN.
- **Multiplayer** runs inside the Java backend (`KnightWebSocket.java`): add `spring-boot-starter-websocket` to `pom.xml`
  (see `backend/pom-add-this.xml`). People find each other by Social ID through the backend, so every account must exist there.
- **Compiler**: Terminal runs 29 languages. JavaScript runs in the browser; the rest go through `POST /api/run`
  (`KnightRunner.java`) to a sandboxed Judge0 (`JUDGE0_URL`, default the public ce.judge0.com).
- **Error finder**: Terminal > "Find errors" and the Debug tab show the exact line of syntax problems.
- **Repo bar**: public/private, watch, pin, star, fork count, branches (create / switch / merge / delete) and tags.
- Copy `frontend/config.example.js` to `frontend/config.js` and set `apiBase`. Favicons are real files now.

## Knight App, accounts, compare (this version)
- **Knight App** (formerly Game Booster): `manifest.webmanifest` + `sw.js` make Knight installable. The installed app and the website
  share one inbox and talk to each other live. Notifications appear when Knight AI finishes or someone needs you. Real push while the
  app is fully closed would need Web Push keys on the backend (not included).
- **Account ID**: the browser's Account ID is now kept by the server (`socialId` + `idHash` sent at sign-up). Open any account with
  ID + password (`POST /api/auth/signin-id`), or with the offline key from Settings when the server is down. Redeploy the backend.
- **Compare** (Versions tab), **Issues**, **Pull requests**, **Insights**, **README** are in each project. The terminal has a live error watch.

## Business access
Login screen > **Business access**. The backend checks the code against `KNIGHT_ADMIN_CODE` (admin account) or `KNIGHT_DEMO_CODE`
(shared Prototype account, default `2345@1/Demo/prototype`). Set `KNIGHT_ADMIN_CODE` in the Render dashboard. It is not in any file.

## Hey Knight (Knight App > Hey Knight tab)
Say "Hey Knight, open the terminal / gaming mode / code mode / refresh / run my code / create project X", or type it. Simple commands are
understood instantly; anything else is interpreted by Knight AI into one of a fixed list of safe actions. The installed app sends website
jobs (open pages, run code, create projects) to the website window; if the website is closed the job waits and runs when you open it.
Voice needs Chrome or Edge with the window open (browsers stop the microphone in the background). Permissions are browser permissions only.
Modes: Balanced, Performance, Battery saver, Gaming, Code, Editing, Night, plus a one-tap Refresh clean-up.
