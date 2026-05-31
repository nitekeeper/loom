-- ============================================================
-- Loom — SQLite schema (Appendix A, verbatim-faithful)
-- ------------------------------------------------------------
-- Executed once against a fresh in-memory sql.js database on
-- each launch (OQ-2: no cross-session history by default). The
-- serialized DB is flushed to <root>/.loom/loom.db on each
-- mutation for in-session durability (NFR-7).
--
-- INT timestamps are integers (epoch milliseconds).
-- Foreign keys are enforced (PRAGMA foreign_keys=ON set in code;
-- sql.js requires the pragma per-connection at runtime).
-- ============================================================

PRAGMA foreign_keys = ON;

-- agents ------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  name          TEXT    PRIMARY KEY,
  connection_id TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'gone')),
  registered_at INTEGER NOT NULL
);

-- channels ----------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- memberships -------------------------------------------------
CREATE TABLE IF NOT EXISTS memberships (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  agent_name TEXT    NOT NULL REFERENCES agents(name),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_name)
);

-- messages ----------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  sender     TEXT    NOT NULL REFERENCES agents(name),
  body       TEXT    NOT NULL,
  addressing TEXT    NOT NULL
               CHECK (addressing IN ('direct', 'here')),
  target     TEXT    REFERENCES agents(name),
  created_at INTEGER NOT NULL
);

-- receipts ----------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  recipient  TEXT    NOT NULL REFERENCES agents(name),
  read_at    INTEGER,                       -- NULL = unread
  PRIMARY KEY (message_id, recipient)
);

-- Partial index that backs unread counts / inbox (FR-28).
CREATE INDEX IF NOT EXISTS idx_receipts_unread
  ON receipts (recipient)
  WHERE read_at IS NULL;
