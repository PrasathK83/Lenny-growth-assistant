"use strict";
/* Lenny Growth Assistant - dependency-free frontend.
   Security: user text and source snippets are inserted with textContent. The only innerHTML is
   assistant `content_html`, which the server renders from Markdown and sanitises with an allow-list.
   Artifacts are never inserted into this page; they render in <iframe sandbox=""> via srcdoc. */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

let uid = localStorage.getItem("lga_user_id");
if (!uid) { uid = "u-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24); localStorage.setItem("lga_user_id", uid); }

const state = { sessionId: null, sessions: [], config: null, busy: false, lastText: null, artifact: null, artifactTab: "preview" };

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { "X-User-Id": uid, "Content-Type": "application/json", ...(opts.headers || {}) } });
  } catch (e) {
    throw { code: "NETWORK", message: "Cannot reach the server. Is the backend running?" };
  }
  if (res.status === 204) return null;
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw (data && data.error) || { code: "HTTP_" + res.status, message: "Request failed (" + res.status + ")" };
  return data;
}

/* ---------- alerts / status ---------- */
function showError(err, retry) {
  const box = $("alert"); box.replaceChildren();
  const msg = el("span", null, `${err.message || "Something went wrong."}${err.code ? " [" + err.code + "]" : ""}${err.request_id ? " · request " + err.request_id : ""}`);
  box.append(msg);
  if (retry) { const b = el("button", "btn", "Retry"); b.type = "button"; b.onclick = retry; box.append(b); }
  const x = el("button", "btn", "Dismiss"); x.type = "button"; x.onclick = () => (box.hidden = true); box.append(x);
  box.hidden = false;
}
function setBusy(on, text) {
  state.busy = on; $("send").disabled = on; $("composer-input").disabled = on;
  $("status").hidden = !on; $("status-text").textContent = text || "";
  if (!on) $("composer-input").focus();
}

/* ---------- config / provider toggle ---------- */
async function loadConfig() {
  try {
    state.config = await api("/api/config");
  } catch (e) { showError(e); return; }
  const sel = $("provider"); const prev = sel.value; sel.replaceChildren();
  for (const p of state.config.providers) {
    const o = el("option", null, `${p.name === "ollama" ? "Local" : "Cloud"} · ${p.name} · ${p.model}${p.available ? "" : " (unavailable)"}`);
    o.value = p.name; sel.append(o);
  }
  sel.value = prev || state.config.default_provider;
  const kb = state.config.knowledge_base;
  $("kb-status").textContent = kb.chunks ? `Knowledge base: ${kb.episodes} episodes, ${kb.chunks.toLocaleString()} passages` : `Knowledge base: ${kb.state}…`;
  updateProviderNote();
}
function updateProviderNote() {
  if (!state.config) return;
  const p = state.config.providers.find((x) => x.name === $("provider").value);
  $("provider-dot").className = "dot " + (p && p.available ? "ok" : "bad");
  const fb = state.config.fallback_provider;
  $("provider-note").textContent = (p && !p.available ? `${p.name}: ${p.reason}. ` : "") + (fb ? `If it fails, requests fall back to ${fb}.` : "No fallback configured.");
}
$("provider").addEventListener("change", updateProviderNote);

/* ---------- sessions ---------- */
async function loadSessions() {
  try { state.sessions = await api("/api/sessions"); } catch (e) { showError(e); return; }
  const ul = $("sessions"); ul.replaceChildren();
  for (const s of state.sessions) {
    const li = el("li"); const b = el("button", "open", s.title); b.type = "button";
    if (s.id === state.sessionId) b.setAttribute("aria-current", "true");
    b.onclick = () => openSession(s.id);
    const d = el("button", "del", "✕"); d.type = "button"; d.setAttribute("aria-label", "Delete chat: " + s.title);
    d.onclick = async () => { if (!confirm("Delete this chat?")) return; await api("/api/sessions/" + s.id, { method: "DELETE" }).catch(showError); if (state.sessionId === s.id) newChat(); else loadSessions(); };
    li.append(b, d); ul.append(li);
  }
}
async function openSession(id) {
  try {
    const d = await api("/api/sessions/" + id);
    state.sessionId = id; $("provider").value = d.provider; updateProviderNote();
    renderMessages(d.messages); loadSessions(); closeSidebar();
  } catch (e) { showError(e); }
}
function newChat() {
  state.sessionId = null; closeArtifact(); renderMessages([]); loadSessions(); closeSidebar(); $("composer-input").focus();
}
$("new-chat").onclick = newChat;

