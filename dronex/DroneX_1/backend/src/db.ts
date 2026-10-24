// The account database: Node's built-in SQLite, one file, created on first
// start. Times are milliseconds since the Unix epoch.

import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  username        TEXT UNIQUE,
  product_updates INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- One pending code per email; only its hash is kept.
CREATE TABLE IF NOT EXISTS otps (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- Bearer sessions; only the token's hash is kept.
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  computer       TEXT,
  user_agent     TEXT,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Sync: the latest copy of each entity in the account, by Core's rule (the
-- higher version, then the higher digest). seq orders copies for pulling:
-- each accepted change takes the account's next seq.
CREATE TABLE IF NOT EXISTS sync_entities (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity      TEXT NOT NULL,
  id          TEXT NOT NULL,
  version     INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  ts_us       INTEGER NOT NULL,
  change      TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_entities_seq ON sync_entities(user_id, seq);

-- Plugin bundles, by the SHA-256 of their bytes, per account.
CREATE TABLE IF NOT EXISTS plugin_bundles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest     TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, digest)
);

-- Computers by their device id, named as sync last told it.
CREATE TABLE IF NOT EXISTS devices (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- Flight (tlog) chunks and recording segments, as Core names them:
-- <item>/<seq>-<sha256>.<ext>. 'granted' until the bytes arrive, 'put'
-- once they did and checked out, 'stored' once the computer completed it.
CREATE TABLE IF NOT EXISTS chunks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  first_us   INTEGER,
  last_us    INTEGER,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, name)
);
CREATE INDEX IF NOT EXISTS chunks_item ON chunks(user_id, kind, device_id, item_id, seq);

-- Hosted model tokens per account per UTC day (day = ms / 86400000).
CREATE TABLE IF NOT EXISTS model_usage (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day                INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Hosted model responses from chats that allow keeping them. A turn is its
-- first response (response_id = turn_id); tool rounds point at it. Only a
-- preview is kept, unless the operator sent the conversation (items).
CREATE TABLE IF NOT EXISTS model_turns (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  thread      TEXT NOT NULL,
  model       TEXT NOT NULL,
  preview     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  rating      TEXT,
  comment     TEXT,
  items       TEXT,
  PRIMARY KEY (user_id, response_id)
);

-- Account deletion waits for a code sent to the account's email.
CREATE TABLE IF NOT EXISTS deletions (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
