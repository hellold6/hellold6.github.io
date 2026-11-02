-- Community room tables. Applied on every startup after migrate() creates
-- users and messages. Idempotent. Does not DROP, UPDATE, or DELETE anything
-- in users or messages, and does not copy private threads into the room.
-- Direct messages stay in messages exactly as they are.

CREATE TABLE IF NOT EXISTS community_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  pronouns TEXT,
  bio TEXT,
  avatar_color TEXT,
  muted_until TIMESTAMPTZ,
  banned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS community_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  reply_to INTEGER REFERENCES community_messages(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_messages_created ON community_messages (created_at);

CREATE TABLE IF NOT EXISTS community_reactions (
  message_id INTEGER NOT NULL REFERENCES community_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- A profile row for each existing account. ON CONFLICT does not change users.
INSERT INTO community_profiles (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;
