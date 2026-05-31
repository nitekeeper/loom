/* ============================================================
 * Loom — Shared type contract (FROZEN)
 * ------------------------------------------------------------
 * The single TypeScript contract imported by EVERY layer:
 * main, preload, and renderer. Changing a shape here is a
 * breaking change to the whole app — treat as frozen.
 *
 * Module strategy: this file is pure types + const objects with
 * no runtime side effects, compiled by esbuild into each bundle
 * (main = CJS, preload = CJS, renderer = IIFE). It MUST contain
 * no Node or DOM API usage so all three targets can import it.
 * ============================================================ */

/* ------------------------------------------------------------------ */
/* 1. Database row shapes — mirror src/main/schema.sql (Appendix A)    */
/* ------------------------------------------------------------------ */

/** agents.status enum. */
export type AgentStatus = 'active' | 'gone';

/** messages.addressing enum. NOTE: the agent-facing token "@here"
 *  maps to the persisted enum value 'here' (requirements M-6). */
export type Addressing = 'direct' | 'here';

/** Row of the `agents` table. Timestamps are INT epoch milliseconds. */
export interface AgentRow {
  /** PRIMARY KEY. Max length 64 (OQ-1). Suffixed on collision. */
  name: string;
  connection_id: string;
  status: AgentStatus;
  registered_at: number;
}

/** Row of the `channels` table. */
export interface ChannelRow {
  id: number;
  /** UNIQUE, NOT NULL. */
  name: string;
  created_at: number;
}

/** Row of the `memberships` table. Composite PK (channel_id, agent_name). */
export interface MembershipRow {
  channel_id: number;
  agent_name: string;
  joined_at: number;
}

/** Row of the `messages` table. */
export interface MessageRow {
  id: number;
  channel_id: number;
  sender: string;
  body: string;
  addressing: Addressing;
  /** Recipient name when addressing='direct'; NULL when 'here'. */
  target: string | null;
  created_at: number;
}

/** Row of the `receipts` table. Composite PK (message_id, recipient). */
export interface ReceiptRow {
  message_id: number;
  recipient: string;
  /** NULL = unread. INT epoch ms when read. */
  read_at: number | null;
}

/* ------------------------------------------------------------------ */
/* 2. MCP tool param + return shapes — the 9 tools (FR-15..FR-27)      */
/*    These are the exact JSON shapes returned by the engine and the   */
/*    MCP server. Keep names identical to CONTRACTS.md.                */
/* ------------------------------------------------------------------ */

/** register(name) -> { ok, name, channels: [] } (FR-15) */
export interface RegisterParams { name: string; }
export interface RegisterResult {
  ok: true;
  /** The ASSIGNED name (may be suffixed, e.g. researcher-2). */
  name: string;
  /** Always empty on first registration. */
  channels: string[];
}

/** create_channel(name) -> { id, name } (FR-16, auto-joins caller) */
export interface CreateChannelParams { name: string; }
export interface CreateChannelResult { id: number; name: string; }

/** join_channel(channel) -> { channel, members } (FR-17) */
export interface JoinChannelParams { channel: string; }
export interface JoinChannelResult { channel: string; members: string[]; }

/** list_channels() -> [{ id, name, members }] (FR-18) */
export type ListChannelsResult = ChannelSummary[];
export interface ChannelSummary { id: number; name: string; members: string[]; }

/** deregister(name) -> { ok, name } (FR-19, sets status='gone') */
export interface DeregisterParams { name: string; }
export interface DeregisterResult { ok: true; name: string; }

/** send_message(channel, to, body) -> { message_id, recipients } (FR-21)
 *  `to` is a member name (direct) OR the literal token "@here" (broadcast). */
export const HERE_TOKEN = '@here' as const;
export interface SendMessageParams { channel: string; to: string; body: string; }
export interface SendMessageResult { message_id: number; recipients: string[]; }

/** check_inbox() -> { unread, previews } — marks NOTHING read (FR-25) */
export interface CheckInboxResult { unread: number; previews: InboxPreview[]; }
export interface InboxPreview {
  message_id: number;
  channel: string;
  sender: string;
  addressing: Addressing;
  /** Truncated body for preview. */
  preview: string;
  created_at: number;
}

