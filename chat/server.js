require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');

const {
  DATABASE_URL,
  JWT_SECRET,
  ADMIN_PASSWORD,
  ALLOWED_ORIGIN, // e.g. https://hellold6.github.io
  DISCORD_BOT_TOKEN,
  DISCORD_OWNER_ID,
  PORT = 3000,
} = process.env;

if (!DATABASE_URL || !JWT_SECRET || !ADMIN_PASSWORD) {
  console.error('Missing required env vars. Check .env.example');
  process.exit(1);
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
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender TEXT NOT NULL CHECK (sender IN ('user','admin')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
  `);
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));
app.use(express.json());

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
    'SELECT sender, content, created_at FROM messages WHERE user_id = $1 ORDER BY created_at ASC',
    [req.auth.id]
  );
  res.json(result.rows);
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
           (SELECT created_at FROM messages m WHERE m.user_id = u.id ORDER BY m.created_at DESC LIMIT 1) AS last_at
    FROM users u
    ORDER BY last_at DESC NULLS LAST
  `);
  res.json(result.rows);
});

app.get('/api/admin/messages/:userId', authMiddleware, requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT sender, content, created_at FROM messages WHERE user_id = $1 ORDER BY created_at ASC',
    [req.params.userId]
  );
  res.json(result.rows);
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

// Shared paths so the admin dashboard, the Discord bot, and (later) anything
// else all go through the same insert + broadcast logic.

async function deliverUserMessage(userId, username, content) {
  const trimmed = content.trim().slice(0, 4000);
  const result = await pool.query(
    'INSERT INTO messages (user_id, sender, content) VALUES ($1, $2, $3) RETURNING content, created_at',
    [userId, 'user', trimmed]
  );
  const payload = { sender: 'user', ...result.rows[0] };
  io.to(`user-${userId}`).emit('message', payload);
  io.to('admin-room').emit('new-message', { userId, username, ...payload });
  notifyDiscordNewMessage(userId, username, trimmed).catch((err) => console.error('Discord notify failed:', err));
  return payload;
}

async function deliverAdminReply(userId, content) {
  const trimmed = content.trim().slice(0, 4000);
  const result = await pool.query(
    'INSERT INTO messages (user_id, sender, content) VALUES ($1, $2, $3) RETURNING content, created_at',
    [userId, 'admin', trimmed]
  );
  const payload = { sender: 'admin', ...result.rows[0] };
  io.to(`user-${userId}`).emit('message', payload);
  return payload;
}

io.on('connection', (socket) => {
  const { role } = socket.auth;

  if (role === 'user') {
    socket.join(`user-${socket.auth.id}`);

    socket.on('message', async (content) => {
      if (!content || typeof content !== 'string' || !content.trim()) return;
      await deliverUserMessage(socket.auth.id, socket.auth.username, content);
    });
  }

  if (role === 'admin') {
    socket.join('admin-room');

    socket.on('message', async ({ userId, content }) => {
      if (!userId || !content || !content.trim()) return;
      const payload = await deliverAdminReply(userId, content);
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
      // Option A: reply directly to a notification DM to route it to that visitor.
      const repliedToId = message.reference?.messageId;
      if (repliedToId && dmMessageToUserId.has(repliedToId)) {
        const userId = dmMessageToUserId.get(repliedToId);
        await deliverAdminReply(userId, message.content);
        await message.react('✅');
        return;
      }

      // Option B: "reply <username> <message>" for conversations without a recent DM.
      const match = message.content.match(/^reply\s+(\S+)\s+([\s\S]+)$/i);
      if (match) {
        const [, username, text] = match;
        const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (!result.rows[0]) {
          await message.reply(`Couldn't find a user called "${username}".`);
          return;
        }
        await deliverAdminReply(result.rows[0].id, text);
        await message.react('✅');
        return;
      }

      await message.reply(
        "Reply directly to one of my notification messages, or use: `reply <username> <message>`"
      );
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

async function notifyDiscordNewMessage(userId, username, content) {
  if (!discordReady) return;
  const owner = await discordClient.users.fetch(DISCORD_OWNER_ID);
  const embed = new EmbedBuilder()
    .setAuthor({ name: username })
    .setDescription(content)
    .setFooter({ text: `Reply to this message, or use: reply ${username} <message>` })
    .setColor(0x6c5ce7)
    .setTimestamp();
  const sent = await owner.send({ embeds: [embed] });
  dmMessageToUserId.set(sent.id, userId);
}

migrate()
  .then(() => {
    server.listen(PORT, () => console.log(`Chat backend listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
