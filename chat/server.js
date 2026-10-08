require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const admin = require('firebase-admin');

const {
  DATABASE_URL,
  JWT_SECRET,
  ADMIN_PASSWORD,
  ALLOWED_ORIGIN, // e.g. https://hellold6.github.io
  DISCORD_BOT_TOKEN,
  DISCORD_OWNER_ID,
  SUPABASE_URL, // e.g. https://tcvhviwiadnynzluhmmv.supabase.co
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_STORAGE_BUCKET = 'chat-uploads',
  FIREBASE_SERVICE_ACCOUNT_BASE64, // base64 of the Firebase service account JSON (see README)
  PORT = 3000,
} = process.env;

if (!DATABASE_URL || !JWT_SECRET || !ADMIN_PASSWORD) {
  console.error('Missing required env vars. Check .env.example');
  process.exit(1);
}

const imagesEnabled = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
if (!imagesEnabled) {
  console.log('Image uploads not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — skipping.');
}

// ---------- Push notifications (Firebase Cloud Messaging) ----------

let pushEnabled = false;
if (FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const serviceAccount = JSON.parse(Buffer.from(FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    pushEnabled = true;
  } catch (err) {
    console.error('Failed to initialize Firebase Admin (check FIREBASE_SERVICE_ACCOUNT_BASE64):', err.message);
  }
} else {
  console.log('Push notifications not configured (FIREBASE_SERVICE_ACCOUNT_BASE64 missing) — skipping.');
}

async function sendPushNotification(userId, payload) {
  if (!pushEnabled) return;
  const result = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
  const fcmToken = result.rows[0]?.fcm_token;
  if (!fcmToken) return;

  const body = payload.type === 'image' ? '📷 Sent an image' : payload.type === 'video' ? '🎥 Sent a video' : payload.content;

  try {
    // Data-only (no top-level "notification" field) so the app always builds
    // and displays the notification itself — consistent behavior whether the
    // app is foregrounded, backgrounded, or not running.
    await admin.messaging().send({
      token: fcmToken,
      data: { type: 'chat-message', title: 'Willow', body: body.slice(0, 150) },
      android: { priority: 'high' },
    });
  } catch (err) {
    // A token that's invalid/expired/uninstalled comes back as one of these —
    // clear it so we stop trying to push to a dead device.
    if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
      await pool.query('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]);
    } else {
      console.error('Push notification failed:', err.message);
    }
  }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // needed for Supabase/Render-style managed Postgres
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      fcm_token TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender TEXT NOT NULL CHECK (sender IN ('user','admin')),
      type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','image','video')),
      content TEXT NOT NULL,
      link_preview JSONB,
      reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'text';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview JSONB;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL;

    -- Widen the type check to allow 'video' for servers that were already
    -- running before video support was added (Postgres auto-names an inline
    -- column CHECK as <table>_<column>_check, which is what we target here).
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
    ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('text','image','video'));
  `);
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '35mb' })); // base64-encoded video is the biggest payload we accept

// ---------- Auth helpers ----------

function signUserToken(user) {
  return jwt.sign({ role: 'user', id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function signAdminToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
}
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ---------- REST: user auth ----------

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and a password (6+ chars) are required' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), hash]
    );
    const user = result.rows[0];
    res.json({ token: signUserToken(user), username: user.username });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ token: signUserToken(user), username: user.username });
});

app.get('/api/messages', authMiddleware, async (req, res) => {
  if (req.auth.role !== 'user') return res.status(403).json({ error: 'User only' });
  const result = await pool.query(
    'SELECT id, sender, type, content, link_preview, reply_to, created_at FROM messages WHERE user_id = $1 ORDER BY created_at ASC',
    [req.auth.id]
  );
  res.json(result.rows);
});

app.post('/api/push/register', authMiddleware, async (req, res) => {
  if (req.auth.role !== 'user') return res.status(403).json({ error: 'User only' });
  const { fcmToken } = req.body || {};
  if (!fcmToken || typeof fcmToken !== 'string') return res.status(400).json({ error: 'Missing fcmToken' });
  await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcmToken, req.auth.id]);
  res.json({ ok: true });
});

// ---------- REST: admin (you) ----------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: signAdminToken() });
});

app.get('/api/admin/conversations', authMiddleware, requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT u.id, u.username,
           (SELECT content FROM messages m WHERE m.user_id = u.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
           (SELECT type FROM messages m WHERE m.user_id = u.id ORDER BY m.created_at DESC LIMIT 1) AS last_type,
           (SELECT created_at FROM messages m WHERE m.user_id = u.id ORDER BY m.created_at DESC LIMIT 1) AS last_at
    FROM users u
    ORDER BY last_at DESC NULLS LAST
  `);
  res.json(result.rows);
});

