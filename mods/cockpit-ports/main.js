// Ports and servers: everything listening on a TCP port on this computer, with the folder it
// runs from and the space it belongs to. Yours (started from a project folder) come first;
// system listeners fold away. Runs `lsof` and `ps` (read-only) every ten seconds while the
// window is in front. The only write is `kill <pid>`, after a second click.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { exec, spaces, panes, home, theme, window, settings, layout, props, run, nextCommand, shared, setShared } from "herdr";
import { Nav, footer } from "./nav.js";

const ICONS = "mods/cockpit-workspace-chrome";
const OWN = "mods/cockpit-ports";
// Cards drawn at once: a view with ~120 rich cards runs out of render time. More on request.
const PAGE = 40;

// "[::1]:3000", "*:3000" and "127.0.0.1:3000" split at the last colon.
function parseName(name) {
  const i = name.lastIndexOf(":");
  const host = name.slice(0, i).replace(/^\[|\]$/g, "");
  return { host, port: Number(name.slice(i + 1)) };
}

// lsof -F output: a `p` line starts a process, `c` names it, each `n` line is one socket.
function parseListeners(out) {
  const found = new Map();
  let pid = null, cmd = "";
  for (const line of out.split("\n")) {
    const tag = line[0], rest = line.slice(1);
    if (tag === "p") pid = Number(rest);
    else if (tag === "c") cmd = rest;
    else if (tag === "n" && pid !== null) {
      const { host, port } = parseName(rest);
      if (!Number.isFinite(port)) continue;
      const key = `${pid}:${port}`;
      const known = found.get(key);
      // One process often listens on both IPv4 and IPv6: one row, the widest host wins.
      const exposed = host === "*" || host === "0.0.0.0" || host === "::";
      if (!known) found.set(key, { pid, cmd, port, exposed });
      else known.exposed ||= exposed;
    }
  }
  return [...found.values()];
}

// Long absolute paths in a command line shrink to their last part.
function shorten(command) {
  return command.split(/\s+/).map((tok) => (tok.startsWith("/") ? tok.split("/").pop() : tok)).join(" ");
}

// Agent helpers stay hidden; Plannotator is explicitly listed as a server.
const TOOLS = new Set(["claude", "codex", "hc", "herdr-core", "herdr-app"]);
const firstWord = (command) => command.split(/\s+/)[0].split("/").pop();
const isPlannotator = (p) => firstWord(p.command) === "plannotator" || p.cmd === "plannotator";
const isTool = (p) => TOOLS.has(firstWord(p.command)) || TOOLS.has(p.cmd) || /^\d+\.\d+\.\d+$/.test(p.cmd);

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


// "now", "5m", "3h", "2d": how old the last look is.
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Folders differ at their end, so a long one keeps its last two parts: "…/apps/herdr-cockpit".
function shortFolder(folder) {
  const parts = folder.split("/");
  return parts.length > 4 ? `…/${parts.slice(-2).join("/")}` : folder;
}

