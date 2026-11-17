import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, layout, settings, keys, focused, terminals, exec, readTextFile, appHome, home, nextCommand, shared, setShared, notify } from "herdr";
import { Feed } from "./feed.js";

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
// The mod behind each panel, for handing it the keyboard ("studio-inbox.focus").
const MODS = { home: "studio-home", projects: "studio-projects", talk: "studio-talk", automations: "studio-automations", review: "studio-review", usage: "studio-usage", ports: "studio-ports", tasks: "studio-tasks", inbox: "studio-inbox", mrs: "studio-mrs" };
const NAMES = { home: "Home", projects: "Projects", talk: "Agent talk", automations: "Automations", review: "Review", usage: "Monitoring", ports: "Ports", tasks: "Tasks", inbox: "Inbox", mrs: "Merge requests" };

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
    // Counter for the Tasks button. Merge requests come from the feed (shared "studio.mrs").
    this.todo = 0;
    this.servers = 0;
    this.feed = new Feed();
    this.feed.start(cx);
    // Commands from keys, the leader, toasts and other mods ("studio-tabs.neovim", "studio-tabs.show-home").
    // The tab bar is always on screen, so a command sent here always arrives.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
      }
    });
    this.readTodo(cx);
    this.countServers(cx);
    cx.timer.every(15000, (cx) => this.countServers(cx));
    cx.timer.every(5000, (cx) => this.readTodo(cx));
  }

  command(c, cx) {
    if (c === "neovim") this.openNeovim(cx);
    else if (c === "refresh") this.feed.refresh(cx);
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
      const quiet = !shared("studio.quiet");
      setShared("studio.quiet", quiet);
      notify({ title: quiet ? "Quiet mode on" : "Alerts on", body: quiet ? "MR and pipeline alerts are paused. The Dock badge still counts." : "MR and pipeline alerts are back.", level: "info", timeout: 3000 });
    } else if (c === "go-blocked") this.goAgent("blocked");
    else if (c === "go-done") this.goAgent("done");
    else if (c === "open-mr") this.openMr(cx);
    // Commands reach shown copies only: give the Tasks pane a moment to be on screen first.
    else if (c === "new-task") { this.showPanel("tasks"); cx.timer.after(120, () => run("studio-tasks.quick")); }
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
    const mrs = shared("studio.mrs");
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
        const text = await readTextFile(`${appHome()}/studio-tasks/tasks.json`);
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
        .when(c.status === "working", el => el.child(svg("mods/studio-workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).rounded(4).text_color(t.dim).cursor_pointer().tooltip("Close tab").accessibility_label(`Close ${name}`)
          .hover(s => s.text_color(t.foreground).bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/studio-pane/close.svg").size(12))));
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
    const mrs = shared("studio.mrs");
    const review = (mrs?.reviews ?? []).filter(m => !m.draft && !m.approvedByMe).length;
    const failedMine = (mrs?.mine ?? []).filter(m => m.pipeline === "failed" && !m.draft).length;
    // What the Inbox holds: agents that need you, and ones that finished while you were away.
    const waiting = agents().filter(a => a.status === "blocked" || a.status === "done");
    const blocked = waiting.filter(a => a.status === "blocked").length;
    const finished = waiting.length - blocked;
    const inboxColor = blocked ? t.blocked : t.done;
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
      ["home", named("Home"), "mods/studio-tabs/home.svg", "Home · what needs you now"],
      ["projects", named("Projects"), "mods/studio-tabs/projects.svg", "Projects · jump to or start a project"],
      ["talk", named("Agent talk"), "mods/studio-tabs/talk.svg", "Agent talk · which agents message which"],
      ["automations", named("Automations"), "mods/studio-tabs/automations.svg", "Automations · scheduled cron jobs"],
      ["review", named("Review"), "mods/studio-workspace-chrome/git-compare.svg", "Review changes in Hunk"],
      ["usage", named("Monitoring"), "mods/studio-tabs/chart.svg", "Monitoring · limits, CPU and memory"],
      ["ports", named("Ports"), "mods/studio-tabs/plug.svg", this.servers ? `Ports · ${this.servers} ${this.servers === 1 ? "server" : "servers"} running` : "Ports and servers", this.servers ? { n: this.servers, color: t.ansi2 } : null],
      ["tasks", named("Tasks"), "mods/studio-tabs/list-todo.svg", this.todo ? `Tasks · ${this.todo} to do` : "Tasks", this.todo ? { n: this.todo, color: t.muted } : null],
      ["inbox", named("Inbox"), "mods/studio-tabs/inbox.svg", waiting.length ? `Inbox · ${[blocked ? `${blocked} need you` : null, finished ? `${finished} done` : null].filter(Boolean).join(", ")}` : "Inbox · reply to agents", waiting.length ? { n: waiting.length, color: inboxColor } : null],
      ["mrs", named("MRs"), "mods/studio-tabs/git-pull-request.svg", [review ? `${review} to review` : null, failedMine ? `${failedMine} failed` : null].filter(Boolean).length ? `Merge requests · ${[review ? `${review} to review` : null, failedMine ? `${failedMine} failed` : null].filter(Boolean).join(", ")}` : "Merge requests",
        failedMine ? { n: failedMine + review, color: t.blocked } : review ? { n: review, color: t.accent } : null],
    ];
    const saved = [...new Set(this.panelOrder)].filter(id => panels.some(p => p[0] === id));
    // Panels new since the order was saved (Home) go first, where they'd be by default.
    const order = [...panels.map(p => p[0]).filter(id => !saved.includes(id)), ...saved];
    const orderedPanels = order.map(id => panels.find(p => p[0] === id));
    // Two groups keep a button: what needs you, then the tools you glance at. The rest sit behind the
    // Panels menu (and Ctrl+B p on the keyboard). Dragging reorders within a group.
    const ATTENTION = ["home", "inbox", "mrs", "tasks"], TOOLS = ["ports", "usage", "talk"];
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
        mod: "studio-panel-menu", kind: "popup", width: 230, height: menuPanels.length * 31 + 48, at: "pointer",
        props: { items: menuPanels.map(([id, _label, icon, tip, badge]) => ({ id, label: NAMES[id] ?? id, icon, tip, badge: badge ?? null })), active: openHidden?.[0] ?? null },
      }))
      .child(svg(openHidden ? openHidden[2] : "mods/studio-tabs/panels.svg").size(14))
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
        .child(svg("mods/studio-workspace-chrome/terminal.svg").size(14))
        .when(words, el => el.child("Neovim")))
      .child(divider("bar-div-1"))
      .children(attention.map(args => panelButton(...args)))
      .child(divider("bar-div-2"))
      .children(tools.map(args => panelButton(...args)))
      .child(panelsMenu)
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/studio-tabs/win-min.svg").size(16) : "−", () => run("window.minimize"), "Minimize"))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/studio-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize"), w.maximized ? "Restore" : "Maximize"))
        .child(button("close-window", w.platform === "windows" ? svg("mods/studio-tabs/win-close.svg").size(16) : svg("mods/studio-pane/close.svg").size(13), () => run("window.close"), "Close window")));
  }
}
