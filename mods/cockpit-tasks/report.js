// The Tasks report: one self-contained HTML page (no server, no network) built from tasks.json and
// tasks-archive.json, opened in the browser. Filters, charts and the table run in the page itself.
// Pure: the caller reads the files and writes the result.

import { taskKey } from "./work.js";

// Only what the report shows (notes and links for a task's detail popup). A task deleted before it was
// done was dropped, not finished: it stays out. One deleted after it was done still counts.
export function reportRows(tasks) {
  return tasks.filter((x) => !(x.deleted && x.status !== "done")).map((x) => {
    const key = taskKey(x);
    return {
      id: x.id,
      title: String(x.title ?? ""),
      notes: String(x.notes ?? ""),
      links: Array.isArray(x.links) ? x.links : [],
      status: x.status,
      created: x.created ?? null,
      doneAt: x.status === "done" ? (x.doneAt ?? x.updated ?? null) : null,
      updated: x.updated ?? null,
      agent: x.agent ?? null,
      key,
      project: key ? key.split("-")[0] : null,
      archived: x.archived ?? null,
      history: Array.isArray(x.history) ? x.history : [],
      blocked: x.blocked && x.status !== "done" ? x.blocked : null,
      todayAt: x.todayAt ?? null,
      log: Array.isArray(x.log) ? x.log : [],
      deleted: x.deleted ?? null,
    };
  });
}

// The start of the last working day before `now` (Mon to Fri): Friday on a Monday or a weekend.
// Its source is also put into the page, so the page and the tests run the same code.
export function lastWorkday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}

// When work started: the last move to "doing" at or before it was done (or before now while doing).
export function startedAt(row) {
  const end = row.doneAt ?? Infinity;
  const doing = row.history.filter((h) => h.status === "doing" && h.at <= end);
  return doing.length ? doing[doing.length - 1].at : null;
}

// `</script>` in a title must not end the data block.
const embed = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