app.get('/api/admin/messages/:userId', authMiddleware, requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT id, sender, type, content, link_preview, reply_to, created_at FROM messages WHERE user_id = $1 ORDER BY created_at ASC',
    [req.params.userId]
  );
  res.json(result.rows);
});

// ---------- REST: media upload (images + videos; both visitors and admin use this) ----------

const ALLOWED_IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'jpg',
  'image/heif': 'jpg',
  'image/avif': 'jpg',
  'image/bmp': 'jpg'
};
const ALLOWED_VIDEO_TYPES = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/x-m4v': 'm4v'
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25MB — client compresses before this, so this is a ceiling, not a target

app.post('/api/upload', authMiddleware, async (req, res) => {
  if (!imagesEnabled) return res.status(503).json({ error: 'Uploads are not configured on this server' });
  const { data, mimeType } = req.body || {};
  if (!data || !mimeType) return res.status(400).json({ error: 'Missing file data' });

  const normalizedMimeType = String(mimeType).split(';')[0].trim().toLowerCase();
  let ext, maxBytes, folder;
  if (ALLOWED_IMAGE_TYPES[normalizedMimeType]) {
    ext = ALLOWED_IMAGE_TYPES[normalizedMimeType]; maxBytes = MAX_IMAGE_BYTES; folder = 'images';
  } else if (ALLOWED_VIDEO_TYPES[normalizedMimeType]) {
    ext = ALLOWED_VIDEO_TYPES[normalizedMimeType]; maxBytes = MAX_VIDEO_BYTES; folder = 'videos';
  } else {
    return res.status(400).json({ error: 'Unsupported file type' });
  }

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length <= 0) {
    return res.status(400).json({ error: 'File is empty or unreadable' });
  }
  if (buffer.length > maxBytes) {
    return res.status(413).json({ error: `File must be under ${Math.round(maxBytes / 1024 / 1024)}MB` });
  }

  const path = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  try {
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': normalizedMimeType,
      },
      body: buffer,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      console.error('Supabase upload failed:', uploadRes.status, text);
      return res.status(502).json({ error: 'Upload failed' });
    }
    const url = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${path}`;
    res.json({ url });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/', (_req, res) => res.send('Chat backend is running.'));

// ---------- Socket.IO real-time layer ----------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGIN || '*' } });

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

// ---------- Link previews ----------

function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : null;
}

function extractMetaTag(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

async function generateLinkPreview(text) {
  const url = extractFirstUrl(text);
  if (!url) return null;
  // Instagram serves a login page to server-side fetches, so a preview card would just say
  // "Instagram". The chat page embeds reels itself instead.
  try { if (/(^|\.)instagram\.com$/i.test(new URL(url).hostname)) return null; } catch { return null; }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChatLinkPreview/1.0)' },
    });
    const html = await res.text();
    const title = extractMetaTag(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || url;
    const description = extractMetaTag(html, 'og:description') || extractMetaTag(html, 'description');
    let image = extractMetaTag(html, 'og:image');
    if (image && !image.startsWith('http')) {
      image = new URL(image, url).toString();
    }
    const siteName = extractMetaTag(html, 'og:site_name') || new URL(url).hostname;
    return { url, title: title?.trim().slice(0, 200) || url, description: description?.trim().slice(0, 300) || null, image: image || null, siteName };
  } catch (err) {
    console.log(`Link preview skipped for ${url}: ${err.message}`);
    return null;
  }
}

// Discord messages we should enrich once a link preview resolves.
const pendingDiscordPreviewEdits = new Map(); // db message id -> discord Message

async function attachLinkPreview(messageId, content, rooms) {
  const preview = await generateLinkPreview(content);
  if (!preview) return;
  await pool.query('UPDATE messages SET link_preview = $1 WHERE id = $2', [preview, messageId]);
  rooms.forEach((room) => io.to(room).emit('message-preview', { id: messageId, link_preview: preview }));

  const discordMsg = pendingDiscordPreviewEdits.get(messageId);
  if (discordMsg) {
    pendingDiscordPreviewEdits.delete(messageId);
    try {
      const embed = EmbedBuilder.from(discordMsg.embeds[0]);
      if (preview.image) embed.setImage(preview.image);
      if (preview.title) embed.addFields({ name: preview.siteName || 'Link', value: preview.title.slice(0, 200) });
      await discordMsg.edit({ embeds: [embed] });
    } catch (err) {
      console.error('Failed to enrich Discord message with preview:', err.message);
    }
  }
}

// Shared paths so the admin dashboard, the Discord bot, and the REST upload
// endpoint all go through the same insert + broadcast logic.

let lastActiveConversation = null; // { userId, username } — whoever messaged most recently

async function deliverUserMessage(userId, username, content, type = 'text', replyTo = null) {
  const trimmed = content.trim().slice(0, 4000);
  const result = await pool.query(
    'INSERT INTO messages (user_id, sender, type, content, reply_to) VALUES ($1, $2, $3, $4, $5) RETURNING id, content, type, reply_to, created_at',
    [userId, 'user', type, trimmed, replyTo]
  );
  const payload = { sender: 'user', ...result.rows[0] };
  lastActiveConversation = { userId, username };
  io.to(`user-${userId}`).emit('message', payload);
  io.to('admin-room').emit('new-message', { userId, username, ...payload });
  notifyDiscordNewMessage(userId, username, payload).catch((err) => console.error('Discord notify failed:', err));
  if (type === 'text') {
    attachLinkPreview(payload.id, trimmed, [`user-${userId}`, 'admin-room']).catch((err) => console.error(err));
  }
  return payload;
}

async function deliverAdminReply(userId, content, type = 'text', replyTo = null) {
  const trimmed = content.trim().slice(0, 4000);
  const result = await pool.query(
    'INSERT INTO messages (user_id, sender, type, content, reply_to) VALUES ($1, $2, $3, $4, $5) RETURNING id, content, type, reply_to, created_at',
    [userId, 'admin', type, trimmed, replyTo]
  );
  const payload = { sender: 'admin', ...result.rows[0] };
  io.to(`user-${userId}`).emit('message', payload);
  if (type === 'text') {
    attachLinkPreview(payload.id, trimmed, [`user-${userId}`]).catch((err) => console.error(err));
  }
  sendPushNotification(userId, payload).catch((err) => console.error('Push notification failed:', err));
  return payload;
}

io.on('connection', (socket) => {
  const { role } = socket.auth;

  const normalizeType = (type) => (type === 'image' || type === 'video' ? type : 'text');

  if (role === 'user') {
    socket.join(`user-${socket.auth.id}`);

    socket.on('message', async ({ content, type, replyTo }) => {
      if (!content || typeof content !== 'string' || !content.trim()) return;
      const msgType = normalizeType(type);
      if (msgType !== 'text' && !imagesEnabled) return;
      await deliverUserMessage(socket.auth.id, socket.auth.username, content, msgType, replyTo || null);
    });
  }

  if (role === 'admin') {
    socket.join('admin-room');

    socket.on('message', async ({ userId, content, type, replyTo }) => {
      if (!userId || !content || !content.trim()) return;
      const msgType = normalizeType(type);
      if (msgType !== 'text' && !imagesEnabled) return;
      const payload = await deliverAdminReply(userId, content, msgType, replyTo || null);
      socket.emit('message-sent', { userId, ...payload });
    });
  }
});

// ---------- Discord bot: DM notifications + two-way replies ----------

let discordReady = false;
const dmMessageToUserId = new Map(); // Discord DM message id -> chat user id

let discordClient = null;

if (DISCORD_BOT_TOKEN && DISCORD_OWNER_ID) {
  discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });

  discordClient.once('ready', () => {
    discordReady = true;
    console.log(`Discord bot logged in as ${discordClient.user.tag}`);
  });

  discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.author.id !== DISCORD_OWNER_ID) return;
    if (message.guild) return; // only act on DMs to the bot

    try {
      let targetUserId = null;
      let targetUsername = null;

      const repliedToId = message.reference?.messageId;
      if (repliedToId && dmMessageToUserId.has(repliedToId)) {
        targetUserId = dmMessageToUserId.get(repliedToId);
      }

      let text = message.content;
      if (!targetUserId) {
        const match = message.content.match(/^reply\s+(\S+)\s*([\s\S]*)$/i);
        if (match) {
          const [, username, rest] = match;
          const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
          if (!result.rows[0]) {
            await message.reply(`Couldn't find a user called "${username}".`);
            return;
          }
          targetUserId = result.rows[0].id;
          text = rest;
        }
      }

      // Fall back to whoever messaged most recently, so a plain reply with no
      // quote and no command still goes somewhere sensible.
      if (!targetUserId && lastActiveConversation) {
        targetUserId = lastActiveConversation.userId;
        targetUsername = lastActiveConversation.username;
      }

      if (!targetUserId) {
        await message.reply(
          "No conversations yet. Once someone messages you, plain replies will go to them automatically — or use: `reply <username> <message>`"
        );
        return;
      }

      if (text && text.trim()) {
        await deliverAdminReply(targetUserId, text.trim(), 'text');
      }
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('image/')) {
          await deliverAdminReply(targetUserId, attachment.url, 'image');
        } else if (attachment.contentType?.startsWith('video/')) {
          await deliverAdminReply(targetUserId, attachment.url, 'video');
        }
      }
      await message.react(targetUsername ? '👉' : '✅');
    } catch (err) {
      console.error('Discord reply handling failed:', err);
      message.reply('Something went wrong sending that.').catch(() => {});
    }
  });

  discordClient.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error('Discord login failed:', err);
  });
} else {
  console.log('Discord bot not configured (DISCORD_BOT_TOKEN / DISCORD_OWNER_ID missing) — skipping.');
}

async function notifyDiscordNewMessage(userId, username, payload) {
  if (!discordReady) return;
  const owner = await discordClient.users.fetch(DISCORD_OWNER_ID);

  let sent;
  if (payload.type === 'video') {
    // Discord embeds can't play video, but a plain message with a direct link
    // gets Discord's own native video player via link unfurling.
    sent = await owner.send({
      content: `**${username}** sent a video:\n${payload.content}\n-# Reply to this message, or use: reply ${username} <message>`,
    });
  } else {
    const embed = new EmbedBuilder()
      .setAuthor({ name: username })
      .setFooter({ text: `Reply to this message, or use: reply ${username} <message>` })
      .setColor(0x6c5ce7)
      .setTimestamp();

    if (payload.type === 'image') {
      embed.setImage(payload.content);
    } else {
      embed.setDescription(payload.content);
    }
    sent = await owner.send({ embeds: [embed] });
  }

  dmMessageToUserId.set(sent.id, userId);
  if (payload.type === 'text' && extractFirstUrl(payload.content)) {
    pendingDiscordPreviewEdits.set(payload.id, sent);
  }
}

migrate()
  .then(() => {
    server.listen(PORT, () => console.log(`Chat backend listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
