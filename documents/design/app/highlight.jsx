/* ============================================================
   Loom — rendering helpers
   - escapeHtml
   - highlightLine: per-line tokenizer (string / comment / number /
     keyword / punctuation). Per-line keeps line numbers honest.
   - renderMarkdown: compact, safe markdown -> HTML
   These NEVER execute content; they only style it.
   ============================================================ */

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const KEYWORDS = new Set([
  "import", "from", "export", "default", "const", "let", "var", "function",
  "return", "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "async", "await", "new", "class", "extends", "try", "catch",
  "finally", "throw", "type", "interface", "as", "of", "in", "typeof",
  "instanceof", "void", "yield", "this", "super",
]);
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN"]);

/* Tokenize one line. No multi-line constructs in the sample set, so
   per-line scanning is safe and keeps the gutter aligned. */
function highlightLine(line) {
  const re = /(\/\/[^\n]*|#![^\n]*|<!--.*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()\[\].,;:<>=+\-*/%!?&|]+)/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out += escapeHtml(line.slice(last, m.index));
    if (m[1]) {
      out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
    } else if (m[2]) {
      out += `<span class="tok-str">${escapeHtml(m[2])}</span>`;
    } else if (m[3]) {
      out += `<span class="tok-num">${escapeHtml(m[3])}</span>`;
    } else if (m[4]) {
      const w = m[4];
      const after = line.slice(re.lastIndex);
      if (KEYWORDS.has(w) || LITERALS.has(w)) {
        out += `<span class="tok-kw">${escapeHtml(w)}</span>`;
      } else if (/^\s*\(/.test(after)) {
        out += `<span class="tok-fn">${escapeHtml(w)}</span>`;
      } else {
        out += escapeHtml(w);
      }
    } else if (m[5]) {
      out += `<span class="tok-punc">${escapeHtml(m[5])}</span>`;
    }
    last = re.lastIndex;
  }
  if (last < line.length) out += escapeHtml(line.slice(last));
  return out || "&nbsp;";
}

function highlightCode(code) {
  return code.replace(/\n$/, "").split("\n").map(highlightLine);
}

/* ---- inline markdown ---- */
function mdInline(text) {
  let t = escapeHtml(text);
  // code spans first (protect contents from further formatting)
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="#" onclick="return false">$1</a>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return t;
}

function renderMarkdown(md) {
  const lines = md.replace(/\n$/, "").split("\n");
  let html = "";
  let i = 0;
  let listType = null;

  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (/^```/.test(line)) {
      closeList();
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const rendered = highlightCode(buf.join("\n")).map((l) => `<span class="ln">${l}</span>`).join("");
      html += `<pre class="md-code"><code>${rendered}</code></pre>`;
      continue;
    }

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      html += `<h${lvl}>${mdInline(m[2])}</h${lvl}>`;
      i++; continue;
    }
    if (/^---+\s*$/.test(line)) { closeList(); html += "<hr/>"; i++; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      const buf = [m[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      html += `<blockquote>${mdInline(buf.join(" "))}</blockquote>`;
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += `<li>${mdInline(m[1])}</li>`;
      i++; continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
      html += `<li>${mdInline(m[1])}</li>`;
      i++; continue;
    }
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    // paragraph (gather consecutive non-empty, non-special lines)
    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|>|\s*[-*]\s|\s*\d+\.\s|```|---)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    html += `<p>${mdInline(buf.join(" "))}</p>`;
  }
  closeList();
  return html;
}

Object.assign(window, { escapeHtml, highlightCode, renderMarkdown, mdInline });
