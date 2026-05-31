/* ============================================================
 * Loom — sql.js (WASM) database module
 * ------------------------------------------------------------
 * Owns the in-memory SQLite database (sql.js). Loads sql-wasm.wasm
 * and schema.sql from __dirname (dist/), enables foreign keys, and
 * flushes the serialized DB to <root>/.loom/loom.db on each mutation
 * for in-session durability (NFR-7). Fresh DB per launch (OQ-2).
 *
 * This module is the ONLY place that talks to sql.js. engine.ts
 * operates over the typed query helpers exported here so the
 * acceptance suite can swap/inspect the store without Electron.
 *
 * R-1 (WF1 open concern): flush() is DEBOUNCED/coalesced (~75ms) so a
 * burst of mutations becomes a single serialize()+write instead of one
 * disk write per mutation. flushNow() forces a synchronous write.
 * ============================================================ */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  // --- mutations (writers) ---
  insertAgent(row: AgentRow): void;
  setAgentStatus(name: string, status: AgentRow['status']): void;
  insertChannel(name: string, createdAt: number): ChannelRow;
  insertMembership(row: MembershipRow): void;
  insertMessage(row: Omit<MessageRow, 'id'>): MessageRow;
  insertReceipt(row: ReceiptRow): void;
  markReceiptsRead(messageIds: number[], recipient: string, at: number): number;
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

  async init(rootDir: string): Promise<void> {
    // sql.js wasm + schema sit beside this bundle (dist/) — see build.mjs.
    const SQL = await initSqlJs({
      locateFile: (f: string) => path.join(__dirname, f),
    });
    // Fresh DB per launch (OQ-2): construct an empty database, then DDL.
    this.db = new SQL.Database();
    const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    // PRAGMA foreign_keys must be set per-connection at runtime (sql.js).
    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run(schema);

    const loomDir = path.join(rootDir, '.loom');
    mkdirSync(loomDir, { recursive: true });
    this.dbFile = path.join(loomDir, 'loom.db');
    // Write an initial (empty-schema) snapshot so the file exists.
    this.flushNow();
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

  /** Force a synchronous serialize()+write right now. */
  private flushNow(): void {
    if (!this.db || !this.dbFile) return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const bytes = this.db.export();
    writeFileSync(this.dbFile, bytes);
  }
}

/** Construct the database module. */
export function createDb(): LoomDb {
  return new SqlJsLoomDb();
}