/* ---------- rendering ---------- */
const PROMPTS = ["How do the best teams think about activation vs. retention?", "What do guests say about pricing experiments?",
  "How should I hire my first product manager?", "Write a Ship 30 for 30 essay about product-market fit"];
function renderMessages(msgs) {
  const box = $("messages"); box.replaceChildren();
  if (!msgs.length) {
    const e = el("div", "empty"); e.append(el("h2", null, "Ask Lenny's Podcast"),
      el("p", "muted", "Answers come only from the podcast transcripts, with sources. Ask for a Ship 30 for 30 essay, or a Markdown/HTML artifact, any time."));
    const c = el("div", "chips");
    for (const p of PROMPTS) { const b = el("button", "chip", p); b.type = "button"; b.onclick = () => { $("composer-input").value = p; send(); }; c.append(b); }
    e.append(c); box.append(e); return;
  }
  msgs.forEach((m) => box.append(renderMessage(m)));
  box.scrollTop = box.scrollHeight;
}
function renderMessage(m) {
  if (m.role === "user") return el("div", "msg user", m.content);
  const wrap = el("article", "msg assistant"); wrap.setAttribute("aria-label", "Assistant answer");
  const body = el("div", "body"); body.innerHTML = m.content_html; wrap.append(body);   // server-sanitised
  const meta = el("div", "meta");
  if (m.kind === "refusal") meta.append(Object.assign(el("span", "badge refusal", "Not in the transcripts"), {}));
  if (m.kind === "essay" && m.meta.word_count) meta.append(el("span", "badge", m.meta.word_count.toLocaleString() + " words"));
  if (m.provider) meta.append(el("span", "badge", `${m.provider} · ${m.model}`));
  if (m.meta && m.meta.fallback_used) meta.append(el("span", "badge warn", "fallback used"));
  if (m.meta && m.meta.uncited) meta.append(el("span", "badge warn", "uncited"));
  if (m.latency_ms) meta.append(el("span", "badge", (m.latency_ms / 1000).toFixed(1) + " s"));
  if (meta.childNodes.length) wrap.append(meta);
  const cited = (m.sources || []).filter((s) => s.cited);
  if (cited.length) {
    const row = el("div", "sources"); row.setAttribute("role", "list"); row.setAttribute("aria-label", "Sources");
    const detail = el("div"); const btns = {};
    for (const s of cited) {
      const b = el("button", "src", `[${s.id}] ${s.guest} — ${s.title.split("|")[0].trim().slice(0, 48)}`);
      b.type = "button"; b.setAttribute("aria-expanded", "false"); b.setAttribute("role", "listitem"); btns[s.id] = b;
      b.onclick = () => showSource(s, b, detail, btns);
      row.append(b);
    }
    wrap.append(row, detail);
    body.querySelectorAll("a.cite").forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault(); const s = cited.find((x) => String(x.id) === a.dataset.n); if (s) showSource(s, btns[s.id], detail, btns, true);
    }));
  }
  if (m.artifact) {
    const card = el("div", "artifact-card"); const b = el("button", "btn primary", "Open “" + m.artifact.title + "”"); b.type = "button";
    b.onclick = () => openArtifact(m.artifact.id); card.append(b, el("span", "badge", m.artifact.type)); wrap.append(card);
  }
  return wrap;
}
function showSource(s, btn, detail, btns, forceOpen) {
  const open = btn.getAttribute("aria-expanded") === "true" && !forceOpen;
  Object.values(btns).forEach((b) => b.setAttribute("aria-expanded", "false")); detail.replaceChildren();
  if (open) return;
  btn.setAttribute("aria-expanded", "true");
  const d = el("div", "src-detail");
  d.append(el("strong", null, `${s.guest} — ${s.title}`));
  d.append(el("div", "small muted", [s.publish_date, s.timestamp && "at " + s.timestamp].filter(Boolean).join(" · ")));
  const links = el("div", "small");
  const addLink = (href, label) => { if (!href || !/^https:\/\//.test(href)) return; const a = el("a", null, label); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; if (links.childNodes.length) links.append(" · "); links.append(a); };
  addLink(s.url, "Open episode at this moment ↗");
  addLink(s.search_url, s.url ? "Video not playing? Search YouTube ↗" : "No video link on file: search YouTube ↗");
  d.append(links);
  d.append(el("blockquote", null, s.snippet + (s.snippet.length >= 320 ? "…" : "")));
  detail.append(d);
}

/* ---------- sending ---------- */
async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const s = await api("/api/sessions", { method: "POST", body: JSON.stringify({ provider: $("provider").value, metadata: { locale: navigator.language, viewport: innerWidth + "x" + innerHeight } }) });
  state.sessionId = s.id; return s.id;
}
async function send(textOverride) {
  if (state.busy) return;
  const input = $("composer-input"); const text = (typeof textOverride === "string" ? textOverride : input.value).trim();
  if (!text) return;
  $("alert").hidden = true; state.lastText = text; input.value = "";
  const box = $("messages"); if (box.querySelector(".empty")) box.replaceChildren();
  box.append(el("div", "msg user", text)); box.scrollTop = box.scrollHeight;
  const wait = $("provider").value === "ollama" ? "Searching transcripts and writing… local models can take a minute" : "Searching transcripts and writing…";
  setBusy(true, wait);
  try {
    const sid = await ensureSession();
    const r = await api(`/api/sessions/${sid}/messages`, { method: "POST", body: JSON.stringify({ content: text, provider: $("provider").value }) });
    box.append(renderMessage(r.assistant_message)); box.scrollTop = box.scrollHeight;
    if (r.assistant_message.artifact) openArtifact(r.assistant_message.artifact.id);
    loadSessions();
  } catch (e) {
    box.lastElementChild && box.lastElementChild.classList.contains("user") && box.lastElementChild.remove();
    showError(e, () => send(state.lastText));
  } finally { setBusy(false); }
}
$("send").onclick = () => send();
$("composer-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

/* ---------- artifact viewer & code editor ---------- */
function highlightHtmlCode(src) {
  if (!src) return "";
  let escaped = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  escaped = escaped.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-comment">$1</span>');
  escaped = escaped.replace(/(&lt;!DOCTYPE[\s\S]*?&gt;)/gi, '<span class="tok-doctype">$1</span>');
  escaped = escaped.replace(/&lt;(\/?[a-zA-Z0-9\-]+)([\s\S]*?)&gt;/g, (match, tag, rest) => {
    if (tag.startsWith("!--") || tag.toUpperCase().startsWith("!DOCTYPE")) return match;
    const isClosing = tag.startsWith("/");
    const tagName = isClosing ? tag.slice(1) : tag;
    const tagOpen = `&lt;${isClosing ? "/" : ""}<span class="tok-tag-name">${tagName}</span>`;
    const formattedRest = rest.replace(/([a-zA-Z0-9_\-:@.]+)(\s*=\s*)(".*?"|'.*?'|[^\s"'>=]+)?/g, (m, attr, eq, val) => {
      let v = "";
      if (val) v = `${eq}<span class="tok-val">${val}</span>`;
      else if (eq) v = eq;
      return `<span class="tok-attr">${attr}</span>${v}`;
    });
    return `<span class="tok-tag">${tagOpen}${formattedRest}&gt;</span>`;
  });
  return escaped;
}

function renderCodeEditor(content, type, title) {
  const code = content || "";
  const lines = code.split("\n");
  const gutter = $("code-editor-gutter");
  if (gutter) gutter.textContent = Array.from({ length: lines.length }, (_, i) => i + 1).join("\n");
  const linesCountEl = $("editor-lines-count");
  if (linesCountEl) linesCountEl.textContent = `${lines.length} lines`;
  const charsCountEl = $("editor-chars-count");
  if (charsCountEl) charsCountEl.textContent = `${code.length.toLocaleString()} chars`;

  const ext = type === "html" ? ".html" : ".md";
  const slug = (title || "artifact").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact";
  if ($("editor-filename")) $("editor-filename").textContent = slug + ext;
  if ($("editor-lang-badge")) $("editor-lang-badge").textContent = type === "html" ? "HTML5" : "MARKDOWN";
  if ($("editor-mode-badge")) $("editor-mode-badge").textContent = type === "html" ? "HTML Document" : "Markdown Doc";

  const srcEl = $("artifact-source");
  if (srcEl) {
    if (type === "html") srcEl.innerHTML = highlightHtmlCode(code);
    else srcEl.textContent = code;
  }
}

async function openArtifact(id) {
  try {
    const a = await api("/api/artifacts/" + id); state.artifact = a;
    $("artifact-title").textContent = a.title; $("artifact-type").textContent = a.type;
    $("artifact-frame").srcdoc = a.render_document;   // sandbox="" => no scripts, unique origin, no forms/popups
    renderCodeEditor(a.content, a.type, a.title);
    $("artifact").hidden = false; $("app").classList.add("has-artifact"); setTab("preview");
  } catch (e) { showError(e); }
}
function closeArtifact() { $("artifact").hidden = true; $("app").classList.remove("has-artifact"); $("artifact-frame").srcdoc = ""; state.artifact = null; }
function setTab(t) {
  state.artifactTab = t;
  for (const n of ["preview", "source"]) {
    $("tab-" + n).setAttribute("aria-selected", String(n === t)); $("tab-" + n).tabIndex = n === t ? 0 : -1; $("panel-" + n).hidden = n !== t;
  }
}
$("tab-preview").onclick = () => setTab("preview"); $("tab-source").onclick = () => setTab("source");
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const t = state.artifactTab === "preview" ? "source" : "preview"; setTab(t); $("tab-" + t).focus(); }
});
$("artifact-close").onclick = closeArtifact;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("artifact").hidden && innerWidth <= 1100) closeArtifact(); });
$("artifact-copy").onclick = async () => {
  if (!state.artifact) return;
  try { await navigator.clipboard.writeText(state.artifact.content); $("artifact-copy").textContent = "Copied"; } catch { $("artifact-copy").textContent = "Copy failed"; }
  setTimeout(() => ($("artifact-copy").textContent = "Copy"), 1500);
};

