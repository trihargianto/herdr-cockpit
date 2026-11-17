import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, layout, settings, keys, focused, terminals, exec, hc, readTextFile, appHome, home, nextCommand, shared, setShared, notify, checking } from "herdr";
import { Feed } from "./feed.js";
import * as fs from "fs/promises";
import { KEY as ANNOTATIONS, notesOf, newId, clip, dialogHeight, message, queue, unqueue, remove, queuedByTarget, ready, lastReply, reviewMessage } from "./annolib.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The agents' own helpers listen on ports too: they are not your dev servers.
const TOOLS = new Set(["claude", "codex", "hc", "herdr-core", "herdr-app"]);
const VERSION = /^\d+\.\d+\.\d+$/;

// The side panels. The upper stack ("panel-body") holds every one; the lower stack ("panel-lower")
// holds copies of these, so two can show at once. Only panes that read their data: two copies of
// Tasks would each save their own list over the other's.
const LOWER = new Set(["home", "inbox", "mrs", "ports", "usage"]);
// The mod behind each panel, for handing it the keyboard ("cockpit-inbox.focus").
const MODS = { annotate: "cockpit-annotate", home: "cockpit-home", projects: "cockpit-projects", talk: "cockpit-talk", automations: "cockpit-automations", review: "cockpit-review", usage: "cockpit-usage", ports: "cockpit-ports", tasks: "cockpit-tasks", inbox: "cockpit-inbox", mrs: "cockpit-mrs" };
const NAMES = { annotate: "Annotations", home: "Home", projects: "Projects", talk: "Agent talk", automations: "Automations", review: "Review", usage: "Monitoring", ports: "Ports", tasks: "Tasks", inbox: "Inbox", mrs: "Merge requests" };

