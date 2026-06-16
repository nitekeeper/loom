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
/* 2. MCP tool param + return shapes — the 10 tools (FR-15..FR-27, R4) */
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

/** purge_all() -> human-invoked, total delete of ALL chat content for the
 *  folder (agents/channels/messages/receipts + .loom/temp report files).
 *  `deleted` holds the row counts present BEFORE the purge; `reports` is the
 *  number of transient report files removed from .loom/temp. After a purge the
 *  calling session's identity is stale (its agents row is gone) — callers MUST
 *  register() again before any further tool call. */
export interface PurgeAllResult {
  ok: true;
  deleted: {
    messages: number;
    channels: number;
    agents: number;
    reports: number;
  };
}

/** The identity of the calling agent. Every engine tool call is made
 *  on behalf of a caller; the MCP server binds caller = the registered
 *  name for that transport session. */
export interface Caller {
  /** Registered agent name, or null for not-yet-registered sessions. */
  name: string | null;
  /** The `connection_id` of the agents row THIS session registered, bound by
   *  register() alongside `name`. The engine accepts the session only while
   *  the live row's connection_id still matches — so after the human removes
   *  an agent (REMOVE_AGENT) and a NEW agent re-registers the freed bare
   *  name, the OLD session keeps failing NOT_REGISTERED instead of silently
   *  acting as its successor (identity capture). ADDITIVE + optional: a
   *  caller without one (hand-built test/demo callers) skips the check —
   *  every transport-bound session gets it from register(). */
  connectionId?: string | null;
}

/** Union of all 10 tool names — the frozen tool surface. */
export type ToolName =
  | 'register'
  | 'create_channel'
  | 'join_channel'
  | 'list_channels'
  | 'deregister'
  | 'send_message'
  | 'check_inbox'
  | 'read_messages'
  | 'mark_read'
  | 'purge_all';

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
  'purge_all',
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
  /** Present for dirs; children sorted dirs-first then alpha. A dir is
   *  delivered SHALLOW (children omitted, loaded:false) until the user expands
   *  it; the renderer then fetches its children via READ_DIR. */
  children?: FileNode[];
  /** Dirs only: true once this directory's children have been read. A lazily-
   *  delivered (unexpanded) dir is loaded:false with no `children` array. */
  loaded?: boolean;
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
  /** Base64 data URI (e.g. `data:image/png;base64,…`) when the file is a
   *  raster image or SVG and fits within the 10 MB image size cap; null otherwise. */
  imageData?: string | null;
}

/* ------------------------------------------------------------------ */
/* 5b. Project-wide content search (ADDITIVE) — VS-Code-style search   */
/*     over file CONTENTS, confined to the sandbox root (Law 3) and    */
/*     bounded (Law 1 / DoS). Mirrors READ_FILE/GET_TREE request shapes.*/
/* ------------------------------------------------------------------ */

/** A search request from the renderer. Empty/blank `query` yields no results. */
export interface SearchQuery {
  /** The substring to find in file contents. */
  query: string;
  /** Case-sensitive match. Default (undefined/false) = case-insensitive. */
  caseSensitive?: boolean;
}

/** One match within a file: 1-based line/col + the (truncated) line text and
 *  the match offsets INTO that line text for highlighting (Law 1: the renderer
 *  escapes lineText and wraps [matchStart, matchEnd) — never raw innerHTML). */
export interface SearchMatch {
  /** 1-based line number (aligns with the Viewer's rendered rows). */
  line: number;
  /** 1-based column of the match start in the original line. */
  col: number;
  /** The line's display text (truncated for safety). MUST be escaped before
   *  rendering — it is raw, attacker-influenced file content. */
  lineText: string;
  /** Match start offset INTO lineText (0-based). */
  matchStart: number;
  /** Match end offset INTO lineText (exclusive, 0-based). */
  matchEnd: number;
}

/** All matches found within a single file. */
export interface FileSearchResult {
  /** Root-relative POSIX path (same shape as FileNode.path). */
  path: string;
  /** Per-line matches, in file order. */
  matches: SearchMatch[];
}

/** A file whose NAME / root-relative PATH matched the query (ADDITIVE). This
 *  covers EVERY file — including image/binary — because matching the path
 *  needs no content read. matchStart/matchEnd index the FIRST match within the
 *  `path` string for highlighting (Law 1: the renderer escapes `path` and wraps
 *  [matchStart, matchEnd) in <mark> — never raw innerHTML). */
export interface FileNameMatch {
  /** Root-relative POSIX path (same shape as FileNode.path). */
  path: string;
  /** Match start offset INTO path (0-based char index). */
  matchStart: number;
  /** Match end offset INTO path (exclusive, 0-based char index). */
  matchEnd: number;
}