const wrapBtn = $("editor-wrap-btn");
if (wrapBtn) {
  wrapBtn.onclick = () => {
    const body = $("code-editor-body");
    const isNoWrap = body.classList.toggle("no-wrap");
    wrapBtn.setAttribute("aria-pressed", String(!isNoWrap));
    const label = wrapBtn.querySelector("span:not(.editor-btn-icon)");
    if (label) label.textContent = isNoWrap ? "Unwrap" : "Wrap";
  };
}
const editorCopyBtn = $("editor-copy-btn");
if (editorCopyBtn) {
  editorCopyBtn.onclick = async () => {
    if (!state.artifact) return;
    const txt = $("editor-copy-text");
    try {
      await navigator.clipboard.writeText(state.artifact.content);
      if (txt) txt.textContent = "Copied ✓";
    } catch {
      if (txt) txt.textContent = "Failed";
    }
    setTimeout(() => { if (txt) txt.textContent = "Copy"; }, 1500);
  };
}
$("artifact-download").onclick = async () => {
  if (!state.artifact) return;
  try {
    const res = await fetch(`/api/artifacts/${state.artifact.id}/download`, { headers: { "X-User-Id": uid } });
    if (!res.ok) throw new Error("download failed");
    const blob = await res.blob(); const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || "artifact.txt";
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { showError({ message: "Download failed.", code: "DOWNLOAD" }); }
};

/* ---------- mobile sidebar ---------- */
function closeSidebar() { $("app").classList.remove("sidebar-open"); $("toggle-sidebar").setAttribute("aria-expanded", "false"); }
$("toggle-sidebar").onclick = () => { const o = $("app").classList.toggle("sidebar-open"); $("toggle-sidebar").setAttribute("aria-expanded", String(o)); };

/* ---------- boot ---------- */
(async function init() {
  renderMessages([]);
  await loadConfig();
  await loadSessions();
  // Pause polling when the tab is hidden; resume (and refresh immediately) on re-focus.
  let _poll = setInterval(loadConfig, 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(_poll); _poll = null; }
    else { loadConfig(); _poll = setInterval(loadConfig, 15000); }
  });
})();