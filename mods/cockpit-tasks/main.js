// Tasks: things to get agents working on, each with a title, details and links.
// Saved in ~/.config/herdr-app/cockpit-tasks/tasks.json. "Send to agent" writes the task as a
// markdown brief next to it and sends the focused agent a short pointer (`hc send`), so long
// context never rides in the message itself. Nothing is sent until you press the button.
// Order within a group is yours (`rank`, J/K moves); a status change puts the task at the top of its new
// group. Done tasks move to tasks-archive.json after a week. A previews archiving the Done matches.
// A task can also be blocked (`blocked: {reason, at}`, b), planned for today (`todayAt`, t, lapses at
// midnight; today's open tasks sit in a Today group on top) and carry dated progress notes
// (`log: [{at, text}]`, p). Deleting moves it to the archive marked `deleted`, so finished work stays
// countable; u brings the last one back.
// tasks.json is watched: an edit from outside reloads the list, and one that lands between two panel
// saves is merged in (merge.js) rather than overwritten.
// The agent menu (S) can also start an agent in a new tab on the task (config.json `agents`), and L
// links a task to an agent without sending anything.
// Each status change is kept in `history` ({status, at}) for the report (R, or the chart button):
// report.html beside the tasks, built from both files and opened in the browser. Once it exists,
// every save rewrites it, and the page reloads itself when its tab is shown again.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor, TextView, ScrollHandle, Popover, CalendarState, Toggle } from "gpui-base";
import * as fs from "fs/promises";
import { agents, focused, hc, exec, appHome, theme, settings, layout, props, panes, spaces, shared, run, nextCommand, watchFolder } from "herdr";
import { workOf, jiraKeys } from "./work.js";
import { reportHtml } from "./report.js";
import { Nav, footer, keyName } from "./nav.js";
import { brief, localDay } from "./brief.js";
import { mergeTasks } from "./merge.js";
import { short, toLink, parseQuick, bareKey, summaryOf, matches } from "./quick.js";

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
const STATUS = ["todo", "doing", "review", "done"];
const LABEL = { todo: "To do", doing: "Doing", review: "On Review", done: "Done" };
const FILTER_CYCLE = [null, ...STATUS];
const OPEN_GROUPS = ["doing", "review", "todo"];
const statusColors = (t) => ({ todo: t.dim, doing: t.working, review: t.ansi4, done: t.ansi2 });
const WORK_TYPES = ["manual", "ai", "unknown"];
const WORK_TYPE_LABEL = { manual: "Manual", ai: "AI Assisted", unknown: "Unknown" };
const workTypeBackground = (t, value) => ({ manual: t.ansi4 + "33", ai: t.ansi5 + "33", unknown: t.raised })[value];
const TASK_FIELDS = {
  status: { label: "Status", values: STATUS, labels: LABEL },
  workType: { label: "Work type", values: WORK_TYPES, labels: WORK_TYPE_LABEL },
};
const workTypeOf = (task) => WORK_TYPES.includes(task?.workType) ? task.workType : "unknown";

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

