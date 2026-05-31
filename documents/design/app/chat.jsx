/* ============================================================
   Loom — Chat layer (channels, receipts, roster, inbox lens)
   Read-only for the human. The composer is replaced by an
   observer notice (design law: chat is for agents, not the human).
   ============================================================ */
const { useState: useStateC, useRef: useRefC, useEffect: useEffectC } = React;

const BASE_CLOCK = 9 * 3600 + 30 * 60; // 09:30:00
function timeStr(t) {
  const s = BASE_CLOCK + Math.floor(t);
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor(s / 60) % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function hashName(n) { let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) & 0xffff; return h; }

/* messages (with stable index) */
function allMessages() {
  return window.LOOM.TIMELINE.map((e, i) => ({ ...e, idx: i })).filter((e) => e.type === "msg");
}
function channelMembers(chId) {
  const ch = window.LOOM.CHANNELS.find((c) => c.id === chId);
  return ch ? ch.members : [];
}
function recipientsOf(msg) {
  if (msg.addr === "direct") return [msg.to];
  return channelMembers(msg.ch).filter((a) => a !== msg.from);
}
/* deterministic per-recipient read time; lead reads fast */
function readAt(msg, recipient) {
  if (recipient === "lead") return msg.t + 4 + (msg.idx % 3) * 2;
  const off = 6 + ((msg.idx * 7 + hashName(recipient)) % 28);
  return msg.t + off;
}

function Avatar({ agent, size = 30, showOn = false, unread = 0, gone = false, onClick, title }) {
  if (!agent) return null;
  const fs = Math.round(size * 0.42);
  return (
    <span
      className={"avatar" + (gone ? " gone" : "")}
      style={{ width: size, height: size, background: agent.color, fontSize: fs, opacity: gone ? 0.55 : 1, cursor: onClick ? "pointer" : "default" }}
      onClick={onClick}
      title={title}
    >
      {agent.initial}
      {showOn && <span className="on" />}
      {unread > 0 && <span className="unread-badge">{unread}</span>}
    </span>
  );
}

