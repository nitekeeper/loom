/* ============================================================
   Loom — demo data
   A Claude sub-agent team auditing the `acme-api` repo and
   writing docs, watched live by a human.
   ============================================================ */

const AGENTS = [
  { id: "lead",    name: "lead",    role: "Lead · orchestrator", color: "var(--a-lead)",    initial: "L" },
  { id: "scout",   name: "scout",   role: "Researcher",          color: "var(--a-scout)",   initial: "S" },
  { id: "scout-2", name: "scout-2", role: "Researcher",          color: "var(--a-scout-2)", initial: "S" },
  { id: "scribe",  name: "scribe",  role: "Writer",              color: "var(--a-scribe)",  initial: "W" },
  { id: "critic",  name: "critic",  role: "Reviewer",            color: "var(--a-critic)",  initial: "C" },
];

const CHANNELS = [
  { id: "general",  name: "general",  members: ["lead", "scout", "scout-2", "scribe", "critic"] },
  { id: "research", name: "research", members: ["lead", "scout", "scout-2"] },
  { id: "docs",     name: "docs",     members: ["lead", "scribe", "critic"] },
];

/* ---- file tree (root-scoped). `born` = tick the file comes into existence ---- */
const TREE = [
  { type: "dir", name: "src", path: "src", open: true, children: [
    { type: "file", name: "index.ts",  path: "src/index.ts",  kind: "code", ext: "ts" },
    { type: "file", name: "server.ts", path: "src/server.ts", kind: "code", ext: "ts" },
    { type: "file", name: "db.ts",     path: "src/db.ts",     kind: "code", ext: "ts" },
  ]},
  { type: "dir", name: "docs", path: "docs", open: true, children: [
    { type: "file", name: "overview.md",      path: "docs/overview.md",      kind: "md" },
    { type: "file", name: "architecture.md",  path: "docs/architecture.md",  kind: "md", born: 74, modified: 100 },
  ]},
  { type: "file", name: "diagram.svg",  path: "diagram.svg",  kind: "svg",    ext: "svg" },
  { type: "file", name: "logo.png",     path: "logo.png",     kind: "image",  ext: "png" },
  { type: "file", name: "data.bin",     path: "data.bin",     kind: "binary", ext: "bin" },
  { type: "file", name: "notes.txt",    path: "notes.txt",    kind: "code",   ext: "txt" },
  { type: "file", name: "package.json", path: "package.json", kind: "code",   ext: "json" },
  { type: "file", name: "README.md",    path: "README.md",    kind: "md" },
];

const FILE_META = {
  "src/index.ts":         { size: "38 B",    modified: "today, 09:02", type: "TypeScript", lang: "ts" },
  "src/server.ts":        { size: "612 B",   modified: "today, 09:04", type: "TypeScript", lang: "ts" },
  "src/db.ts":            { size: "418 B",   modified: "today, 09:04", type: "TypeScript", lang: "ts" },
  "docs/overview.md":     { size: "74 B",    modified: "today, 09:01", type: "Markdown",   lang: "md" },
  "docs/architecture.md": { size: "522 B",   modified: "live",         type: "Markdown",   lang: "md" },
  "diagram.svg":          { size: "286 B",   modified: "today, 08:55", type: "SVG markup", lang: "svg" },
  "logo.png":             { size: "12.4 KB", modified: "yesterday",    type: "PNG image",  lang: "png" },
  "data.bin":             { size: "2.4 MB",  modified: "yesterday",    type: "application/octet-stream", lang: "bin" },
  "notes.txt":            { size: "131 B",   modified: "today, 08:40", type: "Plain text", lang: "txt" },
  "package.json":         { size: "284 B",   modified: "today, 08:30", type: "JSON",       lang: "json" },
  "README.md":            { size: "402 B",   modified: "today, 08:30", type: "Markdown",   lang: "md" },
};

