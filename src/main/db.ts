/* ============================================================
 * Loom — sql.js (WASM) database module
 * ------------------------------------------------------------
 * Owns the in-memory SQLite database (sql.js). Loads sql-wasm.wasm
 * and schema.sql from __dirname (dist/), enables foreign keys, and
 * flushes the serialized DB to <root>/.loom/loom.db on each mutation
 * for durability (NFR-7).
 *
 * PERSISTENCE (R2, OPTION A — supersedes the original "fresh DB per
 * launch" OQ-2 default): chat PERSISTS across launches. init() LOADS an
 * existing <root>/.loom/loom.db when present (falling back to a fresh
 * schema only when absent or the file is corrupt). Content is removed
 * only by the explicit human-invoked purge_all tool — never on close.
 *
 * This module is the ONLY place that talks to sql.js. engine.ts
 * operates over the typed query helpers exported here so the
 * acceptance suite can swap/inspect the store without Electron.
 *
 * R-1 (WF1 open concern): flush() is DEBOUNCED/coalesced (~75ms) so a
 * burst of mutations becomes a single serialize()+write instead of one
 * disk write per mutation. flushNow() forces a synchronous write.
 * ============================================================ */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import type { Database, SqlValue, Statement } from 'sql.js';
import type {
  AgentRow,
  ChannelRow,
  MembershipRow,
  MessageRow,
  ReceiptRow,
} from '../shared/types.js';

/** Debounce window for coalesced disk flushes (R-1). */
const FLUSH_DEBOUNCE_MS = 75;

/** sql.js-native result shape for an ad-hoc read (one entry per statement). */
export interface SqlExecResult {
  columns: string[];
  values: SqlValue[][];
}

export interface LoomDb {
  /** Run the Appendix-A schema against a fresh database. */
  init(rootDir: string): Promise<void>;
  /** Serialize + write to <root>/.loom/loom.db. */
  flush(): void;
  /** Force a SYNCHRONOUS serialize()+write right now (no debounce). Used on
   *  graceful close so the persisted loom.db reflects the latest state before
   *  close() (R2). No-op after close(). */
  flushNow(): void;
  /** Delete ALL chat data in FK-safe order (receipts -> messages ->
   *  memberships -> channels -> agents) and flush the now-empty db. Used by the
   *  human-invoked purge_all tool (R4). */
  purgeAll(): void;
  /** Cancel any pending debounced flush and free the sql.js database, stopping
   *  all further disk writes. After close() neither flush() nor flushNow() can
   *  ever touch loom.db again. R2: close() does NOT delete the file — the
   *  serialized loom.db persists across launches; a final flushNow() before
   *  close() keeps it current. Idempotent. */
  close(): void;
  /** Ad-hoc raw read (sql.js-native shape). Used for schema introspection
   *  (AC-16) and read-only diagnostics; never mutates + never flushes.
   *  Returns [] for an empty result set. */
  exec(sql: string): SqlExecResult[];

  // --- typed accessors (read models) ---
  getAgent(name: string): AgentRow | undefined;
  listAgents(): AgentRow[];
  getChannelByName(name: string): ChannelRow | undefined;
  getChannelById(id: number): ChannelRow | undefined;
  listChannels(): ChannelRow[];
  listMemberships(channelId: number): MembershipRow[];
  listMessages(channelId?: number): MessageRow[];
  listReceipts(messageId: number): ReceiptRow[];
  /** Unread messages addressed to `recipient` (receipt.read_at IS NULL),
   *  optionally filtered to one channel, ordered by message id ASC. Resolves
   *  with a single indexed JOIN over the partial unread index — O(unread),
   *  NOT the O(messages × receipts) per-message scan it replaces. This is the
   *  concurrency hot path: check_inbox / read_messages are polled by every
   *  agent, so under many agents the old full scan blocked the single thread. */
  listUnreadMessagesFor(recipient: string, channelId?: number): MessageRow[];