/* ---- per-message receipt strip ---- */
function ReceiptStrip({ msg, now, agentsById }) {
  const recips = recipientsOf(msg);
  if (msg.addr === "direct") {
    const r = recips[0];
    const seen = now >= readAt(msg, r);
    return (
      <div className={"receipt" + (seen ? " seen" : "")}>
        <span className="chk">{seen ? "✓✓" : "✓"}</span>
        <span>→ {r} · {seen ? "seen" : "delivered"}</span>
      </div>
    );
  }
  const states = recips.map((r) => ({ r, read: now >= readAt(msg, r) }));
  const read = states.filter((s) => s.read).length;
  const tot = states.length;
  const full = read === tot;
  return (
    <div className={"receipt" + (full ? " seen" : "")}>
      <span className="chk">{full ? "✓✓" : "✓"}</span>
      <span>→ @here</span>
      <span className="bar"><i style={{ width: (tot ? (read / tot) * 100 : 0) + "%" }} /></span>
      <span>{read}/{tot} read</span>
      <div className="tip">
        <div className="tip-title">delivered to @here</div>
        {states.map((s) => (
          <div className="tip-row" key={s.r}>
            <Avatar agent={agentsById[s.r]} size={18} />
            <span className="who">{s.r}</span>
            <span className={"st" + (s.read ? " read" : "")}>{s.read ? "seen" : "unread"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MsgBody({ body }) {
  return <div className="msg-body" dangerouslySetInnerHTML={{ __html: mdInline(body) }} />;
}

function Message({ msg, now, agentsById }) {
  const a = agentsById[msg.from];
  return (
    <div className="msg">
      <div className="av-col"><Avatar agent={a} size={30} /></div>
      <div>
        <div className="msg-head">
          <span className="msg-name" style={{ color: a.color }}>{a.name}</span>
          {msg.addr === "here"
            ? <span className="addr here">@here</span>
            : <span className="addr">→ {msg.to}</span>}
          <span className="msg-time">{timeStr(msg.t)}</span>
        </div>
        <MsgBody body={msg.body} />
        <ReceiptStrip msg={msg} now={now} agentsById={agentsById} />
      </div>
    </div>
  );
}

function Typing({ agent }) {
  return (
    <div className="typing">
      <div className="av-col"><Avatar agent={agent} size={30} /></div>
      <div>
        <div className="typing-who">{agent.name} is typing…</div>
        <div className="typing-bubble"><i /><i /><i /></div>
      </div>
    </div>
  );
}

/* ---- thread for a channel ---- */
function Thread({ channelId, now, agentsById }) {
  const ref = useRefC(null);
  const msgs = allMessages().filter((m) => m.ch === channelId && now >= m.t);

  // typing: next upcoming message in this channel, within 3s
  const upcoming = allMessages().filter((m) => m.ch === channelId && m.t > now).sort((a, b) => a.t - b.t)[0];
  const typing = upcoming && upcoming.t - now <= 3 ? agentsById[upcoming.from] : null;

  useEffectC(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [msgs.length, typing ? typing.id : ""]);

  return (
    <div className="thread" ref={ref}>
      <div className="daysep">— today · {timeStr(0)} —</div>
      {msgs.length === 0 && !typing && (
        <div className="inbox-empty">No messages in this channel yet.</div>
      )}
      {msgs.map((m) => <Message key={m.idx} msg={m} now={now} agentsById={agentsById} />)}
      {typing && <Typing agent={typing} />}
    </div>
  );
}

/* ---- inbox lens for one agent ---- */
function InboxLens({ agent, now, agentsById, onBack }) {
  const items = allMessages()
    .filter((m) => now >= m.t && recipientsOf(m).includes(agent.id))
    .map((m) => ({ ...m, read: now >= readAt(m, agent.id) }));
  const unread = items.filter((i) => !i.read).length;

  return (
    <>
      <div className="inbox-head">
        <span className="back" onClick={onBack}>← channels</span>
        <Avatar agent={agent} size={30} showOn />
        <div>
          <div className="inbox-title">{agent.name}</div>
          <div className="inbox-sub">{agent.role} · {unread} unread / {items.length} in inbox</div>
        </div>
      </div>
      <div className="thread" style={{ padding: 0 }}>
        {items.length === 0 && <div className="inbox-empty">Inbox is empty.<br />Nothing has been addressed to {agent.name} yet.</div>}
        {items.slice().reverse().map((m) => {
          const from = agentsById[m.from];
          return (
            <div className={"inbox-item" + (m.read ? "" : " unread")} key={m.idx}>
              <Avatar agent={from} size={26} />
              <div>
                <div><span className="ib-from" style={{ color: from.color }}>{from.name}</span>{" "}
                  <span className="ib-ch">#{m.ch} · {m.addr === "here" ? "@here" : "direct"}</span></div>
                <div className="ib-body" dangerouslySetInnerHTML={{ __html: mdInline(m.body) }} />
              </div>
              <span className={"ib-state " + (m.read ? "read" : "unread")}>{m.read ? "read" : "new"}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---- chat panel ---- */
function ChatPanel({ now, agentsById, goneSet }) {
  const [channel, setChannel] = useStateC("general");
  const [inboxAgent, setInboxAgent] = useStateC(null);

  // per-agent unread counts at `now`
  const unreadByAgent = {};
  window.LOOM.AGENTS.forEach((a) => { unreadByAgent[a.id] = 0; });
  allMessages().forEach((m) => {
    if (now < m.t) return;
    recipientsOf(m).forEach((r) => { if (now < readAt(m, r)) unreadByAgent[r] = (unreadByAgent[r] || 0) + 1; });
  });

  // per-channel visible counts
  const chCount = {};
  window.LOOM.CHANNELS.forEach((c) => {
    chCount[c.id] = allMessages().filter((m) => m.ch === c.id && now >= m.t).length;
  });

  return (
    <div className="pane chat">
      <div className="pane-head">
        <span style={{ color: "var(--accent)" }}>◆</span>
        <span style={{ color: "var(--text)", letterSpacing: ".04em" }}>AGENT CHAT</span>
        <span className="grow" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-faint)", textTransform: "none", letterSpacing: 0 }}>
          {window.LOOM.AGENTS.filter((a) => !goneSet.has(a.id)).length} active
        </span>
      </div>

      {/* roster strip */}
      <div className="roster">
        <span className="lbl">roster</span>
        {window.LOOM.AGENTS.map((a) => {
          const gone = goneSet.has(a.id);
          return (
            <div
              key={a.id}
              className={"rchip" + (inboxAgent === a.id ? " active" : "") + (gone ? " gone" : "")}
              onClick={() => setInboxAgent(inboxAgent === a.id ? null : a.id)}
              title={`Open ${a.name}'s inbox`}
            >
              <Avatar agent={a} size={22} showOn unread={unreadByAgent[a.id]} gone={gone} />
              <span className="nm">{a.name}</span>
            </div>
          );
        })}
      </div>

      {inboxAgent ? (
        <InboxLens agent={agentsById[inboxAgent]} now={now} agentsById={agentsById} onBack={() => setInboxAgent(null)} />
      ) : (
        <>
          <div className="channels">
            {window.LOOM.CHANNELS.map((c) => (
              <div key={c.id} className={"chtab" + (channel === c.id ? " on" : "")} onClick={() => setChannel(c.id)}>
                <span>#{c.name}</span>
                <span className="mem">{c.members.length}</span>
                {chCount[c.id] > 0 && channel !== c.id && <span className="cnt">{chCount[c.id]}</span>}
              </div>
            ))}
          </div>
          <Thread channelId={channel} now={now} agentsById={agentsById} />
          <div className="observer">
            <span className="eye">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
              </svg>
            </span>
            <span className="txt"><b>You're observing.</b> This channel belongs to the agents — they post and read on their own. You can't be seen here.</span>
          </div>
        </>
      )}
    </div>
  );
}

Object.assign(window, { ChatPanel, timeStr, allMessages, recipientsOf, readAt, Avatar });
