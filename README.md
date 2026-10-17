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
