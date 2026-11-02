# Live chat for hellold.dev

The site is GitHub Pages. The chat pages live at `chat/chat.html` and `chat/admin.html`. The backend in this folder (Express + Socket.IO + Postgres) runs on Render.

The room is shared: accounts, profiles, replies, reactions, typing, and moderation. Private threads with Willow are unchanged: same `messages` table, same `/api/messages` routes, same `message` socket events, uploads, link previews, and the Discord relay. `schema-next.sql` only adds community tables. It does not update or delete DM rows.

## Database

`users` and `messages` are created on startup, same as before. `schema-next.sql` then creates the community tables with `CREATE TABLE IF NOT EXISTS` and adds a profile row per account. It does not write to `messages`.

Illustrative accounts (Mara and Jun) are inserted only when `NODE_ENV` is not `production` and `DATABASE_URL` points at localhost. Production does not seed them, and the chat page hides those login buttons unless the backend reports demo mode.

## Backend (Render)

1. Build command: `npm install`. Start command: `npm start`. Root directory: `chat`.
2. Environment:
   - `DATABASE_URL` — Postgres connection string (session pooler, not transaction pooler)
   - `JWT_SECRET` — long random string
   - `ADMIN_PASSWORD` — password for `admin.html`
   - `ALLOWED_ORIGIN` — `https://hellold.dev` (add `https://hellold6.github.io` too if you serve both)
   - `NODE_ENV` — `production` (Render sets this for Node services)
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` — optional; stores the Android app's FCM token via `window.registerFcmToken`
3. `CHAT_NEXT` is no longer read. Remove it if it is still set.
4. The service URL is `https://hellold6-github-io.onrender.com`. `chat.html` and `admin.html` use that URL when they are opened from hellold.dev, and the same origin when opened from localhost.

## Pages

- `https://hellold.dev/chat/chat.html` — the room, with a Willow tab for the private thread. `chat-next.html` redirects here.
- `https://hellold.dev/chat/admin.html` — room moderation and the direct-message inbox. It stays `noindex`. `admin-next.html` redirects here.

Do not link the admin page from the public site. The password is what protects it.