/** read_messages(channel?) -> full unread bodies — marks NOTHING read (FR-26) */
export interface ReadMessagesParams { channel?: string; }
export type ReadMessagesResult = UnreadMessage[];
export interface UnreadMessage {
  message_id: number;
  channel: string;
  sender: string;
  addressing: Addressing;
  target: string | null;
  body: string;
  created_at: number;
}

/** mark_read(message_ids) -> { marked } (FR-27) */
export interface MarkReadParams { message_ids: number[]; }
export interface MarkReadResult { marked: number; }

/** The identity of the calling agent. Every engine tool call is made
 *  on behalf of a caller; the MCP server binds caller = the registered
 *  name for that transport session. */
export interface Caller {
  /** Registered agent name, or null for not-yet-registered sessions. */
  name: string | null;
}

/** Union of all 9 tool names — the frozen tool surface. */
export type ToolName =
  | 'register'
  | 'create_channel'
  | 'join_channel'
  | 'list_channels'
  | 'deregister'
  | 'send_message'
  | 'check_inbox'
  | 'read_messages'
  | 'mark_read';

export const TOOL_NAMES: readonly ToolName[] = [
  'register',
  'create_channel',
  'join_channel',
  'list_channels',
  'deregister',
  'send_message',
  'check_inbox',
  'read_messages',
  'mark_read',
] as const;

/* ------------------------------------------------------------------ */
/* 3. LoomEvent union — the EventBus / live-feed payloads (FR-29/30)   */
/*    The SAME shape is fanned out to IPC and to the optional ws feed. */
/* ------------------------------------------------------------------ */

/** A new message was persisted. */
export interface MessageEvent {
  kind: 'message';
  message: MessageRow;
  /** Resolved recipient names for this message. */
  recipients: string[];
  /** Channel name (denormalized for convenience). */
  channel: string;
}

/** An agent registered, was suffixed/renamed, or went 'gone'. */
export interface AgentEvent {
  kind: 'agent';
  agent: AgentRow;
}

/** A channel was created, or its membership changed. */
export interface ChannelEvent {
  kind: 'channel';
  channel: ChannelRow;
  members: string[];
}

/** A receipt changed (e.g. mark_read updated read_at). */
export interface ReceiptEvent {
  kind: 'receipt';
  receipt: ReceiptRow;
}

/** A filesystem change inside the sandbox root (from chokidar). */
export interface FileEvent {
  kind: 'file';
  /** 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' */
  action: FileAction;
  /** Root-relative POSIX path. NEVER an absolute or escaping path. */
  path: string;
  /** Epoch ms when the watcher observed the event. */
  at: number;
}

export type FileAction = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

/** The frozen event union published on the bus and the live feed. */
export type LoomEvent =
  | MessageEvent
  | AgentEvent
  | ChannelEvent
  | ReceiptEvent
  | FileEvent;

export type LoomEventKind = LoomEvent['kind'];

/* ------------------------------------------------------------------ */
/* 4. File-dispatch contract — ext -> FileKind -> RenderState          */
/*    (FR-4..FR-10, FR-40). Deterministic by extension (NFR-6).        */
/* ------------------------------------------------------------------ */

/** Logical classification of a file by extension. */
export type FileKind = 'md' | 'code' | 'svg' | 'html' | 'image' | 'binary';

/** The render-state badge shown in the Viewer (FR-40, AC-19). */
export type RenderState = 'RENDERED' | 'SOURCE' | 'PREVIEW' | 'NO PREVIEW';

/** Resolved dispatch decision for a single file. */
export interface FileDispatch {
  kind: FileKind;
  renderState: RenderState;
  /** True when a safety banner must be shown (svg, html) (FR-41). */
  safetyBanner: boolean;
}

/* ------------------------------------------------------------------ */
/* 5. FileNode — the root-scoped explorer tree (FR-2, FR-3)            */
/* ------------------------------------------------------------------ */