// jira: your Jira site (config.json), or null: keys then show without a link.
export function reportHtml(tasks, now = Date.now(), jira = null) {
  const rows = reportRows(tasks).map((r) => ({ ...r, started: startedAt(r) }));
  // A function replacement: "$&" in a title must stay literal.
  // The code first: a title can't then be mistaken for its placeholder.
  return PAGE.replace("/*__LIB__*/", () => lastWorkday.toString())
    .replace("__DATA__", () => embed({ rows, generated: now, jira: jira ? jira.replace(/\/+$/, "") + "/browse/" : null }));
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tasks Report</title>
<style>
:root {
  --bg: #f7f7f5; --surface: #ffffff; --raised: #f0f0ed; --border: #e4e4df;
  --fg: #1d1d1b; --muted: #5f5f5a; --dim: #8d8d86;
  --accent: #3b6fd8; --done: #2f9e68; --doing: #d08a1f; --todo: #9a9a93;
  --bar: #3b6fd8; --bar-soft: #3b6fd833; --blocked: #d4483b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141413; --surface: #1c1c1a; --raised: #262624; --border: #30302d;
    --fg: #ececea; --muted: #b0b0aa; --dim: #7b7b75;
    --accent: #7aa2f7; --done: #57c38f; --doing: #e5a845; --todo: #75756f;
    --bar: #7aa2f7; --bar-soft: #7aa2f733; --blocked: #f26d5f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; display: flex; flex-direction: column; gap: 20px; }
header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.sub { color: var(--dim); font-size: 12.5px; margin-top: 4px; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.seg { display: flex; background: var(--raised); border-radius: 8px; padding: 2px; }
.seg button { border: 0; background: none; color: var(--muted); font: inherit; font-size: 12.5px; font-weight: 500; padding: 5px 10px; border-radius: 6px; cursor: pointer; }
.seg button:hover { color: var(--fg); }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--fg); box-shadow: 0 1px 2px #0000001a; }
.seg button:active { transform: scale(0.97); }
select, input[type="search"] { font: inherit; font-size: 12.5px; color: var(--fg); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; height: 32px; }
input[type="search"] { min-width: 180px; }
select:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tiles { display: flex; gap: 12px; flex-wrap: wrap; }
.tile { flex: 1 1 150px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tile .label { font-size: 12px; color: var(--muted); font-weight: 500; }
.tile .value { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.tile .hint { font-size: 11.5px; color: var(--dim); }
.row { display: flex; gap: 12px; flex-wrap: wrap; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.card h2 { margin: 0; font-size: 13.5px; font-weight: 600; }
.card .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.card .note { font-size: 11.5px; color: var(--dim); }
.grow2 { flex: 2 1 520px; } .grow1 { flex: 1 1 280px; }
svg text { fill: var(--dim); font-size: 10.5px; font-family: inherit; }
.hbar { display: flex; flex-direction: column; gap: 8px; }
.hbar .line { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
.hbar .name { width: 92px; flex: none; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hbar .track { flex: 1; height: 8px; background: var(--raised); border-radius: 4px; overflow: hidden; display: flex; }
.hbar .fill { height: 100%; background: var(--bar); border-radius: 4px; }
.hbar .n { width: 28px; flex: none; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.cols { display: flex; gap: 8px; height: 132px; }
.col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
.col .stem { flex: 1; width: 100%; max-width: 36px; display: flex; flex-direction: column; justify-content: flex-end; border-radius: 4px; background: var(--raised); overflow: hidden; }
.col .fill { background: var(--bar); border-radius: 4px; }
.col span { font-size: 11px; color: var(--dim); }
.legend { display: flex; gap: 12px; font-size: 11.5px; color: var(--muted); }
.legend span { display: flex; align-items: center; gap: 5px; }
.dot { width: 8px; height: 8px; border-radius: 4px; display: inline-block; flex: none; }
.table { display: flex; flex-direction: column; font-size: 12.5px; }
.tr { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-top: 1px solid var(--border); }
.tr.th { border-top: 0; color: var(--dim); font-size: 11.5px; font-weight: 500; padding-top: 0; }
.tr.th button { all: unset; cursor: pointer; } .tr.th button:hover { color: var(--fg); }
.c-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-key { width: 86px; flex: none; } .c-status { width: 70px; flex: none; } .c-date { width: 92px; flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
.c-dur { width: 70px; flex: none; text-align: right; font-variant-numeric: tabular-nums; } .c-agent { width: 64px; flex: none; color: var(--muted); }
.key { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 11.5px; color: var(--accent); text-decoration: none; }
.key:hover { text-decoration: underline; }
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); }
.empty { color: var(--dim); font-size: 12.5px; padding: 18px 4px; text-align: center; }
.tr.task { cursor: pointer; border-radius: 6px; }
.tr.task:hover { background: var(--raised); }
.tr.task:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
dialog { border: 1px solid var(--border); border-radius: 14px; padding: 0; width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 64px); background: var(--surface); color: var(--fg); box-shadow: 0 24px 64px #00000059; }
dialog::backdrop { background: #0000008c; }
dialog[open] { animation: pop 180ms cubic-bezier(0.23, 1, 0.32, 1); }
dialog[open]::backdrop { animation: fade 180ms ease-out; }
@keyframes pop { from { opacity: 0; transform: scale(0.97) translateY(4px); } }
@keyframes fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { dialog[open], dialog[open]::backdrop { animation: none; } }
.dlg { display: flex; flex-direction: column; max-height: calc(100vh - 64px); }
.dlg-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 14px; border-bottom: 1px solid var(--border); }
.dlg-head h3 { margin: 0; font-size: 16px; font-weight: 620; line-height: 1.35; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dlg-close { border: 0; background: none; color: var(--dim); width: 28px; height: 28px; border-radius: 7px; cursor: pointer; font-size: 18px; line-height: 1; flex: none; }
.dlg-close:hover { background: var(--raised); color: var(--fg); }
.dlg-close:active { transform: scale(0.94); }
.dlg-body { padding: 16px 20px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; }
.meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 12px; background: var(--raised); font-size: 12px; color: var(--muted); }
.facts { display: flex; flex-wrap: wrap; gap: 14px 24px; }
.fact { display: flex; flex-direction: column; gap: 2px; min-width: 96px; }
.fact .label { font-size: 11.5px; color: var(--dim); }
.fact .value { font-size: 13px; font-variant-numeric: tabular-nums; }
.sec { display: flex; flex-direction: column; gap: 8px; }
.sec h4 { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.04em; }
.steps { display: flex; flex-direction: column; gap: 0; }
.step { display: flex; gap: 10px; align-items: center; font-size: 12.5px; padding: 4px 0; }
.step .when { color: var(--dim); margin-left: auto; font-variant-numeric: tabular-nums; }
.linklist { display: flex; flex-direction: column; gap: 4px; }
.linklist a { color: var(--accent); font-size: 12.5px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.linklist a:hover { text-decoration: underline; }
.md { font-size: 13px; line-height: 1.55; color: var(--fg); overflow-wrap: anywhere; }
.md p, .md ul, .md ol, .md blockquote, .md pre { margin: 0 0 10px; }
.md :last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3 { font-size: 13.5px; margin: 14px 0 6px; }
.md ul, .md ol { padding-left: 20px; }
.md blockquote { border-left: 3px solid var(--border); padding-left: 10px; color: var(--muted); }
.md code { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 12px; background: var(--raised); padding: 1px 5px; border-radius: 4px; }
.md pre { background: var(--raised); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.md a { color: var(--accent); }
#tip { position: fixed; pointer-events: none; background: var(--fg); color: var(--bg); font-size: 11.5px; padding: 4px 8px; border-radius: 6px; opacity: 0; transition: opacity 120ms ease-out; white-space: nowrap; }
.view { display: flex; flex-direction: column; gap: 20px; }
[hidden] { display: none !important; }
.views { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.su-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.su-head h2 { margin: 0; font-size: 26px; font-weight: 650; letter-spacing: -0.02em; }
.su-head .sub { font-size: 13.5px; }
.btn { font: inherit; font-size: 12.5px; font-weight: 500; color: var(--fg); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; height: 32px; padding: 0 12px; cursor: pointer; }
.btn:hover { background: var(--raised); }
.btn:active { transform: scale(0.97); }
.su-cols { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.su-col { flex: 1 1 300px; min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 10px; transition: opacity 160ms ease-out, border-color 160ms ease-out; }
.su-cols.spot .su-col { opacity: 0.35; }
.su-cols.spot .su-col.on { opacity: 1; border-color: var(--accent); }
.su-col h3 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 620; }
.su-col h3 .n { color: var(--dim); font-weight: 500; }
.su-col h4 { margin: 6px 0 0; font-size: 11.5px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.04em; }
.su-item { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-radius: 10px; background: var(--raised); cursor: pointer; text-align: left; border: 0; font: inherit; color: inherit; width: 100%; }
.su-item:hover { background: var(--border); }
.su-item:focus-visible { outline: 2px solid var(--accent); }
.su-item .t { font-size: 15px; font-weight: 550; line-height: 1.35; overflow-wrap: anywhere; }
.su-item .m { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--dim); }
.su-item .note { font-size: 13.5px; color: var(--muted); line-height: 1.45; overflow-wrap: anywhere; }
.su-item .why { font-size: 13.5px; color: var(--blocked); line-height: 1.45; overflow-wrap: anywhere; }
.su-empty { font-size: 13px; color: var(--dim); padding: 6px 2px; }
.su-hint { font-size: 11.5px; color: var(--dim); }
.banner { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--blocked) 40%, transparent); background: color-mix(in srgb, var(--blocked) 10%, transparent); }
.banner b { color: var(--blocked); font-size: 12px; font-weight: 600; }
.logs { display: flex; flex-direction: column; gap: 8px; }
.log { display: flex; gap: 10px; font-size: 12.5px; }
.log .txt { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.log .when { color: var(--dim); flex: none; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) { .c-date, .c-agent { display: none; } .tile .value { font-size: 22px; } }
</style>
</head>
<body>
<main>
  <header>
    <div class="views">
      <div>
        <h1>Tasks report</h1>
        <div class="sub" id="sub"></div>
      </div>
      <div class="seg" id="view" role="group" aria-label="View">
        <button data-v="dash">Dashboard</button><button data-v="standup">Standup</button>
      </div>
    </div>
    <div class="filters" id="filters">
      <div class="seg" id="range" role="group" aria-label="Date range">
        <button data-v="today">Today</button><button data-v="yesterday">Yesterday</button><button data-v="7">7 days</button><button data-v="30">30 days</button><button data-v="90">90 days</button><button data-v="all">All</button>
      </div>
      <select id="project" aria-label="Project"></select>
      <select id="who" aria-label="Who did it">
        <option value="all">Agents and me</option><option value="agent">Sent to an agent</option><option value="me">Without an agent</option>
      </select>
    </div>
  </header>

  <div class="view" id="standup" hidden>
    <div class="su-head">
      <div>
        <h2 id="su-date"></h2>
        <div class="sub" id="su-since"></div>
      </div>
      <div class="filters">
        <span class="su-hint">← → spotlight a column · Esc clears</span>
        <button class="btn" id="copy">Copy as text</button>
      </div>
    </div>
    <div class="su-cols" id="su-cols"></div>
  </div>

  <div class="view" id="dash">
  <section class="tiles" id="tiles"></section>

  <div class="row">
    <div class="card grow2">
      <div class="head"><h2>Finished and added</h2>
        <div class="legend"><span><i class="dot" style="background:var(--bar)"></i>Finished</span><span><i class="dot" style="background:var(--bar-soft)"></i>Added</span></div>
      </div>
      <div id="daily"></div>
    </div>
    <div class="card grow1">
      <div class="head"><h2>Finished by project</h2></div>
      <div id="projects" class="hbar"></div>
    </div>
  </div>

  <div class="row">
    <div class="card grow1">
      <div class="head"><h2>By weekday</h2><span class="note">Finished tasks</span></div>
      <div id="weekday"></div>
    </div>
    <div class="card grow1">
      <div class="head"><h2>Where things stand</h2><span class="note">All tasks now</span></div>
      <div id="status" class="hbar"></div>
    </div>
  </div>

  <div class="card">
    <div class="head"><h2>Tasks</h2><input type="search" id="q" placeholder="Search titles" aria-label="Search titles"></div>
    <div class="table" id="table"></div>
  </div>
  </div>
</main>
<dialog id="detail" aria-labelledby="detail-title"></dialog>
<div id="tip" role="tooltip"></div>
<script id="data" type="application/json">__DATA__</script>
<script>
(() => {
  const { rows, generated, jira: JIRA } = JSON.parse(document.getElementById("data").textContent);
  const DAY = 86400000;
  // A Jira key: a link when config.json names your Jira site, plain text otherwise.
  const keyLink = (key, cls) => JIRA ? '<a class="' + cls + '" target="_blank" rel="noopener" href="' + JIRA + esc(key) + '">' + esc(key) + "</a>" : '<span class="' + cls + '">' + esc(key) + "</span>";
  /*__LIB__*/
  const state = { view: "dash", range: "30", project: "all", who: "all", q: "", sort: "done", desc: true };
  try { Object.assign(state, JSON.parse(localStorage.getItem("tasks-report") || "{}"), { q: "" }); } catch {}
  // The search survives the reload below, in this tab only.
  try { state.q = sessionStorage.getItem("tasks-report-q") || ""; } catch {}
  // Herdr rewrites this file on every task save: coming back to the tab loads the latest copy.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    try { sessionStorage.setItem("tasks-report-q", state.q); } catch {}
    location.reload();
  });
  const save = () => { try { localStorage.setItem("tasks-report", JSON.stringify({ view: state.view, range: state.range, project: state.project, who: state.who, sort: state.sort, desc: state.desc })); } catch {} };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const isToday = (r) => Boolean(r.todayAt) && dayStart(r.todayAt) === dayStart(Date.now());
  const fmtDate = (t) => t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–";
  const dur = (ms) => {
    if (ms == null || ms < 0) return "–";
    const h = ms / 3600000;
    if (h < 1) return Math.max(1, Math.round(ms / 60000)) + "m";
    if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + "h";
    return (h / 24).toFixed(h < 240 ? 1 : 0) + "d";
  };
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Project options: the Jira prefixes seen, most used first.
  const counts = {};
  for (const r of rows) { const p = r.project ?? "none"; counts[p] = (counts[p] || 0) + 1; }
  const projects = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  $("project").innerHTML = '<option value="all">All projects</option>' + projects.map((p) => '<option value="' + esc(p) + '">' + (p === "none" ? "No ticket" : esc(p)) + " · " + counts[p] + "</option>").join("");
  if (state.project !== "all" && !counts[state.project]) state.project = "all";

  const tip = $("tip");
  document.addEventListener("mousemove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.style.opacity = 0; return; }
    tip.textContent = t.getAttribute("data-tip");
    const w = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 12) + "px";
    tip.style.top = (e.clientY - 30) + "px";
    tip.style.opacity = 1;
  });

  function window_() {
    const now = Date.now(), today = dayStart(now), end = today + DAY;
    if (state.range === "today") return { from: today, end };
    // "Yesterday" is the last working day: Friday on a Monday.
    if (state.range === "yesterday") { const from = lastWorkday(now); return { from, end: from + DAY }; }
    if (state.range === "all") {
      const first = Math.min(...rows.map((r) => r.created ?? now), now);
      return { from: dayStart(first), end };
    }
    return { from: end - Number(state.range) * DAY, end };
  }

  function render() {
    for (const b of $("view").children) b.setAttribute("aria-pressed", String(b.dataset.v === state.view));
    const standup = state.view === "standup";
    $("standup").hidden = !standup; $("dash").hidden = standup; $("filters").hidden = standup;
    $("sub").textContent = "Updated " + new Date(generated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) + " · " + rows.length + " tasks, " + rows.filter((r) => r.archived).length + " archived";
    if (standup) { renderStandup(); return; }
    // On a Monday the last working day is Friday: the button says so.
    const now = Date.now(), lw = lastWorkday(now);
    const yBtn = $("range").querySelector('[data-v="yesterday"]');
    yBtn.textContent = lw === dayStart(now) - DAY ? "Yesterday" : new Date(lw).toLocaleDateString(undefined, { weekday: "long" });
    for (const b of $("range").children) b.setAttribute("aria-pressed", String(b.dataset.v === state.range));
    $("project").value = state.project; $("who").value = state.who;
    const { from, end } = window_();
    const scoped = rows.filter((r) =>
      (state.project === "all" || (r.project ?? "none") === state.project) &&
      (state.who === "all" || (state.who === "agent") === Boolean(r.agent)));
    const inRange = (t) => t != null && t >= from && t < end;
    const finished = scoped.filter((r) => inRange(r.doneAt));
    const added = scoped.filter((r) => inRange(r.created));
    const doingNow = scoped.filter((r) => r.status === "doing");
    const leads = finished.filter((r) => r.created).map((r) => r.doneAt - r.created);
    const works = finished.filter((r) => r.started).map((r) => r.doneAt - r.started);
    const agentShare = finished.length ? Math.round(100 * finished.filter((r) => r.agent).length / finished.length) : null;

    // Streak: days in a row, ending today or yesterday, with something finished.
    const doneDays = new Set(scoped.filter((r) => r.doneAt).map((r) => dayStart(r.doneAt)));
    let streak = 0, d = dayStart(Date.now());
    if (!doneDays.has(d)) d -= DAY;
    while (doneDays.has(d)) { streak++; d -= DAY; }

    const days = Math.max(1, Math.round((end - from) / DAY));
    // The same length of time just before, to compare against ("the day before" for one day).
    const before = state.range === "all" ? null : scoped.filter((r) => r.doneAt != null && r.doneAt >= from - (end - from) && r.doneAt < from).length;
    const finishedHint = before == null ? (finished.length / days * 7).toFixed(1) + " a week on average"
      : before + (days === 1 ? " the day before" : " in the " + days + " days before");
    const tiles = [
      ["Finished", finished.length, finishedHint],
      ["Added", added.length, added.length ? Math.round(100 * finished.length / added.length) + "% as many finished" : "Nothing new"],
      ["Doing now", doingNow.length, doingNow.length > 3 ? "Many at once" : "In progress"],
      ["Lead time", dur(median(leads)), "Median, added to done"],
      ["Work time", dur(median(works)), works.length ? "Median, doing to done" : "Tracked from now on"],
      ["Streak", streak + (streak === 1 ? " day" : " days"), agentShare == null ? "Days in a row with a finish" : agentShare + "% finished with an agent"],
    ];
    $("tiles").innerHTML = tiles.map(([l, v, h]) => '<div class="tile"><div class="label">' + l + '</div><div class="value">' + esc(v) + '</div><div class="hint">' + esc(h) + "</div></div>").join("");

    renderDaily(scoped, from, end);
    renderProjects(finished);
    renderWeekday(finished);
    renderStatus(scoped);
    renderTable(scoped, inRange);
  }

  function renderDaily(scoped, from, end) {
    const days = Math.round((end - from) / DAY);
    // One day counts by hour, long ranges by week, the rest by day.
    const HOUR = 3600000;
    const size = days === 1 ? HOUR : days > 120 ? 7 * DAY : DAY;
    const n = Math.ceil((end - from) / size);
    const done = new Array(n).fill(0), add = new Array(n).fill(0);
    const idx = (t) => Math.min(n - 1, Math.floor(((size === HOUR ? t : dayStart(t)) - from) / size));
    const hour = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const tick = (t) => size === HOUR ? hour(t) : fmtDate(t);
    for (const r of scoped) {
      if (r.doneAt && r.doneAt >= from && r.doneAt < end) done[idx(r.doneAt)]++;
      if (r.created && r.created >= from && r.created < end) add[idx(r.created)]++;
    }
    // Whole-number gridlines: up to 4 steps, the top one at or above the highest bar.
    const peak = Math.max(1, ...done, ...add);
    const ticks = Math.min(4, peak), stepV = Math.ceil(peak / ticks), max = stepV * ticks;
    const W = 640, H = 180, L = 24, B = 22, T = 6;
    const bw = (W - L) / n, inner = Math.max(2, bw * 0.72);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let s = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" aria-label="Tasks finished and added over time">';
    for (let i = 0; i <= ticks; i++) {
      const v = stepV * i, yy = y(v);
      s += '<line x1="' + L + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--border)" stroke-width="1"/>';
      s += '<text x="' + (L - 6) + '" y="' + (yy + 3.5) + '" text-anchor="end">' + v + "</text>";
    }
    const every = Math.ceil(n / 8);
    for (let i = 0; i < n; i++) {
      const x = L + i * bw + (bw - inner) / 2, t = from + i * size;
      const label = size === HOUR ? fmtDate(t) + ", " + hour(t) + "–" + hour(t + HOUR) : (size > DAY ? "Week of " : "") + fmtDate(t);
      s += '<g data-tip="' + esc(label + ": " + done[i] + " finished, " + add[i] + " added") + '">';
      s += '<rect x="' + (L + i * bw) + '" y="0" width="' + bw + '" height="' + (H - B) + '" fill="transparent"/>';
      if (add[i]) s += '<rect x="' + x + '" y="' + y(add[i]) + '" width="' + inner + '" height="' + (y(0) - y(add[i])) + '" rx="2" fill="var(--bar-soft)"/>';
      if (done[i]) s += '<rect x="' + (x + inner * 0.2) + '" y="' + y(done[i]) + '" width="' + inner * 0.6 + '" height="' + (y(0) - y(done[i])) + '" rx="2" fill="var(--bar)"/>';
      s += "</g>";
      if (i % every === 0) s += '<text x="' + (L + i * bw + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + tick(t) + "</text>";
    }
    $("daily").innerHTML = s + "</svg>";
  }

  function hbars(el, items, color) {
    const max = Math.max(1, ...items.map((i) => i[1]));
    el.innerHTML = items.length ? items.map(([name, n, c]) =>
      '<div class="line" data-tip="' + esc(name + ": " + n) + '"><span class="name">' + esc(name) + '</span><span class="track"><span class="fill" style="width:' + (100 * n / max) + "%;background:" + (c || color) + '"></span></span><span class="n">' + n + "</span></div>").join("")
      : '<div class="empty">Nothing finished in this range</div>';
  }

  function renderProjects(finished) {
    const c = {};
    for (const r of finished) { const p = r.project ?? "No ticket"; c[p] = (c[p] || 0) + 1; }
    hbars($("projects"), Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8), "var(--bar)");
  }

  function renderStatus(scoped) {
    const c = { todo: 0, doing: 0, done: 0 };
    for (const r of scoped) if (r.status in c) c[r.status]++;
    const blocked = scoped.filter((r) => r.blocked).length;
    hbars($("status"), [["Doing", c.doing, "var(--doing)"], ["To do", c.todo, "var(--todo)"], ["Blocked", blocked, "var(--blocked)"], ["Done", c.done, "var(--done)"]], null);
  }

  function renderWeekday(finished) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const c = new Array(7).fill(0);
    for (const r of finished) c[(new Date(r.doneAt).getDay() + 6) % 7]++;
    const max = Math.max(1, ...c);
    $("weekday").innerHTML = '<div class="cols" role="img" aria-label="Finished tasks by weekday">' + c.map((v, i) =>
      '<div class="col" data-tip="' + names[i] + ": " + v + '"><div class="stem"><div class="fill" style="height:' + (100 * v / max) + '%"></div></div><span>' + names[i] + "</span></div>").join("") + "</div>";
  }

  const STATUS = { todo: ["To do", "var(--todo)"], doing: ["Doing", "var(--doing)"], done: ["Done", "var(--done)"],
    blocked: ["Blocked", "var(--blocked)"], unblocked: ["Unblocked", "var(--dim)"] };
  // A blocked task shows as blocked whatever its place in to do / doing.
  const shownStatus = (r) => STATUS[r.blocked ? "blocked" : r.status] ?? [r.status, "var(--dim)"];
  const COLS = [
    ["title", "Task", "c-title", (r) => r.title.toLowerCase()],
    ["key", "Ticket", "c-key", (r) => r.key ?? "~"],
    ["status", "Status", "c-status", (r) => ["doing", "todo", "done"].indexOf(r.status)],
    ["created", "Added", "c-date", (r) => r.created ?? 0],
    ["done", "Done", "c-date", (r) => r.doneAt ?? 0],
    ["lead", "Lead", "c-dur", (r) => r.doneAt && r.created ? r.doneAt - r.created : -1],
    ["agent", "Agent", "c-agent", (r) => r.agent ?? "~"],
  ];

  function renderTable(scoped, inRange) {
    const q = state.q.trim().toLowerCase();
    // Tasks touched in the range: added, finished, or still open.
    const list = scoped.filter((r) => (inRange(r.created) || inRange(r.doneAt) || r.status !== "done") && (!q || r.title.toLowerCase().includes(q) || (r.key ?? "").toLowerCase().includes(q)));
    const col = COLS.find((c) => c[0] === state.sort) ?? COLS[4];
    list.sort((a, b) => { const x = col[3](a), y = col[3](b); return (x < y ? -1 : x > y ? 1 : 0) * (state.desc ? -1 : 1); });
    let s = '<div class="tr th">' + COLS.map(([k, label, cls]) => '<span class="' + cls + '"><button data-sort="' + k + '">' + label + (state.sort === k ? (state.desc ? " ↓" : " ↑") : "") + "</button></span>").join("") + "</div>";
    s += list.map((r) => {
      const [label, color] = shownStatus(r);
      return '<div class="tr task" tabindex="0" role="button" data-id="' + esc(r.id) + '" aria-label="' + esc("Show details: " + r.title) + '"><span class="c-title" title="' + esc(r.title) + '">' + esc(r.title) + '</span>' +
        '<span class="c-key">' + (r.key ? keyLink(r.key, "key") : "") + "</span>" +
        '<span class="c-status"><span class="badge"><i class="dot" style="background:' + color + '"></i>' + label + "</span></span>" +
        '<span class="c-date">' + fmtDate(r.created) + '</span><span class="c-date">' + fmtDate(r.doneAt) + "</span>" +
        '<span class="c-dur">' + (r.doneAt && r.created ? dur(r.doneAt - r.created) : "–") + '</span><span class="c-agent">' + esc(r.agent ?? "") + "</span></div>";
    }).join("");
    if (!list.length) s += '<div class="empty">No tasks match these filters</div>';
    $("table").innerHTML = s;
  }

  // ---- standup: done since the last working day began, today's plan, and what's blocked

  function standupData() {
    const now = Date.now(), since = lastWorkday(now);
    const open = rows.filter((r) => r.status !== "done" && !r.deleted);
    const done = rows.filter((r) => r.doneAt && r.doneAt >= since).sort((a, b) => b.doneAt - a.doneAt);
    const notesSince = (r) => r.log.filter((n) => n.at >= since);
    // Not done, but a progress note since then: work that moved.
    const lastAt = (r) => { const l = notesSince(r); return l.length ? l[l.length - 1].at : 0; };
    const moved = open.filter((r) => lastAt(r)).sort((a, b) => lastAt(b) - lastAt(a));
    const blocked = open.filter((r) => r.blocked).sort((a, b) => a.blocked.at - b.blocked.at);
    // Today: what you marked for today, then what you're doing; blocked ones sit in their own column.
    const today = open.filter((r) => !r.blocked && (isToday(r) || r.status === "doing"))
      .sort((a, b) => Number(isToday(b)) - Number(isToday(a)) || (b.todayAt ?? 0) - (a.todayAt ?? 0));
    return { now, since, done, moved, blocked, today, notesSince };
  }

  const sinceLabel = (since, now) => since === dayStart(now) - DAY ? "yesterday" : new Date(since).toLocaleDateString(undefined, { weekday: "long" });

  function renderStandup() {
    const d = standupData();
    $("su-date").textContent = "Standup · " + new Date(d.now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    $("su-since").textContent = "Since " + new Date(d.since).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }) + ", the last working day";
    const key = (r) => r.key ? keyLink(r.key, "key") : "";
    const lastNote = (r, list) => { const n = list[list.length - 1]; return n ? '<div class="note">' + esc(n.text) + "</div>" : ""; };
    const item = (r, meta, body) => '<button class="su-item" data-id="' + esc(r.id) + '"><span class="t">' + esc(r.title) + '</span><span class="m">' + [key(r), meta].filter(Boolean).join(" · ") + "</span>" + body + "</button>";
    const time = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const col = (i, title, color, n, inner, empty) => '<section class="su-col" data-col="' + i + '"><h3><i class="dot" style="background:' + color + '"></i>' + title + ' <span class="n">' + n + "</span></h3>" + (inner || '<div class="su-empty">' + empty + "</div>") + "</section>";
    const doneHtml = d.done.map((r) => item(r, "Done " + time(r.doneAt), lastNote(r, d.notesSince(r)))).join("")
      + (d.moved.length ? "<h4>Moved forward</h4>" + d.moved.map((r) => item(r, (STATUS[r.status] ?? [r.status])[0], lastNote(r, d.notesSince(r)))).join("") : "");
    const todayHtml = d.today.map((r) => item(r, [isToday(r) ? "Planned" : "", (STATUS[r.status] ?? [r.status])[0]].filter(Boolean).join(" · "), lastNote(r, r.log))).join("");
    const blockedHtml = d.blocked.map((r) => item(r, "Since " + time(r.blocked.at), '<div class="why">' + esc(r.blocked.reason) + "</div>")).join("");
    $("su-cols").innerHTML =
      col(0, "Since " + sinceLabel(d.since, d.now), "var(--done)", d.done.length + d.moved.length, doneHtml, "Nothing finished or moved yet") +
      col(1, "Today", "var(--accent)", d.today.length, todayHtml, "Mark tasks for today with t in Herdr, or move one to Doing") +
      col(2, "Blocked", "var(--blocked)", d.blocked.length, blockedHtml, "Nothing blocked");
    spotlight();
  }

  // Plain text for Slack: *bold* headings and bullets.
  function standupText() {
    const d = standupData();
    const line = (r, extra) => "• " + (r.key ? r.key + " " : "") + r.title.replace(r.key ?? "\u0000", "").trim() + (extra ? " — " + extra : "");
    const last = (list) => list.length ? list[list.length - 1].text : "";
    const out = ["*Standup · " + new Date(d.now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }) + "*", ""];
    out.push("*Since " + sinceLabel(d.since, d.now) + "*");
    if (!d.done.length && !d.moved.length) out.push("• Nothing finished yet");
    for (const r of d.done) out.push(line(r, last(d.notesSince(r))));
    for (const r of d.moved) out.push(line(r, "in progress: " + last(d.notesSince(r))));
    out.push("", "*Today*");
    if (!d.today.length) out.push("• Nothing planned yet");
    for (const r of d.today) out.push(line(r, last(r.log)));
    out.push("", "*Blocked*");
    if (!d.blocked.length) out.push("• Nothing");
    for (const r of d.blocked) out.push(line(r, r.blocked.reason));
    return out.join("\n");
  }
  window.standupText = standupText;

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    // Safari and file:// pages may refuse the clipboard API: the old way.
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }

  $("copy").addEventListener("click", async () => {
    const ok = await copyText(standupText());
    $("copy").textContent = ok ? "Copied" : "Couldn't copy";
    setTimeout(() => { $("copy").textContent = "Copy as text"; }, 1400);
  });

  // ← → spotlight one column while presenting; Esc (or a third press past the end) clears it.
  let spot = -1;
  function spotlight() {
    const cols = $("su-cols");
    cols.classList.toggle("spot", spot >= 0);
    for (const c of cols.children) c.classList.toggle("on", Number(c.dataset.col) === spot);
  }
  document.addEventListener("keydown", (e) => {
    if (state.view !== "standup" || dlg.open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowRight") spot = spot >= 2 ? -1 : spot + 1;
    else if (e.key === "ArrowLeft") spot = spot <= -1 ? 2 : spot - 1;
    else if (e.key === "Escape") spot = -1;
    else return;
    e.preventDefault();
    spotlight();
  });

  $("su-cols").addEventListener("click", (e) => {
    const it = e.target.closest(".su-item");
    if (it && !e.target.closest("a")) openDetail(it.dataset.id);
  });
  $("view").addEventListener("click", (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) { state.view = v; save(); render(); } });

  $("range").addEventListener("click", (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) { state.range = v; save(); render(); } });
  $("project").addEventListener("change", (e) => { state.project = e.target.value; save(); render(); });
  $("who").addEventListener("change", (e) => { state.who = e.target.value; save(); render(); });
  $("q").value = state.q;
  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  // ---- task detail popup

  // Small markdown: headings, lists, quotes, code, links, bold and italic. Escaped first.
  function md(src) {
    const inline = (s) => esc(s)
      .replace(/` + "`" + String.raw`([^` + "`" + String.raw`]+)` + "`" + String.raw`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    const out = [];
    const lines = src.replace(/\r/g, "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^` + "```" + String.raw`/.test(l)) {
        const code = [];
        while (++i < lines.length && !/^` + "```" + String.raw`/.test(lines[i])) code.push(lines[i]);
        out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
      } else if (/^#{1,6}\s/.test(l)) {
        out.push("<h3>" + inline(l.replace(/^#+\s*/, "")) + "</h3>");
      } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ordered = /^\s*\d+\./.test(l), items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push("<li>" + inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "")) + "</li>");
        i--;
        out.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>"));
      } else if (/^>\s?/.test(l)) {
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(inline(lines[i++].replace(/^>\s?/, "")));
        i--;
        out.push("<blockquote>" + q.join("<br>") + "</blockquote>");
      } else if (l.trim()) {
        const p = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*([-*]|\d+\.)\s|` + "```" + String.raw`)/.test(lines[i])) p.push(inline(lines[i++]));
        i--;
        out.push("<p>" + p.join("<br>") + "</p>");
      }
    }
    return out.join("");
  }

  const when = (t) => t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";
  const dlg = $("detail");

  function openDetail(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    const [label, color] = shownStatus(r);
    const facts = [
      ["Added", when(r.created)], ["Started", when(r.started)], ["Done", when(r.doneAt)],
      ["Lead time", r.doneAt && r.created ? dur(r.doneAt - r.created) : "–"],
      ["Work time", r.doneAt && r.started ? dur(r.doneAt - r.started) : "–"],
    ];
    if (r.archived) facts.push(["Archived", when(r.archived)]);
    let s = '<div class="dlg"><div class="dlg-head"><h3 id="detail-title">' + esc(r.title) + '</h3><button class="dlg-close" aria-label="Close" data-close>×</button></div><div class="dlg-body">';
    s += '<div class="meta"><span class="chip"><i class="dot" style="background:' + color + '"></i>' + label + "</span>";
    if (r.key) s += keyLink(r.key, "chip key");
    if (r.agent) s += '<span class="chip">Agent ' + esc(r.agent) + "</span>";
    if (isToday(r)) s += '<span class="chip">Planned for today</span>';
    if (r.deleted) s += '<span class="chip">Deleted ' + esc(when(r.deleted)) + "</span>";
    s += "</div>";
    if (r.blocked) s += '<div class="banner"><b>Blocked since ' + esc(when(r.blocked.at)) + "</b><span>" + esc(r.blocked.reason) + "</span></div>";
    s += '<div class="facts">' + facts.map(([l, v]) => '<div class="fact"><span class="label">' + l + '</span><span class="value">' + esc(v) + "</span></div>").join("") + "</div>";
    if (r.notes.trim()) s += '<div class="sec"><h4>Details</h4><div class="md">' + md(r.notes) + "</div></div>";
    if (r.log.length) s += '<div class="sec"><h4>Progress</h4><div class="logs">' + [...r.log].reverse().map((n) =>
      '<div class="log"><span class="txt">' + esc(n.text) + '</span><span class="when">' + esc(when(n.at)) + "</span></div>").join("") + "</div></div>";
    if (r.links.length) s += '<div class="sec"><h4>Links</h4><div class="linklist">' + r.links.map((l) => '<a href="' + esc(l) + '" target="_blank" rel="noopener" title="' + esc(l) + '">' + esc(l.replace(/^https?:\/\//, "")) + "</a>").join("") + "</div></div>";
    if (r.history.length) s += '<div class="sec"><h4>History</h4><div class="steps">' + r.history.map((h) => {
      const [hl, hc] = STATUS[h.status] ?? [h.status, "var(--dim)"];
      return '<div class="step"><i class="dot" style="background:' + hc + '"></i>' + hl + (h.reason ? ": " + esc(h.reason) : "") + '<span class="when">' + when(h.at) + "</span></div>";
    }).join("") + "</div></div>";
    dlg.innerHTML = s + "</div></div>";
    dlg.dataset.id = id;
    if (!dlg.open) dlg.showModal();
    try { sessionStorage.setItem("tasks-report-open", id); } catch {}
  }

  dlg.addEventListener("click", (e) => {
    // The backdrop is the dialog itself; its contents fill the box.
    if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
  });
  dlg.addEventListener("close", () => { try { sessionStorage.removeItem("tasks-report-open"); } catch {} });

  $("table").addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest(".tr.task");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDetail(row.dataset.id); }
  });

  $("table").addEventListener("click", (e) => {
    const row = e.target.closest(".tr.task");
    if (row && !e.target.closest("a")) { openDetail(row.dataset.id); return; }
    const k = e.target.dataset && e.target.dataset.sort;
    if (!k) return;
    if (state.sort === k) state.desc = !state.desc; else { state.sort = k; state.desc = k !== "title" && k !== "key"; }
    save(); render();
  });
  render();
  // A popup open before the tab reloaded opens again, with the new data.
  try { const open = sessionStorage.getItem("tasks-report-open"); if (open) openDetail(open); } catch {}
})();
</script>
</body>
</html>`;