/** The full result set for a search run. */
export interface SearchResults {
  /** Files with at least one CONTENT match, in tree order. */
  results: FileSearchResult[];
  /** Files whose NAME / path matched the query, in tree order (ADDITIVE).
   *  Includes image/binary files (name matching reads no content). */
  fileMatches: FileNameMatch[];
  /** True when ANY scan/match bound was hit (results are partial). Kept as the
   *  single legacy flag; the two discriminators below say WHICH list is partial
   *  so the UI can phrase an actionable "refine to see more" caveat (UX-NAME-02). */
  truncated: boolean;
  /** True when the FILE-NAME list was capped (MAX_FILE_NAME_MATCHES) — there may
   *  be more file-name matches than shown (ADDITIVE; optional for back-compat). */
  truncatedNames?: boolean;
  /** True when the CONTENT results were capped (match-count or scanned-bytes
   *  budget) — there may be more content matches than shown (ADDITIVE; optional
   *  for back-compat). */
  truncatedContent?: boolean;
  /** Total number of CONTENT matches across all files (may exceed displayed). */
  total: number;
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
  /** Count of STALE agents — status='gone' rows ∪ status='active' rows with
   *  no live MCP session bound to their connection_id (dead/restart-orphaned
   *  agents that never deregistered; the reaper never flips db status, so
   *  they sit 'active' forever). Drives the roster's "clear stale (N)"
   *  button. Computed ONLY in main (the live-session map lives there) on the
   *  same COUNTERS tick as the others; the renderer must never guess
   *  staleness from AgentEvents. ADDITIVE; optional for back-compat. */
  staleAgents?: number;
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
  /** RESOLVED keyboard shortcut bindings (defaults merged with the
   *  persisted user overrides) — a full commandId -> canonical combo map
   *  for all customizable commands. The renderer dispatcher + Shortcuts
   *  panel read this; the panel writes overrides back via SET_KEYBINDINGS.
   *  Additive to the boot snapshot (mirrors `theme`). */
  keybindings: Record<string, string>;
  /** Number of terminal panes to boot with (1..3), threaded from the persisted
   *  LoomConfig.terminalCount (default 1). The renderer mounts this many panes
   *  on launch (visual no-op for upgrading single-terminal users). */
  terminalCount: number;
}

/* ------------------------------------------------------------------ */
/* 7. UI state enums                                                   */
/* ------------------------------------------------------------------ */

export type Theme = 'dark' | 'light';

/** Status-bar live-session state machine (FR-36). 3 real states.
 *  LIVE: session active, receiving. PAUSED: human froze the feed.
 *  CAUGHT_UP: idle, no new events for a short window. */
export type LiveState = 'LIVE' | 'PAUSED' | 'CAUGHT_UP';

/** Git working-tree status for a single file, populated by the main process
 *  reading `git status --porcelain` and pushed to the renderer on change.
 *  Persists until the file is committed (no expiry timer). */
export type GitFileStatus = 'modified' | 'added' | 'untracked' | 'staged';

/* ------------------------------------------------------------------ */
/* 7b. Git changes / diff (the "Changes" viewer)                       */
/* ------------------------------------------------------------------ */

/** How a file changed on the current branch relative to the base merge-base
 *  (git-diff "Changes" viewer). Mirrors git's name-status M/A/D/R/C codes. The
 *  producer surfaces added (committed adds AND untracked files) / modified /
 *  deleted (committed or worktree-deleted) / renamed; 'copied' is reserved for
 *  forward-compat (the listing runs -M without -C). */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

/** One file changed on the current branch vs. the base (default `main`) — the
 *  UNION of committed branch work and uncommitted working-tree changes.
 *  Produced from the two-dot worktree diff
 *  `git diff --name-status -M -z <mergeBaseSha> --` (before = merge-base,
 *  after = CURRENT working tree, naturally deduped) plus
 *  `git ls-files --others --exclude-standard` for untracked files (listed as
 *  'added'; .gitignore respected). `path` is the root-relative POSIX path of
 *  the NEW (worktree) side, same shape/keying as FileNode.path; confined to the
 *  sandbox root (Law 3). RAW git output — the renderer MUST escape
 *  `path`/`oldPath` before render (Law 1, like SearchMatch.lineText). */
export interface ChangedFile {
  path: string;
  changeKind: ChangeKind;
  /** Source (OLD) path for a rename/copy; null otherwise. */
  oldPath: string | null;
  /** True when git classified the file binary (numstat '-\t-'): the viewer shows
   *  a 'Binary file changed' card, never decoded bytes (Law 1). */
  binary: boolean;
}

/** Result of listing branch changes (GET_CHANGES). When the root is not a git
 *  repo, git is unavailable, or there is no base to diff against, `available`
 *  is false and `files` is empty (fail-soft, mirroring getGitStatus's empty
 *  contract). The renderer shows a graceful 'no changes' state, never an error. */
