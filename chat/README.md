# Live chat for your GitHub Pages site

Three pieces:
- **`server.js`** — the backend (Express + Socket.IO + Postgres). Deploys to Render.
- **`public/chat.html`** — the visitor-facing page. Goes into your `hellold6.github.io` repo.
- **`public/admin.html`** — your private dashboard to see and reply to everyone. Also goes into your GitHub Pages repo (or just open it locally — see note below).

## 1. Set up the database (PostgreSQL)

Keep your existing PostgreSQL database and `DATABASE_URL`. This migration changes media storage only; user accounts and chat messages remain in PostgreSQL.

## 2. Set up Cloudflare R2 for new uploads

1. In Cloudflare Dashboard, open **R2 Object Storage** and create a bucket (for example, `chat-uploads`).
2. Create an R2 API token with object read/write permission for that bucket. Copy its Access Key ID and Secret Access Key; the secret is only shown once.
3. In the bucket settings, enable public access only if you intend chat media URLs to be publicly readable. Prefer connecting a dedicated custom domain such as `media.example.com`; do not expose your R2 credentials in the browser.
4. Set `R2_PUBLIC_BASE_URL` to the public bucket domain or custom media domain, without a trailing slash. It must serve objects at paths such as `/images/<filename>` and `/videos/<filename>`.
5. Add these environment variables to the backend service (Render):
   - `R2_ACCOUNT_ID` — Cloudflare account ID
   - `R2_ACCESS_KEY_ID` — R2 API token access key ID
   - `R2_SECRET_ACCESS_KEY` — R2 API token secret
   - `R2_BUCKET_NAME` — bucket name, e.g. `chat-uploads`
   - `R2_PUBLIC_BASE_URL` — public base URL for reading uploaded objects

New uploads will go to R2. Existing messages and their Supabase media URLs are not changed, and existing objects are not copied or deleted. Keep the old Supabase bucket available while old messages still reference it.

## 3. Set up the database (existing Supabase PostgreSQL)

1. Go to supabase.com → New project.
2. Once it's created, go to **Project Settings → Database → Connection string → URI**. Copy it — this is your `DATABASE_URL`. Use the "Session pooler" connection string, not "Transaction pooler" (Socket.IO needs a stable connection).
3. The `users` and `messages` tables are created automatically the first time the server starts — no manual SQL needed.

## 4. Deploy the backend (Render, free)

1. Push the `chat-backend` folder to its own GitHub repo (private is fine).
2. On render.com → New → Web Service → connect that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under Environment, add these variables (see `.env.example`):
   - `DATABASE_URL` — from Supabase, step 1
   - `JWT_SECRET` — run `openssl rand -hex 32` locally, or any long random string
   - `ADMIN_PASSWORD` — the password you'll use to log into `admin.html`
   - `ALLOWED_ORIGIN` — `https://hellold6.github.io`
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` — base64-encoded Firebase service account JSON; required for Android push notifications
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` — required for new media uploads to Cloudflare R2
5. Deploy. Render gives you a URL like `https://your-app.onrender.com` — that's your backend URL.

Note: Render's free tier spins the server down after 15 minutes of inactivity, so the first message after a quiet period takes ~30 seconds to wake up. Fine for a personal site; upgrade to a paid instance later if that ever bugs you.

## 5. Wire up the frontend

1. In both `chat.html` and `admin.html`, replace:
   ```js
   const API_BASE = "https://YOUR-BACKEND-URL.onrender.com";
   ```
   with your actual Render URL.
2. Copy `chat.html` into your `hellold6.github.io` repo (e.g. as `/chat.html` or `/chat/index.html`), and link to it from your site.
3. Copy `admin.html` in too, but **don't link to it from anywhere** — it's not secret by URL alone (anyone who finds it still needs your `ADMIN_PASSWORD` to do anything), but there's no reason to advertise it. Bookmark the direct URL for yourself.

## How it works

- A visitor opens `chat.html`, registers a username + password (hashed with bcrypt, never stored in plain text), and lands in their own private thread.
- You open `admin.html`, log in with `ADMIN_PASSWORD`, see every conversation in a sidebar, click one, and reply — it shows up live in their chat.
- Everything is saved to Postgres permanently, so history survives refreshes, restarts, and redeploys.
- For Android push notifications to reach your phone while the app is closed, the Android app must load `admin.html` and call `window.registerFcmToken(fcmToken)` with its current FCM token. The authenticated admin page registers the token with the backend; user messages are then sent to that device through Firebase Cloud Messaging.
- Add recent game updates to `changelog.txt` beside the deployed `chat.html` (or keep it at `/chat/changelog.txt`). The notice appears once per browser for each distinct version of the file; changing the text makes it appear again.

## Extending it later

- Add rate limiting (e.g. `express-rate-limit`) on `/api/register` and `/api/login` if you're worried about abuse.
- Add a "typing…" indicator via a Socket.IO event.
- Add browser push/email notifications for you when a new message comes in while you're away.
