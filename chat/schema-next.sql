-- Community chat prototype schema (reactions, replies, profiles, moderation).
-- Additive and optional. server.js does not run this from migrate().
-- community-next.js applies it only when CHAT_NEXT=1 and DATABASE_URL is localhost.
-- Do not run this against production.

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