export interface ChangeSet {
  available: boolean;
  /** The base ref the changes were computed against (e.g. "main"); '' when none. */
  base: string;
  /** Current branch name (HEAD side), or null when detached/unknown. */
  branch: string | null;
  /** Every changed file — committed branch work UNION uncommitted working-tree
   *  changes (staged + unstaged + untracked), one row per file, in git order
   *  (untracked rows appended). */
  files: ChangedFile[];
}

/** One line inside a DiffHunk. `origin` selects styling; `text` is the line
 *  WITHOUT the leading +/-/space marker. RAW file content — escape before render. */
export interface DiffLine {
  origin: 'context' | 'add' | 'del';
  /** 1-based OLD-side line number (null for a pure addition). */
  oldLine: number | null;
  /** 1-based NEW-side line number (null for a pure deletion). */
  newLine: number | null;
  text: string;
}

/** One contiguous changed block, parsed from `git diff --unified=N --no-color`.
 *  Carries the @@ -oldStart,oldLines +newStart,newLines @@ header counts so the
 *  renderer draws gutter line numbers without re-parsing. `header` (optional
 *  function-context git emits after @@) is RAW — escape before render. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string;
  lines: DiffLine[];
}

/** The before->after diff for ONE changed file (READ_FILE_DIFF). Produced from
 *  the two-dot worktree diff `git diff --unified --no-color -M <mergeBaseSha>
 *  -- <path>` (before = merge-base, after = CURRENT working tree), parsed in
 *  main; an untracked file is diffed `--no-index` against /dev/null (empty
 *  before → all additions). Confined to the sandbox root (Law 3); hunk text is
 *  inert source (Law 1). `binary` mirrors FileContent's null-for-binary
 *  contract; `truncated` bounds a giant file (MAX_DIFF_BYTES on either side) —
 *  both null out `hunks` and show a placeholder. */
export interface FileDiff {
  path: string;
  oldPath: string | null;
  changeKind: ChangeKind;
  binary: boolean;
  truncated: boolean;
  /** Parsed hunks; null when binary or truncated; empty array when identical. */
  hunks: DiffHunk[] | null;
}

/** Persisted config file shape (userData/loom-config.json) (FR-37). */
export interface LoomConfig {
  theme: Theme;
  /** OPTIONAL user keyboard-shortcut OVERRIDES — a sparse map of
   *  commandId -> canonical combo string, holding ONLY the bindings that
   *  differ from the defaults. Absent/missing ⇒ all defaults. Persisted
   *  exactly like `theme`: written via SET_KEYBINDINGS, read on boot into
   *  the resolved InitialState.keybindings. Additive (a missing field on
   *  an older config is tolerated as {}). */
  keybindings?: Record<string, string>;
  /** OPTIONAL per-message body cap, in characters (SEC-6), overriding the
   *  MAX_BODY_LENGTH default (500). Validated as a positive integer; an
   *  absent/invalid value falls back to MAX_BODY_LENGTH. Enforced at RUNTIME
   *  (engine + MCP schema) and advertised in mcp.json so a reader knows the
   *  live limit. Additive (a missing field on an older config is tolerated). */
  maxMessageLength?: number;
  /** OPTIONAL cap on the persisted message COUNT per folder. Bounds memory and
   *  the per-flush full-image serialize cost under sustained multi-agent load:
   *  the newest N messages are kept; older ones (and their receipts) are pruned
   *  FK-safe on send and on load. 0 disables the cap (unlimited / fully
   *  persistent). Absent/invalid falls back to DEFAULT_MAX_MESSAGES. Additive
   *  (a missing field on an older config is tolerated). */
  maxMessages?: number;
  /** OPTIONAL number of terminal panes the renderer boots with (1..3). Persisted
   *  via SET_TERMINAL_LAYOUT, read on boot into InitialState.terminalCount.
   *  Validated as an integer CLAMPED to [1,3]; an absent/invalid value falls
   *  back to 1 (back-compat no-op for single-terminal users). Additive — a
   *  missing field on an older config is tolerated (no migration runner). */
  terminalCount?: number;
}

/* ------------------------------------------------------------------ */
/* 7c. Terminal pane (ADDITIVE) — the human-invoked PTY session         */
/*     carried over loom:terminal:*. PTY lives ONLY in main; the        */
/*     renderer drives it via the preload bridge. MCP-invisible: no     */
/*     agent surface touches the terminal.                             */
/* ------------------------------------------------------------------ */

/** Open a terminal session: initial xterm grid size. Supports up to 3
 *  concurrent terminal sessions, each addressed by its sessionId. main
 *  RE-VALIDATES cols/rows as finite integers within the TERMINAL_MIN/MAX
 *  bounds. */
