/* ============================================================
   Loom — Explorer (root-scoped tree) + Content Viewer (dispatch)
   ============================================================ */
const { useState } = React;

/* file-type chip color + label */
const KIND_ICON = {
  md:     { bg: "var(--a-scout-2)", t: "M" },
  code:   { bg: "var(--text-faint)", t: "{}" },
  svg:    { bg: "var(--a-critic)",  t: "<>" },
  image:  { bg: "var(--a-scribe)",  t: "IM" },
  binary: { bg: "var(--text-faint)", t: "B" },
};
function extIcon(node) {
  if (node.kind === "code") {
    if (node.ext === "json") return { bg: "var(--a-lead)", t: "{}" };
    if (node.ext === "ts")   return { bg: "var(--a-scout-2)", t: "TS" };
    if (node.ext === "txt")  return { bg: "var(--text-faint)", t: "T" };
  }
  return KIND_ICON[node.kind] || KIND_ICON.code;
}

function FileIcon({ node }) {
  const ic = extIcon(node);
  return <span className="fileicon" style={{ background: ic.bg }}>{ic.t}</span>;
}

function TreeNode({ node, depth, sel, onSelect, now, flash }) {
  const [open, setOpen] = useState(node.open !== false);
  const pad = { paddingLeft: 8 + depth * 14 };

  if (node.type === "dir") {
    return (
      <div>
        <div className="row" style={pad} onClick={() => setOpen((o) => !o)}>
          <span className={"twirl" + (open ? " open" : "")}>▶</span>
          <span className="fileicon" style={{ background: "transparent", color: "var(--text-faint)" }}>▤</span>
          <span className="fname" style={{ fontWeight: 600, color: "var(--text-dim)" }}>{node.name}</span>
        </div>
        {open && node.children.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} sel={sel} onSelect={onSelect} now={now} flash={flash} />
        ))}
      </div>
    );
  }

  // file — respect liveness: not born yet → hide
  if (node.born && now < node.born) return null;
  const isNew = node.born && now >= node.born && now < node.born + 18;
  const justMod = node.modified && now >= node.modified && now < node.modified + 14;
  const flashing = flash === node.path;

  return (
    <div
      className={"row" + (sel === node.path ? " sel" : "") + (flashing ? " flash" : "")}
      style={pad}
      onClick={() => onSelect(node.path)}
    >
      <span className="twirl" />
      <FileIcon node={node} />
      <span className="fname">{node.name}</span>
      {isNew && <span className="badge-new">NEW</span>}
      {!isNew && justMod && <span className="dot-touch" title="just modified by an agent" />}
    </div>
  );
}

function Explorer({ root, tree, sel, onSelect, now, flash }) {
  return (
    <div className="pane explorer">
      <div className="pane-head">
        <span style={{ color: "var(--text-faint)" }}>⊞</span>
        <span style={{ color: "var(--text)", letterSpacing: ".04em" }}>EXPLORER</span>
        <span className="grow" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-faint)", textTransform: "none", letterSpacing: 0 }}>
          {root.name}
        </span>
      </div>
      <div className="tree">
        <div className="sandbox-note">
          <span className="lk">🔒</span>
          <span>Root is a sandbox. The explorer never traverses above <b style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{root.name}/</b>.</span>
        </div>
        {tree.map((n) => (
          <TreeNode key={n.path} node={n} depth={0} sel={sel} onSelect={onSelect} now={now} flash={flash} />
        ))}
      </div>
    </div>
  );
}

/* ---------------- Viewer ---------------- */

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

function CodeView({ code }) {
  const lines = highlightCode(code);
  return (
    <div className="code">
      <div className="gutter">{lines.map((_, i) => <span key={i}>{i + 1}</span>)}</div>
      <div className="codecol">
        <pre>{lines.map((l, i) => (
          <span className="ln" key={i} dangerouslySetInnerHTML={{ __html: l }} />
        ))}</pre>
      </div>
    </div>
  );
}

function Viewer({ path, now }) {
  if (!path) {
    return (
      <div className="pane viewer">
        <div className="viewer-head"><span className="crumb">no file selected</span></div>
        <div className="empty-viewer">
          <div>Select a file to view it.</div>
          <div className="mono">Everything renders as something — nothing executes.</div>
        </div>
      </div>
    );
  }

  const meta = window.LOOM.FILE_META[path] || {};
  const content = window.LOOM.FILES[path];
  const node = findNode(window.LOOM.TREE, path);
  const kind = node ? node.kind : "binary";
  const parts = path.split("/");

  let tag, tagClass, banner = null, bodyEl;

  if (kind === "md") {
    tag = "RENDERED"; tagClass = "rendered";
    bodyEl = <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content || "") }} />;
  } else if (kind === "svg") {
    tag = "SOURCE"; tagClass = "source";
    banner = "Shown as source. Loom never renders agent-authored SVG or HTML — that removes the entire sandboxed-webview problem.";
    bodyEl = <CodeView code={content || ""} />;
  } else if (kind === "code") {
    tag = "SOURCE"; tagClass = "source";
    if (path.endsWith(".html")) banner = "HTML is shown as source, never rendered.";
    bodyEl = <CodeView code={content || ""} />;
  } else if (kind === "image") {
    tag = "PREVIEW"; tagClass = "rendered";
    bodyEl = (
      <div className="imgwrap">
        <div className="imgprev"><span className="ph">{meta.type} · safe preview</span></div>
      </div>
    );
  } else {
    tag = "NO PREVIEW"; tagClass = "none";
    bodyEl = (
      <div className="noprev">
        <div className="noprev-card">
          <div className="big">∅</div>
          <h4>{parts[parts.length - 1]}</h4>
          <p>Binary file — Loom won't guess at it.</p>
          <dl className="meta-grid">
            <dt>name</dt><dd>{parts[parts.length - 1]}</dd>
            <dt>size</dt><dd>{meta.size}</dd>
            <dt>type</dt><dd>{meta.type}</dd>
            <dt>modified</dt><dd>{meta.modified}</dd>
          </dl>
        </div>
      </div>
    );
  }

  return (
    <div className="pane viewer">
      <div className="viewer-head">
        <span className="crumb">
          {parts.map((p, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sl">/</span>}
              {i === parts.length - 1 ? <b>{p}</b> : <span>{p}</span>}
            </React.Fragment>
          ))}
        </span>
        <span className={"render-tag " + tagClass}>{tag}</span>
      </div>
      <div className="viewer-body">
        {banner && (
          <div className="safety-banner"><ShieldIcon />{banner}</div>
        )}
        {bodyEl}
      </div>
    </div>
  );
}

function findNode(nodes, path) {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) { const f = findNode(n.children, path); if (f) return f; }
  }
  return null;
}

Object.assign(window, { Explorer, Viewer, findNode });
