const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const EMOJIS = ['❤️', '😂', '🔥', '👍', '👀', '🎉'];
const COLORS = ['accent', 'pink', 'muted'];
const DEMO_PASSWORD = 'illustrative';

const DEMOS = [
  {
    username: 'mara',
    display_name: 'Mara Ellison',
    pronouns: 'she/her',
    bio: 'Draws interfaces at night and argues about kerning.',
    avatar_color: 'accent',
  },
  {
    username: 'jun',
    display_name: 'Jun Park',
    pronouns: 'they/them',
    bio: 'Keeps the queue short and the playlists long.',
    avatar_color: 'pink',
  },
];

const SEED_LINES = [
  { username: 'jun', minutesAgo: 48, content: 'you around tonight?' },
  { username: 'mara', minutesAgo: 46, content: 'yeah, after I finish this layout pass', replyTo: 0 },
  { username: 'mara', minutesAgo: 45, content: 'the room feels a lot calmer like this' },
  { username: 'jun', minutesAgo: 12, content: 'agreed. ping me if it gets loud in here' },
];

function isLocalDatabase(connectionString) {
  try {
    const normalized = String(connectionString || '').replace(/^postgres(ql)?:/i, 'http:');
    const host = new URL(normalized).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function demoSeedAllowed() {
  // Illustrative accounts only on a local database, and never when deployed
  // with NODE_ENV=production. A remote database is never seeded.
  return process.env.NODE_ENV !== 'production' && isLocalDatabase(process.env.DATABASE_URL);
}

function clip(value, max) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, max);
}

function searchPattern(value) {
  const cleaned = String(value || '').trim().slice(0, 40).replace(/[\\%_]/g, '\\$&');
  return `%${cleaned}%`;
}

function sendPage(res, name) {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, name));
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    });
  };
}