export interface TerminalOpenParams { cols: number; rows: number; }

/** Result of TERMINAL_OPEN. `sessionId` is the per-spawn random token that
 *  every subsequent input/resize/close must carry (stale-id ⇒ silent no-op).
 *  null = open() at capacity (3) — neither spawns nor kills — OR terminal
 *  unavailable (the node-pty load/spawn failed); the pane shows a graceful
 *  empty state, never an error throw. */
export interface TerminalOpenResult { sessionId: string | null; }

/** TERMINAL_DATA push payload: a coalesced batch of PTY output. */
export interface TerminalDataPush { sessionId: string; data: string; }

/** TERMINAL_EXIT push payload: the PTY exited; the session is invalidated. */
export interface TerminalExitPush { sessionId: string; exitCode: number; }

/** Hard cap (bytes, Buffer.byteLength) on a single TERMINAL_INPUT write —
 *  bounds a hostile/runaway renderer paste; over-cap input is a silent no-op. */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;

/** Sane finite-integer bounds for TERMINAL_OPEN / TERMINAL_RESIZE cols/rows —
 *  anything outside is rejected as a silent no-op (never trust the renderer). */
export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 1000;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 1000;

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
  /** invoke(): FileNode — re-read the (shallow) sandbox tree. */
  GET_TREE: 'loom:tree:get',
  /** invoke(path: string): FileNode[] — read ONE level of a directory's
   *  children (lazy expand). The path is the root-relative POSIX dir path. */
  READ_DIR: 'loom:dir:read',
  /** invoke(q: SearchQuery): SearchResults — project-wide content search,
   *  confined to the sandbox root + bounded (Law 1/3). */
  SEARCH: 'loom:search',
  /** invoke(theme: Theme): void — persist the chosen theme. */
  SET_THEME: 'loom:theme:set',
  /** invoke(map: Record<string,string>): void — persist user keyboard
   *  shortcut OVERRIDES (sparse: only bindings differing from defaults). */
  SET_KEYBINDINGS: 'loom:keybindings:set',
  /** invoke(state: LiveState): void — human toggled pause/live. */
  SET_LIVE_STATE: 'loom:live:set',
  /** invoke(url: string): void — open a SAFE (http/https/mailto) external URL
   *  in the user's default browser via shell.openExternal. main re-validates the
   *  scheme; dangerous/relative targets are dropped. The renderer only ever
   *  passes URLs that already carry a vetted href (data-loom-ext links). */
  OPEN_EXTERNAL: 'loom:external:open',
  /** invoke(payload: { html: string; text: string }): void — write CLEANED,
   *  PORTABLE rendered Viewer content to the OS clipboard so it pastes formatted
   *  into Jira/Confluence/Docs/email (text/html) with a text/plain fallback. The
   *  renderer NEVER touches the clipboard directly — it hands an already-
   *  serialized {html, text} pair (allowlist-rebuilt, link-vetted) through this
   *  channel; main RE-VALIDATES the shape + bounds the size before writing
   *  (mirror of OPEN_EXTERNAL: never trust the renderer). Invalid input is a
   *  silent no-op. */
  COPY_TO_CLIPBOARD: 'loom:clipboard:write',
  /** invoke(): void — minimize the SENDER's window (custom frameless chrome on
   *  win32/linux). Takes NO args; main resolves the target window from the
   *  sender (never a caller-supplied id) so the renderer cannot act on another
   *  window. A no-op no-arg control: widens no privilege. */
  WINDOW_MINIMIZE: 'loom:window:minimize',
  /** invoke(): void — toggle maximize/restore on the SENDER's window. main
   *  reads the live isMaximized() and flips it; takes NO args. */
  WINDOW_TOGGLE_MAXIMIZE: 'loom:window:toggle-maximize',
  /** invoke(): void — close the SENDER's window. Takes NO args; resolves the
   *  target from the sender. */
  WINDOW_CLOSE: 'loom:window:close',
  /** invoke(): boolean — the AUTHORITATIVE maximize state of the SENDER's
   *  window, read synchronously in main via isMaximized(). Takes NO args;
   *  resolves the target from the sender. The renderer calls this ONCE on mount
   *  to seed its maximize<->restore glyph deterministically, closing the
   *  fire-and-forget did-finish-load push race (the WINDOW_MAXIMIZED push is
   *  sent before the renderer's listener attaches, and Electron does not replay
   *  it). Returns false when the sender window can't be resolved. */
  WINDOW_IS_MAXIMIZED: 'loom:window:is-maximized',
  /** invoke(): WindowBounds — the SENDER window's live screen rectangle (DIP),
   *  read in main via win.getBounds(). Takes NO args; resolves the target from
   *  the sender. The Linux frameless edge-resize handles read this at drag start
   *  to anchor the geometry (computeResizeBounds). Returns a zero rect when the
   *  sender window can't be resolved. */
  WINDOW_GET_BOUNDS: 'loom:window:get-bounds',
  /** invoke(b: WindowBounds): void — set the SENDER window's screen rectangle
   *  (DIP) during a Linux frameless edge-resize drag. Resolves the target from
   *  the sender (never a caller-supplied id). main RIGOROUSLY VALIDATES the
   *  payload (x/y/width/height all finite integers) and CLAMPS width/height to
   *  the window minimum + a sane maximum before applying; invalid input or an
   *  unresolved sender is a silent no-op (never trust the renderer). */
  WINDOW_SET_BOUNDS: 'loom:window:set-bounds',
  /** invoke(): void — open ANOTHER window onto the SAME folder in THIS process.
   *  Takes NO args (resolves nothing from the sender — every same-folder window
   *  shares the one db/engine/MCP/watcher, with its OWN renderer pump + terminal
   *  pool). Safe to duplicate because both windows write the single in-memory
   *  sql.js store; a SECOND OS process on the same folder would instead
   *  double-write loom.db, so same-folder duplication MUST stay in-process. */
  WINDOW_NEW: 'loom:window:new',
  /** invoke(): void — pop a native folder picker and open the chosen folder in a
   *  new window. main is the authority: if the pick equals THIS process's root it
   *  duplicates in-process (WINDOW_NEW path, shared db); if a LIVE Loom already
   *  serves that folder it informs + declines (two processes flushing one loom.db
   *  would clobber chat); otherwise it spawns a fresh, fully-isolated Loom process
   *  on that folder. Takes NO args — the renderer never supplies a path. */
  WINDOW_OPEN_FOLDER: 'loom:window:open-folder',
  /** invoke(name: string): boolean — HUMAN roster curation: remove ONE agent
   *  (any status) from the roster. main RE-VALIDATES the input (string,
   *  trimmed non-empty, <= MAX_NAME_LENGTH, existing row) and DELETEs the
   *  agents row plus its memberships/receipts; MESSAGES ARE PRESERVED (the
   *  sender column may dangle by design — the renderer never joins agents).
   *  For a still-active agent this is a FORCE-deregister with NO identity
   *  capture: session identity is the (name, connectionId) pair register()
   *  bound (Caller.connectionId vs the row's per-registration-unique
   *  connection_id), so the removed session's calls fail NOT_REGISTERED and
   *  KEEP failing even after a NEW agent re-registers the freed bare name.
   *  The stale transport object may linger if its client keeps polling
   *  (every poll refreshes the reaper's lastSeen) — harmless, since every
   *  call it makes is refused. Publishes the same 'gone' AgentEvent
   *  deregister publishes (the renderer drops the chip) plus one
   *  ChannelEvent per channel that lost the agent's membership. A removed
   *  name re-registers FRESH (no blocklist). Resolves whether a row was
   *  removed; invalid/unknown input is a fail-soft false. NO MCP tool
   *  counterpart — UI affordance only. */
  REMOVE_AGENT: 'loom:agent:remove',
  /** invoke(): number — HUMAN roster curation: remove ALL STALE agents at
   *  once (same delete semantics as REMOVE_AGENT, messages preserved; one
   *  'gone' AgentEvent per removed row + one ChannelEvent per channel that
   *  lost members). STALE = status='gone' ∪ status='active' with no live MCP
   *  session bound to the row's connection_id — the dead chips the human
   *  actually sees (agents that crash/exit never deregister and the reaper
   *  never touches the db). A LIVE connected agent is NEVER swept; the
   *  per-chip × (REMOVE_AGENT) is the only way to remove one. After an app
   *  relaunch every 'active' row is stale until its agent re-registers
   *  (sessions die with the process) — sweeping them all is intended.
   *  Resolves the count removed; 0 when none. Takes NO args. NO MCP tool
   *  counterpart — UI affordance only. */
  CLEAR_STALE_AGENTS: 'loom:agent:clear-stale',
  /** send(LoomEvent) main->renderer — the live event feed. */
  EVENT: 'loom:event',
  /** send(SessionCounters) main->renderer — telemetry tick. */
  COUNTERS: 'loom:counters',
  /** send(LiveState) main->renderer — live state machine changed. */
  LIVE_STATE: 'loom:live:state',
  /** send(maximized: boolean) main->renderer — the window's maximize state
   *  changed (or the initial state at load). Drives the custom title-bar
   *  maximize<->restore glyph + aria-label flip (frameless win32/linux). */
  WINDOW_MAXIMIZED: 'loom:window:maximized',
  /** send(Record<string,GitFileStatus>) main->renderer — git working-tree
   *  status map; pushed on boot and after every file-change event. */
  GIT_STATUS: 'loom:git:status',
  /** invoke(): ChangeSet — list every file changed vs. the base merge-base:
   *  committed branch work UNION uncommitted working-tree changes (staged +
   *  unstaged + untracked; two-dot worktree diff + ls-files --others). Confined
   *  to the sandbox root (Law 3); fail-soft available:false when not a git
   *  repo. */
  GET_CHANGES: 'loom:git:changes',
  /** invoke(path: string): FileDiff — the before->after unified diff for ONE
   *  changed file. `path` is a root-relative POSIX path from a prior
   *  ChangedFile; main RE-CONFINES it via sandbox.resolveInRoot before any git
   *  read (never trust the renderer; the git show object-store read bypasses the
   *  fs sandbox, so this re-check is mandatory). */
  READ_FILE_DIFF: 'loom:git:diff',
  /** invoke(p: TerminalOpenParams): TerminalOpenResult — spawn a terminal PTY
   *  session in main, cwd = the launch root. Up to 3 concurrent sessions, each
   *  addressed by its sessionId. open() at capacity (3) returns sessionId:null
   *  (spawns/kills nothing); sessionId:null also = terminal unavailable (the
   *  node-pty load/spawn failed) — graceful degradation, never a throw.
   *  ADDITIVE: a human-invoked surface; MCP-invisible (agents never reach it). */
  TERMINAL_OPEN: 'loom:terminal:open',
  /** invoke(p: { sessionId, data }): void — renderer keystrokes -> PTY stdin.
   *  main RE-VALIDATES (never trust the renderer): non-string data, payloads
   *  over MAX_TERMINAL_INPUT_BYTES, or a stale sessionId are silent no-ops. */
  TERMINAL_INPUT: 'loom:terminal:input',
  /** invoke(p: { sessionId, cols, rows }): void — resize the PTY. main
   *  RE-VALIDATES: cols/rows must be finite integers within the
   *  TERMINAL_MIN/MAX bounds; a stale sessionId is a silent no-op. */
  TERMINAL_RESIZE: 'loom:terminal:resize',
  /** invoke(p: { sessionId }): void — kill the PTY session (pane closed).
   *  A stale sessionId is a silent no-op. */
  TERMINAL_CLOSE: 'loom:terminal:close',
  /** send(TerminalDataPush) main->renderer — coalesced PTY output chunks. */
  TERMINAL_DATA: 'loom:terminal:data',
  /** send(TerminalExitPush) main->renderer — the PTY exited; the session id
   *  is invalidated (input/resize/close after exit are silent no-ops). */
  TERMINAL_EXIT: 'loom:terminal:exit',
  /** invoke(count: number): void — persist the desired terminal COUNT
   *  (how many panes are open, 1..3) to loom-config.json so the renderer
   *  boots with it next launch (threaded into InitialState.terminalCount).
   *  main RE-VALIDATES + CLAMPS the count to [1,3] (default 1 on
   *  missing/garbage); it carries NO sessionId — it is layout state, not a
   *  PTY control. ADDITIVE: a human-invoked surface; MCP-invisible. */
  TERMINAL_SET_LAYOUT: 'loom:terminal:set-layout',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** The typed surface the preload bridge exposes on window.loom.
 *  Renderer code MUST only touch privileged main-process capability
 *  through this object (FR-13, NFR-3). */