const FILES = {
  "README.md":
`# acme-api

Internal REST API for the Acme platform.

## Status

Under audit by a **Loom** agent team. Research findings land in
\`#research\`, documentation in \`#docs\`.

## Scripts

- \`npm run dev\` — start the dev server
- \`npm test\` — run the suite

> Heads up: input validation is incomplete on several routes.
> See [architecture](docs/architecture.md).
`,

  "docs/overview.md":
`# Docs

Start with the [architecture overview](architecture.md).
`,

  "docs/architecture.md":
`# Architecture

## Request lifecycle

1. \`express.json()\` parses the request body
2. Auth middleware resolves the caller
3. The route handler runs its query through \`db.ts\`
4. A JSON response is returned

## Known issues

- **No connection pooling.** \`db.ts\` opens a single shared
  connection, so under load queries serialize.
- **Missing validation** on \`GET /users/:id\`.
`,

  "src/index.ts":
`import "./server";
`,

  "src/server.ts":
`import express from "express";
import { getUser, listUsers } from "./db";

const app = express();
app.use(express.json());

// TODO: no input validation on :id
app.get("/users/:id", async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json(user);
});

app.get("/users", async (_req, res) => {
  res.json(await listUsers());
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(\`up on :\${PORT}\`));
`,

  "src/db.ts":
`import Database from "better-sqlite3";

// single shared connection — no pooling (flagged in #research)
const db = new Database("acme.db");

export function getUser(id: string) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function listUsers() {
  return db.prepare("SELECT * FROM users").all();
}
`,

  "package.json":
`{
  "name": "acme-api",
  "version": "0.4.2",
  "private": true,
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest"
  },
  "dependencies": {
    "express": "^4.19.2",
    "better-sqlite3": "^11.0.0"
  }
}
`,

  "diagram.svg":
`<svg viewBox="0 0 220 80" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="26" width="58" height="30" rx="5" fill="#5aa6c8"/>
  <text x="37" y="45" font-size="10" text-anchor="middle">client</text>
  <line x1="66" y1="41" x2="150" y2="41" stroke="#888" stroke-dasharray="4 3"/>
  <rect x="150" y="26" width="62" height="30" rx="5" fill="#c8975a"/>
  <text x="181" y="45" font-size="10" text-anchor="middle">acme-api</text>
</svg>
`,

  "notes.txt":
`scratch notes — not part of the audit.
- check the rate limiter config before prod
- ask lead about the staging db snapshot
`,
};

/* ---- scripted timeline. t = seconds on the virtual clock ---- */
const TIMELINE = [
  { t: 2,   type: "msg", ch: "general",  from: "lead",    addr: "here",   body: "Kicking off the `acme-api` audit. scout + scout-2 on #research, scribe + critic on #docs. Post findings to your channel — I'll relay across." },
  { t: 11,  type: "msg", ch: "research", from: "lead",    addr: "here",   body: "Map the request lifecycle. scout: take `server.ts`. scout-2: take `db.ts`." },
  { t: 17,  type: "msg", ch: "research", from: "scout",   addr: "here",   body: "On it." },
  { t: 21,  type: "msg", ch: "research", from: "scout-2", addr: "here",   body: "On it." },
  { t: 35,  type: "msg", ch: "research", from: "scout",   addr: "here",   body: "`server.ts` — Express, 14 routes. Three have no input validation; `GET /users/:id` is the worst offender." },
  { t: 44,  type: "msg", ch: "research", from: "lead",    to: "scout",    addr: "direct", body: "Flag `/users/:id` explicitly in the writeup." },
  { t: 49,  type: "msg", ch: "research", from: "scout-2", addr: "here",   body: "`db.ts` opens one shared sqlite connection — no pooling. That's the latency spike under load." },
  { t: 58,  type: "msg", ch: "research", from: "scout",   to: "lead",     addr: "direct", body: "Consolidated findings ready: validation gap + the pooling issue scout-2 found." },
  { t: 64,  type: "msg", ch: "general",  from: "lead",    addr: "here",   body: "Research is landing. scribe — start `architecture.md` from the #research findings. critic — review as it goes." },
  { t: 70,  type: "msg", ch: "docs",     from: "lead",    addr: "here",   body: "scribe, focus on the request lifecycle + the pooling issue scout-2 flagged." },
  { t: 74,  type: "file", action: "create", path: "docs/architecture.md", by: "scribe" },
  { t: 79,  type: "msg", ch: "docs",     from: "scribe",  addr: "here",   body: "Draft of `architecture.md` is up — covered the lifecycle and the pooling issue." },
  { t: 93,  type: "msg", ch: "docs",     from: "critic",  to: "scribe",   addr: "direct", body: "Solid draft. The lifecycle is missing the auth middleware step. Add it and ship." },
  { t: 100, type: "file", action: "modify", path: "docs/architecture.md", by: "scribe" },
  { t: 104, type: "msg", ch: "docs",     from: "scribe",  to: "critic",   addr: "direct", body: "Added the auth step. Thanks for the catch." },
  { t: 112, type: "msg", ch: "docs",     from: "critic",  addr: "here",   body: "Approved. Good to merge." },
  { t: 119, type: "msg", ch: "general",  from: "lead",    addr: "here",   body: "Docs approved, research wrapped. Nice work, team — merging `architecture.md`." },
  { t: 126, type: "msg", ch: "general",  from: "scribe",  addr: "here",   body: "Onward." },
];

const TIMELINE_END = 160;

Object.assign(window, {
  LOOM: { AGENTS, CHANNELS, TREE, FILE_META, FILES, TIMELINE, TIMELINE_END },
});
