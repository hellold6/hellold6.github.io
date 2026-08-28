require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const {
  DATABASE_URL,
  JWT_SECRET,
  ADMIN_PASSWORD,
  ALLOWED_ORIGIN, // e.g. https://hellold6.github.io
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

io.on('connection', (socket) => {
  const { role } = socket.auth;

  if (role === 'user') {
    const room = `user-${socket.auth.id}`;
    socket.join(room);

    socket.on('message', async (content) => {
      if (!content || typeof content !== 'string' || !content.trim()) return;
      const trimmed = content.trim().slice(0, 4000);
      const result = await pool.query(
        'INSERT INTO messages (user_id, sender, content) VALUES ($1, $2, $3) RETURNING content, created_at',
        [socket.auth.id, 'user', trimmed]
      );
      const payload = { sender: 'user', ...result.rows[0] };
      io.to(room).emit('message', payload);
      io.to('admin-room').emit('new-message', { userId: socket.auth.id, username: socket.auth.username, ...payload });
    });
  }

  if (role === 'admin') {
    socket.join('admin-room');

    socket.on('message', async ({ userId, content }) => {
      if (!userId || !content || !content.trim()) return;
      const trimmed = content.trim().slice(0, 4000);
      const result = await pool.query(
        'INSERT INTO messages (user_id, sender, content) VALUES ($1, $2, $3) RETURNING content, created_at',
        [userId, 'admin', trimmed]
      );
      const payload = { sender: 'admin', ...result.rows[0] };
      io.to(`user-${userId}`).emit('message', payload);
      socket.emit('message-sent', { userId, ...payload });
    });
  }
});

migrate()
  .then(() => {
    server.listen(PORT, () => console.log(`Chat backend listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