export interface LoomBridge {
  /** The host OS, read from `process.platform` in the preload (Node context;
   *  the renderer has no `process`). One of the Node platform strings:
   *  'darwin' | 'win32' | 'linux' | 'aix' | 'freebsd' | 'openbsd' | 'sunos' |
   *  'android' | 'cygwin' | 'netbsd' | 'haiku'. The renderer reads this to
   *  adapt platform-specific chrome (e.g. the macOS hiddenInset title bar).
   *  ADDITIVE — exposing read-only host platform widens no privilege. */
  platform: string;
  getInitialState(): Promise<InitialState>;
  readFile(path: string): Promise<FileContent>;
  getTree(): Promise<FileNode>;
  /** Read ONE level of a directory's children for lazy expansion. `path` is
   *  the root-relative POSIX dir path (the empty string is the root). */
  readDir(path: string): Promise<FileNode[]>;
  /** Project-wide content search over the sandbox root (confined + bounded). */
  search(q: SearchQuery): Promise<SearchResults>;
  setTheme(theme: Theme): Promise<void>;
  /** Persist the user keyboard-shortcut OVERRIDES (sparse id -> combo map,
   *  only entries differing from defaults). Mirrors setTheme. */
  setKeybindings(map: Record<string, string>): Promise<void>;
  setLiveState(state: LiveState): Promise<void>;
  /** Open a SAFE (http/https/mailto) external URL in the user's default browser.
   *  main re-validates the scheme; dangerous/relative targets are ignored. */
  openExternal(url: string): Promise<void>;
  /** Write CLEANED, PORTABLE rendered Viewer content to the OS clipboard as a
   *  text/html + text/plain pair, so it pastes formatted into external apps.
   *  main re-validates the shape + bounds the size; resolves `true` when it
   *  WROTE and `false` when the write was DROPPED (invalid shape or over the
   *  size cap), so the caller can give honest UI feedback (no false "Copied").
   *  The renderer hands an already-serialized {html, text} (never raw DOM). */
  copyToClipboard(payload: { html: string; text: string }): Promise<boolean>;
  /** Subscribe to the live event feed. Returns an unsubscribe fn. */
  onEvent(handler: (e: LoomEvent) => void): () => void;
  /** Subscribe to telemetry counter updates. Returns an unsubscribe fn. */
  onCounters(handler: (c: SessionCounters) => void): () => void;
  /** Subscribe to live-state-machine changes. Returns an unsubscribe fn. */
  onLiveState(handler: (s: LiveState) => void): () => void;
  /** Fetch the current git status map (path -> status). Returns {} when
   *  the root is not a git repository or git is not installed. */
  getGitStatus(): Promise<Record<string, GitFileStatus>>;
  /** Subscribe to git-status pushes from the main process. */
  onGitStatus(handler: (s: Record<string, GitFileStatus>) => void): () => void;
  /** List every file created/modified on the current branch vs. the base.
   *  Resolves available:false when the root is not a git repo or git is
   *  unavailable. */
  getChanges(): Promise<ChangeSet>;
  /** Fetch the before->after diff for ONE changed file. `path` is a root-relative
   *  POSIX path from a ChangedFile; main re-confines it to the sandbox. */
  readFileDiff(path: string): Promise<FileDiff>;
  /** HUMAN roster curation: remove ONE agent from the roster (force-deregister
   *  when still active). main re-validates the name + deletes the row; messages
   *  are preserved. Resolves true when a row was removed (fail-soft false). */
  removeAgent(name: string): Promise<boolean>;
  /** HUMAN roster curation: remove ALL stale agents at once (gone rows +
   *  actives with no live session — see CLEAR_STALE_AGENTS). Resolves the
   *  count removed. Takes no args; messages are preserved. */
  clearStaleAgents(): Promise<number>;
  /** Frameless custom-chrome window controls (win32/linux; on darwin the native
   *  inset traffic-lights are used instead and the renderer renders no controls).
   *  Each action takes NO untrusted input and acts ONLY on the SENDER window —
   *  main resolves the target from the IPC sender, never a caller-supplied id.
   *  Named "windowControls" (not "window") to avoid confusion with the global. */
  windowControls: WindowControls;
  /** The human-invoked terminal pane's PTY session controls (loom:terminal:*).
   *  Namespaced like windowControls. Every method hard-pins its single IPC.*
   *  constant in the preload; main RE-VALIDATES every payload (types, the
   *  per-spawn sessionId token, the MAX_TERMINAL_INPUT_BYTES cap) — invalid or
   *  stale input is a silent no-op. MCP-invisible: no agent surface. */
  terminal: TerminalBridge;
}