  // --- mutations (writers) ---
  insertAgent(row: AgentRow): void;
  setAgentStatus(name: string, status: AgentRow['status']): void;
  insertChannel(name: string, createdAt: number): ChannelRow;
  insertMembership(row: MembershipRow): void;
  insertMessage(row: Omit<MessageRow, 'id'>): MessageRow;
  insertReceipt(row: ReceiptRow): void;
  markReceiptsRead(messageIds: number[], recipient: string, at: number): number;
  /** Prune the OLDEST messages (and their receipts, FK-safe) so at most `max`
   *  remain — the newest `max` by id are kept. A non-positive/invalid `max` is
   *  a no-op (unlimited). Returns the number of messages removed. Bounds memory
   *  and the full-image flush cost under sustained multi-agent load. O(1) to
   *  decide (an in-memory count), O(removed) to delete. */
  pruneMessagesToCap(max: number): number;
}

type Cell = SqlValue | undefined;

/** Internal: coerce a sql.js cell to a TEXT string (or throw on null). */
function asText(v: Cell): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  throw new Error(`expected TEXT value, got ${v == null ? 'NULL' : typeof v}`);
}

/** Internal: coerce a sql.js cell to an INTEGER. */
function asInt(v: Cell): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  throw new Error(`expected INTEGER value, got ${v == null ? 'NULL' : typeof v}`);
}

/** Internal: nullable TEXT. */
function asTextOrNull(v: Cell): string | null {
  return v == null ? null : asText(v);
}

/** Internal: nullable INTEGER. */
function asIntOrNull(v: Cell): number | null {
  return v == null ? null : asInt(v);
}

class SqlJsLoomDb implements LoomDb {
  private db: Database | null = null;
  private dbFile = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Once closed, no flush may ever write loom.db again (shutdown teardown). */
  private closed = false;
  /** Live row count of `messages`, maintained in memory so pruneMessagesToCap
   *  can decide in O(1) instead of a COUNT(*) scan per send. Seeded once in
   *  init(), bumped on insertMessage, reduced on prune, zeroed on purgeAll. */
  private messageCount = 0;

  async init(rootDir: string): Promise<void> {
    // sql.js wasm + schema sit beside this bundle (dist/) — see build.mjs.
    const SQL = await initSqlJs({
      locateFile: (f: string) => path.join(__dirname, f),
    });

    const loomDir = path.join(rootDir, '.loom');
    mkdirSync(loomDir, { recursive: true });
    this.dbFile = path.join(loomDir, 'loom.db');

    // R2 (OPTION A): chat PERSISTS across launches. If a loom.db already exists
    // for this folder, LOAD it (sql.js opens the serialized bytes) so prior
    // agents/channels/messages/receipts survive a relaunch. Only when the file
    // is absent — or loading fails (corrupt/incompatible bytes) — do we build a
    // fresh schema. We must NOT re-run schema.sql over a LOADED db: its CREATE
    // TABLEs (even IF NOT EXISTS) would be redundant and a non-guarded DDL would
    // clash; the loaded image already carries the schema. foreign_keys is a
    // per-connection PRAGMA in sql.js, so set it on BOTH paths.
    //
    // SINGLE-WRITER-PER-FOLDER ASSUMPTION (known limitation, not yet enforced):
    // each instance loads the WHOLE serialized image into memory and, on flush,
    // writes the WHOLE image back (full-image, last-writer-wins). So if TWO
    // windows open the SAME folder, the later flush durably CLOBBERS the other
    // window's writes. This is mitigated — not solved — by mcp.json ownership:
    // discovered agents are routed to a single owning instance, so in practice
    // only one window mutates chat for a folder. There is intentionally NO
    // folder lock here yet (a separate decision); treat one writer per folder as
    // the contract until a lock lands.
    let loaded = false;
    if (existsSync(this.dbFile)) {
      try {
        const bytes = readFileSync(this.dbFile);
        this.db = new SQL.Database(bytes);
        // Touch a known table so a corrupt/incompatible image fails HERE
        // (rather than on the first real query) and we fall back to fresh.
        this.db.run('PRAGMA foreign_keys = ON;');
        this.db.exec('SELECT 1 FROM agents LIMIT 1;');
        loaded = true;
      } catch (err) {
        // Corrupt/incompatible existing db: discard it and start fresh so a
        // bad file can never wedge boot. Surface a warning for diagnostics.
        process.stderr.write(
          `[loom:db] existing loom.db could not be loaded (${String(err)}); ` +
            `starting a fresh database.\n`,
        );
        try {
          this.db?.close();
        } catch {
          /* ignore */
        }
        this.db = null;
        loaded = false;
      }
    }

    if (!loaded) {
      // Fresh database: construct empty, then run the Appendix-A DDL.
      this.db = new SQL.Database();
      const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      // PRAGMA foreign_keys must be set per-connection at runtime (sql.js).
      this.db.run('PRAGMA foreign_keys = ON;');
      this.db.run(schema);
      // Write an initial (empty-schema) snapshot so the file exists on disk.
      this.flushNow();
    }

    // Seed the in-memory message counter from whatever was loaded (0 for a
    // fresh schema) so the retention cap can decide without a per-send scan.
    this.messageCount =
      this.query('SELECT COUNT(*) AS c FROM messages', [], (o) => asInt(o['c']))[0] ?? 0;
  }

