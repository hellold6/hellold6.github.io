# Live chat for your GitHub Pages site

Three pieces:
- **`server.js`** — the backend (Express + Socket.IO + Postgres). Deploys to Render.
- **`public/chat.html`** — the visitor-facing page. Goes into your `hellold6.github.io` repo.
- **`public/admin.html`** — your private dashboard to see and reply to everyone. Also goes into your GitHub Pages repo (or just open it locally — see note below).

## 1. Set up the database (Supabase, free)

1. Go to supabase.com → New project.
2. Once it's created, go to **Project Settings → Database → Connection string → URI**. Copy it — this is your `DATABASE_URL`. Use the "Session pooler" connection string, not "Transaction pooler" (Socket.IO needs a stable connection).
3. The `users` and `messages` tables are created automatically the first time the server starts — no manual SQL needed.

## 2. Deploy the backend (Render, free)

1. Push the `chat-backend` folder to its own GitHub repo (private is fine).
2. On render.com → New → Web Service → connect that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under Environment, add these variables (see `.env.example`):
   - `DATABASE_URL` — from Supabase, step 1
   - `JWT_SECRET` — run `openssl rand -hex 32` locally, or any long random string
   - `ADMIN_PASSWORD` — the password you'll use to log into `admin.html`
   - `ALLOWED_ORIGIN` — `https://hellold6.github.io`
5. Deploy. Render gives you a URL like `https://your-app.onrender.com` — that's your backend URL.

Note: Render's free tier spins the server down after 15 minutes of inactivity, so the first message after a quiet period takes ~30 seconds to wake up. Fine for a personal site; upgrade to a paid instance later if that ever bugs you.

## 3. Wire up the frontend

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
- Add recent game updates to `changelog.txt` beside `chat.html`. The chat displays the text once per browser for each distinct version of the file; changing the file makes the notice appear again.

## Extending it later

- Add rate limiting (e.g. `express-rate-limit`) on `/api/register` and `/api/login` if you're worried about abuse.
- Add a "typing…" indicator via a Socket.IO event.
- Add browser push/email notifications for you when a new message comes in while you're away.