/** A window's screen rectangle (DIP), mirroring Electron's BrowserWindow
 *  getBounds()/setBounds() shape. Carried over WINDOW_GET_BOUNDS /
 *  WINDOW_SET_BOUNDS for the Linux frameless edge-resize handles. The pure
 *  resize geometry (renderer/lib/window-resize.ts) operates on this same shape. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The minimal frameless-chrome control surface (see LoomBridge.windowControls).
 *  Mirrors the three no-arg WINDOW_* invokes + the WINDOW_MAXIMIZED push, plus
 *  the get/set-bounds pair the Linux edge-resize handles drive. */
export interface WindowControls {
  /** Minimize the SENDER's window. */
  minimize(): Promise<void>;
  /** Toggle maximize/restore on the SENDER's window. */
  toggleMaximize(): Promise<void>;
  /** Close the SENDER's window. */
  close(): Promise<void>;
  /** Read the AUTHORITATIVE maximize state of the SENDER's window on demand.
   *  The renderer calls this once on mount to SEED its glyph deterministically
   *  instead of relying on the fire-and-forget initial WINDOW_MAXIMIZED push
   *  (which can race past a not-yet-attached listener — e.g. an in-app reload
   *  while maximized). Resolves false when the sender window is unresolved. */
  isMaximized(): Promise<boolean>;
  /** Subscribe to maximize-state changes (and the initial state on load) so the
   *  title bar can flip its maximize<->restore glyph + label. Returns an
   *  unsubscribe fn; the renderer never sees the IpcRendererEvent. */
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  /** Read the SENDER window's live screen rectangle (DIP). The Linux frameless
   *  edge-resize handles call this at drag start to anchor the geometry. */
  getBounds(): Promise<WindowBounds>;
  /** Set the SENDER window's screen rectangle (DIP) during a Linux frameless
   *  edge-resize drag. main re-validates + clamps the payload; an invalid shape
   *  or an unresolved sender window is a silent no-op. */
  setBounds(b: WindowBounds): Promise<void>;
  /** Open ANOTHER window onto the SAME folder in this process (shared db/MCP,
   *  own renderer pump + terminal pool). Takes no args. */
  newWindow(): Promise<void>;
  /** Pop a native folder picker and open the chosen folder in a new window —
   *  in-process when it is THIS folder, otherwise a fresh isolated Loom process
   *  (declining when a live Loom already serves it). Takes no args. */
  openFolder(): Promise<void>;
}