  private get conn(): Database {
    if (!this.db) throw new Error('db not initialized — call init() first');
    return this.db;
  }

  /** Prepare, bind, run a write statement, then free it; marks dirty + flush. */
  private execWrite(sql: string, params: SqlValue[]): void {
    const stmt = this.conn.prepare(sql);
    try {
      stmt.run(params);
    } finally {
      stmt.free();
    }
    this.flush();
  }

  /** Public ad-hoc raw read (sql.js-native [{columns, values}] shape).
   *  Read-only: it does NOT flush. Used by the acceptance suite for
   *  schema introspection (AC-16). */
  exec(sql: string): SqlExecResult[] {
    return this.conn.exec(sql);
  }

  /** Prepare a query, step through all rows as objects, free it. */
  private query<T>(
    sql: string,
    params: SqlValue[],
    map: (obj: Record<string, SqlValue>) => T,
  ): T[] {
    const stmt: Statement = this.conn.prepare(sql);
    const out: T[] = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        out.push(map(stmt.getAsObject() as Record<string, SqlValue>));
      }
    } finally {
      stmt.free();
    }
    return out;
  }

  private queryOne<T>(
    sql: string,
    params: SqlValue[],
    map: (obj: Record<string, SqlValue>) => T,
  ): T | undefined {
    const rows = this.query(sql, params, map);
    return rows[0];
  }

  // --- mappers --------------------------------------------------

  private static toAgent(o: Record<string, SqlValue>): AgentRow {
    const status = asText(o['status']);
    return {
      name: asText(o['name']),
      connection_id: asText(o['connection_id']),
      status: status === 'gone' ? 'gone' : 'active',
      registered_at: asInt(o['registered_at']),
    };
  }

  private static toChannel(o: Record<string, SqlValue>): ChannelRow {
    return {
      id: asInt(o['id']),
      name: asText(o['name']),
      created_at: asInt(o['created_at']),
    };
  }

  private static toMembership(o: Record<string, SqlValue>): MembershipRow {
    return {
      channel_id: asInt(o['channel_id']),
      agent_name: asText(o['agent_name']),
      joined_at: asInt(o['joined_at']),
    };
  }

  private static toMessage(o: Record<string, SqlValue>): MessageRow {
    const addressing = asText(o['addressing']);
    return {
      id: asInt(o['id']),
      channel_id: asInt(o['channel_id']),
      sender: asText(o['sender']),
      body: asText(o['body']),
      addressing: addressing === 'direct' ? 'direct' : 'here',
      target: asTextOrNull(o['target']),
      created_at: asInt(o['created_at']),
    };
  }

  private static toReceipt(o: Record<string, SqlValue>): ReceiptRow {
    return {
      message_id: asInt(o['message_id']),
      recipient: asText(o['recipient']),
      read_at: asIntOrNull(o['read_at']),
    };
  }

  // --- accessors ------------------------------------------------

  getAgent(name: string): AgentRow | undefined {
    return this.queryOne(
      'SELECT name, connection_id, status, registered_at FROM agents WHERE name = ?',
      [name],
      SqlJsLoomDb.toAgent,
    );
  }

  listAgents(): AgentRow[] {
    return this.query(
      'SELECT name, connection_id, status, registered_at FROM agents ORDER BY registered_at ASC, name ASC',
      [],
      SqlJsLoomDb.toAgent,
    );
  }

  getChannelByName(name: string): ChannelRow | undefined {
    return this.queryOne(
      'SELECT id, name, created_at FROM channels WHERE name = ?',
      [name],
      SqlJsLoomDb.toChannel,
    );
  }

  getChannelById(id: number): ChannelRow | undefined {
    return this.queryOne(
      'SELECT id, name, created_at FROM channels WHERE id = ?',
      [id],
      SqlJsLoomDb.toChannel,
    );
  }

  listChannels(): ChannelRow[] {
    return this.query(
      'SELECT id, name, created_at FROM channels ORDER BY id ASC',
      [],
      SqlJsLoomDb.toChannel,
    );
  }

  listMemberships(channelId: number): MembershipRow[] {
    return this.query(
      'SELECT channel_id, agent_name, joined_at FROM memberships WHERE channel_id = ? ORDER BY joined_at ASC, agent_name ASC',
      [channelId],
      SqlJsLoomDb.toMembership,
    );
  }

  listMessages(channelId?: number): MessageRow[] {
    if (channelId === undefined) {
      return this.query(
        'SELECT id, channel_id, sender, body, addressing, target, created_at FROM messages ORDER BY id ASC',
        [],
        SqlJsLoomDb.toMessage,
      );
    }
    return this.query(
      'SELECT id, channel_id, sender, body, addressing, target, created_at FROM messages WHERE channel_id = ? ORDER BY id ASC',
      [channelId],
      SqlJsLoomDb.toMessage,
    );
  }

  listReceipts(messageId: number): ReceiptRow[] {
    return this.query(
      'SELECT message_id, recipient, read_at FROM receipts WHERE message_id = ? ORDER BY recipient ASC',
      [messageId],
      SqlJsLoomDb.toReceipt,
    );
  }

  listUnreadMessagesFor(recipient: string, channelId?: number): MessageRow[] {
    // One indexed JOIN: the partial index idx_receipts_unread(recipient) WHERE
    // read_at IS NULL selects exactly this recipient's unread receipts, joined
    // to their messages by PK. Cost scales with the UNREAD set, not the whole
    // transcript — so many agents polling concurrently can't turn this into an
    // O(messages × receipts) event-loop stall. The receipts PK (message_id,
    // recipient) guarantees at most one row per (message, recipient), so no
    // duplicate messages are produced. Column names of `m.<col>` surface
    // unprefixed (id, channel_id, …) — exactly what toMessage expects.
    const base =
      'SELECT m.id, m.channel_id, m.sender, m.body, m.addressing, m.target, m.created_at ' +
      'FROM messages m JOIN receipts r ON r.message_id = m.id ' +
      'WHERE r.recipient = ? AND r.read_at IS NULL';
    if (channelId === undefined) {
      return this.query(`${base} ORDER BY m.id ASC`, [recipient], SqlJsLoomDb.toMessage);
    }
    return this.query(
      `${base} AND m.channel_id = ? ORDER BY m.id ASC`,
      [recipient, channelId],
      SqlJsLoomDb.toMessage,
    );
  }

  // --- mutations ------------------------------------------------

  insertAgent(row: AgentRow): void {
    this.execWrite(
      'INSERT INTO agents (name, connection_id, status, registered_at) VALUES (?, ?, ?, ?)',
      [row.name, row.connection_id, row.status, row.registered_at],
    );
  }

  setAgentStatus(name: string, status: AgentRow['status']): void {
    this.execWrite('UPDATE agents SET status = ? WHERE name = ?', [status, name]);
  }

  insertChannel(name: string, createdAt: number): ChannelRow {
    this.execWrite('INSERT INTO channels (name, created_at) VALUES (?, ?)', [name, createdAt]);
    const created = this.getChannelByName(name);
    if (!created) throw new Error(`insertChannel: channel '${name}' not found after insert`);
    return created;
  }

  insertMembership(row: MembershipRow): void {
    // Idempotent: a re-join must not violate the composite PK.
    this.execWrite(
      'INSERT OR IGNORE INTO memberships (channel_id, agent_name, joined_at) VALUES (?, ?, ?)',
      [row.channel_id, row.agent_name, row.joined_at],
    );
  }

  insertMessage(row: Omit<MessageRow, 'id'>): MessageRow {
    this.execWrite(
      'INSERT INTO messages (channel_id, sender, body, addressing, target, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [row.channel_id, row.sender, row.body, row.addressing, row.target, row.created_at],
    );
    this.messageCount += 1;
    const id = asInt(this.lastInsertRowId());
    return { id, ...row };
  }

  insertReceipt(row: ReceiptRow): void {
    this.execWrite(
      'INSERT INTO receipts (message_id, recipient, read_at) VALUES (?, ?, ?)',
      [row.message_id, row.recipient, row.read_at],
    );
  }

  markReceiptsRead(messageIds: number[], recipient: string, at: number): number {
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => '?').join(', ');
    const stmt = this.conn.prepare(
      `UPDATE receipts SET read_at = ? WHERE recipient = ? AND read_at IS NULL AND message_id IN (${placeholders})`,
    );
    try {
      stmt.run([at, recipient, ...messageIds]);
    } finally {
      stmt.free();
    }
    const marked = this.conn.getRowsModified();
    this.flush();
    return marked;
  }

  pruneMessagesToCap(max: number): number {
    if (!Number.isInteger(max) || max <= 0) return 0; // unlimited / invalid
    const excess = this.messageCount - max;
    if (excess <= 0) return 0;
    // Delete the OLDEST `excess` messages by id. Receipts (FK child of
    // messages) MUST go first. The messages table is untouched by the first
    // statement, so both subselects resolve to the SAME oldest id set.
    const oldest = 'SELECT id FROM messages ORDER BY id ASC LIMIT ?';
    const delReceipts = this.conn.prepare(
      `DELETE FROM receipts WHERE message_id IN (${oldest})`,
    );
    try {
      delReceipts.run([excess]);
    } finally {
      delReceipts.free();
    }
    const delMessages = this.conn.prepare(
      `DELETE FROM messages WHERE id IN (${oldest})`,
    );
    try {
      delMessages.run([excess]);
    } finally {
      delMessages.free();
    }
    this.messageCount -= excess;
    this.flush();
    return excess;
  }

  // --- internals ------------------------------------------------

  private lastInsertRowId(): SqlValue {
    const stmt = this.conn.prepare('SELECT last_insert_rowid() AS id');
    try {
      stmt.step();
      const v = stmt.getAsObject()['id'];
      return v ?? null;
    } finally {
      stmt.free();
    }
  }

  /** Schedule a coalesced disk write (R-1). Multiple calls collapse into one. */
  flush(): void {
    // After close() no write may resurrect loom.db (shutdown teardown).
    if (this.closed) return;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
    // Do not keep the event loop alive solely for a pending flush.
    if (typeof this.flushTimer === 'object' && this.flushTimer !== null) {
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Force a synchronous serialize()+write right now. Public (R2) so graceful
   *  close can persist the latest state before close(). No-op after close(). */
  flushNow(): void {
    if (this.closed || !this.db || !this.dbFile) return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const bytes = this.db.export();
    writeFileSync(this.dbFile, bytes);
  }

  /** Delete ALL chat data in FK-safe order, then flush the now-empty db (R4,
   *  purge_all). Children before parents so foreign-key constraints hold:
   *  receipts -> messages -> memberships -> channels -> agents.
   *
   *  flushNow() (not the debounced flush): a deliberate, irreversible purge
   *  must be durable SYNCHRONOUSLY, so a crash within the ~75ms debounce window
   *  can't reload the un-purged data on the next launch. */
  purgeAll(): void {
    const conn = this.conn;
    conn.run('DELETE FROM receipts;');
    conn.run('DELETE FROM messages;');
    conn.run('DELETE FROM memberships;');
    conn.run('DELETE FROM channels;');
    conn.run('DELETE FROM agents;');
    this.messageCount = 0;
    this.flushNow();
  }

  /** Cancel any pending debounced flush and free the database (R2 teardown).
   *  After this, flush()/flushNow() are inert. Does NOT delete loom.db — the
   *  serialized file persists across launches (a final flushNow() before
   *  close() keeps it current). Idempotent. */
  close(): void {
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* sql.js free() may throw if already freed; ignore on teardown. */
      }
      this.db = null;
    }
  }
}

/** Construct the database module. */
export function createDb(): LoomDb {
  return new SqlJsLoomDb();
}
