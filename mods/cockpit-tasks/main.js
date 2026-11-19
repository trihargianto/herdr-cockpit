// Tasks: things to get agents working on, each with a title, details and links.
// Saved in ~/.config/herdr-app/cockpit-tasks/tasks.json. "Send to agent" writes the task as a
// markdown brief next to it and sends the focused agent a short pointer (`hc send`), so long
// context never rides in the message itself. Nothing is sent until you press the button.
// Order within a group is yours (`rank`, J/K moves); a status change puts the task at the top of its new
// group. Done tasks move to tasks-archive.json after a week (or at once with A), newest first.
// A task can also be blocked (`blocked: {reason, at}`, b), planned for today (`todayAt`, t, lapses at
// midnight) and carry dated progress notes (`log: [{at, text}]`, p). Deleting moves it to the archive
// marked `deleted`, so finished work stays countable.
// Each status change is kept in `history` ({status, at}) for the report (R, or the chart button):
// report.html beside the tasks, built from both files and opened in the browser. Once it exists,
// every save rewrites it, and the page reloads itself when its tab is shown again.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor, TextView, ScrollHandle } from "gpui-base";
import * as fs from "fs/promises";
import { agents, focused, hc, exec, appHome, theme, settings, layout, props, panes, spaces, shared, run, nextCommand } from "herdr";
import { workOf } from "./work.js";
import { reportHtml } from "./report.js";
import { Nav, footer } from "./nav.js";

// The first line of the details that says something, for a closed card: headings ("# Context") and
// code fences are skipped, markdown marks dropped. Nothing when it only repeats the title.
function preview(md, title = "") {
  let fenced = false;
  for (const raw of md.split("\n")) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    if (!fenced && /^\s*#{1,6}\s/.test(raw)) continue;
    const line = raw.replace(/^[>\-*\s`]+/, "").replace(/[*_`]/g, "").trim();
    if (line) return line === title.trim() ? "" : line;
  }
  return "";
}