/** The terminal pane's bridge surface (see LoomBridge.terminal). Mirrors the
 *  four loom:terminal:* invokes + the TERMINAL_DATA / TERMINAL_EXIT pushes. */
export interface TerminalBridge {
  /** Spawn a terminal PTY session in main (cwd = launch root). Up to 3
   *  concurrent sessions, each addressed by its sessionId. open() at capacity
   *  (3) returns sessionId:null (spawns/kills nothing); sessionId:null also =
   *  terminal unavailable. */
  open(opts: TerminalOpenParams): Promise<TerminalOpenResult>;
  /** Forward keystrokes/paste to the PTY's stdin. main re-validates: a stale
   *  sessionId, non-string data, or an over-cap payload is a silent no-op. */
  input(sessionId: string, data: string): Promise<void>;
  /** Resize the PTY grid. main re-validates cols/rows as in-range finite
   *  integers; a stale sessionId is a silent no-op. */
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  /** Kill the PTY session (the pane closed). Stale id = silent no-op. */
  close(sessionId: string): Promise<void>;
  /** Subscribe to coalesced PTY output pushes. Returns an unsubscribe fn. */
  onData(h: (p: TerminalDataPush) => void): () => void;
  /** Subscribe to PTY exit pushes. Returns an unsubscribe fn. */
  onExit(h: (p: TerminalExitPush) => void): () => void;
  /** Persist the desired terminal COUNT (1..3 panes open) to loom-config.json
   *  so the renderer boots with it next launch. main re-validates + clamps to
   *  [1,3] (default 1 on garbage). Layout state, NOT a PTY control: carries no
   *  sessionId. Mirrors setTheme/setKeybindings. */
  setLayout(count: number): Promise<void>;
}

