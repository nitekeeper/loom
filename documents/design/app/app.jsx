/* ============================================================
   Loom — app shell + virtual-clock engine
   ============================================================ */
const { useState: uS, useEffect: uE, useRef: uR, useMemo: uM } = React;

const MViewer = React.memo(window.Viewer);

const SunIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
  </svg>
);
const MoonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

function App() {
  const D = window.LOOM;
  const agentsById = uM(() => Object.fromEntries(D.AGENTS.map((a) => [a.id, a])), []);
  const goneSet = uM(() => new Set(), []);

  const [theme, setTheme] = uS(() => localStorage.getItem("loom-theme") || "dark");
  const [now, setNow] = uS(0);
  const [playing, setPlaying] = uS(true);
  const [speed, setSpeed] = uS(4);
  const [selected, setSelected] = uS("README.md");
  const [flash, setFlash] = uS(null);

  const nowRef = uR(0);
  const processed = uR(new Set());

  uE(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("loom-theme", theme);
  }, [theme]);

  // process file events as the clock crosses them
  const fireFileEvents = (t) => {
    D.TIMELINE.forEach((e, i) => {
      if (e.type !== "file") return;
      if (t >= e.t && !processed.current.has(i)) {
        processed.current.add(i);
        setFlash(e.path);
        if (e.action === "create") setSelected(e.path);
        setTimeout(() => setFlash((f) => (f === e.path ? null : f)), 2600);
      }
    });
  };

  // clock loop
  uE(() => {
    if (!playing) return;
    const id = setInterval(() => {
      let next = nowRef.current + 0.1 * speed;
      if (next >= D.TIMELINE_END) { next = D.TIMELINE_END; }
      nowRef.current = next;
      fireFileEvents(next);
      setNow(next);
      if (next >= D.TIMELINE_END) setPlaying(false);
    }, 100);
    return () => clearInterval(id);
  }, [playing, speed]);

  const finished = now >= D.TIMELINE_END;

  const replay = () => {
    processed.current = new Set();
    nowRef.current = 0;
    setNow(0);
    setFlash(null);
    setSelected("README.md");
    setPlaying(true);
  };
  const jumpLive = () => {
    // reveal everything up to end
    D.TIMELINE.forEach((e, i) => { if (e.type === "file") processed.current.add(i); });
    nowRef.current = D.TIMELINE_END;
    setNow(D.TIMELINE_END);
    setPlaying(false);
  };

  const msgs = window.allMessages();
  const visibleMsgs = msgs.filter((m) => now >= m.t).length;
  const filesWritten = D.TIMELINE.filter((e) => e.type === "file" && now >= e.t)
    .reduce((s, e) => { s.add(e.path); return s; }, new Set()).size;
  const liveReceipts = (() => {
    let r = 0;
    msgs.forEach((m) => { if (now >= m.t) window.recipientsOf(m).forEach((x) => { if (now >= window.readAt(m, x)) r++; }); });
    return r;
  })();

  const pillClass = finished ? "live-pill paused" : (playing ? "live-pill" : "live-pill paused");
  const pillText = finished ? "CAUGHT UP" : (playing ? "LIVE" : "PAUSED");

  return (
    <div className="win">
      {/* title bar */}
      <div className="titlebar">
        <div className="traffic"><i className="r" /><i className="y" /><i className="g" /></div>
        <div className="title-center">
          <span className="lock">🔒</span>
          <b className="mono">{D.root ? D.root.name : "acme-api"}</b>
          <span style={{ color: "var(--text-faint)" }}>— Loom</span>
        </div>
        <div className="title-right">
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-faint)" }}>loom .</span>
        </div>
      </div>

      {/* live status bar */}
      <div className="statusbar">
        <span className={pillClass}><span className="live-dot" />{pillText}</span>
        <span className="stat"><span className="clock">{window.timeStr(now)}</span></span>
        <span className="stat-sep" />
        <span className="stat"><b>{D.AGENTS.length}</b> agents</span>
        <span className="stat"><b>{D.CHANNELS.length}</b> channels</span>
        <span className="stat"><b>{visibleMsgs}</b> messages</span>
        <span className="stat"><b>{liveReceipts}</b> receipts</span>
        <span className="stat"><b>{filesWritten}</b> files written</span>

        <span className="grow" />

        <div className="transport">
          <button className="tbtn" onClick={replay} title="Replay from start">↺</button>
          <button className="tbtn primary" onClick={() => (finished ? replay() : setPlaying((p) => !p))} title={playing ? "Pause" : "Play"}>
            {finished ? "↺" : (playing ? "❚❚" : "▶")}
          </button>
          <button className="tbtn" onClick={jumpLive} title="Jump to end">⇥</button>
        </div>
        <div className="speed">
          {[1, 4, 12].map((s) => (
            <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>{s}×</button>
          ))}
        </div>
        <span className="stat-sep" />
        <button className="iconbtn" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>

      {/* body */}
      <div className="body">
        <window.Explorer root={D.root || { name: "acme-api" }} tree={D.TREE} sel={selected} onSelect={setSelected} now={now} flash={flash} />
        <MViewer path={selected} />
        <window.ChatPanel now={now} agentsById={agentsById} goneSet={goneSet} />
      </div>
    </div>
  );
}

// inject root meta into data
window.LOOM.root = { name: "acme-api", path: "~/work/acme-api" };

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
