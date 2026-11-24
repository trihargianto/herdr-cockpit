// The right-side activity rail. The tab bar owns the panel commands so clicks and shortcuts
// operate the same stacks.

import { View, div, svg } from "gpui-kit";
import { v_flex, ScrollHandle } from "gpui-base";
import { agents, appHome, checking, exec, focused, home, layout, readTextFile, run, setShared, shared, theme, window } from "herdr";

const ORDER_KEY = "cockpit.panel-order";
const TOOLS = new Set(["claude", "codex", "hc", "herdr-core", "herdr-app"]);
const VERSION = /^\d+\.\d+\.\d+$/;
const PANELS = [
  ["home", "Home", "home"],
  ["inbox", "Inbox", "inbox"],
  ["mrs", "Merge requests", "git-pull-request"],
  ["tasks", "Tasks", "list-todo"],
  ["re view", "Review", null],
  ["projects", "Projects", "projects"],
  ["annotate", "Annotations", "annotate"],
  ["talk", "Agent talk", "talk"],
  ["ports", "Ports", "plug"],
  ["usage", "Monitoring", "chart"],
  ["automations", "Automations", "automations"],
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class PanelRail extends View {
  init(_props, cx) {
    this.scroll = ScrollHandle.new();
    this.focus = new Map(PANELS.map(([id]) => [id, cx.focus_handle()]));
    this.todo = 0;
    this.servers = 0;
    this.press = null;
    this.drop = null;
    this.skipClick = false;
    if (checking()) return;
    this.readTodo(cx);
    this.countServers(cx);
    cx.timer.every(5000, (cx) => this.readTodo(cx));
    cx.timer.every(30000, (cx) => this.countServers(cx));
  }

  // Dev servers running: listeners on a TCP port started from a project folder, leaving out the
  // agents' own helpers. The same rule as the Ports pane. Read-only `lsof` and `ps`, every 30 seconds
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

  clearDrag(cx) {
    const dragging = Boolean(this.drop);
    this.press = null;
    this.drop = null;
    if (dragging) cx.notify();
  }

  reorder(ids, from, to, after) {
    // Keep disabled panels in the saved order so they recover their place when re-enabled.
    const all = this.orderedPanels().map(([id]) => id).filter((id) => id !== from);
    const at = all.indexOf(to);
    if (at < 0 || !ids.includes(from)) return;
    all.splice(at + (after ? 1 : 0), 0, from);
    setShared(ORDER_KEY, all);
  }

  orderedPanels() {
    const stored = shared(ORDER_KEY);
    const order = Array.isArray(stored) ? [...new Set(stored)] : [];
    const byId = new Map(PANELS.map((item) => [item[0], item]));
    return [...PANELS.filter(([id]) => !order.includes(id)), ...order.map((id) => byId.get(id)).filter(Boolean)];
  }

  counters(t) {
    const { reviews = [], mine = [] } = shared("cockpit.mrs") ?? {};
    const review = reviews.filter((m) => !m.draft && !m.approvedByMe).length;
    const failed = mine.filter((m) => !m.draft && m.pipeline === "failed").length;
    const live = agents();
    const blocked = live.filter((a) => a.status === "blocked").length;
    const finished = live.filter((a) => a.status === "done").length;
    const savedNotes = shared("cockpit.annotations")?.notes;
    const notes = Array.isArray(savedNotes) ? savedNotes : [];
    const space = focused()?.space;
    const here = notes.filter((note) => !note.queued && note.source?.space === space).length;
    const queued = notes.filter((note) => note.queued).length;
    return {
      inbox: { count: blocked + finished, color: blocked ? t.blocked : t.accent,
        detail: [blocked && `${blocked} need you`, finished && `${finished} finished`].filter(Boolean).join(", ") },
      mrs: { count: review + failed, color: failed ? t.blocked : t.accent,
        detail: [review && `${review} to review`, failed && `${failed} failed`].filter(Boolean).join(", ") },
      tasks: { count: this.todo, detail: `${this.todo} to do` },
      ports: { count: this.servers, detail: `${this.servers} running` },
      annotate: { count: here + queued, detail: [here && `${here} in this space`, queued && `${queued} queued`].filter(Boolean).join(", ") },
    };
  }

  render() {
    const t = theme();
    const root = layout();
    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const lower = find(root, "panel-lower");
    const active = panel && !panel.hidden ? body?.active : null;
    const below = panel && !panel.hidden && lower && !lower.hidden ? lower.active : null;
    const off = shared("cockpit.prefs")?.off;
    const available = body && new Set(body.children.map((child) => child.id));
    const enabled = this.orderedPanels().filter(([id]) =>
      (!available || available.has(id)) && !(Array.isArray(off) && off.includes(id)));
    const ids = enabled.map(([id]) => id);
    const counters = this.counters(t);

    return v_flex().id("panel-rail").size_full().min_h(0).rounded(9).border(1).border_color(t.border).bg(t.chrome)
      .role("tab_list").accessibility_label("Right sidebar panels")
      .on_mouse_up("left", (_e, cx) => { this.skipClick = Boolean(this.drop); this.clearDrag(cx); })
      .on_mouse_down_out((_e, cx) => this.clearDrag(cx))
      .on_hover((inside, cx) => { if (!inside) this.clearDrag(cx); })
      .child(v_flex().id("panel-rail-scroll").flex_1().min_h(0).px(3).py(5).gap(3).items_center()
        .overflow_y_scroll().track_scroll(this.scroll)
        .children(enabled.map(([id, label, icon], index) => {
          const on = id === active;
          const lowerId = `lower-${id}`;
          const canOpenBelow = lower?.children.some((child) => child.id === lowerId);
          const openBelow = lowerId === below;
          const counter = counters[id];
          const detail = counter?.count ? `${label} · ${counter.detail}` : label;
          const target = this.drop?.id === id && this.press?.id !== id ? this.drop : null;
          const iconPath = icon ? `mods/cockpit-tabs/${icon}.svg` : "mods/cockpit-workspace-chrome/git-compare.svg";
          return div().id(`rail-${id}`).role("tab").aria_selected(on)
            .track_focus(this.focus.get(id)).tab_stop(true)
            .accessibility_label(openBelow ? `${detail}, open below` : detail)
            .tooltip([detail, on ? "Click to close" : null, canOpenBelow ? "Right-click to toggle below" : null].filter(Boolean).join(" · "))
            .size(36).flex_none().relative().flex().items_center().justify_center().rounded(7).cursor_pointer()
            .bg(on ? t.selected : t.chrome).text_color(on || openBelow ? t.foreground : t.muted)
            .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
            .active((s) => s.bg(t.selected)).focus((s) => s.text_color(t.foreground))
            .on_key_down((e, cx) => {
              if (e.key === "enter" || e.key === "space") run(`cockpit-tabs.toggle-${id}`);
              else if (e.key === "up" || e.key === "down") {
                const next = (index + (e.key === "up" ? -1 : 1) + ids.length) % ids.length;
                this.focus.get(ids[next]).focus();
                this.scroll.scroll_to_item(next);
              } else return;
              cx.stop_propagation();
              cx.notify();
            })
            .when(canOpenBelow, (el) => el.on_mouse_down("right", (_e, cx) => {
              cx.stop_propagation();
              run(`cockpit-tabs.lower-${id}`);
            }))
            .on_mouse_down("left", (e) => { this.press = { id, y: e.position.y }; this.drop = null; this.skipClick = false; })
            .on_mouse_move((e, cx) => {
              if (!this.press || (!this.drop && Math.abs(e.position.y - this.press.y) < 5)) return;
              const after = e.local_position.y > e.bounds.height / 2;
              if (this.drop?.id === id && this.drop.after === after) return;
              this.drop = { id, after };
              cx.notify();
            })
            .on_mouse_up("left", (_e, cx) => {
              this.skipClick = Boolean(this.drop);
              if (target && this.press) this.reorder(ids, this.press.id, id, target.after);
              this.clearDrag(cx);
              cx.stop_propagation();
            })
            .on_click(() => { if (!this.skipClick) run(`cockpit-tabs.toggle-${id}`); })
            .when(this.drop && this.press?.id === id, (el) => el.opacity(0.5))
            .child(svg(iconPath).size(19))
            .when(on, (el) => el.child(div().absolute().right(0).top(10).bottom(10).w(2).rounded(1).bg(t.accent)))
            .when(openBelow, (el) => el.child(div().absolute().bottom(2).left(13).w(10).h(2).rounded(1).bg(t.accent)))
            .when(Boolean(target), (el) => el.child(div().absolute().left(2).right(2).h(2).rounded(1).bg(t.accent)
              .when(target.after, (line) => line.bottom(0)).when(!target.after, (line) => line.top(0))))
            .when(Boolean(counter?.count), (el) => el.child(div().absolute().right(1).bottom(1).h(14).min_w(14).px(3)
              .flex().items_center().justify_center().rounded(7).bg(counter.color ?? t.accent).text_color(t.accent_foreground)
              .text_size(9).font_semibold().child(counter.count > 99 ? "99+" : String(counter.count))));
        })));
  }
}