declare global {
  interface Window {
    loom: LoomBridge;
  }
}

/* ------------------------------------------------------------------ */
/* 9. Engine surface — the 10 pure tool fns (src/main/engine.ts)       */
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
  /** Human-invoked total delete of all chat content for the folder. Requires a
   *  registered caller. Empties every table (FK-safe) + removes .loom/temp
   *  report files; the caller's identity is stale afterward (must re-register). */
  purge_all(caller: Caller): PurgeAllResult;
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

/** DEFAULT max message-body length, in characters (SEC-6). Bounds the per-line
 *  highlighter that renders chat bodies in the renderer's main thread so a
 *  single multi-megabyte fenced block cannot freeze the observer UI. The
 *  cap is enforced authoritatively at the engine boundary (FR-14) and is
 *  mirrored by the MCP send_message input schema for an early reject.
 *
 *  CONFIGURABLE (R1): this is only the DEFAULT/fallback. The effective cap is
 *  resolved at runtime from LoomConfig.maxMessageLength (when a positive
 *  integer is set) and injected into the engine + MCP server; an absent or
 *  invalid config value falls back to this constant. */
export const MAX_BODY_LENGTH = 500;

/** Hard ceiling (bytes) on a single file's diff payload. A file whose base OR
 *  head blob exceeds this is reported truncated:true with null hunks so a
 *  multi-megabyte file can't flood the renderer's per-line highlighter
 *  (mirrors sandbox MAX_TEXT_BYTES). */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** DEFAULT cap on the number of persisted chat messages per folder. Bounds
 *  memory + the per-flush full-image serialize cost under sustained multi-agent
 *  load: the newest N messages are kept; older ones (and their receipts) are
 *  pruned FK-safe on send and on load. 0 disables the cap (unlimited / fully
 *  persistent). Overridable via LoomConfig.maxMessages. Generous by default so
 *  it never bites normal interactive use, only a runaway/marathon session. */
export const DEFAULT_MAX_MESSAGES = 10000;