export interface FileNode {
  type: 'file' | 'dir';
  /** Base name (no path separators). */
  name: string;
  /** Root-relative POSIX path. Root itself is ''. */
  path: string;
  /** Lowercase extension without dot, '' for none / dirs. */
  ext: string;
  /** Present for files; classification used by the Explorer icon + Viewer. */
  kind?: FileKind;
  /** Present for dirs; children sorted dirs-first then alpha. */
  children?: FileNode[];
  /** File size in bytes (files only). */
  size?: number;
  /** Last modified epoch ms (files only). */
  mtimeMs?: number;
}

/** Metadata card payload for the NO PREVIEW state (FR-43). */
export interface FileMeta {
  name: string;
  /** Human-readable size string, e.g. "2.4 KB". */
  size: string;
  /** Human-readable type label, e.g. "PNG image". */
  type: string;
  /** Human-readable modified time. */
  modified: string;
}

/** Payload returned by the preload `readFile` bridge for the Viewer. */
export interface FileContent {
  path: string;
  dispatch: FileDispatch;
  meta: FileMeta;
  /** UTF-8 text for md/code/svg/html; null for image/binary (never decoded). */
  text: string | null;
}

/* ------------------------------------------------------------------ */
/* 6. InitialState snapshot — sent to renderer on boot via IPC         */
/*    (FR-14: main is the single source of truth; renderer derives.)   */
/* ------------------------------------------------------------------ */

export interface SessionCounters {
  agents: number;   // active agents only
  channels: number;
  messages: number;
  receipts: number;
  files: number;    // files written/observed this session
}

export interface AgentView {
  name: string;
  status: AgentStatus;
  /** Per-agent unread count, derived from receipts. */
  unread: number;
  /** OPTIONAL agent role (e.g. "Writer"), surfaced as the inbox role line
   *  (FR-50). The real MCP protocol + agents schema (Appendix A) carry NO
   *  role, so this is undefined for every live backend and the role line is
   *  omitted gracefully — it exists only so a future role source can thread
   *  one through WITHOUT a contract break, and is never fabricated. */
  role?: string;
}

export interface ChannelView {
  id: number;
  name: string;
  members: string[];
  /** Visible message count for the channel tab badge (FR-47). */
  messageCount: number;
}

/** A fully materialized chat message for the renderer, with receipts. */
export interface MessageView {
  id: number;
  channel: string;
  channelId: number;
  sender: string;
  body: string;
  addressing: Addressing;
  target: string | null;
  created_at: number;
  receipts: ReceiptView[];
}

export interface ReceiptView {
  recipient: string;
  /** read_at epoch ms, or null if unread. */
  read_at: number | null;
}

/** The boot snapshot the renderer renders from. */
export interface InitialState {
  /** Sandbox root folder display name (FR-35, FR-38). */
  rootName: string;
  /** Persisted theme (FR-37, AC-20). */
  theme: Theme;
  /** Live state machine value (FR-36). */
  liveState: LiveState;
  tree: FileNode;
  agents: AgentView[];
  channels: ChannelView[];
  messages: MessageView[];
  counters: SessionCounters;
  /** True when the optional external ws observer feed is enabled (LOOM_WS=1). */
  wsEnabled: boolean;
}

/* ------------------------------------------------------------------ */
/* 7. UI state enums                                                   */
/* ------------------------------------------------------------------ */

export type Theme = 'dark' | 'light';

/** Status-bar live-session state machine (FR-36). 3 real states.
 *  LIVE: session active, receiving. PAUSED: human froze the feed.
 *  CAUGHT_UP: idle, no new events for a short window. */
export type LiveState = 'LIVE' | 'PAUSED' | 'CAUGHT_UP';

/** Persisted config file shape (userData/loom-config.json) (FR-37). */
export interface LoomConfig {
  theme: Theme;
}

/* ------------------------------------------------------------------ */
/* 8. IPC channel contract — every channel name + payload type         */
/*    (FR-13: all privileged access flows through the preload bridge.) */
/*    Naming: 'loom:<noun>:<verb>'. invoke = request/response;         */
/*    'loom:event' = main->renderer push.                              */
/* ------------------------------------------------------------------ */