function completionDay(task) {
  const at = task.doneAt ?? task.history?.findLast((entry) => entry.status === "done")?.at;
  return Number.isFinite(new Date(at).getTime()) ? localDay(at) : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function completionDateLabel(task, now) {
  const day = completionDay(task);
  if (!day) return { text: "Date unknown", tooltip: "Completion date unavailable" };
  const [year, month, date] = day.split("-").map(Number);
  const name = MONTHS[month - 1];
  const short = `${date} ${name.slice(0, 3)}`;
  return {
    text: year === new Date(now).getFullYear() ? short : `${short} ${year}`,
    tooltip: `Completed on ${date} ${name} ${year}`,
  };
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
    this.doneDate = undefined; // Default to the current local day. Clearing selects all dates (null).
    this.doneCalendar = CalendarState.new();
    this.doneCalendarOpen = false;
    this.doneDateFocus = cx.focus_handle();
    this.doneCalendarFocus = cx.focus_handle();
    this.doneDateCursor = null;
    this.filter = null; // null shows every status
    this.limit = {}; // cards drawn per group, PAGE until "Show more"
    this.hoverNote = null; // the progress note under the pointer, whose edit and delete show
    this.confirm = null; // a task whose delete awaits a second click
    this.archiveScope = null;
    this.archiveConfirm = null;
    this.copied = null;
    this.note = null;
    this.sending = null;
    this.menuFor = null; // the task whose agent list is open
    this.menuSel = 0; // the menu row the keyboard is on
    this.choiceMenu = null;
    this.choiceFocus = cx.focus_handle();
    this.formTypeFocus = cx.focus_handle();
    this.pick = null; // an agent chosen by hand; null follows the active one
    this.queue = Promise.resolve();
    // tasks.json as this panel last read or wrote it: a file that differs was edited outside, and is
    // merged before the next write (merge.js) instead of overwritten.
    this.lastText = null;
    this.lastDeleted = null; // { task, at }: what u puts back
    this.flashNote = null; // { text, warn }: a passing line under the title
    this.query = ""; // search, on title, details, links and Jira key
    this.todayOnly = false; // T: only the Today group
    this.todoTodayOnly = false;
    this.press = null; // { id, y }: a card header the left button went down on
    this.drag = null; // the task being dragged, once the press has moved a few pixels
    this.over = null; // { id, after }: where it would land

    this.quickIn = InputState.new({ placeholder: "Add a task, press Enter" });
    this.quickIn.on("submit", (_e, cx) => this.quickAdd(cx));
    this.quickIn.on("focus", (_e, cx) => { this.focus = "quick"; cx.notify(); });
    this.quickIn.on("blur", (_e, cx) => { if (this.focus === "quick") this.focus = null; cx.notify(); });
    // Search shares the quick-add row. Both fields stay mounted (one narrowed to its icon): a field
    // that appears and takes the keyboard in the same moment loses it.
    this.searchIn = InputState.new({ placeholder: "Search tasks" });
    this.searchIn.on("change", (_e, cx) => {
      const q = this.searchIn.value();
      if (q === this.query) return;
      this.query = q;
      this.scrollPending = true;
      cx.notify();
    });
    // Enter keeps the search and gives the list the keyboard.
    this.searchIn.on("submit", (_e, cx) => { this.nav.focus(); cx.notify(); });
    this.searchIn.on("focus", (_e, cx) => { this.focus = "search"; cx.notify(); });
    this.searchIn.on("blur", (_e, cx) => { if (this.focus === "search") this.focus = null; cx.notify(); });
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
        const text = await this.readText();
        if (text != null) this.tasks = ranked(JSON.parse(text));
        this.lastText = text ?? "[]";
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
    // tasks.json edited outside (by hand, an agent, the other panel copy): the list follows, merged
    // in (not replaced) so a panel edit made in the same moment stays. The panel's own writes and the
    // report and briefs beside it fire this too; they leave the text as last seen. A half-written hand
    // edit doesn't parse and waits for the next change.
    cx.spawn(async (cx) => {
      for (;;) {
        let paths;
        try { paths = await watchFolder(this.dir); } catch { await cx.sleep(10000); continue; }
        if (!paths.length) { await cx.sleep(1000); continue; }
        const root = this.dir.replace(/\/+$/, "");
        if (!paths.some((p) => p.replace(/\/+$/, "") === root || /\/tasks\.json$/.test(p))) continue;
        this.queue = this.queue.then(() => this.mergeDisk()).catch(() => {});
        await this.queue;
        if (this.merged) { this.merged = false; cx.notify(); }
      }
    });
    // Keyboard: the cards in screen order (rebuilt on each render) and which scroll child holds each.
    this.nav = new Nav(cx, { slot: props()?.slot ?? null });
    this.nav.watch(cx);
    this.scroll = ScrollHandle.new();
    this.rows = [];
    // "cockpit-tasks.quick" (Ctrl+Space g t, through the tab bar): the quick-add field takes the keyboard.
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

  // tasks.json's text, or null when there is none yet.
  async readText() {
    const file = `${this.dir}/tasks.json`;
    return (await fs.exists(file)) ? fs.readFile(file, "utf8") : null;
  }

  // Run inside the queue, before a write: when the file changed since the panel last read or wrote it,
  // the outside edit is merged into the list (merge.js) so the write keeps both. A file that doesn't
  // parse (mid-edit by hand) throws, and the write waits for the next save.
  async mergeDisk() {
    const text = await this.readText();
    if (text == null || text === this.lastText) return;
    // No base (the first read failed): nothing is dropped, the later `updated` wins.
    let base = null;
    try { base = this.lastText == null ? null : JSON.parse(this.lastText); } catch {}
    this.tasks = ranked(mergeTasks(this.tasks, JSON.parse(text), base));
    this.lastText = text;
    this.merged = true; // the watch loop redraws
  }

  async writeTasks() {
    const text = JSON.stringify(this.tasks, null, 2);
    await fs.writeFile(`${this.dir}/tasks.json`, text);
    this.lastText = text;
  }

  // Writes are queued so two quick edits never race.
  persist() {
    this.queue = this.queue
      .then(async () => { await this.mergeDisk(); await this.writeTasks(); })
      .catch(() => { this.headNote = "Couldn't save tasks."; });
    this.refreshReport();
  }

  // Reads tasks.json again (after any queued save), for edits made outside the panel.
  reload(cx) {
    this.queue = this.queue.then(async () => {
      try {
        const text = await this.readText();
        if (text != null) { this.tasks = ranked(JSON.parse(text)); this.lastText = text; }
        this.headNote = null;
      } catch { this.headNote = "Couldn't read saved tasks."; }
      cx.notify();
    });
  }

  // A passing line under the title (5 s): what just happened, or why a key did nothing.
  flash(text, cx, warn = false) {
    const note = { text, warn };
    this.flashNote = note;
    cx.notify();
    cx.timer.after(5000, (cx) => { if (this.flashNote === note) { this.flashNote = null; cx.notify(); } });
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

  // Swaps the selected task with its neighbour in the same group (dir -1 up, 1 down). Today and the
  // group below it can hold the same status: the drawn group must match too.
  move(dir) {
    const ra = this.rows[this.nav.sel], rb = this.rows[this.nav.sel + dir];
    const a = ra?.task, b = rb?.task;
    if (!a || !b || a.status !== b.status || ra.group !== rb.group) return;
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
    const over = dragged && task.id !== dragged.id && task.status === dragged.status && this.groupOf(task) === this.groupOf(dragged)
      ? { id: task.id, after: e.local_position.y > e.bounds.height / 2 } : null;
    if (over?.id !== this.over?.id || over?.after !== this.over?.after || !this.dragShown) {
      this.over = over;
      this.dragShown = true;
      cx.notify();
    }
  }

  // The group a task is drawn in (rows of the last render), so a drag stays inside Today or out of it.
  groupOf(task) {
    return this.rows.find((r) => r.task.id === task.id)?.group ?? task.status;
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

  // Moves done tasks to tasks-archive.json: the confirmed selection, or those done over a week ago. The archive is
  // written before the list, so a failed write keeps the tasks. Returns whether any moved.
  archive(selection = null) {
    if (!this.ready) return false;
    const now = Date.now();
    const old = this.tasks.filter((x) => x.status === "done" &&
      (selection ? selection.has(x.id) : now - (x.doneAt ?? x.updated ?? now) > WEEK));
    if (!old.length) return false;
    const ids = new Set(old.map((x) => x.id));
    this.tasks = this.tasks.filter((x) => !ids.has(x.id));
    if (this.open && ids.has(this.open)) this.open = null;
    this.toArchive(old.map((x) => ({ ...x, archived: now })), old, "Couldn't archive done tasks.");
    return true;
  }

  confirmArchive(cx) {
    const pending = this.archiveConfirm;
    this.archiveConfirm = null;
    if (pending) this.archive(pending.ids);
    cx.notify();
  }

  requestArchive(cx) {
    const scope = this.archiveScope;
    if (!scope?.tasks.length) {
      this.flash("No completed tasks match the Done filters.", cx);
      return;
    }
    this.archiveConfirm = { key: scope.key, detail: scope.detail, ids: new Set(scope.tasks.map((task) => task.id)) };
    cx.notify();
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
      await this.mergeDisk();
      await this.writeTasks();
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
  // Pasted URLs go under Links (quick.js); a title that is only a Jira key gets the card's summary.
  quickAdd(cx) {
    const { title, links } = parseQuick(this.quickIn.value());
    if (!title) return;
    const id = `task-${Date.now().toString(36)}`;
    const now = Date.now();
    this.tasks = [{ id, title, notes: "", links, status: "todo", workType: "unknown", agent: null, created: now, updated: now, rank: this.top(), history: [{ status: "todo", at: now }] }, ...this.tasks];
    this.quickIn.set_value("");
    if (this.filter && this.filter !== "todo") this.filter = null;
    this.persist();
    if (bareKey(title)) this.summarize(id, title, cx);
    cx.notify();
  }

  // "CFE-1998" becomes "CFE-1998 <summary>" through acli, only while the title is still the bare key.
  // Any failure (no acli, not logged in, offline) leaves the key as the title, silently.
  summarize(id, key, cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("acli", ["jira", "workitem", "view", key, "--fields", "summary", "--json"], { timeout: 15000 });
        const summary = r.code === 0 ? summaryOf(r.stdout) : null;
        if (!summary || this.tasks.find((x) => x.id === id)?.title !== key) return;
        this.update(id, { title: `${key} ${summary}` });
        cx.notify();
      } catch {}
    });
  }

  // agent: the address a new task is linked to (N, from the active agent).
  edit(task, cx, agent = null) {
    this.form = { id: task?.id ?? null, links: [...(task?.links ?? [])], workType: null, agent };
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
    if (form.id) this.update(form.id, { title, notes, links, ...(form.workType && { workType: form.workType }) });
    else {
      const id = `task-${Date.now().toString(36)}`;
      const now = Date.now();
      // From an agent (N): already under way, so it starts as doing, linked to that agent.
      const status = form.agent ? "doing" : "todo";
      const history = form.agent ? [{ status: "todo", at: now }, { status: "doing", at: now }] : [{ status: "todo", at: now }];
      this.tasks = [{ id, title, notes, links, status, workType: form.workType ?? "unknown", agent: form.agent ?? null, created: now, updated: now, rank: this.top(), history }, ...this.tasks];
      this.open = id;
      this.selId = id;
      this.scrollPending = true;
      if (this.filter && this.filter !== status) this.filter = null;
      this.persist();
    }
    this.form = null;
    this.note = null;
    cx.notify();
  }

  // ---- keyboard

  onKey(e, cx) {
    if (this.doneCalendarOpen && (this.doneCalendarFocus.is_focused() || this.doneDateFocus.is_focused() || this.nav.focused())) {
      this.doneCalendarKey(e, cx);
      return;
    }
    if (this.choiceMenu && (this.choiceFocus.is_focused() || this.nav.focused() || this.formTypeFocus.is_focused())) {
      this.choiceKey(e, cx);
      return;
    }
    // A form field has the keyboard: its keys are its own.
    if (!this.nav.focused()) return;
    const key = keyName(e);
    if (this.archiveConfirm && (key === "enter" || key === "escape" || key === "ctrl-[")) {
      cx.stop_propagation();
      if (key === "enter") this.confirmArchive(cx);
      else { this.archiveConfirm = null; cx.notify(); }
      return;
    }
    // The agent menu is open (S): j/k, Enter, l and Esc are its own.
    if (this.menuFor && this.menuKey(keyName(e), cx)) { cx.stop_propagation(); cx.notify(); return; }
    // Esc with a search on clears it first; the next Esc leaves the panel.
    if (this.query && (keyName(e) === "escape" || keyName(e) === "ctrl-[")) {
      this.clearSearch();
      cx.stop_propagation();
      cx.notify();
      return;
    }
    const it = () => this.rows[this.nav.sel]?.task;
    const toggle = () => { const x = it(); if (x) { this.open = this.open === x.id ? null : x.id; this.confirm = null; this.note = null; } };
    const status = () => { const x = it(); if (x) this.openChoice("status", x.id, x.status); };
    const quick = () => this.quickIn.focus();
    // The selected task's work item, for the chip keys (gj, gm, gs).
    const work = () => { const x = it(); return x ? this.workFor(x) : null; };
    const used = this.nav.key(e, this.rows.length, {
      enter: toggle, l: toggle,
      space: status, x: status,
      m: () => {
        const task = it();
        if (!task) return;
        this.open = task.id;
        this.openChoice("workType", task.id, workTypeOf(task));
      },
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
      A: () => this.requestArchive(cx),
      R: () => this.report(cx),
      b: () => { const x = it(); if (x && x.status !== "done") this.startBlock(x, cx); },
      t: () => { const x = it(); if (x && x.status !== "done") this.toggleToday(x.id); },
      // p: the task opens with its progress note field taking the keyboard.
      p: () => { const x = it(); if (x && x.status !== "done") { this.open = x.id; this.logIn.focus(); } },
      u: () => this.undoDelete(cx),
      // S: the agent menu on the selected task (the card opens, since the menu sits in it).
      S: () => { const x = it(); if (x) { this.open = x.id; this.menuFor = x.id; this.menuSel = 0; this.menuOff = 0; this.note = null; } },
      L: () => { const x = it(); if (x) this.linkActive(x, cx); },
      N: () => this.fromAgent(cx),
      T: () => {
        if (this.filter === "todo") this.todoTodayOnly = !this.todoTodayOnly;
        else this.todayOnly = !this.todayOnly;
      },
      "/": () => this.searchIn.focus(),
      ga: () => { const x = it(); if (x) this.goToAgent(x, cx); },
      gj: () => {
        const w = work();
        if (w?.url) cx.open_url(w.url);
        else this.flash(w ? "Set jiraUrl in config.json to open Jira." : "No Jira key on this task.", cx, true);
      },
      gm: () => { const w = work(); if (w?.mr) cx.open_url(w.mr.url); else this.flash("No MR for this task.", cx, true); },
      gs: () => {
        const w = work();
        if (!w?.space) { this.flash("No space on this task's branch.", cx, true); return; }
        run("space.select", { id: w.space.id });
        if (w.tab) run("tab.select", { id: w.tab });
      },
      gl: () => { const l = it()?.links?.[0]; if (l) cx.open_url(l); else this.flash("No links on this task.", cx, true); },
      yy: () => { const x = it(); if (x) this.copyBrief(x, cx); },
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
    // The brief file would only mislead an agent now (Send writes it again after an undo).
    fs.unlink(`${this.dir}/briefs/${task.id}.md`).catch(() => {});
    this.lastDeleted = { task, at: now };
    this.flash("Deleted. Press u to undo", cx);
  }

  // u: the last deleted task comes back with its old rank, and its `deleted` entry leaves the archive.
  undoDelete(cx) {
    const d = this.lastDeleted;
    if (!d) return;
    this.lastDeleted = null;
    if (this.tasks.some((x) => x.id === d.task.id)) return;
    this.tasks = [...this.tasks, d.task];
    this.hold = d.task.id;
    const file = `${this.dir}/tasks-archive.json`;
    this.queue = this.queue.then(async () => {
      const prev = await this.archived();
      await fs.writeFile(file, JSON.stringify(prev.filter((x) => !(x.id === d.task.id && x.deleted === d.at)), null, 2));
    }).catch(() => { this.headNote = "Couldn't take the task out of the archive."; });
    this.persist();
    this.flashNote = null;
  }

  // The task's work item (work.js): Jira key, the space on that branch, its agent and MR.
  workFor(task, ctx = null) {
    const c = ctx ?? { list: agents(), panes: panes(), spaces: spaces(), mrs: shared("cockpit.mrs") };
    return workOf(task, { panes: c.panes, spaces: c.spaces, agents: c.list, mrs: c.mrs, jira: this.config.jiraUrl ?? null });
  }

  copyBrief(task, cx) {
    cx.write_to_clipboard(brief(task, this.workFor(task)));
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
  target(list, focus = focused()) {
    return (this.pick && list.find((a) => a.address === this.pick)) || list.find((a) => a.address === focus?.terminal) || null;
  }

  // Links a task to an agent without sending anything: a to-do task becomes doing.
  link(task, address) {
    const cur = this.tasks.find((x) => x.id === task.id) ?? task;
    this.update(cur.id, { agent: address, ...(cur.status === "todo" ? { status: "doing" } : {}) });
  }

  // L: links the task to the agent Send would use; on a task already linked to it, unlinks.
  linkActive(task, cx) {
    const a = this.target(agents());
    if (!a) { this.flash("Focus an agent terminal first.", cx, true); return; }
    if (task.agent === a.address) { this.update(task.id, { agent: null }); this.flash(`Unlinked from ${a.address}`, cx); }
    else { this.link(task, a.address); this.flash(`Linked to ${a.address}`, cx); }
    this.pick = null;
    this.menuFor = null;
  }

  // N: a task for what the active agent is already doing. The title is the Jira key on its branch and
  // the terminal's title; the agent's first prompt isn't read back (only screen text is there).
  fromAgent(cx) {
    const a = agents().find((x) => x.address === focused()?.terminal);
    if (!a) { this.flash("Focus an agent terminal first.", cx, true); return; }
    const all = panes();
    const branch = all.find((p) => p.terminal === a.address)?.branch ?? all.find((p) => p.tab === a.tab && p.branch)?.branch ?? null;
    const key = jiraKeys(branch)[0] ?? null;
    const name = clean(a.title) || a.tab_name || "";
    const title = key && !name.includes(key) ? `${key} ${name}`.trim() : name || key || "";
    this.quickIn.set_value("");
    this.edit(null, cx, a.address);
    this.titleIn.set_value(title);
  }

  // The agent working on a task: its own, else the one on the task's branch (work.js).
  agentOf(task) {
    const list = agents();
    const address = task.agent ?? this.workFor(task)?.agent?.address ?? null;
    return { address, agent: address ? list.find((a) => a.address === address) ?? null : null };
  }

  // ga, or a click on the agent pill: that agent's space, tab and terminal.
  goToAgent(task, cx) {
    const { address, agent } = this.agentOf(task);
    if (!agent) { this.flash(address ? `${address} is no longer running.` : "No agent on this task.", cx, true); return; }
    run("space.select", { id: agent.space });
    run("tab.select", { id: agent.tab });
    run("pane.focus", { terminal: agent.address });
  }

  // Programs the menu can start in a new tab: config.json's `agents` (each a command line), else Claude.
  programs() {
    const list = Array.isArray(this.config.agents) ? this.config.agents.filter((p) => typeof p === "string" && p.trim()) : [];
    return list.length ? list : ["claude"];
  }

  // A new tab in the task's space (else the shown one) running `program`, whose first message points
  // at the brief. The new agent is found by polling for an address that wasn't there (tab.new returns
  // nothing), then linked. Only on this computer: elsewhere the brief would have to be copied first.
  startAgent(task, program, cx) {
    if (this.sending) return;
    const work = this.workFor(task);
    const space = spaces().find((s) => s.id === (work?.space?.id ?? focused()?.space)) ?? null;
    if (space?.machine) {
      this.note = { ok: false, text: `${space.name} is on ${space.machine}: start an agent there, then send to it.` };
      cx.notify();
      return;
    }
    const argv = program.trim().split(/\s+/);
    this.sending = task.id;
    this.note = { ok: true, text: `Starting ${argv[0]}…` };
    this.menuFor = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const file = `${this.dir}/briefs/${task.id}.md`;
        await fs.writeFile(file, brief(task, work));
        const before = new Set(agents().map((a) => a.address));
        run("tab.new", {
          name: (work?.key ?? task.title).slice(0, 24),
          ...(space ? { space: space.id } : {}),
          argv,
          task: `Read ${file} and work on the task described in it: ${task.title}`,
          focus: false,
        });
        let found = null;
        for (let waited = 0; waited < 6000 && !found; waited += 300) {
          await cx.sleep(300);
          found = agents().find((a) => !before.has(a.address) && (!space || a.space === space.id)) ?? null;
        }
        if (!found) throw new Error(`Started ${argv[0]} in a new tab, but no agent showed up within 6 s. Link it with L once it runs.`);
        this.link(task, found.address);
        this.note = { ok: true, text: `Started ${found.address}` };
      } catch (e) {
        this.note = { ok: false, text: String(e.message ?? e) };
      }
      this.sending = null;
      cx.notify();
    });
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
        await fs.writeFile(file, brief(task, this.workFor(task)));
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
        this.link(task, target.address);
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

  // The agent menu's rows, in screen order: the active agent, one "new tab" row per program, then the
  // running agents, most urgent first. The keyboard (S) and the mouse use the same list.
  menuRows(list, focus) {
    const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
    const active = list.find((a) => a.address === focus?.terminal) ?? null;
    // The active agent has its own first row, so it isn't listed again below.
    const sorted = list.filter((a) => a !== active).sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0));
    const rows = [{ kind: "follow" }, ...this.programs().map((program) => ({ kind: "start", program })), ...sorted.map((agent) => ({ kind: "agent", agent }))];
    return { active, sorted, rows };
  }

  // Keys while the menu is open: j/k move, Enter sends (or starts the program), l links without
  // sending, Esc or S closes. Returns whether the key was the menu's.
  menuKey(k, cx) {
    const task = this.tasks.find((x) => x.id === this.menuFor);
    if (!task || this.open !== task.id) { this.menuFor = null; return false; }
    const { rows } = this.menuRows(agents(), focused());
    const n = rows.length;
    if (k === "j" || k === "down") { this.menuSel = Math.min(n - 1, this.menuSel + 1); this.menuFollow = true; }
    else if (k === "k" || k === "up") { this.menuSel = Math.max(0, this.menuSel - 1); this.menuFollow = true; }
    else if (k === "escape" || k === "ctrl-[" || k === "S") this.menuFor = null;
    else if (k === "enter" || k === "l") {
      const row = rows[Math.min(this.menuSel, n - 1)];
      if (row.kind === "start") { if (k === "enter") this.startAgent(task, row.program, cx); }
      else {
        this.pick = row.kind === "agent" ? row.agent.address : null;
        if (k === "l") this.linkActive(task, cx);
        else { this.menuFor = null; this.send(task, cx); }
      }
    } else return false;
    return true;
  }

  clearSearch() {
    this.query = "";
    this.searchIn.set_value("");
    this.scrollPending = true;
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

  archivePrompt(t, pending) {
    const count = pending.ids.size;
    return v_flex().id("archive-confirm").p(9).gap(7).rounded(8).border(1).border_color(t.border).bg(t.surface)
      .child(div().text_size(12).font_medium().text_color(t.foreground)
        .child(`Archive ${count} completed ${count === 1 ? "task" : "tasks"}?`))
      .when(Boolean(pending.detail), (el) => el.child(div().text_size(11.5).text_color(t.muted).whitespace_normal().child(pending.detail)))
      .child(h_flex().gap(6).justify_end()
        .child(this.button(t, "archive-cancel", "Cancel", (cx) => { this.archiveConfirm = null; cx.notify(); }))
        .child(this.button(t, "archive-confirm-button", "Archive", (cx) => this.confirmArchive(cx), true)));
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

  openChoice(field, id, value) {
    this.choiceMenu = { id, field, index: Math.max(0, TASK_FIELDS[field].values.indexOf(value)) };
  }

  closeChoice(id) {
    this.choiceMenu = null;
    if (id === null && this.form) this.formTypeFocus.focus();
    else this.nav.focus();
  }

  chooseTaskField(field, id, value, cx) {
    this.closeChoice(id);
    if (id === null) {
      if (this.form) this.form.workType = value;
      cx.notify();
      return;
    }
    const task = this.tasks.find((task) => task.id === id);
    if (task && (field === "workType" ? workTypeOf(task) : task.status) !== value) {
      this.selId = id;
      this.update(id, { [field]: value });
    }
    cx.notify();
  }

  choiceKey(e, cx) {
    const menu = this.choiceMenu;
    if (!menu) return;
    const { values } = TASK_FIELDS[menu.field];
    const key = keyName(e);
    cx.stop_propagation();
    if (key === "enter" || key === "space") {
      this.chooseTaskField(menu.field, menu.id, values[menu.index], cx);
      return;
    } else if (key === "escape" || key === "ctrl-[") {
      this.closeChoice(menu.id);
    } else if (menu.id === null && (key === "tab" || key === "shift-tab")) {
      this.stepField(key === "tab" ? 1 : -1, cx);
      return;
    } else if (key === "down" || key === "j" || key === "up" || key === "k") {
      const step = key === "down" || key === "j" ? 1 : -1;
      menu.index = (menu.index + step + values.length) % values.length;
    } else {
      return;
    }
    cx.notify();
  }

  statusIcon(t, status) {
    const dot = div().size(15).flex_none().rounded(8);
    if (status === "done") {
      return dot.bg(t.ansi2).flex().items_center().justify_center().text_color(t.chrome).child(svg(`${ICONS}/check.svg`).size(10));
    }
    if (status === "doing") {
      return dot.border(2).border_color(t.working).flex().items_center().justify_center().child(div().size(5).rounded(3).bg(t.working));
    }
    if (status === "review") {
      return dot.bg(t.ansi4 + "26").flex().items_center().justify_center().text_color(t.ansi4)
        .child(svg(`${ICONS}/file-text.svg`).size(10));
    }
    return dot.border(1.5).border_color(t.input);
  }

  mark(t, task) {
    const trigger = h_flex().id(`mark-${task.id}`).h(26).px(4).gap(3).flex_none().items_center().rounded(7).cursor_pointer()
      .child(this.statusIcon(t, task.status));
    return this.taskChoice(t, "status", task.id, task.status, trigger);
  }

  workTypePicker(t, id, value) {
    const trigger = h_flex().id(`work-type-${id ?? "form"}`).h(26).px(8).gap(6).flex_none().items_center().rounded(7)
      .bg(id === null ? t.raised : workTypeBackground(t, value)).text_size(12).text_color(t.foreground).cursor_pointer()
      .when(id === null, (el) => el.track_focus(this.formTypeFocus)
        .focus((s) => s.bg(t.selected))
        .on_key_down((e, cx) => {
          const key = keyName(e);
          if (!["enter", "space", "down"].includes(key) || this.choiceMenu) return;
          this.openChoice("workType", null, value);
          cx.stop_propagation();
          cx.notify();
        }))
      .child(WORK_TYPE_LABEL[value]);
    return this.taskChoice(t, "workType", id, value, trigger);
  }

  taskChoice(t, field, id, value, trigger) {
    const { label, values, labels } = TASK_FIELDS[field];
    const menu = this.choiceMenu;
    const open = menu?.field === field && menu.id === id;
    const key = `${field}-${id ?? "form"}`;
    trigger.tooltip(`Change ${label.toLowerCase()} (${labels[value]})`)
      .accessibility_label(`${label}, ${labels[value]}`)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .when(open, (el) => el.bg(t.selected))
      .child(svg("mods/cockpit-tasks/chevron-down.svg").size(10).flex_none().text_color(t.muted));
    return Popover.new(key).trigger(trigger).open(open)
      .on_open_change((visible, cx) => {
        if (visible && !this.drag) this.openChoice(field, id, value);
        else if (this.choiceMenu?.field === field && this.choiceMenu.id === id) this.choiceMenu = null;
        cx.notify();
      })
      .when(open, (el) => el.track_focus(this.choiceFocus).content(
        v_flex().id(`${key}-options`).role("list_box").accessibility_label(label)
          .w(124).p(4).gap(2).rounded(8).border(1).border_color(t.border).bg(t.popover)
          .track_focus(this.choiceFocus)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_key_down((e, cx) => this.choiceKey(e, cx))
          .children(values.map((option, index) => {
            const selected = option === value;
            return h_flex().id(`option-${option}`).role("list_box_option").aria_selected(selected)
              .h(28).px(6).gap(7).items_center().rounded(5).cursor_pointer().text_size(12).text_color(t.foreground)
              .when(index === menu.index, (row) => row.bg(t.selected).aria_active_descendant())
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); this.chooseTaskField(field, id, option, cx); })
              .when(field === "status", (row) => row.child(this.statusIcon(t, option)))
              .child(div().flex_1().child(labels[option]))
              .when(selected, (row) => row.child(svg(`${ICONS}/check.svg`).size(11).text_color(t.muted)));
          })),
      ));
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
    const order = ["title", "workType", "notes", "link"];
    const fromWorkType = this.formTypeFocus.is_focused() || this.choiceMenu?.id === null;
    if (this.choiceMenu?.id === null) this.choiceMenu = null;
    const at = Math.max(0, order.indexOf(fromWorkType ? "workType" : this.focus));
    const next = order[(at + dir + order.length) % order.length];
    ({ title: this.titleIn, workType: this.formTypeFocus, notes: this.notesIn, link: this.linkIn })[next].focus();
    cx.notify();
  }

  formCard(t) {
    const form = this.form;
    const ready = this.titleIn.value().trim().length > 0;
    const workType = form.workType ?? workTypeOf(this.tasks.find((task) => task.id === form.id));
    return v_flex().id("task-form").flex_none().p(14).gap(12).rounded(10).border(1).border_color(t.accent + "88").bg(t.surface)
      // Tab / Shift+Tab step through the form fields (bound in init under this context).
      .key_context("TaskForm")
      .on_action("cockpit-tasks.next-field", (_e, cx) => this.stepField(1, cx))
      .on_action("cockpit-tasks.prev-field", (_e, cx) => this.stepField(-1, cx))
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(13).font_semibold().child(form.id ? "Edit task" : "New task"))
        .child(this.iconButton(t, "f-close", `${ICONS}/x.svg`, "Cancel", (cx) => { this.form = null; this.note = null; cx.notify(); })))
      .child(v_flex().gap(4).child(this.label(t, "Title")).child(h_flex().child(this.field(t, "f-title", this.titleIn, "title"))))
      .child(h_flex().gap(8).items_center().child(this.label(t, "Work type")).child(this.workTypePicker(t, null, workType)))
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
      .when(Boolean(form.agent), (el) => el.child(div().min_w(0).px(2).text_size(11).text_color(t.muted).child(`Starts as doing, linked to ${form.agent}. Nothing is sent to it.`)))
      .child(div().min_w(0).px(2).text_size(11).text_color(t.dim).child("Tab moves between fields · Enter in the title saves · ⌘Enter in details saves"))
      .child(h_flex().gap(8).items_center().justify_end()
        .child(this.button(t, "f-cancel", "Cancel", (cx) => { this.form = null; this.note = null; cx.notify(); }))
        .child(div().id("f-save").h(26).px(14).flex().items_center().flex_none().rounded(7).text_size(12).font_medium()
          .accessibility_label("Save task").bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
          .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(t.solid)).active((s) => s.bg(t.selected).text_color(t.foreground)))
          .on_click((_e, cx) => this.save(cx))
          .child("Save")));
  }

  // ctx: Herdr's live lists, read once per render (agents, panes, spaces, MRs, the focused terminal).
  card(t, task, now, ctx, on = false) {
    const open = this.open === task.id;
    const done = task.status === "done";
    const age = done ? null : ago(now - task.updated);
    const date = done ? completionDateLabel(task, now) : { text: age, tooltip: `Updated ${age} ago` };
    const workType = workTypeOf(task);
    const list = ctx.list;
    const live = ctx.live;
    const target = this.target(list, ctx.focus);
    // A pick that is now the active agent is the same as following it.
    const following = !this.pick || this.pick === ctx.focus?.terminal || !list.some((a) => a.address === this.pick);
    const agent = task.agent ? live.get(task.agent) : null;
    const targetName = target ? clean(target.title) || target.program?.name || "agent" : null;
    const blocked = isBlocked(task);
    const today = !done && isToday(task, now);
    const accent = done ? t.ansi2 + "55" : blocked || (task.status === "doing" && agent === "blocked") ? t.blocked
      : task.status === "todo" ? t.chrome : statusColors(t)[task.status] ?? t.chrome;
    const agentColor = agent === "working" ? t.working : agent === "blocked" ? t.blocked : agent === "done" ? t.done : null;
    const sending = this.sending === task.id;
    const confirming = this.confirm === task.id;
    // The work item: Jira key, the space on that branch, its agent and MR (see work.js).
    const work = done ? null : this.workFor(task, ctx);
    const gist = open ? "" : preview(task.notes, task.title);
    // A doing task whose agent finished, or waits on you, says so on its pill (the stripe turns too).
    const agentState = task.status === "doing" && agent === "done" ? { label: "Finished", color: t.done }
      : task.status === "doing" && agent === "blocked" ? { label: "Needs you", color: t.blocked } : null;
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
        .child(h_flex().pl(6).pr(12).py(10).gap(5).items_start()
          .child(this.mark(t, task))
          .child(v_flex().id(`task-head-${task.id}`).flex_1().min_w(0).gap(7).pt(3).cursor_pointer()
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
            .child(h_flex().gap(8).items_start()
              .child(div().id(`task-title-${task.id}`).flex_1().min_w(0).when(!open, (el) => el.truncate()).tooltip(task.title)
                .text_size(13).font_medium().text_color(done ? t.dim : t.foreground).when(done, (el) => el.line_through()).child(task.title))
              .child(div().id(`task-age-${task.id}`).flex_none().text_size(11).text_color(done ? t.muted : t.dim).pt(1)
                .tooltip(date.tooltip).child(date.text)))
            .when(Boolean(gist), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(gist)))
            .when(!open || !done || Boolean(task.agent), (el) => el.child(h_flex().gap(5).items_center().flex_wrap()
              .when(!open, (row) => row.child(this.pill(t, [WORK_TYPE_LABEL[workType]])
                .bg(workTypeBackground(t, workType)).text_color(t.foreground)))
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
              // The agent pill goes to that agent's terminal (ga does the same).
              .when(Boolean(task.agent), (el) => el.child(h_flex().id(`task-agent-${task.id}`).h(18).max_w(170).px(7).gap(5).items_center().flex_none().rounded(9)
                .bg(agentState ? agentState.color + "1f" : t.raised)
                .tooltip(agent ? `${task.agent} is ${agent}. Click to go to it (ga)` : `${task.agent} is no longer running`)
                .accessibility_label(agent ? `Go to ${task.agent}, ${agentState?.label ?? agent}` : `${task.agent} is no longer running`)
                .when(Boolean(agent), (el) => el.cursor_pointer()
                  .hover((s) => s.bg(agentState ? agentState.color + "33" : t.hover)).active((s) => s.bg(t.selected))
                  // The press must not reach the card header, or the next mouse move starts a drag.
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .on_click((_e, cx) => { cx.stop_propagation(); this.goToAgent(task, cx); }))
                .child(div().size(6).rounded(3).flex_none().bg(agentColor ?? t.dim + "88"))
                .child(agentState
                  ? div().min_w(0).truncate().text_size(10.5).font_medium().text_color(agentState.color).child(agentState.label)
                  : div().min_w(0).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).text_color(agent ? t.muted : t.dim).child(task.agent))))))))
        .when(open, (el) => el.child(v_flex().pl(37).pr(12).pb(12).gap(12)
          .child(h_flex().gap(8).items_center().child(this.label(t, "Work type")).child(this.workTypePicker(t, task.id, workType)))
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
          .when(this.menuFor === task.id, (el) => el.child(this.agentMenu(t, task, ctx, target, following))))));
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
            // Words flow in a wrapping row so a URL can be its own clickable piece.
            .child(h_flex().id(`task-log-text-${key}`).flex_wrap().text_size(12).text_color(isEdit ? t.accent : i === 0 ? t.foreground : t.muted)
              .children(n.text.split(/(\s+)/).filter((w) => w && !/^\s+$/.test(w)).map((w, wi) => {
                const url = /^https?:\/\//.test(w) ? w.replace(/[).,;:!?]+$/, "") : null;
                if (!url) return div().flex_none().child(`${w} `);
                const label = shortUrls(url);
                return div().id(`task-log-url-${key}-${wi}`).flex_none().text_color(t.ansi4).cursor_pointer().hover((s) => s.text_color(t.foreground))
                  .accessibility_label(`Open ${label}`).tooltip(url)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(url); })
                  .child(`${label}${w.slice(url.length)} `);
              })))
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

  // The agents to send to, most urgent first. The first row goes back to following the active one; the
  // "New agent tab" rows start a program on the task (startAgent).
  agentMenu(t, task, ctx, target, following) {
    const { active, sorted, rows } = this.menuRows(ctx.list, ctx.focus);
    const programs = rows.filter((r) => r.kind === "start").map((r) => r.program);
    const kbd = this.nav.focused();
    const sel = Math.min(this.menuSel, rows.length - 1);
    const mono = settings().font_family ?? "JetBrains Mono";
    const dot = (a) => a.status === "blocked"
      ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : a.status === "working"
        ? div().size(12).flex_none().flex().items_center().justify_center().child(div().size(7).rounded(4).bg(t.working))
        : div().size(14).flex_none().flex().items_center().justify_center()
          .child(a.status === "done" ? div().size(7).rounded(4).bg(t.done) : div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim));
    // i: the row's place in `rows`, where the keyboard cursor (S, then j/k) shows as a hover.
    const row = (i, id, a, label, picked, action, icon = null) => h_flex().id(id).h(30).px(8).gap(8).items_center().flex_none().rounded(6).cursor_pointer()
      .accessibility_label(`${label}${picked ? ", selected" : ""}`)
      .when(picked, (el) => el.bg(t.selected)).when(!picked && kbd && sel === i, (el) => el.bg(t.hover))
      .hover((s) => s.bg(picked ? t.selected : t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.menuFor = null;
        action(cx);
        cx.notify();
      })
      .child(a ? (a.program?.icon ? (a.program.tint ? svg(a.program.icon).size(14).flex_none().text_color(t.foreground) : image(a.program.icon).size(14).flex_none()) : div().size(14).flex_none()) : svg(icon ?? `${ICONS}/terminal.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().id(`${id}-name`).flex_1().min_w(0).truncate().text_size(12.5).tooltip(label).child(label))
      .when(Boolean(a), (el) => el.child(div().flex_none().h(16).px(4).flex().items_center().rounded(4).bg(t.raised).text_color(t.dim).font_family(mono).text_size(10.5).child(a.address)))
      .when(Boolean(a), (el) => el.child(dot(a)))
      .child(div().w(12).flex_none().flex().items_center().justify_center().when(picked, (el) => el.child(svg(`${ICONS}/check.svg`).size(12).text_color(t.foreground))));
    // A scroll area needs a definite height: rows are 30px with a 1px gap, plus the divider and padding.
    const P = programs.length;
    const content = 8 + (1 + P + sorted.length) * 31 + (sorted.length ? 8 : 36);
    const height = Math.min(240, content);
    // The wheel is handled here, not by GPUI's scroll area: that one passes the wheel on to the task
    // list behind it at its top and bottom edges. Rows sit in an inner column shifted by the offset.
    const max = Math.max(0, content - (height - 2));
    // After j/k the offset follows the keyboard row into view.
    if (this.menuFollow) {
      this.menuFollow = false;
      const y = 4 + sel * 31 + (sel > P ? 8 : 0);
      const cur = this.menuOff ?? 0;
      this.menuOff = y < cur ? Math.max(0, y - 4) : y + 30 > cur + height - 2 ? y + 34 - height : cur;
    }
    const off = Math.max(0, Math.min(this.menuOff ?? 0, max));
    return div().id(`task-menu-${task.id}`).relative().h(height).w_full().flex_none().rounded(8).border(1).border_color(t.border).bg(t.popover).overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        cx.stop_propagation();
        const next = Math.max(0, Math.min((this.menuOff ?? 0) - e.delta.y, max));
        if (next !== this.menuOff) { this.menuOff = next; cx.notify(); }
      })
      .child(v_flex().absolute().top(-off).left(0).right(0).p(4).gap(1)
      .child(row(0, `menu-follow-${task.id}`, null, active ? `Active agent · ${clean(active.title) || active.program?.name || active.address}` : "Active agent (none focused)", following,
        () => { this.pick = null; }))
      // Start a program in a new tab of the task's space, on this task's brief.
      .children(programs.map((p, j) => row(1 + j, `menu-start-${task.id}-${j}`, null, `New agent tab · ${p}`, false,
        (cx) => this.startAgent(task, p, cx), `${ICONS}/plus.svg`)))
      .when(sorted.length > 0, (el) => el.child(div().h(1).my(3).bg(t.border).flex_none()))
      .when(!sorted.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No agents running")))
      .children(sorted.map((a, j) => row(1 + P + j, `menu-${task.id}-${a.address}`, a, clean(a.title) || a.program?.name || a.address, !following && target?.address === a.address,
        () => { this.pick = a.address; }))));
  }

  // A group heading. Its count is in the filter above; a collapsible group (Done) is quieter.
  // tip: a clickable heading that isn't a fold (Today, whose click shows it alone): full colour, no chevron.
  section(t, label, color, action, open, tip = null) {
    const fold = Boolean(action) && !tip;
    return h_flex().id(`sec-${label}`).h(28).px(2).mt(8).gap(7).items_center().flex_none().text_size(11.5).font_medium().rounded(6)
      .text_color(fold ? t.dim : t.muted).when(Boolean(action), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(fold ? t.muted : t.foreground)).active((s) => s.bg(t.selected))
        .accessibility_label(tip ?? `${label}. ${open ? "Hide" : "Show"}`)
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .on_click((_e, cx) => { action(); cx.notify(); }))
      .child(div().size(7).rounded(4).flex_none().bg(fold ? color + "99" : color))
      .child(div().child(label))
      .when(fold, (el) => el.child(div().flex_1()).child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)));
  }

  calendarMonth() {
    return `${this.doneCalendar.year()}-${String(this.doneCalendar.month()).padStart(2, "0")}`;
  }

  openDoneCalendar(cx) {
    const month = this.calendarMonth();
    const date = this.doneDate ?? localDay(Date.now());
    this.doneDateCursor = date.startsWith(month) ? date : `${month}-01`;
    this.doneCalendarOpen = true;
    cx.notify();
  }

  setDoneDate(date, cx) {
    const month = this.calendarMonth();
    if (date && !date.startsWith(month)) {
      if (date < month) this.doneCalendar.prev_month();
      else this.doneCalendar.next_month();
    }
    this.doneDate = date;
    this.doneCalendarOpen = false;
    this.limit.done = PAGE;
    this.nav.focus();
    cx.notify();
  }

  moveDoneCalendarMonth(step, cx) {
    if (step < 0) this.doneCalendar.prev_month();
    else this.doneCalendar.next_month();
    this.doneDateCursor = `${this.calendarMonth()}-01`;
    cx.notify();
  }

  doneCalendarKey(e, cx) {
    const key = keyName(e);
    if (key === "escape") {
      this.doneCalendarOpen = false;
      this.doneDateFocus.focus();
      cx.notify();
    } else if (key === "enter" || key === "space") {
      this.setDoneDate(this.doneDateCursor, cx);
    } else {
      const step = { left: -1, right: 1, up: -7, down: 7 }[key];
      if (!step) return;
      const date = new Date(`${this.doneDateCursor}T12:00:00`);
      date.setDate(date.getDate() + step);
      const day = localDay(date.getTime());
      if (!day.startsWith(this.calendarMonth())) this.moveDoneCalendarMonth(step, cx);
      this.doneDateCursor = day;
      cx.notify();
    }
    cx.stop_propagation();
  }

  doneCalendarGrid(t, doneDate, todayDate) {
    const month = this.calendarMonth();
    const weeks = this.doneCalendar.month_days()[0];
    return v_flex().id("done-calendar-grid").w(224).p(7).gap(3).rounded(8).border(1).border_color(t.border).bg(t.popover)
      .track_focus(this.doneCalendarFocus).on_key_down((e, cx) => this.doneCalendarKey(e, cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().items_center().justify_between()
        .child(this.iconButton(t, "done-month-prev", `${ICONS}/chevron-left.svg`, "Previous month", (cx) => this.moveDoneCalendarMonth(-1, cx)))
        .child(div().text_size(12).font_medium().text_color(t.foreground)
          .child(`${MONTHS[this.doneCalendar.month() - 1]} ${this.doneCalendar.year()}`))
        .child(this.iconButton(t, "done-month-next", `${ICONS}/chevron-right.svg`, "Next month", (cx) => this.moveDoneCalendarMonth(1, cx))))
      .child(h_flex().children(weeks[0].map((day) => div().flex_1().text_center().text_size(10).text_color(t.dim)
        .child(WEEKDAYS[new Date(`${day}T12:00:00`).getDay()]))))
      .children(weeks.map((week) => h_flex().children(week.map((day) => {
        const selected = day === doneDate;
        return div().id(`done-date-${day}`).role("button").accessibility_label(day).aria_selected(selected)
          .flex_1().h(26).flex().items_center().justify_center().rounded(5).cursor_pointer().text_size(11)
          .text_color(selected ? t.accent_foreground : day.startsWith(month) ? t.foreground : t.dim)
          .when(day === todayDate, (el) => el.border(1).border_color(t.input))
          .when(selected, (el) => el.bg(t.accent))
          .when(day === this.doneDateCursor, (el) => el.border(1).border_color(t.accent).aria_active_descendant())
          .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { cx.stop_propagation(); this.setDoneDate(day, cx); })
          .child(String(Number(day.slice(8))));
      }))));
  }

  doneDateFilter(t, doneDate, todayDate) {
    const label = doneDate === todayDate ? "Today" : doneDate ?? "All dates";
    const trigger = h_flex().id("done-date-trigger").h(26).px(8).gap(6).items_center().flex_none().rounded(7)
      .bg(t.raised).text_size(11.5).text_color(t.foreground).cursor_pointer()
      .accessibility_label(`Filter by done date, ${label}`)
      .track_focus(this.doneDateFocus).tab_stop(true).focus((s) => s.border(1).border_color(t.accent))
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_key_down((e, cx) => {
        if (this.doneCalendarOpen || !["enter", "space", "down"].includes(keyName(e))) return;
        cx.stop_propagation();
        this.openDoneCalendar(cx);
      })
      .child(label)
      .child(svg(`${ICONS}/chevron-down.svg`).size(10).flex_none().text_color(t.muted));
    return h_flex().id("done-date-filter").flex_none().px(2).gap(7).items_center()
      .child(this.label(t, "Done date"))
      .child(Popover.new("done-date-picker").trigger(trigger).open(this.doneCalendarOpen)
        .on_open_change((open, cx) => {
          if (open) this.openDoneCalendar(cx);
          else { this.doneCalendarOpen = false; cx.notify(); }
        })
        .when(this.doneCalendarOpen, (el) => el.track_focus(this.doneCalendarFocus).content(this.doneCalendarGrid(t, doneDate, todayDate))))
      .when(Boolean(doneDate), (el) => el.child(this.button(t, "done-date-clear", "Clear", (cx) => this.setDoneDate(null, cx))));
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

  // Status filters and their counts, with a 2px line showing the distribution.
  filterBar(t, byStatus, colors) {
    const total = STATUS.reduce((count, id) => count + byStatus[id].length, 0);
    const f = this.filter;
    const seg = (id, label, count) => {
      const on = f === id;
      const empty = count === 0 && !on;
      return h_flex().id(`chip-${id ?? "all"}`).flex_1().flex_grow(id === "review" ? 1.55 : 1)
        .min_w(0).h(26).gap(3).items_center().justify_center().rounded(6)
        .text_size(11.5).font_medium().text_color(empty ? t.dim : on ? t.foreground : t.muted)
        .when(on, (el) => el.bg(t.chrome).border(1).border_color(t.border))
        .tooltip(`${label} · ${count}`).accessibility_label(`${label}, ${count}${on ? ", shown" : ". Show only these"}`)
        .when(!empty && !on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => { this.filter = id; cx.notify(); }))
        .child(div().truncate().child(label))
        .child(div().flex_none().text_color(t.dim).child(String(count)));
    };
    const line = (n, color) => n ? div().h_full().w(`${(n / total) * 100}%`).bg(color) : null;
    return v_flex().gap(6)
      .child(h_flex().p(2).gap(2).rounded(8).bg(t.raised)
        .child(seg(null, "All", total))
        .children(STATUS.map((id) => seg(id, LABEL[id], byStatus[id].length))))
      .child(h_flex().h(2).mx(4).rounded(1).overflow_hidden().bg(t.raised)
        .children([...STATUS].reverse().map((id) => line(byStatus[id].length, colors[id])).filter(Boolean)));
  }

  todoTodayFilter(t) {
    const on = this.todoTodayOnly;
    return Toggle.new("todo-today-filter").pressed(on).tab_stop(true)
      .accessibility_label("Show only to-do tasks marked for today")
      .h(26).px(8).gap(5).flex().items_center().self_start().rounded(7).border(1).cursor_pointer()
      .border_color(on ? t.accent + "55" : t.border).bg(on ? t.accent + "1f" : t.chrome)
      .text_size(11.5).font_medium().text_color(on ? t.accent : t.muted)
      .hover((s) => s.bg(on ? t.accent + "33" : t.hover)).focus((s) => s.border_color(t.accent))
      .on_change((pressed, cx) => { this.todoTodayOnly = pressed; this.scrollPending = true; cx.notify(); })
      .child(svg("mods/cockpit-tasks/sun.svg").size(11).flex_none())
      .child("Today");
  }

  // The quick-add field and search share one row: the one in use is wide, the other narrows to its
  // icon (a click on it, or a or /, gives it the keyboard). Both stay mounted, so focus always lands.
  // A fill instead of a border until a field has the keyboard.
  quickRow(t) {
    const searching = this.focus === "search" || (Boolean(this.query) && this.focus !== "quick");
    const field = (id, state, icon, on, wide, tip) => h_flex().id(id).key_context("TaskField").min_h(32).pl(10).pr(10).gap(8).items_center().rounded(8).border(1)
      .when(wide, (el) => el.flex_1().min_w(0)).when(!wide, (el) => el.w(34).flex_none().overflow_hidden().cursor_pointer().tooltip(tip).hover((s) => s.bg(t.hover)))
      .border_color(on ? t.accent : t.raised).bg(on ? t.background : t.raised).when(wide, (el) => el.cursor_text())
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); state.focus(); cx.notify(); })
      // A search still filtering while its field is narrow keeps its icon lit.
      .child(svg(icon).size(13).flex_none().text_color(on || (state === this.searchIn && this.query) ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).overflow_hidden().child(Input.new(state).w_full().text_size(12.5).text_color(t.foreground)));
    return h_flex().gap(6).items_center()
      .child(field("task-quick", this.quickIn, `${ICONS}/plus.svg`, this.focus === "quick", !searching, "Add a task (a)"))
      .child(field("task-search", this.searchIn, `${ICONS}/search.svg`, this.focus === "search", searching, "Search tasks (/)"));
  }

  // Marked for today on an earlier day and not done: one row offers to carry them over or let them go.
  carryRow(t, stale, now) {
    const yesterday = stale.every((x) => sameDay(x.todayAt, now - 24 * 3600 * 1000));
    const ids = new Set(stale.map((x) => x.id));
    const set = (todayAt) => {
      this.tasks = this.tasks.map((x) => (ids.has(x.id) ? { ...x, todayAt } : x));
      this.persist();
    };
    return h_flex().id("carry-over").min_h(34).pl(10).pr(4).py(4).mt(8).gap(8).items_center().flex_none().rounded(8).border(1).border_color(t.border).bg(t.raised)
      .child(svg("mods/cockpit-tasks/sun.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).whitespace_normal()
        .child(`${stale.length} from ${yesterday ? "yesterday" : "an earlier day"} not finished`))
      .child(this.button(t, "carry-yes", "Carry over", () => set(Date.now())))
      .child(this.button(t, "carry-no", "Dismiss", () => set(null)));
  }

  render() {
    const t = theme();
    const now = Date.now();
    // Herdr's live lists, read once per redraw and handed to every card.
    const list = agents();
    const ctx = { list, live: new Map(list.map((a) => [a.address, a.status])), panes: panes(), spaces: spaces(), mrs: shared("cockpit.mrs"), focus: focused() };
    const q = this.query.trim();
    const hit = (x) => !q || matches(x, q);
    const byStatus = Object.fromEntries(STATUS.map((id) => [id,
      this.tasks.filter((task) => task.status === id).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))]));
    const colors = statusColors(t);
    const f = this.filter;
    const filtered = Boolean(f);
    const todoToday = f === "todo" && this.todoTodayOnly;
    // Today: open tasks marked for today appear at the top in the same order as the open groups.
    const openTasks = OPEN_GROUPS.flatMap((id) => byStatus[id]);
    const inToday = (x) => !filtered && isToday(x, now);
    const today = openTasks.filter((x) => inToday(x) && hit(x));
    const matchingDone = byStatus.done.filter(hit);
    const todayDate = localDay(now);
    const doneDate = this.doneDate === undefined ? todayDate : this.doneDate;
    const done = doneDate ? matchingDone.filter((task) => completionDay(task) === doneDate) : matchingDone;
    const scopeKey = JSON.stringify([f, doneDate, q]);
    const archiveFiltered = Boolean(doneDate || q);
    const scopeDetail = [
      doneDate === todayDate ? "Completed today" : doneDate ? `Completed on ${doneDate}` : null,
      q ? `Matches “${q}”` : null,
    ].filter(Boolean).join(" · ");
    this.archiveScope = { key: scopeKey, detail: scopeDetail, tasks: done };
    const pending = this.archiveConfirm;
    if (pending && (pending.key !== scopeKey || done.filter((task) => pending.ids.has(task.id)).length !== pending.ids.size)) {
      this.archiveConfirm = null;
    }
    // Worked out from the data on each redraw, so no midnight timer is needed.
    const stale = filtered ? [] : openTasks.filter((x) => x.todayAt && !isToday(x, now));
    const only = this.todayOnly && !filtered;
    const showToday = !filtered && (today.length > 0 || only);
    const empty = this.ready && !this.tasks.length && !this.form;
    const groups = OPEN_GROUPS.filter((id) => !only && (!f || f === id)).map((id) => ({
      id, tasks: byStatus[id].filter((x) => !inToday(x) && (!todoToday || isToday(x, now)) && hit(x)),
    }));
    // What each group draws: its first `limit` cards (PAGE until "Show more"), and how many wait.
    const cap = (group, id) => group.slice(0, this.limit[id] ?? PAGE);
    const left = (group, id) => Math.max(0, group.length - (this.limit[id] ?? PAGE));
    // A search opens Done, so a finished task can be found too.
    const doneOpen = only ? false : !filtered ? this.showDone || Boolean(q) : f === "done";
    const doneHeading = !filtered && !only && (matchingDone.length > 0 || Boolean(this.doneDate));
    const showDoneDate = doneOpen && (f === "done" || doneHeading);
    if (!showDoneDate) this.doneCalendarOpen = false;
    // The selection follows screen order: Today first.
    const order = [...today, ...groups.flatMap(({ id, tasks }) => cap(tasks, id)), ...(doneOpen ? cap(done, "done") : [])];
    const menu = this.choiceMenu;
    if (menu && (menu.id === null ? !this.form : !order.some((task) => task.id === menu.id) || (menu.field === "workType" && this.open !== menu.id))) this.choiceMenu = null;
    // Nothing left to show for the filter or the search (Today only has its own empty line).
    const nothing = this.ready && this.tasks.length > 0 && (filtered || Boolean(q)) && !only && !order.length && !(showDoneDate && doneDate);
    // Keyboard rows: each card and the scroll child it is (the form, loading and empty lines come first).
    const kbd = this.nav.focused();
    const rows = [];
    let at = [Boolean(this.form), !this.ready, empty, nothing, stale.length > 0].filter(Boolean).length;
    // Where the selected task sits now; a task that left the list (done, collapsed) leaves the row index.
    const found = this.selId ? order.findIndex((x) => x.id === this.selId) : -1;
    if (found >= 0) this.nav.sel = found;
    this.nav.clamp(order.length);
    this.selId = order[this.nav.sel]?.id ?? null;
    // group: which group the card is drawn in, so J/K never swaps across Today and the group below.
    const cardOf = (group) => (x) => {
      rows.push({ task: x, section: at++, group });
      return this.card(t, x, now, ctx, kbd && this.nav.sel === rows.length - 1);
    };
    if (showToday) at++;
    const todayCards = today.map(cardOf("today"));
    if (only && !today.length) at++;
    // A "Show more" row is a scroll child too, so it counts in `at`.
    const openCards = groups.flatMap(({ id, tasks }) => {
      const children = [];
      if (!filtered && tasks.length) {
        children.push(this.section(t, LABEL[id], colors[id]));
        at++;
      }
      children.push(...cap(tasks, id).map(cardOf(id)));
      const more = left(tasks, id);
      if (more) {
        children.push(this.moreRow(t, id, more));
        at++;
      }
      return children;
    });
    const moreDone = doneOpen ? left(done, "done") : 0;
    if (doneHeading) at++;
    if (showDoneDate) at++;
    const doneCards = doneOpen ? cap(done, "done").map(cardOf("done")) : [];
    this.rows = rows;
    if (this.scrollPending) {
      this.scrollPending = false;
      const sec = rows[this.nav.sel]?.section;
      if (sec != null) this.scroll.scroll_to_item(sec);
    }
    const problem = this.reportNote || this.headNote;
    const passing = problem ? null : this.flashNote;
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
        .when(Boolean(problem), (el) => el.child(div().id("head-note").px(2).text_size(11.5).text_color(t.blocked)
          .cursor_pointer().tooltip("Click to dismiss").accessibility_label(`${problem} Dismiss`)
          .on_click((_e, cx) => { this.reportNote = null; this.headNote = null; cx.notify(); })
          .child(problem)))
        // A passing line (5 s): "Deleted. Press u to undo", or why a key did nothing.
        .when(Boolean(passing), (el) => el.child(div().id("head-note").px(2).text_size(11.5).text_color(passing.warn ? t.blocked : t.muted).child(passing.text)))
        .when(this.tasks.length > 0, (el) => el.child(this.filterBar(t, byStatus, colors)))
        .when(f === "todo", (el) => el.child(this.todoTodayFilter(t)))
        .when(Boolean(this.archiveConfirm), (el) => el.child(this.archivePrompt(t, this.archiveConfirm)))
        .child(this.quickRow(t)))
      .child(v_flex().id("tasks-scroll").flex_1().min_h(0).px(12).pt(6).pb(14).gap(8).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(Boolean(this.form), (el) => el.child(this.formCard(t)))
        .when(!this.ready, (el) => el.child(div().px(4).py(10).text_color(t.dim).child("Loading…")))
        .when(empty, (el) => el.child(v_flex().items_center().px(16).py(28).gap(10)
          .child(div().size(44).rounded(12).bg(t.raised).flex().items_center().justify_center().text_color(t.dim).child(svg("mods/cockpit-tasks/list-todo.svg").size(22)))
          .child(div().text_size(14).font_medium().child("Nothing queued"))
          .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal().child("Type a task above and press Enter. Use + to add details and links, then send it to an agent as context."))))
        .when(nothing, (el) => el.child(v_flex().px(4).py(10).gap(8)
          .child(div().text_color(t.muted).whitespace_normal().child(
            q ? `No tasks match “${q}”` : todoToday ? "No to-do tasks marked for today." : `No ${LABEL[f].toLowerCase()} tasks`))
          .when(Boolean(q), (row) => row.child(this.button(t, "search-clear", "Clear search", (cx) => { this.clearSearch(); cx.notify(); }).self_start()))
          .when(!q && !todoToday, (row) => row.child(this.button(t, "filter-clear", "Show all", (cx) => { this.filter = null; cx.notify(); }).self_start()))))
        .when(stale.length > 0, (el) => el.child(this.carryRow(t, stale, now)))
        // Today: a click on its heading (or T) shows it alone.
        .when(showToday, (el) => el.child(this.section(t, only ? "Today · only" : "Today", t.accent, () => { this.todayOnly = !this.todayOnly; }, only,
          only ? "Show every group (T)" : "Show only today (T)")))
        .children(todayCards)
        .when(only && !today.length, (el) => el.child(div().px(4).py(6).text_size(12).text_color(t.dim).whitespace_normal()
          .child(q ? "Nothing for today matches." : "Nothing planned for today. Press t on a task to plan it.")))
        .children(openCards)
        .when(doneHeading, (el) => el.child(this.section(t, "Done", t.ansi2, () => { this.showDone = !this.showDone; }, doneOpen)))
        .when(showDoneDate, (el) => el.child(this.doneDateFilter(t, doneDate, todayDate)))
        .when(this.ready && showDoneDate && Boolean(doneDate) && !done.length, (el) => el.child(
          div().px(2).py(6).text_size(12).text_color(t.muted)
            .child(doneDate === todayDate ? "No matching tasks completed today." : `No completed tasks match ${doneDate}.`)))
        .children(doneCards)
        .when(moreDone > 0, (el) => el.child(this.moreRow(t, "done", moreDone)))
        .when(doneCards.length > 0, (el) => el.child(h_flex().px(2).gap(8).items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child("Done tasks move to the archive after a week"))
          .child(this.button(t, "archive-done", archiveFiltered ? "Archive matches" : "Archive all done", (cx) => this.requestArchive(cx))))))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ l", "expand"], ["x ␣", "change status"], ["J K", "reorder"], ["a o", "add"], ["/", "search"], ["n +", "new with details"], ["N", "new from active agent"], ["e", "edit"],
          ["m", "work type"], ["t", "today"], ["T", "today only"], ["b", "block"], ["p", "progress note"], ["s", "send to agent"], ["S", "agent menu"], ["L", "link agent"], ["ga", "go to agent"],
          ["gj gm", "Jira, MR"], ["gs gl", "space, first link"], ["yy", "copy brief"], ["dd", "delete"], ["u", "undo delete"], ["f", "filter"], ["D", "show done"], ["A", "preview archive"], ["R", "report"]], this.nav.help)));
  }
}