export default class Tabs extends View {
  // A new tab running Neovim, in the repository root of the focused pane (else its folder). The tab bar's
  // Neovim button and the leader's Ctrl+B n both come here, so they always agree.
  openNeovim(cx) {
    const f = focused();
    // The folder the pane reports as you move around. The terminal list's folder is only where
    // the terminal started, so it is the last resort.
    const pane = panes().find(p => p.terminal === f?.terminal);
    const started = terminals().find(x => x.address === f?.terminal)?.cwd;
    const here = pane?.cwd ?? f?.cwd ?? started;
    const remote = (f?.terminal ?? "").includes("/");
    cx.spawn(async (cx) => {
      // The root of the repository the pane is in (a worktree's own root counts). If it isn't
      // inside one, the pane's own folder: a space's recorded folder is only where it was created.
      let folder = here;
      if (here && !remote) {
        let top = null;
        try {
          const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: here, timeout: 10000 });
          if (r.code === 0) top = r.stdout.trim();
        } catch {}
        folder = top || here;
      }
      run("terminal.open", { argv: ["nvim"], place: "tab", name: "Neovim", ...(folder && !remote ? { folder } : {}) });
    });
  }

  init(_props, cx) {
    this.barWidth = null; // the tab bar's width, to drop the labels when it gets tight
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panelOrder = JSON.parse(localStorage.getItem("panel-order") ?? "[]"); } catch { this.panelOrder = []; }
    if (!Array.isArray(this.panelOrder)) this.panelOrder = [];
    this.panelPress = null;
    this.panelDrop = null;
    this.panelDragged = false;
    this.skipPanelClick = false;
    // Counter for the Tasks button. Merge requests come from the feed (shared "cockpit.mrs").
    this.todo = 0;
    this.servers = 0;
    // One-time move from the old name (Herdr Studio): your project list, quiet mode and dismissed
    // errors live in shared state under "studio.*". The old keys stay as they were.
    if (!checking()) {
      for (const key of ["projects", "quiet", "errors.dismissed"]) {
        if (shared(`cockpit.${key}`) == null && shared(`studio.${key}`) != null) setShared(`cockpit.${key}`, shared(`studio.${key}`));
      }
    }
    this.feed = new Feed();
    this.feed.start(cx);
    // Commands from keys, the leader, toasts and other mods ("cockpit-tabs.neovim", "cockpit-tabs.show-home").
    // The tab bar is always on screen, so a command sent here always arrives.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
      }
    });
    // Annotations queued for an agent go out from here, the one mod always on screen, once it's idle.
    this.annoSending = new Set();
    if (!checking()) cx.timer.every(1000, (cx) => this.drainAnnotations(cx));
    // Plannotator reviews you opened: their results come back as files, looked for while any is open.
    if (!checking()) cx.timer.every(3000, (cx) => this.checkReviews(cx));
    this.readTodo(cx);
    this.countServers(cx);
    cx.timer.every(30000, (cx) => this.countServers(cx));
    cx.timer.every(5000, (cx) => this.readTodo(cx));
  }

  command(c, cx) {
    if (c === "neovim") this.openNeovim(cx);
    else if (c === "refresh") this.feed.refresh(cx);
    // The MRs pane has no fetch of its own: it asks the feed when it opens on old data, and every 2 min while shown.
    else if (c === "refresh-mrs") this.feed.mrs(cx, true);
    else if (c === "panel") this.showPanel("mrs");
    else if (c.startsWith("show-")) this.showPanel(c.slice(5));
    else if (c.startsWith("toggle-")) this.showPanel(c.slice(7), true);
    // From the keyboard: open and take the keyboard, or close when it's already open.
    else if (c.startsWith("key-")) this.keyPanel(c.slice(4), cx);
    else if (c === "sidebar") this.toggleRail();
    // `q` in a panel: close it (or just the lower half) and give the keyboard back to the pane.
    else if (c === "close-panel" || c === "close-lower") {
      run("layout.hide", { id: c === "close-panel" ? "panel" : "panel-lower" });
      const pane = focused()?.pane;
      if (pane) run("pane.focus", { pane });
    }
    else if (c === "sidebar-hide") run("layout.toggle", { id: "sidebar" });
    else if (c.startsWith("lower-")) this.toggleLower(c.slice(6), cx);
    else if (c === "lower") this.toggleLower(null);
    else if (c === "quiet") {
      const quiet = !shared("cockpit.quiet");
      setShared("cockpit.quiet", quiet);
      notify({ title: quiet ? "Quiet mode on" : "Alerts on", body: quiet ? "MR and pipeline alerts are paused. The Dock badge still counts." : "MR and pipeline alerts are back.", level: "info", timeout: 3000 });
    } else if (c === "go-blocked") this.goAgent("blocked");
    else if (c === "go-done") this.goAgent("done");
    else if (c === "open-mr") this.openMr(cx);
    // Commands reach shown copies only: give the Tasks pane a moment to be on screen first.
    else if (c === "annotate") this.annotate(cx);
    else if (c === "annotate-send") this.annotateSend();
    else if (c === "review-last") this.reviewLast(cx);
    else if (c === "review-folder") this.reviewFolder(cx);
    else if (c === "new-task") { this.showPanel("tasks"); cx.timer.after(120, () => run("cockpit-tasks.quick")); }
  }

  // Annotate: copy the focused terminal's selection, then open the note dialog with it. The selection is
  // read here, before any overlay takes the keyboard. The clipboard is left as it was (with
  // copy-on-select it already held the selection).
  // Programs that take the mouse (Claude Code, Neovim) select text themselves: Herdr has no selection
  // then, and a click there clears Herdr's. Their selection lands on the clipboard, so with no
  // selection the note quotes the clipboard (the dialog says so).
  annotate(cx) {
    const f = focused();
    const address = f?.shown ?? f?.terminal;
    if (!address) { notify({ title: "Click a terminal first", body: "Annotate works on text selected in a terminal.", level: "info", timeout: 3000 }); return; }
    const selection = f.selection ?? terminals().find((x) => x.address === address)?.selection;
    if (!selection) {
      const quote = clip(cx.read_from_clipboard());
      if (!quote) { notify({ title: "Nothing selected", body: "Select text (hold Shift in Claude Code or Neovim) or copy it, then press Ctrl+B A.", level: "info", timeout: 4000 }); return; }
      openOverlay({ mod: "cockpit-annotate", kind: "dialog", width: 540, height: dialogHeight(quote), props: { mode: "new", from: "clipboard", quote, source: this.annotationSource(address) } });
      return;
    }
    const before = cx.read_from_clipboard();
    run("terminal.copy");
    cx.timer.after(30, (cx) => {
      const text = cx.read_from_clipboard();
      if (before !== undefined && text !== before) cx.write_to_clipboard(before);
      const quote = clip(text);
      if (!quote) { notify({ title: "Couldn't read the selection", level: "warning", timeout: 3000 }); return; }
      openOverlay({ mod: "cockpit-annotate", kind: "dialog", width: 540, height: dialogHeight(quote), props: { mode: "new", quote, source: this.annotationSource(address) } });
    });
  }

  // Where a note came from, kept with it: the panel groups by it and the message names it.
  annotationSource(address) {
    const agent = agents().find((a) => a.address === address);
    const pane = panes().find((p) => p.terminal === address);
    const tabId = agent?.tab ?? pane?.tab ?? null;
    const space = spaces().find((s) => s.tabs.some((tab) => tab.id === tabId)) ?? spaces().find((s) => s.id === focused()?.space);
    const tab = space?.tabs.find((x) => x.id === tabId);
    const program = agent?.program ?? pane?.program;
    const title = (agent?.title ?? pane?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
    const telling = title && title !== program?.name && title.toLowerCase() !== program?.key && !/^[~/]/.test(title);
    const label = agent ? (telling ? `${program?.name ?? "Agent"} · ${title}` : program?.name ?? "Agent") : (telling ? title : program?.name || "Terminal");
    return { terminal: address, space: space?.id ?? null, space_name: space?.name ?? null, tab: tabId, tab_name: tab?.name ?? null,
      label, agent: Boolean(agent), icon: program?.icon ?? null, tint: Boolean(program?.tint) };
  }

  // Right-click › Send annotations here: queue this space's waiting notes for the focused agent.
  annotateSend() {
    const f = focused();
    const to = f?.shown ?? f?.terminal;
    const agent = agents().find((a) => a.address === to);
    if (!agent) { notify({ title: "Not an agent", body: "Annotations go to an agent's terminal.", level: "info", timeout: 3000 }); return; }
    const notes = notesOf(shared(ANNOTATIONS));
    const ids = notes.filter((n) => !n.queued && n.source?.space === agent.space).map((n) => n.id);
    if (!ids.length) { notify({ title: "No annotations to send", body: "This space has none waiting.", level: "info", timeout: 3000 }); return; }
    setShared(ANNOTATIONS, { notes: queue(notes, ids, to) });
  }

  // Sends each agent its queued notes once it's idle (or done), one `hc send` per agent at a time.
  // A note leaves the list only when the send worked; otherwise it goes back with the reason.
  drainAnnotations(cx) {
    const notes = notesOf(shared(ANNOTATIONS));
    if (!notes.some((n) => n.queued)) return;
    for (const q of queuedByTarget(notes)) {
      if (this.annoSending.has(q.to)) continue;
      const agent = agents().find((a) => a.address === q.to);
      if (!agent) { setShared(ANNOTATIONS, { notes: unqueue(notesOf(shared(ANNOTATIONS)), { to: q.to, error: "the agent closed" }) }); continue; }
      if (!ready(agent.status)) continue;
      this.annoSending.add(q.to);
      const ids = q.notes.map((n) => n.id);
      const text = message(q.notes, q.to);
      cx.spawn(async () => {
        let r;
        try { r = await exec("hc", ["send", q.to, text], { cwd: home(), timeout: 60000 }); }
        catch (e) { r = { code: 1, stdout: "", stderr: String(e?.message ?? e) }; }
        const now = notesOf(shared(ANNOTATIONS));
        if (r.code === 0) {
          setShared(ANNOTATIONS, { notes: remove(now, ids) });
          this.archiveAnnotations(now.filter((n) => ids.includes(n.id)), q.to);
          notify({ title: `Sent ${ids.length} ${ids.length === 1 ? "annotation" : "annotations"}`, body: `To ${agent.program?.name ?? "the agent"} (${q.to})`, level: "success", timeout: 2500 });
        } else {
          const why = (r.stderr || r.stdout || "hc send failed").trim().split("\n")[0];
          setShared(ANNOTATIONS, { notes: unqueue(now, { ids, error: why }) });
          notify({ title: "Annotations not sent", body: why, level: "error", timeout: 5000 });
        }
        this.annoSending.delete(q.to);
      });
    }
  }

  // ---- Plannotator reviews. Plannotator opens the review in the browser and, when you submit, writes
  // {decision, feedback} to a result file; the feedback then joins the annotation queue for the agent, so
  // it waits if the agent is busy. Open reviews are kept in shared "cockpit.reviews", so they survive a reload.

  // Review the focused agent's last reply. Claude Code: from its transcript (terminal → its process →
  // ~/.claude/sessions/<pid>.json → the session's log). Other agents: the end of their screen.
  reviewLast(cx) {
    const f = focused();
    const to = f?.shown ?? f?.terminal;
    const agent = agents().find((a) => a.address === to);
    if (!agent) { notify({ title: "Focus an agent first", body: "Review last reply works on an agent's terminal.", level: "info", timeout: 3000 }); return; }
    if (to.includes("/")) { notify({ title: "Not on this computer", body: "Reviews work for agents on this computer for now.", level: "info", timeout: 3500 }); return; }
    cx.spawn(async () => {
      let text = "", from = "transcript";
      try {
        const info = JSON.parse((await hc(["get", to, "--json"])).stdout);
        const pid = info?.foreground?.pid;
        const session = pid ? JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null") : null;
        if (session?.sessionId && /^[\w-]+$/.test(session.sessionId)) {
          const r = await exec("sh", ["-c", 'f=$(ls -t "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -1); [ -n "$f" ] && tail -n 800 "$f"', "sh", session.sessionId], { cwd: home(), timeout: 10000 });
          text = lastReply(r.stdout.split("\n"));
        }
      } catch {}
      if (!text) {
        from = "screen";
        try {
          const r = await hc(["read", to, "--lines", "300"]);
          text = r.code === 0 ? clip(r.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")) : "";
        } catch {}
      }
      if (!text) { notify({ title: "No reply to review", body: "This agent hasn't written a reply yet.", level: "info", timeout: 3000 }); return; }
      const name = agent.program?.name ?? "Agent";
      const file = await this.reviewFile(`# Last reply from ${name} (${to})\n\n${text}\n`);
      if (!file) return;
      this.startReview({ path: file, temp: true, cwd: home(), title: `${name} (${to}) · last reply`, what: "your last reply", to,
        note: from === "screen" ? "Read from the screen: this agent has no transcript Cockpit can read." : null });
    });
  }

  // Review the documents in the focused pane's repository (or folder). The feedback goes to the focused
  // agent; from a terminal that isn't one, it lands in Annotations for you to send.
  reviewFolder(cx) {
    const f = focused();
    const address = f?.shown ?? f?.terminal;
    if (!address) { notify({ title: "Click a terminal first", level: "info", timeout: 3000 }); return; }
    if (address.includes("/")) { notify({ title: "Not on this computer", body: "Reviews work for folders on this computer for now.", level: "info", timeout: 3500 }); return; }
    const pane = panes().find((p) => p.terminal === address);
    const here = pane?.cwd ?? f?.cwd;
    if (!here) { notify({ title: "No folder for this terminal", level: "info", timeout: 3000 }); return; }
    const agent = agents().find((a) => a.address === address);
    cx.spawn(async () => {
      let folder = here;
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: here, timeout: 10000 });
        if (r.code === 0 && r.stdout.trim()) folder = r.stdout.trim();
      } catch {}
      const name = folder.split("/").pop() || folder;
      this.startReview({ path: folder, temp: false, cwd: folder, title: name, what: `the documents in ${name}`, to: agent ? address : null, from: address });
    });
  }

  async reviewFile(text) {
    const dir = `${appHome()}/cockpit-annotate/reviews`;
    try {
      await fs.mkdir(dir, { recursive: true });
      const file = `${dir}/${newId()}.md`;
      await fs.writeFile(file, text);
      return file;
    } catch (e) {
      notify({ title: "Couldn't start the review", body: String(e?.message ?? e), level: "error", timeout: 5000 });
      return null;
    }
  }

  // Starts `plannotator annotate --gate` in the background (it serves the page until you submit) and
  // remembers where its result will land.
  async startReview({ path, temp, cwd, title, what, to, from = null, note = null }) {
    const dir = `${appHome()}/cockpit-annotate/reviews`;
    const id = newId();
    const result = `${dir}/${id}.json`, log = `${dir}/${id}.log`;
    try {
      await fs.mkdir(dir, { recursive: true });
      const r = await exec("sh", ["-c", 'nohup plannotator annotate "$1" --title "$2" --gate --json --result-file "$3" >/dev/null 2>"$4" </dev/null & echo $!',
        "sh", path, title, result, log], { cwd, timeout: 15000 });
      const pid = Number(r.stdout.trim());
      if (r.code !== 0 || !pid) throw new Error((r.stderr || "plannotator didn't start").trim().split("\n")[0]);
      const reviews = Array.isArray(shared("cockpit.reviews")) ? shared("cockpit.reviews") : [];
      setShared("cockpit.reviews", [...reviews, { id, pid, to, from: from ?? to, title, what, result, log, file: temp ? path : null, at: Date.now() }]);
      notify({ title: "Review opened in your browser", body: note ?? (to ? `Your feedback goes to ${to} when you submit.` : "Your feedback lands in Annotations when you submit."), level: "info", timeout: 3500 });
    } catch (e) {
      notify({ title: "Couldn't start Plannotator", body: String(e?.message ?? e), level: "error", timeout: 5000 });
    }
  }

  // Looks for finished reviews: a result file means you submitted; a Plannotator that's gone without one
  // failed or was closed (its last error line is shown).
  checkReviews(cx) {
    const reviews = Array.isArray(shared("cockpit.reviews")) ? shared("cockpit.reviews") : [];
    if (!reviews.length || this.checkingReviews) return;
    this.checkingReviews = true;
    cx.spawn(async () => {
      for (const rv of reviews) {
        let text = null;
        try { text = await readTextFile(rv.result); } catch {}
        let done = false;
        if (text) {
          done = true;
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          this.reviewDone(rv, parsed);
        } else {
          let alive = true;
          try { alive = (await exec("kill", ["-0", String(rv.pid)], { cwd: home(), timeout: 5000 })).code === 0; } catch {}
          if (!alive) {
            done = true;
            // The result can land just as the process ends: look once more.
            try { text = await readTextFile(rv.result); } catch {}
            if (text) { try { this.reviewDone(rv, JSON.parse(text)); } catch { this.reviewDone(rv, null); } }
            else {
              let why = "";
              try { why = ((await readTextFile(rv.log)) ?? "").trim().split("\n").filter(Boolean).pop() ?? ""; } catch {}
              notify({ title: "Review closed", body: why || `${rv.title}: nothing was sent.`, level: why ? "warning" : "info", timeout: 4000 });
            }
          }
        }
        if (done) {
          const now = Array.isArray(shared("cockpit.reviews")) ? shared("cockpit.reviews") : [];
          setShared("cockpit.reviews", now.filter((x) => x.id !== rv.id));
          for (const p of [rv.result, rv.log, rv.file]) if (p) fs.unlink(p).catch(() => {});
        }
      }
      this.checkingReviews = false;
    });
  }

  // A submitted review: its feedback joins the annotation queue for the agent, or waits in Annotations.
  reviewDone(rv, result) {
    const text = reviewMessage(result, rv.what);
    if (!text) { notify({ title: "Review closed", body: `${rv.title}: nothing to send.`, level: "info", timeout: 3000 }); return; }
    const live = rv.to && agents().some((a) => a.address === rv.to);
    const base = this.annotationSource(rv.from ?? rv.to ?? focused()?.terminal);
    const note = { id: newId(), at: Date.now(), kind: "review", quote: "", comment: text,
      source: { ...base, label: `Plannotator · ${rv.title}` } };
    let notes = [...notesOf(shared(ANNOTATIONS)), note];
    if (live) notes = queue(notes, [note.id], rv.to);
    setShared(ANNOTATIONS, { notes });
    const approved = result?.decision === "approved";
    notify({ title: approved ? "Approved" : "Review feedback ready",
      body: live ? `Going to ${rv.to}${agents().find((a) => a.address === rv.to && ready(a.status)) ? "" : " when it's idle"}.` : "It's in Annotations: pick an agent and send it.",
      level: "success", timeout: 3000 });
  }

  // Sent notes are kept, one JSON line each, in cockpit-annotate/sent.jsonl.
  async archiveAnnotations(notes, to) {
    if (!notes.length) return;
    const dir = `${appHome()}/cockpit-annotate`;
    const lines = notes.map((n) => JSON.stringify({ ...n, queued: undefined, sent: { to, how: "send", at: Date.now() } })).join("\n") + "\n";
    try {
      await fs.mkdir(dir, { recursive: true });
      const file = `${dir}/sent.jsonl`;
      const before = (await fs.exists(file)) ? await fs.readFile(file, "utf8") : "";
      await fs.writeFile(file, before + lines);
    } catch {}
  }

  // The sidebar between its rail and the width it had (as the sidebar's own toggle does). A hidden
  // sidebar comes back first.
  toggleRail() {
    const sidebar = find(layout(), "sidebar");
    if (sidebar?.hidden) { run("layout.show", { id: "sidebar" }); return; }
    const width = sidebar?.size?.px ?? 232;
    const narrow = width < 160;
    if (!narrow) setShared("sidebar.width", width);
    setShared("sidebar.collapsed", !narrow);
    run("layout.resize", { id: "sidebar", px: narrow ? (shared("sidebar.width") ?? 232) : window()?.platform === "macos" ? 76 : 44 });
  }

  // Opens a panel in the upper half (a toggle when it's already the one shown and `toggle` is set).
  showPanel(id, toggle = false) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (toggle && panel && !panel.hidden && body?.active === id) { run("layout.hide", { id: "panel" }); return; }
    run("layout.select", { stack: "panel-body", child: id });
    run("layout.show", { id: "panel" });
  }

  // Opens a panel (or keeps it open) and gives it the keyboard. Commands reach shown copies only, so
  // the focus waits a moment for it to show. `q` inside a panel closes it.
  keyPanel(id, cx) {
    this.showPanel(id);
    // A panel that starts slowly can miss the first one: send it again (taking focus twice is harmless).
    if (MODS[id]) for (const ms of [120, 400]) cx.timer.after(ms, () => run(`${MODS[id]}.focus`));
  }

  // The lower half: shows `id` there (hides it if it's already shown); no id toggles the half.
  toggleLower(id, cx) {
    const root = layout(), panel = find(root, "panel"), lower = find(root, "panel-lower");
    const open = panel && !panel.hidden && lower && !lower.hidden;
    if (!id) {
      if (open) run("layout.hide", { id: "panel-lower" });
      else { run("layout.show", { id: "panel-lower" }); run("layout.show", { id: "panel" }); }
      return;
    }
    if (!LOWER.has(id)) return;
    if (open && lower.active === `lower-${id}`) { run("layout.hide", { id: "panel-lower" }); return; }
    run("layout.select", { stack: "panel-lower", child: `lower-${id}` });
    run("layout.show", { id: "panel-lower" });
    run("layout.show", { id: "panel" });
    if (cx && MODS[id]) for (const ms of [120, 400]) cx.timer.after(ms, () => run(`${MODS[id]}.focus-lower`));
  }

  // The agent that has needed you longest, or the one that finished most recently.
  goAgent(status) {
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const when = (a) => tabs.get(a.tab)?.changed_at ?? 0;
    const list = agents().filter((a) => a.status === status).sort((x, y) => (status === "blocked" ? when(x) - when(y) : when(y) - when(x)));
    if (list[0]) run("agent.focus", { terminal: list[0].address });
    else notify({ title: status === "blocked" ? "No agent needs you" : "No finished agent", level: "info", timeout: 2500 });
  }

  // The merge request for the branch of the pane you're in: from the feed, else `glab mr view --web`.
  openMr(cx) {
    const f = focused();
    const pane = panes().find((p) => p.terminal === f?.terminal);
    const branch = pane?.branch;
    const cwd = pane?.cwd ?? f?.cwd;
    const mrs = shared("cockpit.mrs");
    const hit = branch && [...(mrs?.mine ?? []), ...(mrs?.reviews ?? [])].find((m) => m.branch === branch);
    cx.spawn(async () => {
      try {
        if (hit) { await exec("open", [hit.url], { cwd: home(), timeout: 5000 }); return; }
        if (!cwd || (f?.terminal ?? "").includes("/")) throw new Error("no folder");
        const r = await exec("glab", ["mr", "view", "--web"], { cwd, timeout: 20000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
      } catch (e) {
        notify({ title: "No merge request found", body: branch ? `Nothing open for ${branch}` : "This pane isn't on a branch", level: "info", timeout: 3500 });
      }
    });
  }

  // Dev servers running: listeners on a TCP port started from a project folder, leaving out the
  // agents' own helpers. The same rule as the Ports pane. Read-only `lsof` and `ps`, every ten seconds
  // while the window is in front.
  countServers(cx) {
    if (!window()?.active || this.scanning) return;
    // The Ports pane, when shown, scans every 10 seconds and shares its count: no second `lsof`.
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body"), lower = find(root, "panel-lower");
    const portsShown = panel && !panel.hidden && (body?.active === "ports" || (lower && !lower.hidden && lower.active === "lower-ports"));
    if (portsShown) {
      const n = shared("cockpit.servers");
      if (typeof n === "number" && n !== this.servers) { this.servers = n; cx.notify(); }
      return;
    }
    this.scanning = true;
    cx.spawn(async (cx) => {
      let n = this.servers;
      try {
        const base = home();
        const sockets = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { cwd: base, timeout: 15000 });
        const found = new Map();
        let pid = null, cmd = "";
        for (const line of sockets.stdout.split("\n")) {
          const tag = line[0], rest = line.slice(1);
          if (tag === "p") pid = Number(rest);
          else if (tag === "c") cmd = rest;
          else if (tag === "n" && pid !== null) {
            const port = Number(rest.slice(rest.lastIndexOf(":") + 1));
            if (Number.isFinite(port)) found.set(`${pid}:${port}`, { pid, cmd });
          }
        }
        const pids = [...new Set([...found.values()].map((x) => x.pid))];
        if (!pids.length) n = 0;
        else {
          const [cwd, ps] = await Promise.all([
            exec("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { cwd: base, timeout: 15000 }),
            exec("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { cwd: base, timeout: 15000 }),
          ]);
          const folders = new Map(), commands = new Map();
          let at = null;
          for (const line of cwd.stdout.split("\n")) {
            if (line[0] === "p") at = Number(line.slice(1));
            else if (line[0] === "n" && at !== null) folders.set(at, line.slice(1));
          }
          for (const line of ps.stdout.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (m) commands.set(Number(m[1]), m[2]);
          }
          n = [...found.values()].filter((x) => {
            const dir = folders.get(x.pid) ?? "";
            const command = commands.get(x.pid) ?? x.cmd;
            const word = command.split(/\s+/)[0].split("/").pop();
            const tool = TOOLS.has(word) || TOOLS.has(x.cmd) || VERSION.test(x.cmd);
            return word === "plannotator" || x.cmd === "plannotator" || (dir.startsWith(`${base}/`) && !dir.startsWith(`${base}/Library`) && !tool);
          }).length;
        }
      } catch {}
      this.scanning = false;
      if (n !== this.servers) {
        this.servers = n;
        cx.notify();
      }
    });
  }

  // To-do tasks: read from the file the Tasks pane saves, so the count is right even before that pane has been opened.
  readTodo(cx) {
    if (!window()?.active) return;
    cx.spawn(async (cx) => {
      let n = this.todo;
      try {
        const text = await readTextFile(`${appHome()}/cockpit-tasks/tasks.json`);
        n = text ? JSON.parse(text).filter((x) => x.status === "todo").length : 0;
      } catch {}
      if (n !== this.todo) {
        this.todo = n;
        cx.notify();
      }
    });
  }

  // "\u23181" for tab 1, from the key actually bound to tab.select:1.
  shortcut(n) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "\u2318" : "Ctrl+", ctrl: mac ? "\u2303" : "Ctrl+", shift: mac ? "\u21e7" : "Shift+", alt: mac ? "\u2325" : "Alt+", option: mac ? "\u2325" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === `tab.select:${n}`);
    return b ? b.keys.split("-").map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
  }

  clearPanelDrag(cx) {
    const changed = this.panelDragged;
    this.panelPress = null;
    this.panelDrop = null;
    this.panelDragged = false;
    if (changed) cx.notify();
  }

  movePanel(from, target, after, ids) {
    const order = ids.filter(id => id !== from);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, from);
    this.panelOrder = order;
    localStorage.setItem("panel-order", JSON.stringify(order));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
      .when(Boolean(tip), el => el.tooltip(tip).accessibility_label(tip))
      .hover(s => s.bg(t.hover).text_color(t.foreground)).active(s => s.bg(t.selected))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      // tab.select:N counts only the tabs that aren't settled.
      const place = c.settled ? null : shown.slice(0, i + 1).filter(x => !x.settled).length;
      const key = place && place <= 9 ? this.shortcut(place) : null;
      const state = { working: "working", blocked: "needs you", done: "done" }[c.status];
      return h_flex().id(`tab-${c.id}`)
        .tooltip([name, c.zoomed ? "zoomed" : null, state, key].filter(Boolean).join(" · "))
        .accessibility_label([name, c.active ? "selected" : null, c.zoomed ? "zoomed" : null, state].filter(Boolean).join(", ")).h(30).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .cursor_pointer()
        .hover(s => s.bg(c.active ? t.raised : t.hover))
        .active(s => s.bg(t.selected))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(name))
        .when(c.zoomed, el => el.child(div().flex_none().h(16).px(4).flex().items_center().rounded(4).bg(t.accent + "26").text_size(10).font_medium().text_color(t.accent).child("Zoomed")))
        .when(Boolean(key), el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(key)))
        .when(c.status === "working", el => el.child(svg("mods/cockpit-workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).rounded(4).text_color(t.dim).cursor_pointer().tooltip("Close tab").accessibility_label(`Close ${name}`)
          .hover(s => s.text_color(t.foreground).bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/cockpit-pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body"), lowerStack = find(root, "panel-lower");
    const lowerOn = panel && !panel.hidden && lowerStack && !lowerStack.hidden ? lowerStack.active?.replace(/^lower-/, "") : null;
    this.feed.updateBadge();
    // Waiting for your review: others' open, non-draft MRs naming you that you haven't approved (from the feed).
    const mrs = shared("cockpit.mrs");
    const review = (mrs?.reviews ?? []).filter(m => !m.draft && !m.approvedByMe).length;
    const failedMine = (mrs?.mine ?? []).filter(m => m.pipeline === "failed" && !m.draft).length;
    // What the Inbox holds: agents that need you, and ones that finished while you were away.
    const waiting = agents().filter(a => a.status === "blocked" || a.status === "done");
    const blocked = waiting.filter(a => a.status === "blocked").length;
    const finished = waiting.length - blocked;
    const inboxColor = blocked ? t.blocked : t.done;
    // Annotations waiting in the space you're in; amber while some are queued for a busy agent.
    const annoAll = notesOf(shared(ANNOTATIONS));
    const annoHere = annoAll.filter((n) => !n.queued && n.source?.space === focused()?.space).length;
    const annoQueued = annoAll.filter((n) => n.queued).length;
    // label: text next to the icon; without it the button is icon-only and says what it is on hover.
    const panelButton = (id, label, icon, tip, badge) => {
      const on = panel && !panel.hidden && body?.active === id;
      const below = lowerOn === id;
      const canLower = LOWER.has(id);
      return h_flex().id(`panel-${id}`).relative().h(26).px(label ? 8 : 7).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on || below ? t.foreground : t.muted)
        .cursor_pointer().tooltip(`${tip ?? label}${canLower ? " · right-click: open below" : ""} · drag to reorder`)
        .accessibility_label(`${tip ?? label}${on ? ", open" : below ? ", open below" : ""}`)
        // Shown in the lower half: a short line under the icon.
        .when(below, el => el.child(div().absolute().bottom(1).left(8).w(10).h(2).rounded(1).bg(t.accent)))
        .when(canLower, el => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.toggleLower(id); }))
        .hover(s => s.bg(on ? t.selected : t.hover)).active(s => s.bg(t.selected))
        .when(this.panelDragged && this.panelPress?.id === id, el => el.opacity(0.5))
        .when(this.panelDragged && this.panelDrop?.id === id && this.panelPress?.id !== id
          && (ATTENTION.includes(id) === ATTENTION.includes(this.panelPress?.id)) && (TOOLS.includes(id) === TOOLS.includes(this.panelPress?.id)), el => el.child(
          div().absolute().top(3).bottom(3).w(2).bg(t.accent)
            .when(this.panelDrop.after, line => line.right(0))
            .when(!this.panelDrop.after, line => line.left(0))))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.panelPress = { id, x: e.position.x, y: e.position.y };
          this.panelDrop = null;
          this.panelDragged = false;
          this.skipPanelClick = false;
        })
        .on_mouse_move((e, cx) => {
          if (!this.panelPress) return;
          if (!this.panelDragged && Math.hypot(e.position.x - this.panelPress.x, e.position.y - this.panelPress.y) < 5) return;
          const after = e.local_position.x > e.bounds.width / 2;
          if (!this.panelDragged || this.panelDrop?.id !== id || this.panelDrop?.after !== after) {
            this.panelDragged = true;
            this.panelDrop = { id, after };
            cx.notify();
          }
        })
        .on_mouse_up("left", (_e, cx) => {
          cx.stop_propagation();
          this.skipPanelClick = this.panelDragged;
          // Buttons stay in their group, so a drop counts only next to one of the same group.
          const group = (x) => (ATTENTION.includes(x) ? "a" : TOOLS.includes(x) ? "t" : "m");
          if (this.panelDragged && this.panelPress?.id !== id && this.panelDrop?.id === id && group(this.panelPress.id) === group(id)) {
            this.movePanel(this.panelPress.id, id, this.panelDrop.after, orderedPanels.map(p => p[0]));
          }
          this.clearPanelDrag(cx);
        })
        .on_click(() => {
          if (this.skipPanelClick) return;
          this.showPanel(id, true);
        }).child(svg(icon).size(14))
        .when(Boolean(label), el => el.child(label))
        .when(Boolean(badge), el => el.child(div().h(16).min_w(16).px(4).flex().items_center().justify_center().rounded(8).bg(badge.color + "33").text_size(10.5).font_semibold().text_color(badge.color).child(String(badge.n))));
    };
    // Words next to the icons while there is room for them.
    const words = this.barWidth === null || this.barWidth >= 1100;
    const named = (text) => (words ? text : null);
    const panels = [
      ["home", named("Home"), "mods/cockpit-tabs/home.svg", "Home · what needs you now"],
      ["projects", named("Projects"), "mods/cockpit-tabs/projects.svg", "Projects · jump to or start a project"],
      ["talk", named("Agent talk"), "mods/cockpit-tabs/talk.svg", "Agent talk · which agents message which"],
      ["automations", named("Automations"), "mods/cockpit-tabs/automations.svg", "Automations · scheduled cron jobs"],
      ["review", named("Review"), "mods/cockpit-workspace-chrome/git-compare.svg", "Review changes in Hunk"],
      ["annotate", named("Annotations"), "mods/cockpit-tabs/annotate.svg", [annoHere ? `${annoHere} in this space` : null, annoQueued ? `${annoQueued} queued` : null].filter(Boolean).length ? `Annotations · ${[annoHere ? `${annoHere} in this space` : null, annoQueued ? `${annoQueued} queued` : null].filter(Boolean).join(", ")}` : "Annotations · notes on terminal text for agents",
        annoQueued ? { n: annoHere + annoQueued, color: t.working } : annoHere ? { n: annoHere, color: t.muted } : null],
      ["usage", named("Monitoring"), "mods/cockpit-tabs/chart.svg", "Monitoring · limits, CPU and memory"],
      ["ports", named("Ports"), "mods/cockpit-tabs/plug.svg", this.servers ? `Ports · ${this.servers} ${this.servers === 1 ? "server" : "servers"} running` : "Ports and servers", this.servers ? { n: this.servers, color: t.ansi2 } : null],
      ["tasks", named("Tasks"), "mods/cockpit-tabs/list-todo.svg", this.todo ? `Tasks · ${this.todo} to do` : "Tasks", this.todo ? { n: this.todo, color: t.muted } : null],
      ["inbox", named("Inbox"), "mods/cockpit-tabs/inbox.svg", waiting.length ? `Inbox · ${[blocked ? `${blocked} need you` : null, finished ? `${finished} done` : null].filter(Boolean).join(", ")}` : "Inbox · reply to agents", waiting.length ? { n: waiting.length, color: inboxColor } : null],
      ["mrs", named("MRs"), "mods/cockpit-tabs/git-pull-request.svg", [review ? `${review} to review` : null, failedMine ? `${failedMine} failed` : null].filter(Boolean).length ? `Merge requests · ${[review ? `${review} to review` : null, failedMine ? `${failedMine} failed` : null].filter(Boolean).join(", ")}` : "Merge requests",
        failedMine ? { n: failedMine + review, color: t.blocked } : review ? { n: review, color: t.accent } : null],
    ];
    const saved = [...new Set(this.panelOrder)].filter(id => panels.some(p => p[0] === id));
    // Panels new since the order was saved (Home) go first, where they'd be by default.
    const order = [...panels.map(p => p[0]).filter(id => !saved.includes(id)), ...saved];
    const orderedPanels = order.map(id => panels.find(p => p[0] === id));
    // Two groups keep a button: what needs you, then the tools you glance at. The rest sit behind the
    // Panels menu (and Ctrl+B p on the keyboard). Dragging reorders within a group.
    const ATTENTION = ["home", "inbox", "mrs", "tasks"], TOOLS = ["annotate", "ports", "usage", "talk"];
    const attention = orderedPanels.filter(p => ATTENTION.includes(p[0]));
    const tools = orderedPanels.filter(p => TOOLS.includes(p[0]));
    const menuPanels = orderedPanels.filter(p => !ATTENTION.includes(p[0]) && !TOOLS.includes(p[0]));
    const openHidden = panel && !panel.hidden ? menuPanels.find(p => p[0] === body?.active) : null;
    const menuBadge = !openHidden && menuPanels.some(p => p[4]);
    const divider = (id) => div().id(id).w(1).h(16).mx(5).flex_none().bg(t.border);
    const panelsMenu = h_flex().id("panels-menu").h(26).px(words ? 8 : 7).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(openHidden ? t.selected : t.chrome).text_color(openHidden ? t.foreground : t.muted)
      .cursor_pointer().tooltip(openHidden ? `${NAMES[openHidden[0]]} · more panels` : "More panels").accessibility_label("More panels")
      .hover(s => s.bg(openHidden ? t.selected : t.hover).text_color(t.foreground)).active(s => s.bg(t.selected))
      .on_mouse_down("left", stop)
      .on_click(() => openOverlay({
        mod: "cockpit-panel-menu", kind: "popup", width: 230, height: menuPanels.length * 31 + 48, at: "pointer",
        props: { items: menuPanels.map(([id, _label, icon, tip, badge]) => ({ id, label: NAMES[id] ?? id, icon, tip, badge: badge ?? null })), active: openHidden?.[0] ?? null },
      }))
      .child(svg(openHidden ? openHidden[2] : "mods/cockpit-tabs/panels.svg").size(14))
      .when(words, el => el.child(openHidden ? NAMES[openHidden[0]] : "Panels"))
      .child(div().text_size(9).text_color(t.dim).child("▾"))
      .when(menuBadge, el => el.child(div().size(6).rounded(3).bg(t.ansi2)));
    return h_flex().id("tab-bar").size_full().min_w(0).px(10).pl(lightsPadding)
      .on_size_change((size, cx) => {
        if (this.barWidth !== size.width) {
          this.barWidth = size.width;
          cx.notify();
        }
      }).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.clearPanelDrag(cx); })
      .on_mouse_down_out((_e, cx) => this.clearPanelDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.clearPanelDrag(cx); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        // The wheel over the tabs steps through them: one step per 40px of scrolling, so a trackpad
        // flick moves one or two tabs, not ten.
        .on_scroll_wheel(e => {
          this.wheel = (this.wheel ?? 0) + e.delta.y;
          if (Math.abs(this.wheel) < 40) return;
          run(this.wheel > 0 ? "tab.prev" : "tab.next");
          this.wheel = 0;
        })
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New tab or agent"))
      // A new tab running Neovim, in the folder of the terminal you are in.
      .child(h_flex().id("nvim-new").h(26).px(words ? 8 : 7).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .text_color(t.muted).cursor_pointer().tooltip("New tab with Neovim").accessibility_label("Open Neovim in a new tab")
        .hover(s => s.bg(t.hover).text_color(t.foreground)).active(s => s.bg(t.selected)).on_mouse_down("left", stop)
        .on_click((_e, cx) => this.openNeovim(cx))
        .child(svg("mods/cockpit-workspace-chrome/terminal.svg").size(14))
        .when(words, el => el.child("Neovim")))
      .child(divider("bar-div-1"))
      .children(attention.map(args => panelButton(...args)))
      .child(divider("bar-div-2"))
      .children(tools.map(args => panelButton(...args)))
      .child(panelsMenu)
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/cockpit-tabs/win-min.svg").size(16) : "−", () => run("window.minimize"), "Minimize"))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/cockpit-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize"), w.maximized ? "Restore" : "Maximize"))
        .child(button("close-window", w.platform === "windows" ? svg("mods/cockpit-tabs/win-close.svg").size(16) : svg("mods/cockpit-pane/close.svg").size(13), () => run("window.close"), "Close window")));
  }
}