function tokenBucket({ capacity, refillPerSec }) {
  const buckets = new Map();
  return function allow(userId) {
    const now = Date.now();
    let bucket = buckets.get(userId);
    if (!bucket) {
      bucket = { tokens: capacity, updated: now };
      buckets.set(userId, bucket);
    }
    const elapsed = (now - bucket.updated) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.updated = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}

async function setupCommunity({ app, io, pool, authMiddleware, requireAdmin }) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema-next.sql'), 'utf8');
  await pool.query(sql);
  if (demoSeedAllowed()) await seedIllustrative(pool);

  const typingUntil = new Map();
  const allowMessage = tokenBucket({ capacity: 5, refillPerSec: 0.5 });
  const allowReaction = tokenBucket({ capacity: 10, refillPerSec: 2 });
  const allowTyping = tokenBucket({ capacity: 8, refillPerSec: 4 });

  function socketsForUser(userId) {
    const matches = [];
    for (const socket of io.sockets.sockets.values()) {
      if (socket.auth?.role === 'user' && Number(socket.auth.id) === Number(userId)) matches.push(socket);
    }
    return matches;
  }

  function onlineCount() {
    const room = io.sockets.adapter.rooms.get('community');
    if (!room) return 0;
    let count = 0;
    for (const id of room) {
      const socket = io.sockets.sockets.get(id);
      if (socket?.auth?.role === 'user') count += 1;
    }
    return count;
  }

  function emitPresence() {
    io.to('community').emit('community-presence', { online: onlineCount() });
  }

  function broadcastTyping() {
    const typers = [];
    const now = Date.now();
    for (const [userId, info] of typingUntil) {
      if (info.until < now) typingUntil.delete(userId);
      else typers.push({ userId: Number(userId), name: info.name });
    }
    io.to('community').emit('community-typers', { typers });
  }

  setInterval(() => {
    const before = typingUntil.size;
    const now = Date.now();
    for (const [userId, info] of typingUntil) {
      if (info.until < now) typingUntil.delete(userId);
    }
    if (typingUntil.size || before) broadcastTyping();
  }, 1000).unref?.();

  async function displayNameFor(userId) {
    const result = await pool.query(
      `SELECT u.username, p.display_name
       FROM users u
       LEFT JOIN community_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    const row = result.rows[0];
    return row?.display_name || row?.username || 'Someone';
  }

  async function getMod(userId) {
    const result = await pool.query(
      'SELECT muted_until, banned_at FROM community_profiles WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || { muted_until: null, banned_at: null };
  }

  async function assertCanPost(userId) {
    const mod = await getMod(userId);
    if (mod.banned_at) return 'You are banned from the room.';
    if (mod.muted_until && new Date(mod.muted_until) > new Date()) return 'You are muted.';
    return null;
  }

  function pushModeration(userId, mod) {
    const payload = {
      banned: Boolean(mod.banned_at),
      muted_until: mod.muted_until,
    };
    for (const socket of socketsForUser(userId)) {
      socket.emit('community-moderation', payload);
      if (payload.banned) socket.leave('community');
    }
  }

  async function reactionsFor(messageId) {
    const result = await pool.query(
      `SELECT emoji, user_id
       FROM community_reactions
       WHERE message_id = $1
       ORDER BY created_at ASC`,
      [messageId]
    );
    const buckets = new Map();
    for (const row of result.rows) {
      if (!buckets.has(row.emoji)) buckets.set(row.emoji, []);
      buckets.get(row.emoji).push(row.user_id);
    }
    return [...buckets.entries()].map(([emoji, userIds]) => ({
      emoji,
      count: userIds.length,
      userIds,
    }));
  }

  async function attachReactions(rows) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const reactions = await pool.query(
      `SELECT message_id, emoji, user_id
       FROM community_reactions
       WHERE message_id = ANY($1::int[])
       ORDER BY created_at ASC`,
      [ids]
    );
    const byMessage = new Map();
    for (const reaction of reactions.rows) {
      if (!byMessage.has(reaction.message_id)) byMessage.set(reaction.message_id, new Map());
      const bucket = byMessage.get(reaction.message_id);
      if (!bucket.has(reaction.emoji)) bucket.set(reaction.emoji, []);
      bucket.get(reaction.emoji).push(reaction.user_id);
    }
    return rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      username: row.username,
      display_name: row.display_name || row.username,
      pronouns: row.pronouns || '',
      bio: row.bio || '',
      avatar_color: row.avatar_color || 'accent',
      joined_at: row.joined_at,
      content: row.content,
      created_at: row.created_at,
      reply: row.reply_to
        ? {
            id: row.reply_to,
            user_id: row.reply_user_id,
            username: row.reply_username,
            display_name: row.reply_display_name || row.reply_username,
            content: row.reply_deleted ? '' : row.reply_content || '',
            removed: Boolean(row.reply_deleted),
          }
        : null,
      reactions: [...(byMessage.get(row.id)?.entries() || [])].map(([emoji, userIds]) => ({
        emoji,
        count: userIds.length,
        userIds,
      })),
    }));
  }

  const messageSelect = `
    SELECT m.id, m.user_id, m.content, m.reply_to, m.created_at,
           u.username, u.created_at AS joined_at,
           p.display_name, p.pronouns, p.bio, p.avatar_color,
           parent.content AS reply_content,
           parent.deleted_at AS reply_deleted,
           parent.user_id AS reply_user_id,
           pu.username AS reply_username,
           pp.display_name AS reply_display_name
    FROM community_messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN community_profiles p ON p.user_id = u.id
    LEFT JOIN community_messages parent ON parent.id = m.reply_to
    LEFT JOIN users pu ON pu.id = parent.user_id
    LEFT JOIN community_profiles pp ON pp.user_id = pu.id
  `;

  async function loadMessages() {
    const result = await pool.query(
      `${messageSelect}
       WHERE m.deleted_at IS NULL
       ORDER BY m.created_at DESC
       LIMIT 300`
    );
    result.rows.reverse();
    return attachReactions(result.rows);
  }

  async function loadMessage(id) {
    const result = await pool.query(`${messageSelect} WHERE m.id = $1 AND m.deleted_at IS NULL`, [id]);
    const [message] = await attachReactions(result.rows);
    return message || null;
  }

  async function loadProfile(userId) {
    const result = await pool.query(
      `SELECT u.id, u.username, u.created_at,
              p.display_name, p.pronouns, p.bio, p.avatar_color, p.muted_until, p.banned_at
       FROM users u
       LEFT JOIN community_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      user_id: row.id,
      username: row.username,
      display_name: row.display_name || row.username,
      pronouns: row.pronouns || '',
      bio: row.bio || '',
      avatar_color: row.avatar_color || 'accent',
      joined_at: row.created_at,
      muted_until: row.muted_until,
      banned_at: row.banned_at,
    };
  }

  function requireUser(req, res, next) {
    if (req.auth?.role !== 'user') return res.status(403).json({ error: 'User only' });
    next();
  }

  app.get('/chat/chat.html', (_req, res) => sendPage(res, 'chat.html'));
  app.get('/chat/admin.html', (_req, res) => sendPage(res, 'admin.html'));
  app.get('/chat/chat-next.html', (_req, res) => res.redirect(302, '/chat/chat.html'));
  app.get('/chat/admin-next.html', (_req, res) => res.redirect(302, '/chat/admin.html'));

  app.get('/api/community/health', (_req, res) => {
    res.json({ ok: true, demo: demoSeedAllowed() });
  });

  app.get('/api/community/messages', authMiddleware, requireUser, asyncHandler(async (req, res) => {
    const mod = await getMod(req.auth.id);
    if (mod.banned_at) return res.status(403).json({ error: 'You are banned from the room.' });
    res.json(await loadMessages());
  }));

  app.get('/api/community/me', authMiddleware, requireUser, asyncHandler(async (req, res) => {
    const profile = await loadProfile(req.auth.id);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json({ ...profile, self: true });
  }));

  app.get('/api/community/profile/:userId', authMiddleware, requireUser, asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Bad user id' });
    const profile = await loadProfile(userId);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const self = Number(req.auth.id) === userId;
    const body = { ...profile, self };
    if (!self) {
      delete body.muted_until;
      delete body.banned_at;
    }
    res.json(body);
  }));

  app.patch('/api/community/me', authMiddleware, requireUser, asyncHandler(async (req, res) => {
    const displayName = clip(req.body?.displayName, 40);
    const pronouns = clip(req.body?.pronouns, 40);
    const bio = clip(req.body?.bio, 280);
    const avatarColor = COLORS.includes(req.body?.avatarColor) ? req.body.avatarColor : null;
    await pool.query(
      `INSERT INTO community_profiles (user_id, display_name, pronouns, bio, avatar_color)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'accent'))
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = COALESCE($2, community_profiles.display_name),
         pronouns = COALESCE($3, community_profiles.pronouns),
         bio = COALESCE($4, community_profiles.bio),
         avatar_color = COALESCE($5, community_profiles.avatar_color)`,
      [req.auth.id, displayName, pronouns, bio, avatarColor]
    );
    const name = await displayNameFor(req.auth.id);
    for (const socket of socketsForUser(req.auth.id)) socket.communityName = name;
    const profile = await loadProfile(req.auth.id);
    res.json({ ...profile, self: true });
  }));

  app.get('/api/community/admin/stats', authMiddleware, requireAdmin, asyncHandler(async (_req, res) => {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS members,
        (SELECT COUNT(*)::int FROM community_messages WHERE deleted_at IS NULL) AS messages,
        (SELECT COUNT(*)::int FROM community_messages WHERE deleted_at IS NULL AND created_at >= date_trunc('day', now())) AS today,
        (SELECT COUNT(*)::int FROM community_profiles WHERE muted_until > now()) AS muted,
        (SELECT COUNT(*)::int FROM community_profiles WHERE banned_at IS NOT NULL) AS banned
    `);
    res.json(result.rows[0]);
  }));

  app.get('/api/community/admin/users', authMiddleware, requireAdmin, asyncHandler(async (req, res) => {
    const pattern = searchPattern(req.query.q || '');
    const result = await pool.query(
      `SELECT u.id, u.username, u.created_at,
              p.display_name, p.pronouns, p.bio, p.avatar_color, p.muted_until, p.banned_at
       FROM users u
       LEFT JOIN community_profiles p ON p.user_id = u.id
       WHERE u.username ILIKE $1 ESCAPE '\\'
          OR COALESCE(p.display_name, '') ILIKE $1 ESCAPE '\\'
       ORDER BY COALESCE(p.display_name, u.username) ASC
       LIMIT 100`,
      [pattern]
    );
    res.json(result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      display_name: row.display_name || row.username,
      pronouns: row.pronouns || '',
      bio: row.bio || '',
      avatar_color: row.avatar_color || 'accent',
      joined_at: row.created_at,
      muted_until: row.muted_until,
      banned_at: row.banned_at,
    })));
  }));

  app.get('/api/community/admin/messages', authMiddleware, requireAdmin, asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `SELECT m.id, m.content, m.created_at, u.username, COALESCE(p.display_name, u.username) AS display_name
       FROM community_messages m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN community_profiles p ON p.user_id = u.id
       WHERE m.deleted_at IS NULL
       ORDER BY m.created_at DESC
       LIMIT 40`
    );
    res.json(result.rows);
  }));

  async function setModeration(userId, fields) {
    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!existing.rows[0]) return null;
    await pool.query(
      `INSERT INTO community_profiles (user_id, banned_at, muted_until)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         banned_at = $2,
         muted_until = $3`,
      [userId, fields.banned_at, fields.muted_until]
    );
    return getMod(userId);
  }

  app.post('/api/community/admin/users/:id/ban', authMiddleware, requireAdmin, asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Bad user id' });
    const current = await getMod(userId);
    const mod = await setModeration(userId, { banned_at: new Date(), muted_until: current.muted_until });
    if (!mod) return res.status(404).json({ error: 'User not found' });
    typingUntil.delete(userId);
    pushModeration(userId, mod);
    broadcastTyping();
    res.json({ ok: true });
  }));

  app.post('/api/community/admin/users/:id/unban', authMiddleware, requireAdmin, asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Bad user id' });
    const current = await getMod(userId);
    const mod = await setModeration(userId, { banned_at: null, muted_until: current.muted_until });
    if (!mod) return res.status(404).json({ error: 'User not found' });
    pushModeration(userId, mod);
    res.json({ ok: true });
  }));

  app.post('/api/community/admin/users/:id/mute', authMiddleware, requireAdmin, asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Bad user id' });
    const minutes = Math.min(Math.max(Number(req.body?.minutes) || 10, 1), 1440);
    const current = await getMod(userId);
    const until = new Date(Date.now() + minutes * 60 * 1000);
    const mod = await setModeration(userId, { banned_at: current.banned_at, muted_until: until });
    if (!mod) return res.status(404).json({ error: 'User not found' });
    typingUntil.delete(userId);
    pushModeration(userId, mod);
    broadcastTyping();
    res.json({ ok: true, muted_until: mod.muted_until });
  }));

  app.post('/api/community/admin/users/:id/unmute', authMiddleware, requireAdmin, asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Bad user id' });
    const current = await getMod(userId);
    const mod = await setModeration(userId, { banned_at: current.banned_at, muted_until: null });
    if (!mod) return res.status(404).json({ error: 'User not found' });
    pushModeration(userId, mod);
    res.json({ ok: true });
  }));

  app.delete('/api/community/admin/messages/:id', authMiddleware, requireAdmin, asyncHandler(async (req, res) => {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: 'Bad message id' });
    const result = await pool.query(
      `UPDATE community_messages
       SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [messageId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found' });
    io.to('community').emit('community-deleted', { id: messageId });
    res.json({ ok: true });
  }));

  io.on('connection', (socket) => {
    socket.on('community-join', async () => {
      try {
        if (socket.auth?.role !== 'user') return;
        const mod = await getMod(socket.auth.id);
        socket.emit('community-moderation', {
          banned: Boolean(mod.banned_at),
          muted_until: mod.muted_until,
        });
        if (mod.banned_at) {
          socket.leave('community');
          typingUntil.delete(Number(socket.auth.id));
          socket.emit('community-error', { error: 'You are banned from the room.' });
          emitPresence();
          broadcastTyping();
          return;
        }
        await pool.query(
          'INSERT INTO community_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
          [socket.auth.id]
        );
        socket.join('community');
        socket.communityName = await displayNameFor(socket.auth.id);
        emitPresence();
        broadcastTyping();
      } catch (err) {
        console.error('community-join failed:', err.message);
      }
    });

    socket.on('community-admin-watch', () => {
      if (socket.auth?.role !== 'admin') return;
      socket.join('community');
    });

    socket.on('community-typing', async (body) => {
      try {
        if (socket.auth?.role !== 'user') return;
        const userId = Number(socket.auth.id);
        if (body?.typing) {
          const blocked = await assertCanPost(userId);
          if (blocked) {
            typingUntil.delete(userId);
            broadcastTyping();
            return;
          }
          if (!allowTyping(userId)) return;
          if (!socket.communityName) socket.communityName = await displayNameFor(userId);
          typingUntil.set(userId, {
            name: socket.communityName || socket.auth.username,
            until: Date.now() + 12000,
          });
        } else {
          typingUntil.delete(userId);
        }
        broadcastTyping();
      } catch (err) {
        console.error('community-typing failed:', err.message);
      }
    });

    socket.on('community-message', async (body) => {
      try {
        if (socket.auth?.role !== 'user') return;
        const blocked = await assertCanPost(socket.auth.id);
        if (blocked) {
          socket.emit('community-error', { error: blocked });
          return;
        }
        const content = String(body?.content || '').trim().slice(0, 2000);
        if (!content) return;
        if (!allowMessage(socket.auth.id)) {
          socket.emit('community-error', { error: 'Slow down a little.' });
          return;
        }
        let replyTo = Number(body?.replyTo);
        if (!Number.isInteger(replyTo) || replyTo <= 0) replyTo = null;
        if (replyTo) {
          const parent = await pool.query(
            'SELECT id FROM community_messages WHERE id = $1 AND deleted_at IS NULL',
            [replyTo]
          );
          if (!parent.rows[0]) replyTo = null;
        }
        const inserted = await pool.query(
          `INSERT INTO community_messages (user_id, content, reply_to)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [socket.auth.id, content, replyTo]
        );
        typingUntil.delete(Number(socket.auth.id));
        const message = await loadMessage(inserted.rows[0].id);
        io.to('community').emit('community-message', message);
        broadcastTyping();
      } catch (err) {
        console.error('community-message failed:', err.message);
        socket.emit('community-error', { error: 'Could not send that message.' });
      }
    });

    socket.on('community-react', async (body) => {
      try {
        if (socket.auth?.role !== 'user') return;
        const blocked = await assertCanPost(socket.auth.id);
        if (blocked) {
          socket.emit('community-error', { error: blocked });
          return;
        }
        const messageId = Number(body?.messageId);
        const emoji = body?.emoji;
        if (!Number.isInteger(messageId) || !EMOJIS.includes(emoji)) return;
        if (!allowReaction(socket.auth.id)) {
          socket.emit('community-error', { error: 'Slow down a little.' });
          return;
        }
        const exists = await pool.query(
          'SELECT id FROM community_messages WHERE id = $1 AND deleted_at IS NULL',
          [messageId]
        );
        if (!exists.rows[0]) return;
        const removed = await pool.query(
          `DELETE FROM community_reactions
           WHERE message_id = $1 AND user_id = $2 AND emoji = $3
           RETURNING emoji`,
          [messageId, socket.auth.id, emoji]
        );
        if (!removed.rows.length) {
          await pool.query(
            `INSERT INTO community_reactions (message_id, user_id, emoji)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [messageId, socket.auth.id, emoji]
          );
        }
        io.to('community').emit('community-reactions', {
          messageId,
          reactions: await reactionsFor(messageId),
        });
      } catch (err) {
        console.error('community-react failed:', err.message);
      }
    });

    socket.on('disconnect', () => {
      if (socket.auth?.role !== 'user') return;
      typingUntil.delete(Number(socket.auth.id));
      emitPresence();
      broadcastTyping();
    });
  });

  console.log('Community chat on /chat/chat.html and /chat/admin.html');
}