export default class Ports extends View {
  init(_props, cx) {
    this.list = null;
    this.error = null;
    this.loading = false;
    this.spinning = false; // a refresh the person asked for: only that one turns the refresh icon
    this.at = null;
    this.confirm = null; // a pid whose kill awaits a second click
    this.copied = null;
    this.showHidden = false;
    this.limit = PAGE;
    this.last = 0;
    // Keyboard: the server cards in screen order (rebuilt on each render), and where each sits.
    this.nav = new Nav(cx, { slot: props()?.slot ?? null });
    this.nav.watch(cx);
    this.scroll = ScrollHandle.new();
    this.items = [];
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.nav.wants(c, props()?.slot)) { this.nav.focus(); cx.notify(); }
      }
    });
    // Looks every ten seconds, but only while this pane is the one shown (and on the first look after it opens).
    cx.timer.every(2000, (cx) => {
      // The first look runs even with the window in the background, so the pane never sits on "Looking…".
      if (shown("ports") && !this.firstLook) { this.firstLook = true; this.refresh(cx); return; }
      if (window()?.active && shown("ports") && Date.now() - this.last > 10000) this.refresh(cx);
    });
  }

  // manual: the person asked (r or the button), so the refresh icon turns until the list is back.
  // The ten-second looks stay still: a turning icon every ten seconds is motion nobody asked for.
  refresh(cx, manual = false) {
    if (this.loading) {
      if (manual && !this.spinning) { this.spinning = true; cx.notify(); }
      return;
    }
    this.loading = true;
    this.last = Date.now();
    if (manual) { this.spinning = true; cx.notify(); }
    cx.spawn(async (cx) => {
      try {
        const sockets = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { cwd: home(), timeout: 15000 });
        const listeners = parseListeners(sockets.stdout);
        const pids = [...new Set(listeners.map((l) => l.pid))];
        const folders = new Map(), commands = new Map();
        if (pids.length) {
          const [cwd, ps] = await Promise.all([
            exec("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { cwd: home(), timeout: 15000 }),
            exec("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { cwd: home(), timeout: 15000 }),
          ]);
          let pid = null;
          for (const line of cwd.stdout.split("\n")) {
            if (line[0] === "p") pid = Number(line.slice(1));
            else if (line[0] === "n" && pid !== null) folders.set(pid, line.slice(1));
          }
          for (const line of ps.stdout.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (m) commands.set(Number(m[1]), m[2]);
          }
        }
        this.list = listeners
          .map((l) => {
            const command = commands.get(l.pid) ?? l.cmd;
            // Claude's process is named after its version: call it by what it runs.
            return { ...l, cwd: folders.get(l.pid) ?? "", command, cmd: /^\d+\.\d+\.\d+$/.test(l.cmd) ? firstWord(command) : l.cmd };
          })
          .sort((a, b) => a.port - b.port);
        this.at = Date.now();
        this.error = null;
        // The tab bar's Ports counter: while this pane scans, the tab bar skips its own `lsof`.
        const base = home();
        const n = this.list.filter((p) => !isTool(p) && (isPlannotator(p) || (p.cwd.startsWith(`${base}/`) && !p.cwd.startsWith(`${base}/Library`)))).length;
        if (shared("cockpit.servers") !== n) setShared("cockpit.servers", n);
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.loading = false;
      this.spinning = false;
      cx.notify();
    });
  }

  kill(proc, cx) {
    if (this.confirm !== proc.pid) {
      this.confirm = proc.pid;
      cx.notify();
      cx.timer.after(3000, (cx) => {
        if (this.confirm === proc.pid) this.confirm = null;
        cx.notify();
      });
      return;
    }
    this.confirm = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("kill", [String(proc.pid)], { cwd: home(), timeout: 10000 });
        if (r.code !== 0) throw new Error((r.stderr || "kill failed").trim().split("\n")[0]);
        this.killNote = null;
      } catch (e) {
        this.killNote = `Couldn't stop ${proc.cmd} (pid ${proc.pid}): ${String(e.message ?? e)}`;
        cx.timer.after(8000, (cx) => { this.killNote = null; cx.notify(); });
      }
      this.loading = false;
      // Give it a moment to exit before looking again.
      cx.timer.after(700, (cx) => this.refresh(cx));
    });
  }

  onKey(e, cx) {
    const it = () => this.items[this.nav.sel];
    const used = this.nav.key(e, this.items.length, {
      enter: () => { const x = it(); if (x) cx.open_url(x.url); },
      o: () => { const x = it(); if (x) cx.open_url(x.url); },
      yy: () => { const x = it(); if (x) this.copy(x.url, `${x.proc.pid}-${x.proc.port}`, cx); },
      // dd is deliberate, so it skips the second-click confirm; only your own servers stop.
      dd: () => { const x = it(); if (x?.canStop) { this.confirm = x.proc.pid; this.kill(x.proc, cx); } },
      s: () => { const w = it()?.where; if (w) { run("space.select", { id: w.space }); run("tab.select", { id: w.tab }); } },
      H: () => { this.showHidden = !this.showHidden; this.limit = PAGE; },
      r: () => this.refresh(cx, true),
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  copy(text, key, cx) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === key) this.copied = null;
      cx.notify();
    });
  }

  // A quiet bordered button; `icon` puts a glyph before the label (or alone, with `tip` saying what it does).
  // tone: "danger" (red, a confirm), "ok" (green, just done) or none.
  button(t, id, label, action, { icon = null, tip = null, tone = null } = {}) {
    const color = tone === "danger" ? t.blocked : tone === "ok" ? t.ansi2 : null;
    return h_flex().id(id).h(22).px(label ? 7 : 0).when(!label, (el) => el.w(22).justify_center()).gap(5).items_center().flex_none()
      .rounded(5).border(1).text_size(11.5)
      .border_color(color ? color + "66" : t.border).bg(color ? color + "1a" : t.chrome).text_color(color ?? t.muted)
      .accessibility_label(tip ?? label).when(Boolean(tip), (el) => el.tooltip(tip))
      .cursor_pointer()
      .hover((s) => s.bg(color ? color + "26" : t.hover).text_color(color ?? t.foreground))
      .active((s) => s.bg(color ? color + "33" : t.selected))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .when(Boolean(icon), (el) => el.child(svg(icon).size(12).flex_none()))
      .when(Boolean(label), (el) => el.child(label));
  }

  // The space (and named tab) whose terminal sits in or around the folder the process runs from.
  place(proc, ctx) {
    if (!proc.cwd) return null;
    let best = null, score = 0;
    for (const p of ctx.panes) {
      if (!p.cwd) continue;
      const near = proc.cwd === p.cwd || proc.cwd.startsWith(`${p.cwd}/`) || p.cwd.startsWith(`${proc.cwd}/`);
      const length = Math.min(p.cwd.length, proc.cwd.length);
      if (near && length > score) { best = p; score = length; }
    }
    const where = best && ctx.tabs.get(best.tab);
    if (!where) return null;
    return { label: where.tab.named ? `${where.space.name} / ${where.tab.name}` : where.space.name, space: where.space.id, tab: where.tab.id };
  }

  // One listener: port and name, where it runs, the command, then what you can do with it.
  // canStop: only your own servers get a stop button. Stopping an agent's helper would end the agent.
  row(t, proc, ctx, where, canStop = false, on = false) {
    const key = `${proc.pid}-${proc.port}`;
    const url = `http://localhost:${proc.port}`;
    const confirming = this.confirm === proc.pid;
    const copied = this.copied === key;
    const folder = proc.cwd.startsWith(`${ctx.home}/`) ? `~${proc.cwd.slice(ctx.home.length)}` : proc.cwd;
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id(`port-${key}`).w_full().flex_none().px(10).py(8).gap(6).rounded(8).border(1)
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome)
      // What it is: the port (never shortened, ports get compared) and the program.
      .child(h_flex().gap(8).items_center().h(20)
        .child(div().flex_none().font_family(mono).text_size(13.5).font_semibold().text_color(canStop ? t.foreground : t.muted).child(String(proc.port)))
        .child(div().id(`port-name-${key}`).flex_1().min_w(0).truncate().font_medium().text_size(12.5)
          .text_color(canStop ? t.foreground : t.muted).tooltip(proc.command).child(proc.cmd))
        .when(proc.exposed, (el) => el.child(div().id(`port-exposed-${key}`).flex_none().h(16).px(5).flex().items_center().rounded(4)
          .bg(t.ansi3 + "26").text_size(10.5).font_medium().text_color(t.ansi3)
          .tooltip("Listening on all network interfaces, so other machines on your network can reach it").child("Network"))))
      // Where it runs, and its process id.
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(Boolean(folder) && folder !== "/"
          ? h_flex().id(`port-dir-${key}`).flex_1().min_w(0).gap(5).items_center().tooltip(proc.cwd)
            .child(svg(`${ICONS}/folder.svg`).size(12).flex_none())
            .child(div().min_w(0).truncate().child(shortFolder(folder)))
          : div().flex_1())
        .child(div().flex_none().font_family(mono).text_size(10.5).child(`pid ${proc.pid}`)))
      // The command, as code.
      .child(div().id(`port-cmd-${key}`).h(22).px(7).flex().items_center().rounded(5).bg(t.background).tooltip(proc.command)
        .child(div().min_w(0).truncate().font_family(mono).text_size(10.5).text_color(t.muted).child(shorten(proc.command))))
      // What you can do with it.
      .child(h_flex().gap(6).items_center().h(22)
        .when(Boolean(where), (el) => el.child(h_flex().id(`port-where-${key}`).h(22).min_w(0).max_w(160).px(7).gap(5).items_center()
          .rounded(5).border(1).border_color(t.border).bg(t.chrome).text_size(11.5).text_color(t.muted)
          .cursor_pointer().tooltip(`Go to ${where.label} (s)`).accessibility_label(`Go to ${where.label}`)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => { cx.stop_propagation(); run("space.select", { id: where.space }); run("tab.select", { id: where.tab }); })
          .child(svg(`${ICONS}/layers.svg`).size(12).flex_none())
          .child(div().min_w(0).truncate().child(where.label))))
        .child(div().flex_1())
        .child(this.button(t, `port-copy-${key}`, null, (cx) => this.copy(url, key, cx), {
          icon: copied ? `${ICONS}/check.svg` : `${OWN}/copy.svg`, tone: copied ? "ok" : null,
          tip: copied ? "Copied" : `Copy ${url} (yy)` }))
        .when(canStop, (el) => el.child(this.button(t, `port-kill-${key}`, confirming ? "Stop?" : null, (cx) => this.kill(proc, cx), {
          icon: `${OWN}/power.svg`, tone: confirming ? "danger" : null,
          tip: confirming ? `Click again to stop ${proc.cmd} on port ${proc.port}` : `Stop ${proc.cmd} (pid ${proc.pid}) (dd)` })))
        .child(this.button(t, `port-open-${key}`, "Open", (cx) => cx.open_url(url), { icon: `${OWN}/external.svg`, tip: `Open ${url} (o)` })));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const all = this.list ?? [];
    const base = home();
    // Yours: running from a project folder. The rest is system software.
    const yours = all.filter((p) => isPlannotator(p) || (p.cwd.startsWith(`${base}/`) && !p.cwd.startsWith(`${base}/Library`)));
    const mine = yours.filter((p) => !isTool(p));
    const tools = yours.filter(isTool);
    const other = all.filter((p) => !yours.includes(p));
    const hidden = tools.length + other.length;
    const exposed = mine.filter((p) => p.exposed).length;
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, { space: s, tab }])));
    const ctx = { home: base, panes: panes().filter((p) => p.terminal && p.cwd), tabs };
    const kbd = this.nav.focused();
    const items = [];
    const kids = [];
    // One card per listener; `section` is its place among the scroll area's children. At most
    // `limit` cards are drawn: a view with ~120 rich cards runs out of render time.
    let room = this.limit;
    const cards = (list, canStop) => {
      for (const p of list.slice(0, Math.max(0, room))) {
        const url = `http://localhost:${p.port}`;
        const where = this.place(p, ctx);
        items.push({ proc: p, url, canStop, where, section: kids.length });
        kids.push(this.row(t, p, ctx, where, canStop, kbd && this.nav.sel === items.length - 1));
      }
      const left = list.length - Math.max(0, room);
      room -= list.length;
      if (left > 0) kids.push(h_flex().py(4).justify_center()
        .child(this.button(t, `ports-more-${canStop ? "mine" : "hidden"}`, `Show ${Math.min(PAGE, left)} more of ${left}`,
          (cx) => { this.limit += PAGE; cx.notify(); })));
    };
    const note = (text) => div().px(10).py(8).rounded(6).border(1).border_color(t.blocked + "55").bg(t.blocked + "14")
      .text_size(12).text_color(t.blocked).whitespace_normal().child(text);
    if (this.killNote) kids.push(note(this.killNote));
    if (this.error) kids.push(note(this.error));
    if (!this.list && !this.error) kids.push(div().px(4).py(8).text_color(t.dim).child("Looking for servers…"));
    if (this.list && !mine.length) kids.push(v_flex().py(28).px(12).gap(8).items_center()
      .child(svg(`${ICONS}/server.svg`).size(20).text_color(t.dim))
      .child(div().font_medium().child("No servers running"))
      .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal()
        .child("Dev servers you start from a project folder show up here.")));
    cards(mine, true);
    // Everything that isn't your own server stays out of sight behind one quiet heading.
    if (hidden > 0) kids.push(h_flex().id("ports-hidden").h(26).px(4).mt(4).gap(6).items_center().flex_none().rounded(6)
      .text_size(11).font_medium().text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .tooltip(this.showHidden ? "Hide (H)" : "Show (H)")
      .accessibility_label(`${this.showHidden ? "Hide" : "Show"} ${hidden} agent and system ${hidden === 1 ? "listener" : "listeners"}`)
      .on_click((_e, cx) => {
        this.showHidden = !this.showHidden;
        this.limit = PAGE;
        cx.notify();
      })
      .child(svg(`${ICONS}/chevron-${this.showHidden ? "down" : "right"}.svg`).size(11).flex_none())
      .child(div().child("Agent and system listeners"))
      .child(div().child(String(hidden))));
    if (this.showHidden) cards([...tools, ...other], false);
    this.items = items;
    this.nav.clamp(items.length);
    return v_flex().id("ports-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Ports"))
        .when(Boolean(this.list), (el) => el.child(div().text_size(11.5).font_medium().text_color(mine.length ? t.done : t.dim)
          .child(`${mine.length} ${mine.length === 1 ? "server" : "servers"}`)))
        .when(exposed > 0, (el) => el.child(div().text_size(11.5).font_medium().text_color(t.ansi3).child(`${exposed} on network`)))
        .child(div().flex_1())
        .when(Boolean(this.at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - this.at))))
        .child(div().id("ports-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .tooltip("Refresh (r)").accessibility_label("Refresh ports")
          .when(!this.spinning, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => this.refresh(cx, true)))
          .child(this.spinning ? svg(`${ICONS}/spinner.svg`).size(13).text_color(t.muted).spin(900) : svg(`${OWN}/refresh.svg`).size(13))))
      .child(v_flex().id("ports-scroll").flex_1().min_h(0).px(10).pb(12).gap(6).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(kids))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ o", "open"], ["yy", "copy URL"], ["dd", "stop"], ["s", "go to space"], ["H", "hidden listeners"], ["r", "refresh"]], this.nav.help)));
  }
}