// Headings drawn at body size in a card: the card is 12px text and a 26px "# Context" would outweigh
// the task's own title. The report keeps them as headings.
const flatHeadings = (md) => md.replace(/^\s*#{1,6}\s+(.+)$/gm, "**$1**");

// URLs in a progress note shown as "host/path…" (40 characters at most): a pasted merge request link
// would otherwise wrap over eight lines. The full text is in the note's tooltip.
const shortUrls = (text) => text.replace(/https?:\/\/\S+/g, (u) => { const s = short(u); return s.length > 40 ? `${s.slice(0, 39)}…` : s; });

const ICONS = "mods/cockpit-workspace-chrome";
const STATUS = ["todo", "doing", "done"];
const NEXT = { todo: "doing", doing: "done", done: "todo" };
const LABEL = { todo: "To do", doing: "Doing", done: "Done" };

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

const WEEK = 7 * 24 * 3600 * 1000;
// Cards drawn per group before "Show more": every card is rebuilt on each redraw, and around 130
// cards the view no longer finishes drawing.
const PAGE = 50;

// Marked for today: `todayAt` is when, and the mark lapses at local midnight (a timestamp, so the
// report's browser judges "today" in its own time zone, the same way).
function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
const isToday = (task, now = Date.now()) => Boolean(task.todayAt) && sameDay(task.todayAt, now);
// Blocked only counts on a task that isn't done.
const isBlocked = (task) => Boolean(task.blocked) && task.status !== "done";

// Tasks saved before ordering existed get ranks in their old order (latest update first), after any ranked ones.
function ranked(tasks) {
  const has = (x) => typeof x.rank === "number";
  const missing = tasks.filter((x) => !has(x)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  let next = Math.max(-1, ...tasks.filter(has).map((x) => x.rank)) + 1;
  for (const x of missing) x.rank = next++;
  return tasks;
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// "https://host/a/b?x" shown as "host/a/b".
function short(url) {
  return url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
}

// Only http(s) links open (`open_url` refuses everything else); a bare domain gets https.
function toLink(raw) {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\/\S+\.\S+/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`;
  return null;
}

function brief(task) {
  const lines = [`# Task: ${task.title}`, ""];
  if (task.notes) lines.push(task.notes, "");
  if (task.links.length) lines.push("## Links", ...task.links.map((l) => `- ${l}`), "");
  lines.push(`_From Herdr Cockpit tasks · ${task.id}_`, "");
  return lines.join("\n");
}

// A pane in the side panel does work only while it is the one shown: a hidden pane's timers still run,
// so each tick asks first. (The tab bar keeps its own counters, which are always needed.)
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
function shown(id) {
  const root = layout();
  const panel = findNode(root, "panel");
  if (!panel || panel.hidden) return false;
  // A copy in the lower half of the panel (props.slot "lower") is shown when that stack is open on it.
  const lower = props()?.slot === "lower";
  const stack = findNode(root, lower ? "panel-lower" : "panel-body");
  return Boolean(stack && !stack.hidden && stack.active === (lower ? `lower-${id}` : id));
}

export default class Tasks extends View {
  init(_props, cx) {
    this.dir = `${appHome()}/cockpit-tasks`;
    // Your settings: config.json in the herdr-cockpit folder, which dev.py publishes here.
    this.config = {};
    cx.spawn(async (cx) => {
      try { this.config = JSON.parse(await fs.readFile(`${appHome()}/cockpit/config.json`, "utf8")); cx.notify(); } catch {}
    });
    this.tasks = [];
    this.ready = false;
    this.open = null; // the expanded task's id
    this.form = null; // { id: string | null, links: string[] } while adding or editing
    this.focus = null; // which input has the keyboard
    this.showDone = false;
    this.filter = null; // "todo", "doing" or "done"; null shows everything
    this.limit = {}; // cards drawn per group, PAGE until "Show more"
    this.hoverNote = null; // the progress note under the pointer, whose edit and delete show
    this.confirm = null; // a task whose delete awaits a second click
    this.copied = null;
    this.note = null;
    this.sending = null;
    this.menuFor = null; // the task whose agent list is open
    this.pick = null; // an agent chosen by hand; null follows the active one
    this.queue = Promise.resolve();
    this.press = null; // { id, y }: a card header the left button went down on
    this.drag = null; // the task being dragged, once the press has moved a few pixels
    this.over = null; // { id, after }: where it would land

    this.quickIn = InputState.new({ placeholder: "Add a task, press Enter" });
    this.quickIn.on("submit", (_e, cx) => this.quickAdd(cx));
    this.quickIn.on("focus", (_e, cx) => { this.focus = "quick"; cx.notify(); });
    this.quickIn.on("blur", (_e, cx) => { if (this.focus === "quick") this.focus = null; cx.notify(); });
    this.titleIn = InputState.new({ placeholder: "What should the agent do?" });
    // Details are markdown: a small editor that wraps, with no gutter.
    const t = theme();
    this.notesIn = EditorState.new({
      language: "markdown", soft_wrap: true, line_numbers: false, folding: false, font_size: 12,
      font_family: settings().font_family,
      syntax: { keyword: t.accent, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi6, number: t.ansi3, constant: t.ansi5, punctuation: t.dim },
    });
    this.linkIn = InputState.new({ placeholder: "Paste a link, press Enter" });
    // In the open card: why it's blocked (shown after Block or b), and a progress note (always shown).
    this.blocking = null; // the task whose block reason is being typed
    this.blockIn = InputState.new({ placeholder: "Why is it blocked? Press Enter" });
    this.blockIn.on("submit", (_e, cx) => {
      const reason = this.blockIn.value().trim();
      if (!reason || !this.blocking) return;
      this.setBlocked(this.blocking, reason);
      this.blocking = null;
      this.blockIn.set_value("");
      this.nav.focus();
      cx.notify();
    });
    this.logIn = InputState.new({ placeholder: "What moved? Press Enter" });
    // The same field adds a note, or, while one is being edited (`logEdit`), saves its new text.
    this.logEdit = null; // { id, at }: the note whose text is in the field
    this.logConfirm = null; // "id:at" of a note whose delete awaits a second click
    this.logAll = null; // the task whose every note is listed, not just the last three
    this.logIn.on("submit", (_e, cx) => {
      const text = this.logIn.value().trim();
      if (!text || !this.open) return;
      if (this.logEdit) this.editLog(this.logEdit.id, this.logEdit.at, text);
      else this.addLog(this.open, text);
      this.logEdit = null;
      this.logIn.set_value("");
      cx.notify();
    });
    for (const [name, state] of [["block", this.blockIn], ["log", this.logIn]]) {
      state.on("focus", (_e, cx) => { this.focus = name; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focus === name) this.focus = null; cx.notify(); });
    }
    this.titleIn.on("submit", (_e, cx) => this.save(cx));
    // Details are multi-line: Enter and Shift+Enter add a line (the editor also reports them as "submit",
    // without `secondary`), and only Cmd/Ctrl+Enter saves the form.
    this.notesIn.on("submit", (e, cx) => { if (e.secondary) this.save(cx); });
    // Key bindings run before key handlers, and the app's own Tab (and the editor's indent) would win:
    // bindings scoped to the form, and to the fields inside it, are deeper and so take Tab first.
    const fieldKeys = [];
    // The fields sit inside a "TaskField" context (for Esc, below), so the deeper forms are listed too.
    for (const context of ["TaskForm", "TaskForm > Input", "TaskForm > Editor",
      "TaskForm > TaskField", "TaskForm > TaskField > Input", "TaskForm > TaskField > Editor"]) {
      fieldKeys.push({ keystroke: "tab", action: "cockpit-tasks.next-field", context });
      fieldKeys.push({ keystroke: "shift-tab", action: "cockpit-tasks.prev-field", context });
    }
    // Esc in any of the panel's text fields (each wrapped in a "TaskField" context) hands the keyboard
    // back to the list; a second Esc then leaves the panel as usual. Bound the same way as Tab, so the
    // field's own Esc doesn't swallow it.
    for (const context of ["TaskField", "TaskField > Input", "TaskField > Editor"]) {
      fieldKeys.push({ keystroke: "escape", action: "cockpit-tasks.blur", context });
    }
    cx.bind_keys(fieldKeys);
    this.linkIn.on("submit", (_e, cx) => this.addLink(cx));
    for (const [name, state] of [["title", this.titleIn], ["notes", this.notesIn], ["link", this.linkIn]]) {
      state.on("focus", (_e, cx) => { this.focus = name; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focus === name) this.focus = null; cx.notify(); });
    }

    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(`${this.dir}/briefs`, { recursive: true });
        if (await fs.exists(`${this.dir}/tasks.json`)) this.tasks = ranked(JSON.parse(await fs.readFile(`${this.dir}/tasks.json`, "utf8")));
        this.ready = true;
        this.archive();
      } catch {
        this.headNote = "Couldn't read saved tasks.";
        this.ready = true;
      }
      cx.notify();
    });
    // Done tasks older than a week leave the list; checked hourly as well as on start.
    cx.timer.every(3600000, (cx) => { if (this.archive()) cx.notify(); });
    // Keyboard: the cards in screen order (rebuilt on each render) and which scroll child holds each.
    this.nav = new Nav(cx, { slot: props()?.slot ?? null });
    this.nav.watch(cx);
    this.scroll = ScrollHandle.new();
    this.rows = [];
    // "cockpit-tasks.quick" (Ctrl+B g t, through the tab bar): the quick-add field takes the keyboard.
    // "focus" / "focus-lower" (opening from the keyboard, or pane.go): the list does.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "quick") { this.quickIn.focus(); cx.notify(); }
        else if (this.nav.wants(c, props()?.slot)) { this.nav.focus(); cx.notify(); }
      }
    });
    // The ages ("2m") redraw once a minute, and only while this pane is the one shown.
    cx.timer.every(60000, (cx) => {
      if (shown("tasks")) cx.notify();
    });
  }

  // Writes are queued so two quick edits never race.
  persist() {
    const text = JSON.stringify(this.tasks, null, 2);
    this.queue = this.queue
      .then(() => fs.writeFile(`${this.dir}/tasks.json`, text))
      .catch(() => { this.headNote = "Couldn't save tasks."; });
    this.refreshReport();
  }

  // Reads tasks.json again (after any queued save), for edits made outside the panel.
  reload(cx) {
    this.queue = this.queue.then(async () => {
      try {
        if (await fs.exists(`${this.dir}/tasks.json`)) this.tasks = ranked(JSON.parse(await fs.readFile(`${this.dir}/tasks.json`, "utf8")));
        this.headNote = null;
      } catch { this.headNote = "Couldn't read saved tasks."; }
      cx.notify();
    });
  }

  // Once a report has been opened, each save rewrites it; the page reloads when you come back to its tab.
  refreshReport() {
    const out = `${this.dir}/report.html`;
    this.queue = this.queue.then(async () => {
      if (!(await fs.exists(out))) return;
      await fs.writeFile(out, reportHtml([...this.tasks, ...(await this.archived())], Date.now(), this.config.jiraUrl ?? null));
    }).catch(() => {});
  }

  async archived() {
    const file = `${this.dir}/tasks-archive.json`;
    return (await fs.exists(file)) ? JSON.parse(await fs.readFile(file, "utf8")) : [];
  }

  // A status change puts the task at the top of its new group and notes when it was done.
  update(id, patch) {
    const top = this.top();
    this.tasks = this.tasks.map((x) => {
      if (x.id !== id) return x;
      const now = Date.now();
      const next = { ...x, ...patch, updated: now };
      if (patch.status && patch.status !== x.status) {
        next.rank = top;
        next.doneAt = patch.status === "done" ? now : null;
        next.history = [...(x.history ?? []), { status: patch.status, at: now }];
        // Done ends a block.
        if (patch.status === "done") next.blocked = null;
      }
      return next;
    });
    this.persist();
  }

  // Blocked, with a one-line reason, or unblocked (reason null). Both go into `history` for the report.
  setBlocked(id, reason) {
    const now = Date.now();
    this.tasks = this.tasks.map((x) => {
      if (x.id !== id) return x;
      const entry = reason ? { status: "blocked", at: now, reason } : { status: "unblocked", at: now };
      return { ...x, blocked: reason ? { reason, at: now } : null, updated: now, history: [...(x.history ?? []), entry] };
    });
    this.persist();
  }

  // Today's plan: marks or unmarks the task for today.
  toggleToday(id) {
    const now = Date.now();
    this.tasks = this.tasks.map((x) => (x.id === id ? { ...x, todayAt: isToday(x, now) ? null : now } : x));
    this.persist();
  }

  // A dated progress note: what moved on a task that isn't done yet.
  addLog(id, text) {
    const now = Date.now();
    this.tasks = this.tasks.map((x) => (x.id === id ? { ...x, log: [...(x.log ?? []), { at: now, text }], updated: now } : x));
    this.persist();
  }

  // A note keeps its time when its text changes, so the standup still files it under the right day.
  editLog(id, at, text) {
    const now = Date.now();
    this.tasks = this.tasks.map((x) => (x.id === id
      ? { ...x, log: (x.log ?? []).map((n) => (n.at === at ? { ...n, text, edited: now } : n)), updated: now } : x));
    this.persist();
  }

  // First click asks ("Delete?"), the second removes; the question lapses after 3 seconds.
  removeLog(id, at, cx) {
    const key = `${id}:${at}`;
    if (this.logConfirm !== key) {
      this.logConfirm = key;
      cx.notify();
      cx.timer.after(3000, (cx) => { if (this.logConfirm === key) { this.logConfirm = null; cx.notify(); } });
      return;
    }
    this.logConfirm = null;
    if (this.logEdit?.at === at) { this.logEdit = null; this.logIn.set_value(""); }
    this.tasks = this.tasks.map((x) => (x.id === id ? { ...x, log: (x.log ?? []).filter((n) => n.at !== at), updated: Date.now() } : x));
    this.persist();
    cx.notify();
  }

  startLogEdit(id, note, cx) {
    this.logEdit = { id, at: note.at };
    this.logConfirm = null;
    this.logIn.set_value(note.text);
    this.logIn.focus();
    cx.notify();
  }

  cancelLogEdit(cx) {
    this.logEdit = null;
    this.logIn.set_value("");
    cx.notify();
  }

  // b: blocked tasks unblock at once; others open with the reason field taking the keyboard.
  startBlock(task, cx) {
    if (isBlocked(task)) { this.setBlocked(task.id, null); cx.notify(); return; }
    this.open = task.id;
    this.blocking = task.id;
    this.blockIn.set_value("");
    this.blockIn.focus();
    cx.notify();
  }

  // A rank above every task (smaller sits higher).
  top() {
    return Math.min(0, ...this.tasks.map((x) => x.rank ?? 0)) - 1;
  }

  // Swaps the selected task with its neighbour in the same group (dir -1 up, 1 down).
  move(dir) {
    const a = this.rows[this.nav.sel]?.task;
    const b = this.rows[this.nav.sel + dir]?.task;
    if (!a || !b || a.status !== b.status) return;
    this.tasks = this.tasks.map((x) => (x.id === a.id ? { ...x, rank: b.rank } : x.id === b.id ? { ...x, rank: a.rank } : x));
    this.hold = a.id;
    this.persist();
  }

  // Puts a task just before or after another in the same group, reusing the group's ranks.
  moveTo(id, targetId, after) {
    const a = this.tasks.find((x) => x.id === id);
    const b = this.tasks.find((x) => x.id === targetId);
    if (!a || !b || a.id === b.id || a.status !== b.status) return;
    const group = this.tasks.filter((x) => x.status === a.status).sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0));
    const ranks = group.map((x) => x.rank);
    const rest = group.filter((x) => x.id !== a.id);
    rest.splice(rest.findIndex((x) => x.id === b.id) + (after ? 1 : 0), 0, a);
    const rank = new Map(rest.map((x, i) => [x.id, ranks[i]]));
    this.tasks = this.tasks.map((x) => (rank.has(x.id) ? { ...x, rank: rank.get(x.id) } : x));
    this.selId = a.id;
    this.persist();
  }

  // ---- dragging (GPUI gives script views no drag payloads: a press, its moves and the release are tracked here)

  // The pointer moves over a card. A press that has moved 5px becomes a drag; the card under it, if it is
  // in the dragged task's group, shows where the task would land (its upper or lower half).
  dragOver(task, e, cx) {
    if (!this.press) return;
    if (!this.drag) {
      if (Math.abs(e.position.y - this.press.y) < 5) return;
      this.drag = this.press.id;
    }
    const dragged = this.tasks.find((x) => x.id === this.drag);
    const over = dragged && task.id !== dragged.id && task.status === dragged.status
      ? { id: task.id, after: e.local_position.y > e.bounds.height / 2 } : null;
    if (over?.id !== this.over?.id || over?.after !== this.over?.after || !this.dragShown) {
      this.over = over;
      this.dragShown = true;
      cx.notify();
    }
  }

  drop(cx) {
    const { drag, over } = this;
    this.press = null;
    this.drag = null;
    this.over = null;
    this.dragShown = false;
    if (drag && over) this.moveTo(drag, over.id, over.after);
    if (drag) cx.notify();
  }

  // Moves done tasks to tasks-archive.json: those done over a week ago, or all of them. The archive is
  // written before the list, so a failed write keeps the tasks. Returns whether any moved.
  archive(all = false) {
    if (!this.ready) return false;
    const now = Date.now();
    const old = this.tasks.filter((x) => x.status === "done" && (all || now - (x.doneAt ?? x.updated ?? now) > WEEK));
    if (!old.length) return false;
    const ids = new Set(old.map((x) => x.id));
    this.tasks = this.tasks.filter((x) => !ids.has(x.id));
    if (this.open && ids.has(this.open)) this.open = null;
    this.toArchive(old.map((x) => ({ ...x, archived: now })), old, "Couldn't archive done tasks.");
    return true;
  }

  // Puts tasks (already out of this.tasks) at the top of the archive, then saves the list. A failed
  // archive write brings the originals back.
  toArchive(moved, originals, failText) {
    const file = `${this.dir}/tasks-archive.json`;
    this.queue = this.queue.then(async () => {
      try {
        const prev = (await fs.exists(file)) ? JSON.parse(await fs.readFile(file, "utf8")) : [];
        await fs.writeFile(file, JSON.stringify([...moved, ...prev], null, 2));
      } catch {
        this.tasks = [...this.tasks, ...originals];
        this.headNote = failText;
      }
      await fs.writeFile(`${this.dir}/tasks.json`, JSON.stringify(this.tasks, null, 2));
    }).catch(() => { this.headNote = "Couldn't save tasks."; });
    this.refreshReport();
  }

  // Writes report.html from the list and the archive, after any queued save, and opens it in the browser.
  report(cx) {
    if (this.reporting) return;
    this.reporting = true;
    this.reportNote = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.queue;
        const out = `${this.dir}/report.html`;
        await fs.writeFile(out, reportHtml([...this.tasks, ...(await this.archived())], Date.now(), this.config.jiraUrl ?? null));
        const r = await exec("open", [out]);
        if (r.code !== 0) throw new Error((r.stderr || "Couldn't open the report.").trim().split("\n")[0]);
      } catch (e) {
        this.reportNote = String(e.message ?? e);
      }
      this.reporting = false;
      cx.notify();
    });
  }

  // ---- form

  // One line, Enter: a task with just a title. The + opens the full form for details and links.
  quickAdd(cx) {
    const title = this.quickIn.value().trim();
    if (!title) return;
    const id = `task-${Date.now().toString(36)}`;
    const now = Date.now();
    this.tasks = [{ id, title, notes: "", links: [], status: "todo", agent: null, created: now, updated: now, rank: this.top(), history: [{ status: "todo", at: now }] }, ...this.tasks];
    this.quickIn.set_value("");
    if (this.filter === "doing" || this.filter === "done") this.filter = null;
    this.persist();
    cx.notify();
  }

  edit(task, cx) {
    this.form = { id: task?.id ?? null, links: [...(task?.links ?? [])] };
    // Anything typed in the quick field carries over into a new task's form.
    this.titleIn.set_value(task?.title ?? this.quickIn.value());
    if (!task) this.quickIn.set_value("");
    this.notesIn.set_value(task?.notes ?? "");
    this.linkIn.set_value("");
    this.note = null;
    this.titleIn.focus();
    cx.notify();
  }

  addLink(cx) {
    const raw = this.linkIn.value();
    if (!raw.trim() || !this.form) return;
    const link = toLink(raw);
    if (!link) {
      this.note = { ok: false, text: "Links must start with http:// or https://" };
    } else {
      if (!this.form.links.includes(link)) this.form.links.push(link);
      this.linkIn.set_value("");
      this.note = null;
    }
    cx.notify();
  }

  save(cx) {
    const form = this.form;
    const title = this.titleIn.value().trim();
    if (!form || !title) return;
    // A link typed but not yet added still counts.
    const pending = toLink(this.linkIn.value());
    const links = pending && !form.links.includes(pending) ? [...form.links, pending] : form.links;
    const notes = this.notesIn.value().trim();
    if (form.id) this.update(form.id, { title, notes, links });
    else {
      const id = `task-${Date.now().toString(36)}`;
      const now = Date.now();
      this.tasks = [{ id, title, notes, links, status: "todo", agent: null, created: now, updated: now, rank: this.top(), history: [{ status: "todo", at: now }] }, ...this.tasks];
      this.open = id;
      if (this.filter === "doing" || this.filter === "done") this.filter = null;
      this.persist();
    }
    this.form = null;
    this.note = null;
    cx.notify();
  }

  // ---- keyboard

  onKey(e, cx) {
    // A form field has the keyboard: its keys are its own.
    if (!this.nav.focused()) return;
    const it = () => this.rows[this.nav.sel]?.task;
    const toggle = () => { const x = it(); if (x) { this.open = this.open === x.id ? null : x.id; this.confirm = null; this.note = null; } };
    const step = () => { const x = it(); if (x) this.update(x.id, { status: NEXT[x.status] }); };
    const quick = () => this.quickIn.focus();
    const FILTER_CYCLE = [null, "todo", "doing", "done"];
    const used = this.nav.key(e, this.rows.length, {
      enter: toggle, l: toggle,
      space: step, x: step,
      e: () => { const x = it(); if (x) this.edit(x, cx); },
      a: quick, o: quick,
      // The + button: a new task with the full form.
      n: () => this.edit(null, cx), "+": () => this.edit(null, cx),
      s: () => { const x = it(); if (x) this.send(x, cx); },
      // dd is deliberate enough: no second press.
      dd: () => { const x = it(); if (x) { this.confirm = x.id; this.remove(x, cx); } },
      f: () => { this.filter = FILTER_CYCLE[(FILTER_CYCLE.indexOf(this.filter) + 1) % FILTER_CYCLE.length]; },
      D: () => { this.showDone = !this.showDone; },
      K: () => this.move(-1), J: () => this.move(1),
      A: () => this.archive(true),
      R: () => this.report(cx),
      b: () => { const x = it(); if (x && x.status !== "done") this.startBlock(x, cx); },
      t: () => { const x = it(); if (x && x.status !== "done") this.toggleToday(x.id); },
      // p: the task opens with its progress note field taking the keyboard.
      p: () => { const x = it(); if (x && x.status !== "done") { this.open = x.id; this.logIn.focus(); } },
    }, run);
    if (!used) return;
    cx.stop_propagation();
    // The selection follows the task, not the row: a status change, a move or a new task moves it.
    this.selId = this.hold ?? it()?.id ?? null;
    this.hold = null;
    // Scrolled in render, once the rows are rebuilt and the task's new place is known.
    this.scrollPending = true;
    cx.notify();
  }

  // ---- actions

  remove(task, cx) {
    if (this.confirm !== task.id) {
      this.confirm = task.id;
      cx.notify();
      cx.timer.after(3000, (cx) => {
        if (this.confirm === task.id) this.confirm = null;
        cx.notify();
      });
      return;
    }
    // Deleted tasks go to the archive marked `deleted`, so finished work stays in the report.
    const now = Date.now();
    this.tasks = this.tasks.filter((x) => x.id !== task.id);
    this.confirm = null;
    if (this.open === task.id) this.open = null;
    this.toArchive([{ ...task, deleted: now, archived: now }], [task], "Couldn't delete the task.");
    // The brief file would only mislead an agent now.
    fs.unlink(`${this.dir}/briefs/${task.id}.md`).catch(() => {});
    cx.notify();
  }

  copyBrief(task, cx) {
    cx.write_to_clipboard(brief(task));
    this.copied = task.id;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === task.id) this.copied = null;
      cx.notify();
    });
  }

  copyText(text, key, cx) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === key) this.copied = null;
      cx.notify();
    });
  }

  // Where Send goes: the agent picked in the list, else the one whose terminal is active.
  target(list) {
    return (this.pick && list.find((a) => a.address === this.pick)) || list.find((a) => a.address === focused()?.terminal) || null;
  }

  // The chosen agent gets a one-line pointer to the task's brief file.
  send(task, cx) {
    const target = this.target(agents());
    if (!target) {
      this.note = { ok: false, text: "Focus an agent terminal first." };
      cx.notify();
      return;
    }
    if (this.sending) return;
    this.sending = task.id;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const file = `${this.dir}/briefs/${task.id}.md`;
        await fs.writeFile(file, brief(task));
        let path = file;
        if (target.address.includes("/")) {
          // On another machine: put the file beside that terminal and use where it landed.
          const put = await hc(["put", target.address, file]);
          if (put.code !== 0) throw new Error((put.stderr || put.stdout || "Couldn't copy the brief there.").trim().split("\n")[0]);
          path = put.stdout.trim().split("\n").filter(Boolean).pop().replace(/^["']|["']$/g, "");
        }
        const text = `Read ${path} and work on the task described in it: ${task.title}`;
        const r = await hc(["send", target.address, text, ...(target.status === "blocked" ? ["--force"] : [])]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Not sent").trim().split("\n")[0]);
        this.update(task.id, { agent: target.address, status: task.status === "todo" ? "doing" : task.status });
        this.note = { ok: true, text: `Sent to ${target.address}` };
        this.pick = null;
        this.menuFor = null;
      } catch (e) {
        this.note = { ok: false, text: String(e.message ?? e) };
      }
      this.sending = null;
      cx.notify();
    });
  }

  // ---- pieces

  button(t, id, label, action, primary = false) {
    return div().id(id).h(26).px(10).flex().items_center().flex_none().rounded(7).text_size(12).font_medium().cursor_pointer()
      .accessibility_label(label)
      .border(1).border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.chrome).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.bg(primary ? t.solid : t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(label);
  }

  iconButton(t, id, path, label, action, color, size = 24) {
    return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(color ?? t.dim).cursor_pointer().tooltip(label).accessibility_label(label)
      .hover((s) => s.bg(t.raised).text_color(color ?? t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(svg(path).size(13));
  }

  // Today / Blocked: a tinted pill when on; with an action (an open card), a switch that shows an
  // outline "+ Today" while off.
  toggle(t, id, icon, label, on, color, tip, action) {
    return h_flex().id(id).h(18).px(7).gap(4).items_center().flex_none().rounded(9).text_size(11).font_medium()
      .tooltip(tip).accessibility_label(tip)
      .when(on, (el) => el.bg(color + "1f").text_color(color))
      .when(!on, (el) => el.border(1).border_color(t.border).text_color(t.dim))
      .when(Boolean(action), (el) => el.cursor_pointer()
        .hover((s) => s.bg(color + (on ? "33" : "14")).text_color(color)).active((s) => s.bg(color + "40"))
        // The press must not reach the card header: a click's stop_propagation also swallows the
        // pane's mouse-up, so a leftover press would turn the next mouse move into a drag (dimmed card).
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .child(on ? svg(`mods/cockpit-tasks/${icon}`).size(10).flex_none() : svg(`${ICONS}/plus.svg`).size(10).flex_none())
      .child(label);
  }

  // A small rounded label: icon and/or text, optionally tinted.
  pill(t, children, color) {
    return h_flex().h(18).px(7).gap(4).items_center().flex_none().rounded(9).text_size(11)
      .bg(color ? color + "1f" : t.raised).text_color(color ?? t.muted).children(children);
  }

  // The status mark, which is also the button that moves a task along: to do, doing, done.
  mark(t, task) {
    const next = NEXT[task.status];
    const face = task.status === "done"
      ? div().size(18).rounded(9).bg(t.ansi2).flex().items_center().justify_center().text_color(t.chrome).child(svg(`${ICONS}/check.svg`).size(11))
      : task.status === "doing"
        ? div().size(18).rounded(9).border(2).border_color(t.working).flex().items_center().justify_center().child(div().size(6).rounded(3).bg(t.working))
        : div().size(18).rounded(9).border(1.5).border_color(t.input);
    return div().id(`mark-${task.id}`).size(26).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
      .tooltip(`${LABEL[task.status]}. Click to mark ${LABEL[next].toLowerCase()}`)
      .accessibility_label(`${LABEL[task.status]}. Mark ${LABEL[next].toLowerCase()}`)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (this.drag) return; // the release that ends a drag is not a click
        this.update(task.id, { status: next });
        cx.notify();
      })
      .child(face);
  }

  field(t, id, state, name) {
    return div().id(id).key_context("TaskField").min_h(32).px(10).flex().items_center().flex_1().min_w(0).rounded(8).border(1)
      .border_color(this.focus === name ? t.accent : t.border).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).w_full().text_size(12.5).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation()));
  }

  // Lined up with the left edge of what it labels.
  label(t, text) {
    return div().text_size(11).font_medium().text_color(t.dim).child(text);
  }

  // The next (1) or previous (-1) form field, wrapping: title, details, link.
  stepField(dir, cx) {
    const order = ["title", "notes", "link"];
    const at = Math.max(0, order.indexOf(this.focus));
    const next = order[(at + dir + order.length) % order.length];
    ({ title: this.titleIn, notes: this.notesIn, link: this.linkIn })[next].focus();
    cx.notify();
  }

  formCard(t) {
    const form = this.form;
    const ready = this.titleIn.value().trim().length > 0;
    return v_flex().id("task-form").flex_none().p(14).gap(12).rounded(10).border(1).border_color(t.accent + "88").bg(t.surface)
      // Tab / Shift+Tab step through title, details and link (bound in init under this context).
      .key_context("TaskForm")
      .on_action("cockpit-tasks.next-field", (_e, cx) => this.stepField(1, cx))
      .on_action("cockpit-tasks.prev-field", (_e, cx) => this.stepField(-1, cx))
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(13).font_semibold().child(form.id ? "Edit task" : "New task"))
        .child(this.iconButton(t, "f-close", `${ICONS}/x.svg`, "Cancel", (cx) => { this.form = null; this.note = null; cx.notify(); })))
      .child(v_flex().gap(4).child(this.label(t, "Title")).child(h_flex().child(this.field(t, "f-title", this.titleIn, "title"))))
      .child(v_flex().gap(4).child(this.label(t, "Details · Markdown"))
        // The editor has padding of its own: this wrapper only adds what lines the text up with the single-line fields.
        .child(div().id("f-notes").key_context("TaskField").h(132).px(5).py(4).rounded(8).border(1).border_color(this.focus === "notes" ? t.accent : t.border).bg(t.background).cursor_text()
          .overflow_hidden().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Editor.new(this.notesIn).size_full().on_mouse_down("left", (_e, cx) => cx.stop_propagation()))))
      .child(v_flex().gap(6)
        .child(this.label(t, form.links.length ? `Links · ${form.links.length}` : "Links"))
        .child(h_flex().gap(6).items_center()
          .child(this.field(t, "f-link", this.linkIn, "link"))
          .child(this.button(t, "f-add-link", "Add", (cx) => this.addLink(cx))))
        .children(form.links.map((l, i) => h_flex().id(`f-link-${i}`).h(26).pl(9).pr(2).gap(6).items_center().rounded(6).bg(t.raised).text_size(11.5).text_color(t.muted)
          .child(svg("mods/cockpit-tasks/link.svg").size(11).flex_none().text_color(t.dim))
          .child(div().id(`f-link-text-${i}`).flex_1().min_w(0).truncate().tooltip(l).child(short(l)))
          .child(this.iconButton(t, `f-link-x-${i}`, `${ICONS}/x.svg`, "Remove link", (cx) => {
            form.links = form.links.filter((x) => x !== l);
            cx.notify();
          }, null, 22)))))
      .when(Boolean(this.note), (el) => el.child(div().text_size(11.5).text_color(this.note.ok ? t.ansi2 : t.blocked).child(this.note.text)))
      .child(div().min_w(0).px(2).text_size(11).text_color(t.dim).child("Tab moves between fields · Enter in the title saves · ⌘Enter in details saves"))
      .child(h_flex().gap(8).items_center().justify_end()
        .child(this.button(t, "f-cancel", "Cancel", (cx) => { this.form = null; this.note = null; cx.notify(); }))
        .child(div().id("f-save").h(26).px(14).flex().items_center().flex_none().rounded(7).text_size(12).font_medium()
          .accessibility_label("Save task").bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
          .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(t.solid)).active((s) => s.bg(t.selected).text_color(t.foreground)))
          .on_click((_e, cx) => this.save(cx))
          .child("Save")));
  }

  card(t, task, now, live, on = false) {
    const open = this.open === task.id;
    const done = task.status === "done";
    const list = agents();
    const target = this.target(list);
    // A pick that is now the active agent is the same as following it.
    const following = !this.pick || this.pick === focused()?.terminal || !list.some((a) => a.address === this.pick);
    const agent = task.agent ? live.get(task.agent) : null;
    const targetName = target ? clean(target.title) || target.program?.name || "agent" : null;
    const blocked = isBlocked(task);
    const today = !done && isToday(task, now);
    const accent = done ? t.ansi2 + "55" : blocked ? t.blocked : task.status === "doing" ? (agent === "blocked" ? t.blocked : t.working) : t.chrome;
    const agentColor = agent === "working" ? t.working : agent === "blocked" ? t.blocked : agent === "done" ? t.done : null;
    const sending = this.sending === task.id;
    const confirming = this.confirm === task.id;
    // The work item: Jira key, the space on that branch, its agent and MR (see work.js).
    const work = done ? null : workOf(task, { panes: panes(), spaces: spaces(), agents: list, mrs: shared("cockpit.mrs"), jira: this.config.jiraUrl ?? null });
    const chip = (id, text, color, tip, onClick) => div().id(id).flex_none().h(18).px(6).flex().items_center().rounded(9).bg(color + "1f")
      .text_size(10.5).font_medium().text_color(color).cursor_pointer().tooltip(tip).accessibility_label(tip)
      .hover((s) => s.bg(color + "33")).active((s) => s.bg(color + "40"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(text);
    const dragging = this.drag === task.id;
    const dropHere = this.over?.id === task.id ? this.over : null;
    return h_flex().id(`task-${task.id}`).relative().w_full().flex_none().rounded(10).border(1).overflow_hidden()
      .border_color(on ? t.accent : open ? t.input : t.border).bg(on && !open ? t.selected : open ? t.surface : t.chrome)
      // The whole card lights up while it is closed. An open card stays still: a band over
      // just its header would end halfway down, where the details begin.
      .when(!open && !this.drag, (el) => el.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .when(dragging, (el) => el.opacity(0.45))
      .on_mouse_move((e, cx) => this.dragOver(task, e, cx))
      // Where a dragged task would land: a line on this card's top or bottom edge.
      .when(Boolean(dropHere), (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(dropHere.after, (el) => el.bottom(0)).when(!dropHere.after, (el) => el.top(0))))
      // A stripe on the left says where the task stands before you read it.
      .child(div().w(3).flex_none().bg(accent))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().id(`task-head-${task.id}`).pl(6).pr(12).py(10).gap(5).items_start().cursor_pointer()
          .accessibility_label(`${task.title}, ${LABEL[task.status]}. ${open ? "Collapse" : "Expand"}`)
          .on_mouse_down("left", (e) => { this.press = { id: task.id, y: e.position.y }; })
          .on_click((_e, cx) => {
            if (this.drag) return; // the release that ends a drag is not a click
            this.open = open ? null : task.id;
            this.confirm = null;
            this.note = null;
            this.blocking = null;
            this.logEdit = null;
            this.logConfirm = null;
            this.logIn.set_value("");
            cx.notify();
          })
          .child(this.mark(t, task))
          .child(v_flex().flex_1().min_w(0).gap(7).pt(3)
            .child(h_flex().gap(8).items_start()
              .child(div().id(`task-title-${task.id}`).flex_1().min_w(0).when(!open, (el) => el.truncate()).tooltip(task.title)
                .text_size(13).font_medium().text_color(done ? t.dim : t.foreground).when(done, (el) => el.line_through()).child(task.title))
              .child(div().id(`task-age-${task.id}`).flex_none().text_size(11).text_color(t.dim).pt(1)
                .tooltip(`Updated ${ago(now - task.updated)} ago`).child(ago(now - task.updated))))
            .when(!open && Boolean(preview(task.notes, task.title)), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(preview(task.notes, task.title))))
            .when((task.links.length > 0 && !open) || Boolean(task.agent) || Boolean(work) || blocked || today || (open && !done), (el) => el.child(h_flex().gap(5).items_center().flex_wrap()
              // Today and Blocked: pills when set; on an open card, switches (an outline "+ Today" when off).
              .when(blocked || (open && !done), (el) => el.child(this.toggle(t, `task-blocked-${task.id}`, "ban.svg", "Blocked", blocked, t.blocked,
                blocked ? `Blocked: ${task.blocked.reason}${open ? ". Click to unblock (b)" : ""}` : "Mark blocked (b)", open ? (cx) => this.startBlock(task, cx) : null)))
              .when(today || (open && !done), (el) => el.child(this.toggle(t, `task-today-${task.id}`, "sun.svg", "Today", today, t.accent,
                today ? `Planned for today${open ? ". Click to unmark (t)" : ""}` : "Plan for today (t)", open ? (cx) => { this.toggleToday(task.id); cx.notify(); } : null)))
              .when(Boolean(work), (el) => el
                .child(chip(`task-jira-${task.id}`, work.key, t.ansi4, work.url ? `Open ${work.key} in Jira` : `${work.key} (set jiraUrl in config.json to link it)`, (cx) => { if (work.url) cx.open_url(work.url); }))
                .when(Boolean(work.space), (el) => el.child(chip(`task-space-${task.id}`, work.space.name, t.muted, `Go to ${work.space.name}${work.branch ? ` on ${work.branch}` : ""}`,
                  () => { run("space.select", { id: work.space.id }); if (work.tab) run("tab.select", { id: work.tab }); })))
                .when(Boolean(work.mr), (el) => el.child(chip(`task-mr-${task.id}`, `!${work.mr.iid}${work.mr.pipeline ? ` ${work.mr.pipeline}` : ""}`,
                  work.mr.pipeline === "failed" ? t.blocked : work.mr.pipeline === "success" ? t.ansi2 : t.working, `Open ${work.mr.repo} !${work.mr.iid}`, (cx) => cx.open_url(work.mr.url)))))
              // The link count only on a closed card: an open one lists the links.
              .when(task.links.length > 0 && !open, (el) => el.child(this.pill(t, [svg("mods/cockpit-tasks/link.svg").size(10).flex_none(), `${task.links.length}`])))
              .when(Boolean(task.agent), (el) => el.child(h_flex().id(`task-agent-${task.id}`).h(18).max_w(170).px(7).gap(5).items_center().flex_none().rounded(9).bg(t.raised)
                .tooltip(agent ? `${task.agent} is ${agent}` : `${task.agent} is no longer running`)
                .child(div().size(6).rounded(3).flex_none().bg(agentColor ?? t.dim + "88"))
                .child(div().min_w(0).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).text_color(agent ? t.muted : t.dim).child(task.agent))))))))
        .when(open, (el) => el.child(v_flex().pl(37).pr(12).pb(12).gap(12)
          .when(Boolean(task.notes), (el) => el.child(div().id(`task-notes-${task.id}`).p(10).rounded(8).bg(t.raised).text_size(12).text_color(t.muted)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(TextView.markdown(`task-md-${task.id}`, flatHeadings(task.notes)).selectable(true))))
          .when(task.links.length > 0, (el) => el.child(v_flex().gap(4)
            .child(this.label(t, "Links"))
            .children(task.links.map((l, i) => h_flex().id(`task-link-${task.id}-${i}`).h(28).pl(9).pr(2).gap(6).items_center().rounded(7).bg(t.raised)
              .cursor_pointer().accessibility_label(`Open ${short(l)}`)
              .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
              .on_click((_e, cx) => cx.open_url(l))
              .child(svg("mods/cockpit-tasks/external.svg").size(11).flex_none().text_color(t.dim))
              .child(div().id(`task-link-text-${task.id}-${i}`).flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).tooltip(l).child(short(l)))
              .child(this.iconButton(t, `task-link-copy-${task.id}-${i}`, this.copied === `${task.id}-${i}` ? `${ICONS}/check.svg` : "mods/cockpit-tasks/copy.svg", this.copied === `${task.id}-${i}` ? "Copied" : "Copy link",
                (cx) => this.copyText(l, `${task.id}-${i}`, cx), this.copied === `${task.id}-${i}` ? t.ansi2 : null, 22))))))
          // Blocked: the reason, how long, and the way out.
          // The reason gets the full width; Unblock sits on the heading line.
          .when(blocked, (el) => el.child(v_flex().id(`task-block-${task.id}`).pl(10).pr(4).pt(4).pb(8).gap(2).rounded(8)
            .border(1).border_color(t.blocked + "55").bg(t.blocked + "14")
            .child(h_flex().gap(6).items_center()
              .child(svg("mods/cockpit-tasks/ban.svg").size(12).flex_none().text_color(t.blocked))
              .child(div().flex_1().min_w(0).text_size(11).font_medium().text_color(t.blocked).child(`Blocked ${ago(now - task.blocked.at)}`))
              .child(div().id(`task-unblock-${task.id}`).h(22).px(8).flex().items_center().flex_none().rounded(6).text_size(11.5).font_medium()
                .text_color(t.blocked).cursor_pointer().accessibility_label("Unblock")
                .hover((s) => s.bg(t.blocked + "26")).active((s) => s.bg(t.blocked + "40"))
                .on_click((_e, cx) => { cx.stop_propagation(); this.setBlocked(task.id, null); cx.notify(); })
                .child("Unblock")))
            .child(div().pr(6).text_size(12).text_color(t.foreground).whitespace_normal().child(task.blocked.reason))))
          .when(!blocked && this.blocking === task.id, (el) => el.child(v_flex().gap(4)
            .child(this.label(t, "Blocked by"))
            .child(h_flex().gap(6).items_center()
              .child(this.field(t, `task-block-in-${task.id}`, this.blockIn, "block"))
              .child(this.button(t, `task-block-cancel-${task.id}`, "Cancel", (cx) => { this.blocking = null; cx.notify(); })))))
          // Progress notes: what moved, newest first (the last three, or all after "Show all"). Each one
          // can be edited (its text goes into the field below) or deleted (a second click confirms).
          .when(!done, (el) => el.child(this.progressNotes(t, task, now)))
          .when(Boolean(this.note) && !this.form, (el) => el.child(div().text_size(11.5).text_color(this.note.ok ? t.ansi2 : t.blocked).child(this.note.text)))
          // Send is filled only when there is an agent to send to; otherwise an outline. Its label may cut
          // off ("Send to mac15/t1…") so Copy, Edit and Delete always fit beside it.
          .child(h_flex().gap(4).items_center()
            .child(h_flex().h(28).min_w(0).rounded(7).overflow_hidden().border(1).border_color(target ? t.solid : t.border).bg(target ? t.solid : t.surface)
              .child(h_flex().id(`task-send-${task.id}`).h_full().min_w(0).pl(10).pr(9).gap(6).items_center().text_size(12).font_medium()
                .accessibility_label(target ? `Send to ${targetName}, ${target.address}` : "Send to the active agent")
                .text_color(target ? t.solid_foreground : t.dim)
                .when(Boolean(target), (el) => el.cursor_pointer().hover((s) => s.bg(t.solid_foreground + "14")).active((s) => s.bg(t.solid_foreground + "26")))
                .tooltip(target ? `${targetName} · ${target.address}${following ? " (active agent)" : ""}` : "Focus an agent terminal, or choose one")
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.send(task, cx);
                })
                .child(svg("mods/cockpit-tasks/send.svg").size(12).flex_none())
                .child(div().min_w(0).truncate().child(sending ? "Sending…" : target ? `Send to ${target.address}` : "Send to agent")))
              .child(div().w(1).h_full().flex_none().bg(target ? t.solid_foreground + "33" : t.border))
              .child(div().id(`task-send-menu-${task.id}`).h_full().w(26).flex_none().flex().items_center().justify_center()
                .text_color(target ? t.solid_foreground : t.muted).cursor_pointer().tooltip("Choose an agent")
                .accessibility_label(this.menuFor === task.id ? "Close agent list" : "Choose which agent to send to")
                .when(this.menuFor === task.id, (el) => el.bg((target ? t.solid_foreground : t.dim) + "26"))
                .hover((s) => s.bg((target ? t.solid_foreground : t.dim) + "1a")).active((s) => s.bg((target ? t.solid_foreground : t.dim) + "33"))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.menuFor = this.menuFor === task.id ? null : task.id;
                  this.menuOff = 0;
                  cx.notify();
                })
                .child(svg(`mods/cockpit-tasks/chevron-${this.menuFor === task.id ? "up" : "down"}.svg`).size(12))))
            .child(div().flex_1().min_w(4))
            .child(this.iconButton(t, `task-copy-${task.id}`, this.copied === task.id ? `${ICONS}/check.svg` : "mods/cockpit-tasks/copy.svg", this.copied === task.id ? "Copied" : "Copy brief to paste into a prompt",
              (cx) => this.copyBrief(task, cx), this.copied === task.id ? t.ansi2 : null))
            .child(this.iconButton(t, `task-edit-${task.id}`, `${ICONS}/square-pen.svg`, "Edit", (cx) => this.edit(task, cx)))
            // Delete stands a little apart from the everyday actions.
            .child(div().w(1).h(14).mx(2).flex_none().bg(t.border))
            .child(confirming
              ? h_flex().id(`task-del-${task.id}`).h(24).px(9).items_center().flex_none().rounded(6).bg(t.blocked + "26").text_size(11.5).font_medium().text_color(t.blocked)
                .cursor_pointer().accessibility_label("Confirm delete").hover((s) => s.bg(t.blocked + "3a")).active((s) => s.bg(t.blocked + "4d"))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.remove(task, cx);
                })
                .child("Delete?")
              : this.iconButton(t, `task-del-${task.id}`, "mods/cockpit-tasks/trash.svg", "Delete", (cx) => this.remove(task, cx))))
          .when(this.menuFor === task.id, (el) => el.child(this.agentMenu(t, task, list, target, following))))));
  }

  progressNotes(t, task, now) {
    const log = task.log ?? [];
    const all = this.logAll === task.id;
    const shown = (all ? log : log.slice(-3)).slice().reverse();
    const editing = this.logEdit?.id === task.id ? this.logEdit : null;
    return v_flex().gap(4)
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().child(this.label(t, log.length ? `Progress · ${log.length}` : "Progress")))
        .when(log.length > 3, (el) => el.child(div().id(`task-log-all-${task.id}`).px(6).h(20).flex().items_center().rounded(5)
          .text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .accessibility_label(all ? "Show the last three notes" : `Show all ${log.length} notes`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.logAll = all ? null : task.id; cx.notify(); })
          .child(all ? "Show fewer" : `Show all ${log.length}`))))
      // A small timeline: a dot per note joined by a line, the text, and its time underneath. Edit and
      // delete appear on the note under the pointer (and stay while it is being edited or confirmed);
      // their space is kept either way, so the text never reflows on hover.
      .children(shown.map((n, i) => {
        const key = `${task.id}:${n.at}`;
        const isEdit = editing?.at === n.at;
        const confirming = this.logConfirm === key;
        const actions = this.hoverNote === key || isEdit || confirming;
        const last = i === shown.length - 1;
        const text = shortUrls(n.text);
        return h_flex().id(`task-log-${key}`).gap(8).items_stretch().rounded(6)
          .on_hover((inside, cx) => {
            if (inside) this.hoverNote = key;
            else if (this.hoverNote === key) this.hoverNote = null;
            cx.notify();
          })
          .child(v_flex().w(7).flex_none().items_center().pt(5)
            .child(div().size(7).rounded(4).flex_none().bg(isEdit ? t.accent : i === 0 ? t.muted : t.border))
            .when(!last, (el) => el.child(div().w(1).flex_1().mt(3).bg(t.border))))
          .child(v_flex().flex_1().min_w(0).gap(1).pb(last ? 2 : 10)
            .child(div().id(`task-log-text-${key}`).text_size(12).text_color(isEdit ? t.accent : i === 0 ? t.foreground : t.muted).whitespace_normal()
              .when(text !== n.text, (el) => el.tooltip(n.text)).child(text))
            .child(div().id(`task-log-at-${key}`).text_size(10.5).text_color(t.dim)
              .when(Boolean(n.edited), (el) => el.tooltip(`Edited ${ago(now - n.edited)} ago`)).child(`${ago(now - n.at)} ago${n.edited ? " · edited" : ""}`)))
          .child(actions
            ? h_flex().flex_none().gap(2).items_start()
              .child(this.iconButton(t, `task-log-edit-${key}`, `${ICONS}/square-pen.svg`, "Edit note",
                (cx) => this.startLogEdit(task.id, n, cx), isEdit ? t.accent : null, 22))
              .child(confirming
                ? div().id(`task-log-del-${key}`).h(22).px(7).flex().items_center().flex_none().rounded(6).bg(t.blocked + "26")
                  .text_size(11).font_medium().text_color(t.blocked).cursor_pointer().accessibility_label("Confirm delete note")
                  .hover((s) => s.bg(t.blocked + "3a")).active((s) => s.bg(t.blocked + "4d"))
                  .on_click((_e, cx) => { cx.stop_propagation(); this.removeLog(task.id, n.at, cx); })
                  .child("Delete?")
                : this.iconButton(t, `task-log-del-${key}`, "mods/cockpit-tasks/trash.svg", "Delete note", (cx) => this.removeLog(task.id, n.at, cx), null, 22))
            : div().w(46).flex_none());
      }))
      .when(Boolean(editing), (el) => el.child(div().px(2).pt(2).text_size(11).text_color(t.accent).child("Editing note · Enter saves")))
      .child(h_flex().gap(6).items_center()
        .child(this.field(t, `task-log-in-${task.id}`, this.logIn, "log"))
        .when(Boolean(editing), (el) => el.child(this.button(t, `task-log-cancel-${task.id}`, "Cancel", (cx) => this.cancelLogEdit(cx)))));
  }

  // The agents to send to, most urgent first. The first row goes back to following the active one.
  agentMenu(t, task, list, target, following) {
    const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
    const active = list.find((a) => a.address === focused()?.terminal);
    // The active agent has its own first row, so it isn't listed again below.
    const sorted = list.filter((a) => a !== active).sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0));
    const mono = settings().font_family ?? "JetBrains Mono";
    const dot = (a) => a.status === "blocked"
      ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : a.status === "working"
        ? svg(`${ICONS}/spinner.svg`).size(12).flex_none().text_color(t.working).spin(900)
        : div().size(14).flex_none().flex().items_center().justify_center()
          .child(a.status === "done" ? div().size(7).rounded(4).bg(t.done) : div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim));
    const row = (id, a, label, picked, action) => h_flex().id(id).h(30).px(8).gap(8).items_center().flex_none().rounded(6).cursor_pointer()
      .accessibility_label(`${label}${picked ? ", selected" : ""}`)
      .when(picked, (el) => el.bg(t.selected)).hover((s) => s.bg(picked ? t.selected : t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
        this.menuFor = null;
        cx.notify();
      })
      .child(a ? (a.program?.icon ? (a.program.tint ? svg(a.program.icon).size(14).flex_none().text_color(t.foreground) : image(a.program.icon).size(14).flex_none()) : div().size(14).flex_none()) : svg(`${ICONS}/terminal.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().id(`${id}-name`).flex_1().min_w(0).truncate().text_size(12.5).tooltip(label).child(label))
      .when(Boolean(a), (el) => el.child(div().flex_none().h(16).px(4).flex().items_center().rounded(4).bg(t.raised).text_color(t.dim).font_family(mono).text_size(10.5).child(a.address)))
      .when(Boolean(a), (el) => el.child(dot(a)))
      .child(div().w(12).flex_none().flex().items_center().justify_center().when(picked, (el) => el.child(svg(`${ICONS}/check.svg`).size(12).text_color(t.foreground))));
    // A scroll area needs a definite height: rows are 30px with a 1px gap, plus the divider and padding.
    const content = 8 + (sorted.length + 1) * 31 + (sorted.length ? 7 : 0) + (sorted.length ? 0 : 36);
    const height = Math.min(240, content);
    // The wheel is handled here, not by GPUI's scroll area: that one passes the wheel on to the task
    // list behind it at its top and bottom edges. Rows sit in an inner column shifted by the offset.
    const max = Math.max(0, content - (height - 2));
    const off = Math.min(this.menuOff ?? 0, max);
    return div().id(`task-menu-${task.id}`).relative().h(height).w_full().flex_none().rounded(8).border(1).border_color(t.border).bg(t.popover).overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        cx.stop_propagation();
        const next = Math.max(0, Math.min((this.menuOff ?? 0) - e.delta.y, max));
        if (next !== this.menuOff) { this.menuOff = next; cx.notify(); }
      })
      .child(v_flex().absolute().top(-off).left(0).right(0).p(4).gap(1)
      .child(row(`menu-follow-${task.id}`, null, active ? `Active agent · ${clean(active.title) || active.program?.name || active.address}` : "Active agent (none focused)", following,
        () => { this.pick = null; }))
      .when(sorted.length > 0, (el) => el.child(div().h(1).my(3).bg(t.border).flex_none()))
      .when(!sorted.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No agents running")))
      .children(sorted.map((a) => row(`menu-${task.id}-${a.address}`, a, clean(a.title) || a.program?.name || a.address, !following && target?.address === a.address,
        () => { this.pick = a.address; }))));
  }

  // A group heading. Its count is in the filter above; a collapsible group (Done) is quieter.
  section(t, label, color, action, open) {
    return h_flex().id(`sec-${label}`).h(28).px(2).mt(8).gap(7).items_center().flex_none().text_size(11.5).font_medium().rounded(6)
      .text_color(action ? t.dim : t.muted).when(Boolean(action), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.muted)).active((s) => s.bg(t.selected))
        .accessibility_label(`${label}. ${open ? "Hide" : "Show"}`)
        .on_click((_e, cx) => { action(); cx.notify(); }))
      .child(div().size(7).rounded(4).flex_none().bg(action ? color + "99" : color))
      .child(div().child(label))
      .when(Boolean(action), (el) => el.child(div().flex_1()).child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)));
  }

  // "Show 50 more": past 50 cards a group stops, so a long list still draws (200 tasks didn't).
  moreRow(t, id, left) {
    const step = Math.min(PAGE, left);
    return div().id(`more-${id}`).h(30).flex().items_center().justify_center().flex_none().rounded(8).bg(t.raised)
      .text_size(11.5).font_medium().text_color(t.muted).cursor_pointer().accessibility_label(`Show ${step} more, ${left} hidden`)
      .hover((s) => s.text_color(t.foreground).bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => { cx.stop_propagation(); this.limit[id] = (this.limit[id] ?? PAGE) + PAGE; cx.notify(); })
      .child(`Show ${step} more · ${left} hidden`);
  }

  // The filter, as one segmented control: All, To do, Doing, Done, each with its count, and under it a
  // 2px line of how the work splits (done, doing, to do). The counts live here and nowhere else.
  filterBar(t, doing, todo, done) {
    const total = doing + todo + done;
    const f = this.filter;
    const seg = (id, label, count, color) => {
      const on = f === id;
      const empty = count === 0 && !on;
      return h_flex().id(`chip-${id ?? "all"}`).flex_1().min_w(0).h(26).gap(5).items_center().justify_center().rounded(6)
        .text_size(11.5).font_medium().text_color(empty ? t.dim : on ? t.foreground : t.muted)
        .when(on, (el) => el.bg(t.chrome).border(1).border_color(t.border))
        .accessibility_label(`${label}, ${count}${on ? ", shown" : ". Show only these"}`)
        .when(!empty && !on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => { this.filter = id; cx.notify(); }))
        .when(Boolean(color), (el) => el.child(div().size(6).rounded(3).flex_none().bg(empty ? color + "55" : color)))
        .child(div().truncate().child(label))
        .child(div().text_color(t.dim).child(String(count)));
    };
    const line = (n, color) => n ? div().h_full().w(`${(n / total) * 100}%`).bg(color) : null;
    return v_flex().gap(6)
      .child(h_flex().p(2).gap(2).rounded(8).bg(t.raised)
        .child(seg(null, "All", total, null))
        .child(seg("todo", "To do", todo, t.dim))
        .child(seg("doing", "Doing", doing, t.working))
        .child(seg("done", "Done", done, t.ansi2)))
      .child(h_flex().h(2).mx(4).rounded(1).overflow_hidden().bg(t.raised)
        .children([line(done, t.ansi2), line(doing, t.working), line(todo, t.dim)].filter(Boolean)));
  }

  // The quick-add field: a leading +, a fill instead of a border until it has the keyboard.
  quickField(t) {
    const on = this.focus === "quick";
    return h_flex().id("task-quick").key_context("TaskField").min_h(32).pl(10).pr(10).gap(8).items_center().flex_1().min_w(0).rounded(8).border(1)
      .border_color(on ? t.accent : t.raised).bg(on ? t.background : t.raised).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(svg(`${ICONS}/plus.svg`).size(13).flex_none().text_color(on ? t.accent : t.dim))
      .child(Input.new(this.quickIn).w_full().text_size(12.5).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation()));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const live = new Map(agents().map((a) => [a.address, a.status]));
    const by = (status) => this.tasks.filter((x) => x.status === status).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const doing = by("doing"), todo = by("todo"), done = by("done");
    const empty = this.ready && !this.tasks.length && !this.form;
    const f = this.filter;
    const filtered = Boolean(f);
    const shown = (group, id) => (!f || f === id ? group : []);
    // What each group draws: its first `limit` cards (PAGE until "Show more"), and how many wait.
    const cap = (group, id) => group.slice(0, this.limit[id] ?? PAGE);
    const left = (group, id) => Math.max(0, group.length - (this.limit[id] ?? PAGE));
    const doneOpen = !filtered ? this.showDone : f === "done";
    // Keyboard rows: each card and the scroll child it is (the form, loading and empty lines come first).
    const kbd = this.nav.focused();
    const rows = [];
    let at = [Boolean(this.form), !this.ready, empty, filtered && this.ready && this.tasks.length > 0 && !shown(by(f), f).length].filter(Boolean).length;
    // Where the selected task sits now; a task that left the list (done, collapsed) leaves the row index.
    const order = [...cap(shown(doing, "doing"), "doing"), ...cap(shown(todo, "todo"), "todo"), ...(doneOpen ? cap(done, "done") : [])];
    const found = this.selId ? order.findIndex((x) => x.id === this.selId) : -1;
    if (found >= 0) this.nav.sel = found;
    this.nav.clamp(order.length);
    this.selId = order[this.nav.sel]?.id ?? null;
    const cardOf = (x) => {
      rows.push({ task: x, section: at++ });
      return this.card(t, x, now, live, kbd && this.nav.sel === rows.length - 1);
    };
    // A "Show more" row is a scroll child too, so it counts in `at`.
    const more = { doing: left(shown(doing, "doing"), "doing"), todo: left(shown(todo, "todo"), "todo"), done: doneOpen ? left(done, "done") : 0 };
    if (!filtered && doing.length > 0) at++;
    const doingCards = cap(shown(doing, "doing"), "doing").map(cardOf);
    if (more.doing) at++;
    if (!filtered && todo.length > 0) at++;
    const todoCards = cap(shown(todo, "todo"), "todo").map(cardOf);
    if (more.todo) at++;
    if (!filtered && done.length > 0) at++;
    const doneCards = doneOpen ? cap(done, "done").map(cardOf) : [];
    this.rows = rows;
    if (this.scrollPending) {
      this.scrollPending = false;
      const sec = rows[this.nav.sel]?.section;
      if (sec != null) this.scroll.scroll_to_item(sec);
    }
    return v_flex().id("tasks-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      // Esc from a text field: the list takes the keyboard back (the field blurs). What was typed stays.
      .on_action("cockpit-tasks.blur", (_e, cx) => { this.nav.focus(); cx.notify(); })
      // A release anywhere in the pane ends a drag; leaving the pane cancels it (a release outside is never seen).
      .on_mouse_up("left", (_e, cx) => this.drop(cx))
      .on_hover((inside, cx) => { if (!inside && (this.press || this.drag)) { this.over = null; this.drop(cx); } })
      .when(Boolean(this.drag), (el) => el.cursor_grabbing())
      .child(v_flex().flex_none().px(12).pt(14).pb(12).gap(12).border_b(1).border_color(t.border)
        .child(h_flex().items_center().gap(8).px(2)
          .child(div().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Tasks"))
          .child(div().flex_1())
          .child(this.iconButton(t, "task-reload", "mods/cockpit-tasks/refresh.svg", "Reload tasks from disk", (cx) => this.reload(cx)))
          .child(this.iconButton(t, "task-report", "mods/cockpit-tasks/chart.svg", this.reporting ? "Building report…" : "See report in the browser",
            (cx) => this.report(cx), this.reporting ? t.accent : null))
          .child(this.iconButton(t, "task-new", `${ICONS}/plus.svg`, "New task with details and links", (cx) => this.edit(null, cx))))
        // Report, load and save problems: here, not inside whichever card is open. A click dismisses.
        .when(Boolean(this.reportNote || this.headNote), (el) => el.child(div().id("head-note").px(2).text_size(11.5).text_color(t.blocked)
          .cursor_pointer().tooltip("Click to dismiss").accessibility_label(`${this.reportNote || this.headNote} Dismiss`)
          .on_click((_e, cx) => { this.reportNote = null; this.headNote = null; cx.notify(); })
          .child(this.reportNote || this.headNote)))
        .when(this.tasks.length > 0, (el) => el.child(this.filterBar(t, doing.length, todo.length, done.length)))
        .child(h_flex().child(this.quickField(t))))
      .child(v_flex().id("tasks-scroll").flex_1().min_h(0).px(12).pt(6).pb(14).gap(8).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(Boolean(this.form), (el) => el.child(this.formCard(t)))
        .when(!this.ready, (el) => el.child(div().px(4).py(10).text_color(t.dim).child("Loading…")))
        .when(empty, (el) => el.child(v_flex().items_center().px(16).py(28).gap(10)
          .child(div().size(44).rounded(12).bg(t.raised).flex().items_center().justify_center().text_color(t.dim).child(svg("mods/cockpit-tasks/list-todo.svg").size(22)))
          .child(div().text_size(14).font_medium().child("Nothing queued"))
          .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal().child("Type a task above and press Enter. Use + to add details and links, then send it to an agent as context."))))
        .when(filtered && this.ready && this.tasks.length > 0 && !shown(by(f), f).length, (el) => el.child(v_flex().px(4).py(10).gap(8)
          .child(div().text_color(t.muted).child(`No ${LABEL[f].toLowerCase()} tasks`))
          .child(this.button(t, "filter-clear", "Show all", (cx) => { this.filter = null; cx.notify(); }).self_start())))
        // With a filter on, the one group shows without its heading.
        .when(!filtered && doing.length > 0, (el) => el.child(this.section(t, "Doing", t.working)))
        .children(doingCards)
        .when(more.doing > 0, (el) => el.child(this.moreRow(t, "doing", more.doing)))
        .when(!filtered && todo.length > 0, (el) => el.child(this.section(t, "To do", t.dim)))
        .children(todoCards)
        .when(more.todo > 0, (el) => el.child(this.moreRow(t, "todo", more.todo)))
        .when(!filtered && done.length > 0, (el) => el.child(this.section(t, "Done", t.ansi2, () => { this.showDone = !this.showDone; }, this.showDone)))
        .children(doneCards)
        .when(more.done > 0, (el) => el.child(this.moreRow(t, "done", more.done)))
        .when(doneCards.length > 0, (el) => el.child(h_flex().px(2).gap(8).items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child("Done tasks move to the archive after a week"))
          .child(this.button(t, "archive-done", "Archive now", (cx) => { this.archive(true); cx.notify(); })))))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ l", "expand"], ["x ␣", "next status"], ["J K", "reorder"], ["a o", "add"], ["n +", "new with details"], ["e", "edit"], ["t", "today"], ["b", "block"], ["p", "progress note"], ["s", "send to agent"], ["dd", "delete"], ["f", "filter"], ["D", "show done"], ["A", "archive done"], ["R", "report"]], this.nav.help)));
  }
}