async function seedIllustrative(pool) {
  if (!demoSeedAllowed()) return;
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const ids = {};
  for (const demo of DEMOS) {
    const result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [demo.username, hash]
    );
    if (result.rows[0]) {
      ids[demo.username] = result.rows[0].id;
    } else {
      const existing = await pool.query('SELECT id FROM users WHERE username = $1', [demo.username]);
      ids[demo.username] = existing.rows[0].id;
    }
    await pool.query(
      `INSERT INTO community_profiles (user_id, display_name, pronouns, bio, avatar_color)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO NOTHING`,
      [ids[demo.username], demo.display_name, demo.pronouns, demo.bio, demo.avatar_color]
    );
  }

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM community_messages');
  if (count.rows[0].n > 0) return;

  const insertedIds = [];
  for (const line of SEED_LINES) {
    const replyTo = Number.isInteger(line.replyTo) ? insertedIds[line.replyTo] : null;
    const result = await pool.query(
      `INSERT INTO community_messages (user_id, content, reply_to, created_at)
       VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)
       RETURNING id`,
      [ids[line.username], line.content, replyTo, String(line.minutesAgo)]
    );
    insertedIds.push(result.rows[0].id);
  }
  await pool.query(
    'INSERT INTO community_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
    [insertedIds[0], ids.mara, '👍']
  );
}

module.exports = { setupCommunity, demoSeedAllowed };