export const IPC = {
  /** invoke(): InitialState — renderer asks main for the boot snapshot. */
  GET_INITIAL_STATE: 'loom:state:get',
  /** invoke(path: string): FileContent — read+dispatch a sandbox file. */
  READ_FILE: 'loom:file:read',
  /** invoke(): FileNode — re-read the sandbox tree. */
  GET_TREE: 'loom:tree:get',
  /** invoke(theme: Theme): void — persist the chosen theme. */
  SET_THEME: 'loom:theme:set',
  /** invoke(state: LiveState): void — human toggled pause/live. */
  SET_LIVE_STATE: 'loom:live:set',
  /** send(LoomEvent) main->renderer — the live event feed. */
  EVENT: 'loom:event',
  /** send(SessionCounters) main->renderer — telemetry tick. */
  COUNTERS: 'loom:counters',
  /** send(LiveState) main->renderer — live state machine changed. */
  LIVE_STATE: 'loom:live:state',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** The typed surface the preload bridge exposes on window.loom.
 *  Renderer code MUST only touch privileged main-process capability
 *  through this object (FR-13, NFR-3). */
export interface LoomBridge {
  getInitialState(): Promise<InitialState>;
  readFile(path: string): Promise<FileContent>;
  getTree(): Promise<FileNode>;
  setTheme(theme: Theme): Promise<void>;
  setLiveState(state: LiveState): Promise<void>;
  /** Subscribe to the live event feed. Returns an unsubscribe fn. */
  onEvent(handler: (e: LoomEvent) => void): () => void;
  /** Subscribe to telemetry counter updates. Returns an unsubscribe fn. */
  onCounters(handler: (c: SessionCounters) => void): () => void;
  /** Subscribe to live-state-machine changes. Returns an unsubscribe fn. */
  onLiveState(handler: (s: LiveState) => void): () => void;
}

declare global {
  interface Window {
    loom: LoomBridge;
  }
}

/* ------------------------------------------------------------------ */
/* 9. Engine surface — the 9 pure tool fns (src/main/engine.ts)        */
/*    Importable WITHOUT Electron so the acceptance suite can test it. */
/* ------------------------------------------------------------------ */

export interface LoomEngine {
  register(caller: Caller, params: RegisterParams): RegisterResult;
  create_channel(caller: Caller, params: CreateChannelParams): CreateChannelResult;
  join_channel(caller: Caller, params: JoinChannelParams): JoinChannelResult;
  list_channels(caller: Caller): ListChannelsResult;
  deregister(caller: Caller, params: DeregisterParams): DeregisterResult;
  send_message(caller: Caller, params: SendMessageParams): SendMessageResult;
  check_inbox(caller: Caller): CheckInboxResult;
  read_messages(caller: Caller, params: ReadMessagesParams): ReadMessagesResult;
  mark_read(caller: Caller, params: MarkReadParams): MarkReadResult;
}

/** Domain error thrown by the engine for contract violations
 *  (e.g. unregistered caller, not a channel member — Law 5). */
export class LoomError extends Error {
  constructor(
    public code: LoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoomError';
  }
}

export type LoomErrorCode =
  | 'NOT_REGISTERED'
  | 'NAME_TOO_LONG'
  /** A message body exceeded MAX_BODY_LENGTH characters (SEC-6). */
  | 'BODY_TOO_LONG'
  | 'CHANNEL_EXISTS'
  | 'CHANNEL_NOT_FOUND'
  | 'NOT_A_MEMBER'
  | 'RECIPIENT_NOT_MEMBER'
  | 'AGENT_NOT_FOUND'
  /** A caller attempted to act as / mutate an agent other than itself
   *  (e.g. deregister another agent by name). Identity is bound to the
   *  transport session at register() time (SEC-2). */
  | 'NOT_AUTHORIZED'
  | 'BAD_REQUEST';

/** Max agent-name length (OQ-1). */
export const MAX_NAME_LENGTH = 64;

/** Max message-body length, in characters (SEC-6). Bounds the per-line
 *  highlighter that renders chat bodies in the renderer's main thread so a
 *  single multi-megabyte fenced block cannot freeze the observer UI. The
 *  cap is enforced authoritatively at the engine boundary (FR-14) and is
 *  mirrored by the MCP send_message input schema for an early reject. */
export const MAX_BODY_LENGTH = 16_384;
