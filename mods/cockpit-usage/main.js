// Monitoring: the numbers you glance at, not a report. How full each agent's context is, and how much
// of the 5-hour and weekly limits is used, for Claude and for Codex.
// They are read from the status lines the agents already draw on their own screens
// (`hc read`, read-only, one terminal at a time), so they match what you see there.
// Refreshes every minute while the window is in front. CPU and memory per space and pane
// come from one `ps` every few seconds (a pane's shell and everything it started).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, hc, exec, home, machines, panes, spaces, theme, window, settings, layout, props, run, nextCommand } from "herdr";
import { Nav, footer } from "./nav.js";

const ICONS = "mods/cockpit-workspace-chrome";
const BARS = "[█▓▒░]";

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function resetIn(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// CPU and memory take the theme's cyan and magenta: apart from each other in the common kinds of colour
// blindness, and apart from the green, amber and red that say how full a limit is.
// Cards a list draws at first, and how many "Show more" adds.
const MORE = 40;

// Okabe-Ito sky blue and orange: told apart with any colour vision, in light and dark themes alike.
// Fixed on purpose (the user's choice) rather than taken from the theme.
const CPU_COLOR = "#56B4E9", MEM_COLOR = "#E69F00";
const cpuColor = (_t) => CPU_COLOR, memColor = (_t) => MEM_COLOR;
// Numbers that change sit in the terminal font, so their digits keep one width as they update.
const MONO = () => settings().font_family ?? "JetBrains Mono";

const CTX_ROW = 40, CTX_GAP = 2, CTX_PAD = 4, CTX_SHOWN = 3; // three context rows fit the scroll view
const CARD = 86, CARD2 = 138, GAP = 8; // a card's fixed height; two of them fill a section's scroll view

const mem = (kb) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`);
const cpu = (v) => `${v >= 100 ? Math.round(v) : v.toFixed(1)}%`;

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// One agent's screen to numbers. Claude's status line reads
//   Context ████░░░░░░ 42% │ Usage █░░░░░░░░░ 9% (resets in 3h 21m) | Weekly ██████████ 98% (resets in 4h 51m)
// and Codex's footer
//   … Context 11% used · 5h 23% left · weekly 82% left     (and "5h limit: 23% left · resets at 20:05")
// The last matching line wins: older ones are scrollback. Limits become "used" percentages.
function parse(text) {
  const lines = text.replace(ANSI, "").split("\n");
  const out = {};
  const claude = new RegExp(`Context\\s+${BARS}+\\s*(\\d+)%`);
  const usage = new RegExp(`Usage\\s+${BARS}+\\s*(\\d+)%(?:\\s*\\(resets in ([^)]+)\\))?`);
  const weekly = new RegExp(`Weekly\\s+${BARS}+\\s*(\\d+)%(?:\\s*\\(resets in ([^)]+)\\))?`);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const c = l.match(claude);
    if (c) {
      out.kind = "claude";
      out.context = Number(c[1]);
      const u = l.match(usage), w = l.match(weekly);
      if (u) { out.five = Number(u[1]); out.fiveReset = u[2] ? `in ${u[2]}` : null; }
      if (w) { out.week = Number(w[1]); out.weekReset = w[2] ? `in ${w[2]}` : null; }
      return out;
    }
    const x = l.match(/Context (\d+)% used(?:\s*·\s*5h (\d+)% left)?(?:\s*·\s*weekly (\d+)% left)?/);
    if (x) {
      out.kind = "codex";
      out.context = Number(x[1]);
      if (x[2] != null) out.five = 100 - Number(x[2]);
      if (x[3] != null) out.week = 100 - Number(x[3]);
      // The warning line above the footer carries when the 5-hour window resets.
      for (const m of lines) {
        const r = m.match(/5h limit: (\d+)% left(?: · resets at ([0-9:]+))?/);
        if (r) { if (out.five == null) out.five = 100 - Number(r[1]); if (r[2]) out.fiveReset = `at ${r[2]}`; }
      }
      return out;
    }
  }
  return null;
}

// "in 3h 21m", "in 4d 2h" or "at 20:05" to a moment in time, so a saved reading can keep counting down.
function resetMoment(text, now) {
  if (!text) return null;
  const at = text.match(/^at (\d{1,2}):(\d{2})$/);
  if (at) {
    const d = new Date(now);
    d.setHours(Number(at[1]), Number(at[2]), 0, 0);
    return d.getTime() <= now ? d.getTime() + 86400000 : d.getTime();
  }
  const get = (u) => Number(text.match(new RegExp(`(\\d+)\\s*${u}`))?.[1] ?? 0);
  const ms = ((get("d") * 24 + get("h")) * 60 + get("m")) * 60000;
  return ms ? now + ms : null;
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

export default class Usage extends View {
  init(_props, cx) {
    this.data = load("limits", null); // last good reading, shown at once on open
    // Each agent's account limits, kept after its sessions close: { five|week: { pct, resetAt, readAt } }.
    this.acct = load("account-limits", {});
    this.loading = false;
    this.last = 0;
    this.mons = {}; // machine key ("" is this computer) -> { at, spaces: [...], panes: [...] }
    this.monBusy = new Set();
    this.monErr = {}; // machine key -> why its last reading failed
    this.machine = load("monitor-machine", null); // the tab shown: null is this computer
    this.pids = new Map(); // terminal address -> its shell's pid
    this.folded = load("monitor-folded", {}); // section title -> true when folded
    // Section title -> how many rows of cards it shows, as dragged. Rows, not pixels: a list always
    // ends on a whole card, even after the cards change size. `heights` holds a drag in progress.
    this.rows = load("monitor-rows", {});
    this.heights = {};
    this.limits = {}; // section title -> how many cards it draws (busiest first; "Show more" adds MORE) // section title -> the height the person dragged it to
    this.drag = null; // { title, y, h } while a list's bottom edge is held
    this.sys = {}; // machine key -> { os, cores, ramKb }, read once per machine
    // Keyboard: space cards, pane cards, then context rows, in screen order (rebuilt on each render).
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
    // Reads once a minute, but only while this pane is the one shown (and at once when it opens).
    // The process monitor (`ps`, every 3 s) redraws when it lands; with the window in the background it
    // stops after its first reading.
    cx.timer.every(3000, (cx) => {
      if (!shown("usage")) return;
      const active = window()?.active !== false;
      if (active || !this.mons[this.machine ?? ""]) this.monitor(cx);
      if (active && Date.now() - this.last > 60000) this.refresh(cx);
    });
  }

  // CPU and memory per pane (its shell plus every process under it), then per space.
  monitor(cx) {
    const machine = this.machine && machines().some((m) => m.name === this.machine) ? this.machine : null;
    const mk = machine ?? "";
    const on = machine; // where `ps` and friends run
    if (this.monBusy.has(mk)) return;
    this.monBusy.add(mk);
    const tabInfo = new Map();
    const local = [];
    for (const sp of spaces()) {
      if ((sp.machine ?? null) !== machine) continue;
      local.push(sp);
      for (const t of sp.tabs) tabInfo.set(t.id, { space: sp, tab: t });
    }
    const terms = panes().filter((p) => p.terminal && tabInfo.has(p.tab));
    cx.spawn(async (cx) => {
      try {
        for (const p of terms) {
          if (this.pids.has(p.terminal)) continue;
          const r = await hc(["get", p.terminal, "--json"]);
          const pid = r.code === 0 ? JSON.parse(r.stdout).pid : null;
          if (pid) this.pids.set(p.terminal, pid);
        }
        const run = (cmd, args, timeout = 5000) => exec(cmd, args, { cwd: machine ? undefined : home(), on, timeout });
        if (!this.sys[mk]) {
          const os = (await run("uname", ["-s"])).stdout.trim();
          if (os === "Darwin") {
            const r = await run("sysctl", ["-n", "hw.ncpu", "hw.memsize"]);
            const [cores, bytes] = r.stdout.trim().split(/\s+/).map(Number);
            if (cores && bytes) this.sys[mk] = { os, cores, ramKb: bytes / 1024 };
          } else {
            const cores = Number((await run("nproc", [])).stdout.trim());
            const kb = Number((await run("sh", ["-c", "grep MemTotal /proc/meminfo"])).stdout.match(/(\d+)/)?.[1]);
            if (cores && kb) this.sys[mk] = { os, cores, ramKb: kb };
          }
        }
        const out = await run("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], 15000);
        // The whole computer. macOS, as Activity Monitor counts "Memory Used": app (anonymous) + wired + compressed.
        // Linux: total minus what is available.
        let sysMemKb = null;
        try {
          if (this.sys[mk]?.os === "Darwin") {
            const vm = (await run("vm_stat", [])).stdout;
            const page = Number(vm.match(/page size of (\d+)/)?.[1]);
            const pages = (k) => Number(vm.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1]);
            const n = pages("Anonymous pages") + pages("Pages wired down") + pages("Pages occupied by compressor");
            if (page && n) sysMemKb = (n * page) / 1024;
          } else if (this.sys[mk]) {
            const mi = (await run("sh", ["-c", "grep MemAvailable /proc/meminfo"])).stdout.match(/(\d+)/)?.[1];
            if (mi) sysMemKb = this.sys[mk].ramKb - Number(mi);
          }
        } catch {}
        const proc = new Map();
        const kids = new Map();
        for (const line of out.stdout.split("\n")) {
          const [pid, ppid, c, rss] = line.trim().split(/\s+/).map(Number);
          if (!pid) continue;
          proc.set(pid, { c, rss });
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push(pid);
        }
        const total = (root) => {
          let c = 0, rss = 0;
          const stack = [root];
          const seen = new Set();
          while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            const x = proc.get(id);
            if (x) { c += x.c; rss += x.rss; }
            stack.push(...(kids.get(id) ?? []));
          }
          return { cpu: c, mem: rss };
        };
        const rows = terms.map((p) => {
          const { space, tab } = tabInfo.get(p.tab);
          const u = this.pids.has(p.terminal) ? total(this.pids.get(p.terminal)) : { cpu: 0, mem: 0 };
          return { id: p.terminal, name: clean(p.title) || p.program?.name || "Terminal", sub: `${space.name} · ${tab.named ? tab.name : `Tab ${tab.index}`}`, icon: p.program, space: space.id, ...u };
        });
        const bySpace = local.map((sp) => ({
          id: sp.id, name: sp.name, sub: `${rows.filter((r) => r.space === sp.id).length === 1 ? "1 pane" : `${rows.filter((r) => r.space === sp.id).length} panes`}`,
          cpu: rows.filter((r) => r.space === sp.id).reduce((a, r) => a + r.cpu, 0),
          mem: rows.filter((r) => r.space === sp.id).reduce((a, r) => a + r.mem, 0),
        }));
        delete this.monErr[mk];
        this.mons[mk] = {
          at: Date.now(), spaces: bySpace, panes: rows,
          cpu: rows.reduce((a, r) => a + r.cpu, 0), mem: rows.reduce((a, r) => a + r.mem, 0),
          sysCpu: [...proc.values()].reduce((a, x) => a + x.c, 0), sysMem: sysMemKb,
        };
      } catch (e) {
        this.monErr[mk] = String(e?.message ?? e ?? "unreachable").split("\n")[0];
      }
      this.monBusy.delete(mk);
      cx.notify();
    });
  }

  // Reads a few terminals at a time: every `hc read` is a process of its own.
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.last = Date.now();
    cx.notify();
    const list = agents().map((a) => ({ address: a.address, program: a.program?.key ?? a.program?.name, title: clean(a.title) || a.program?.name || "Agent", icon: a.program, status: a.status, seq: a.seq }));
    cx.spawn(async (cx) => {
      const seen = [];
      const queue = [...list];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            const r = await hc(["read", a.address]);
            const got = r.code === 0 ? parse(r.stdout) : null;
            // Antigravity's custom statusline prints Claude's shape (Context and Weekly bars, no 5-hour
            // limit), so the agent's own name tells them apart.
            const agy = /antigravity|^agy$/i.test(`${a.icon?.key ?? ""} ${a.program ?? ""}`);
            if (got) seen.push({ ...a, ...got, kind: agy ? "antigravity" : got.kind, five: agy ? null : got.five, fiveReset: agy ? null : got.fiveReset });
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      // The account's limits are the same in every session of one agent: take the freshest reading.
      const freshest = (kind, key) => seen.filter((s) => s.kind === kind && s[key] != null).sort((a, b) => b.seq - a.seq)[0] ?? null;
      // A window with no fresh reading keeps its last one. Its reset moment is saved, not "in 3h".
      const now = Date.now();
      const account = (kind) => {
        const prev = this.acct[kind] ?? {};
        const out = { ...prev };
        for (const [key, resetKey] of [["five", "fiveReset"], ["week", "weekReset"]]) {
          const r = freshest(kind, key);
          if (r) out[key] = { pct: r[key], resetAt: resetMoment(r[resetKey], now) ?? (prev[key]?.resetAt > now ? prev[key].resetAt : null), readAt: now };
        }
        return out;
      };
      this.acct = { claude: account("claude"), codex: account("codex"), antigravity: account("antigravity") };
      save("account-limits", this.acct);
      if (seen.length || !this.data) {
        this.data = {
          at: Date.now(),
          contexts: seen.map((s) => ({ address: s.address, title: s.title, kind: s.kind, context: s.context, icon: s.icon, status: s.status })),
        };
        save("limits", this.data);
      }
      this.loading = false;
      cx.notify();
    });
  }

  // Green to amber to red as it fills.
  tone(t, pct) {
    return pct >= 90 ? t.blocked : pct >= 70 ? t.ansi3 : t.ansi2;
  }

  iconButton(t, id, path, text, action) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .tooltip(text).accessibility_label(text)
      .when(!this.loading, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => action(cx)))
      .child(this.loading ? svg(`${ICONS}/spinner.svg`).size(13).text_color(t.muted).spin(900) : svg(path).size(13));
  }

  // A thin meter: the track, then the filled share. `frac` is 0 to 1; anything over 1 stays full.
  bar(t, frac, color, h = 4) {
    const w = Math.max(0, Math.min(1, frac || 0));
    return h_flex().h(h).flex_none().rounded(h / 2).overflow_hidden().bg(t.raised)
      .when(w > 0, (el) => el.child(div().h_full().rounded(h / 2).w(`${Math.max(2, Math.round(w * 100))}%`).bg(color)));
  }

  // One limit: what is used, how full that is, and when it resets. A reading whose window has
  // reset since is no longer true, so it says so instead of showing the old number.
  // Every state draws the same three lines, so meters side by side stay level.
  meter(t, name, w, now, key) {
    const over = w && w.resetAt != null && w.resetAt <= now;
    const pct = w && !over ? w.pct : null;
    const color = pct != null ? this.tone(t, pct) : t.dim;
    const note = !w ? "Not shown yet" : over ? "Reset since the last reading" : w.resetAt != null ? `Resets in ${resetIn(w.resetAt - now)}` : null;
    return v_flex().gap(5)
      .child(h_flex().items_baseline().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(name))
        .child(div().flex_none().font_family(MONO()).text_size(15).font_semibold()
          .text_color(pct == null ? t.dim : pct >= 70 ? color : t.foreground).child(pct == null ? "–" : `${pct}%`))
        .when(pct != null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("used"))))
      .child(this.bar(t, pct == null ? 0 : pct / 100, color))
      .child(div().id(`meter-note-${key}`).h(15).min_w(0).truncate().text_size(11).text_color(t.dim).when(Boolean(note), (el) => el.tooltip(note)).child(note ?? ""));
  }

  account(t, name, accent, data, now, weeklyOnly = false) {
    const wins = weeklyOnly ? [data?.week] : [data?.five, data?.week];
    const none = wins.every((w) => !w);
    const newest = Math.max(0, ...wins.map((w) => w?.readAt ?? 0));
    const old = newest > 0 && now - newest > 120000;
    return v_flex().w_full().flex_none().px(10).py(9).gap(10).rounded(8).border(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().h(18).items_center().gap(7)
        .child(div().size(8).flex_none().rounded(2).bg(accent))
        .child(div().id(`acct-${name}`).flex_1().min_w(0).truncate().text_size(12.5).font_semibold().tooltip(name).child(name))
        .when(old, (el) => el.child(div().id(`acct-old-${name}`).flex_none().font_family(MONO()).text_size(10.5).text_color(t.dim)
          .tooltip(`Last read ${ago(now - newest)} ago`).child(`${ago(now - newest)} ago`))))
      .when(none, (el) => el.child(div().text_size(12).text_color(t.dim).whitespace_normal().child(`No ${name} session has shown its limits yet.`)))
      .when(!none, (el) => el.when(!weeklyOnly, (m) => m.child(this.meter(t, "5 hours", data.five, now, `${name}-five`))).child(this.meter(t, "Weekly", data.week, now, `${name}-week`)));
  }

  // A section title that folds its list on click; the choice is remembered per title.
  foldHeader(t, title, count) {
    const folded = Boolean(this.folded[title]);
    return h_flex().id(`mon-fold-${title}`).flex_none().h(24).px(4).items_center().gap(6).rounded(6).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted)).active((s) => s.bg(t.selected))
      .accessibility_label(`${title}, ${count}, ${folded ? "folded" : "expanded"}`)
      .on_click((_e, cx) => {
        this.folded = { ...this.folded, [title]: !folded };
        save("monitor-folded", this.folded);
        cx.notify();
      })
      .child(svg(`${ICONS}/${folded ? "chevron-right" : "chevron-down"}.svg`).size(12).flex_none())
      .child(div().text_size(11).font_medium().child(title))
      .child(div().font_family(MONO()).text_size(10.5).child(String(count)));
  }

  // A metric's half of a row: its name and value, then a bar scaled to the biggest in the list.
  metric(t, label, color, value, frac) {
    return v_flex().flex_1().min_w(0).gap(5)
      .child(h_flex().items_center().gap(6)
        .child(div().size(6).flex_none().rounded(2).bg(color))
        .child(div().flex_1().min_w(0).text_size(10.5).font_medium().text_color(t.dim).child(label))
        .child(div().flex_none().font_family(MONO()).text_size(11.5).font_medium().text_color(t.foreground).child(value)))
      .child(this.bar(t, frac, color));
  }

  onKey(e, cx) {
    const it = () => this.items[this.nav.sel];
    const open = () => it()?.open();
    // [ and ] step through the machine tabs.
    const step = (by) => {
      const names = [null, ...machines().filter((m) => m.name).map((m) => m.name)];
      if (names.length < 2) return;
      const i = names.indexOf(this.shownMachine());
      this.machine = names[(i + by + names.length) % names.length];
      save("monitor-machine", this.machine);
      this.nav.sel = 0;
      this.monitor(cx);
    };
    const used = this.nav.key(e, this.items.length, {
      enter: open, o: open, l: open,
      r: () => { this.refresh(cx); this.monitor(cx); },
      "[": () => step(-1), "]": () => step(1),
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  // The bottom edge of a list: drag it to make the list taller or shorter, with no upper limit.
  // The move and release are read on the whole scroll view (see render), so a fast drag cannot slip off.
  resizeHandle(t, title, height) {
    const held = this.drag?.title === title;
    return h_flex().id(`mon-resize-${title}`).flex_none().h(12).items_center().justify_center().rounded(4).cursor_row_resize()
      .tooltip("Drag to resize").accessibility_label(`Resize ${title} list`)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { this.drag = { title, y: e.position.y, h: height }; cx.notify(); })
      .child(div().w(32).h(3).rounded(2).bg(held ? t.muted : t.border));
  }

  // One list, busiest first. "Load" adds a row's share of all CPU in use to its share of all memory in
  // use, so a pane that is busy and one that is big both rise, with no switch to flip.
  usageList(t, title, items) {
    const sum = (k) => Math.max(1e-9, items.reduce((a, r) => a + r[k], 0));
    const cpuAll = sum("cpu"), memAll = sum("mem");
    const load = (r) => r.cpu / cpuAll + r.mem / memAll;
    const all = [...items].sort((a, b) => load(b) - load(a) || a.name.localeCompare(b.name));
    // Busiest first, so the cap hides the quiet ones: ~120 rich cards in one view fail to draw live.
    const limit = this.limits[title] ?? MORE;
    const sorted = all.slice(0, limit);
    const hidden = all.length - sorted.length;
    const topCpu = Math.max(1, ...items.map((r) => r.cpu)), topMem = Math.max(1, ...items.map((r) => r.mem));
    const folded = Boolean(this.folded[title]);
    // Spaces sit two to a row: narrower cards, so the name has its own line and the two meters stack.
    const wide = title !== "Spaces";
    const cardH = wide ? CARD : CARD2;
    // Keyboard selection: a space card selects its space, a pane card focuses its pane (see onKey).
    // Registered once per card, in drawing order, and not at all while the list is folded.
    const card = (r) => {
      const on = !folded && Boolean(this.reg?.(title === "Spaces" ? () => run("space.select", { id: r.id }) : () => run("pane.focus", { terminal: r.id }), 0));
      return v_flex().id(`mon-${title}-${r.id}`).flex_none().h(cardH).justify_between().gap(6).px(10).py(9).rounded(8).border(1)
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome)
        .when(!wide, (c) => c.flex_1().min_w(0))
        .child(h_flex().gap(7).items_center()
          .when(Boolean(r.icon?.icon), (el) => el.child(r.icon.tint ? svg(r.icon.icon).size(14).flex_none().text_color(t.foreground) : image(r.icon.icon).size(14).flex_none()))
          .child(div().id(`mon-name-${title}-${r.id}`).flex_1().min_w(0).truncate().text_size(12.5).font_medium().tooltip(`${r.name}\n${r.sub}`).child(r.name))
          .when(wide, (el) => el.child(div().id(`mon-sub-${title}-${r.id}`).flex_none().max_w(120).truncate().text_size(11).text_color(t.dim).tooltip(r.sub).child(r.sub))))
        .when(!wide, (c) => c.child(div().truncate().text_size(11).text_color(t.dim).child(r.sub)))
        .child((wide ? h_flex().gap(14) : v_flex().gap(8))
          .child(this.metric(t, "CPU", cpuColor(t), cpu(r.cpu), r.cpu / topCpu))
          .child(this.metric(t, "MEM", memColor(t), mem(r.mem), r.mem / topMem)));
    };
    // Flexbox rows of two (no grid); an odd last card gets an empty half so it keeps its width.
    const rows = wide ? sorted.map(card) : Array.from({ length: Math.ceil(sorted.length / 2) }, (_, k) => {
      const pair = sorted.slice(k * 2, k * 2 + 2);
      return h_flex().id(`mon-row-${title}-${k}`).flex_none().h(cardH).gap(GAP)
        .children(pair.map(card))
        .when(pair.length === 1, (r) => r.child(div().flex_1().min_w(0)));
    });
    const n = rows.length;
    const fit = (k) => k * cardH + Math.max(0, k - 1) * GAP;
    const height = this.heights[title] ?? fit(Math.min(n, this.rows[title] ?? 2));
    return v_flex().flex_none().gap(4)
      .child(this.foldHeader(t, title, items.length))
      .when(!folded, (el) => el.child(v_flex().id(`mon-list-${title}`).gap(GAP).min_h(0)
        .h(height).overflow_y_scrollbar()
        .children(rows)
        .when(hidden > 0, (el) => el.child(h_flex().id(`mon-more-${title}`).flex_none().h(28).justify_center().items_center()
          .child(div().id(`mon-more-btn-${title}`).h(22).px(8).flex().items_center().rounded(5).border(1).border_color(t.border)
            .bg(t.chrome).text_size(11.5).text_color(t.muted).cursor_pointer()
            .accessibility_label(`Show ${Math.min(MORE, hidden)} more ${title.toLowerCase()}`)
            .hover((st) => st.bg(t.hover).text_color(t.foreground)).active((st) => st.bg(t.selected))
            .on_click((_e, cx) => { cx.stop_propagation(); this.limits = { ...this.limits, [title]: limit + MORE }; cx.notify(); })
            .child(`Show ${Math.min(MORE, hidden)} more of ${hidden} quieter`)))))
        .child(this.resizeHandle(t, title, height)));
  }

  // The totals: the whole computer, with the share Herdr's panes take marked inside the bar.
  tile(t, label, scope, color, value, of, frac, mine, mineFrac) {
    const pct = (f) => `${Math.max(1, Math.min(100, Math.round(f * 100)))}%`;
    const whole = Math.max(frac, mineFrac);
    return v_flex().flex_1().min_w(0).gap(6).px(10).py(9).rounded(8).border(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().items_center().gap(6)
        .child(div().size(7).flex_none().rounded(2).bg(color))
        .child(div().flex_none().text_size(11.5).font_medium().child(label))
        .child(div().id(`mon-tile-${label}`).flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).tooltip(scope).child(scope)))
      // Numbers wrap under each other in a narrow panel rather than being cut.
      .child(h_flex().items_baseline().gap_x(6).flex_wrap()
        .child(div().flex_none().font_family(MONO()).text_size(20).font_semibold().text_color(t.foreground).child(value))
        .when(Boolean(of), (el) => el.child(div().flex_none().font_family(MONO()).text_size(11).text_color(t.dim).child(of))))
      // The computer's use is the paler fill; Herdr's panes are the solid part of it.
      .child(h_flex().h(6).flex_none().rounded(3).overflow_hidden().bg(t.raised)
        .child(div().h_full().w(pct(whole)).bg(color + "59")
          .child(div().h_full().w(`${Math.min(100, Math.round((mineFrac / Math.max(whole, 1e-9)) * 100))}%`).bg(color))))
      .child(h_flex().items_baseline().gap_x(6).flex_wrap()
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Herdr panes"))
        .child(div().flex_none().font_family(MONO()).text_size(11).text_color(t.muted).child(mine)));
  }

  // The machine whose tab is shown: null is this computer. One that was removed falls back to it.
  shownMachine() {
    return this.machine && machines().some((m) => m.name === this.machine) ? this.machine : null;
  }

  // A tab per machine, only once a second one is known. Flexbox chips; the choice is remembered.
  machineTabs(t) {
    const others = machines().filter((m) => m.name);
    if (!others.length) return null;
    const current = this.shownMachine();
    const tab = (name, text, away) => {
      const on = name === current;
      return h_flex().id(`mon-machine-${name ?? "local"}`).h(24).px(8).max_w(180).items_center().gap(5).flex_none().rounded(6)
        .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome)
        .text_size(11.5).text_color(on ? t.foreground : away ? t.dim : t.muted)
        .cursor_pointer().tooltip(`${text}${away ? " · unavailable" : ""}`)
        .hover((s) => s.bg(on ? t.selected : t.hover)).active((s) => s.bg(t.selected))
        .accessibility_label(`${text}${away ? ", unavailable" : ""}${on ? ", shown" : ""}`)
        .on_click((_e, cx) => {
          this.machine = name;
          save("monitor-machine", name);
          this.monitor(cx);
          cx.notify();
        })
        .when(away, (el) => el.child(div().size(6).flex_none().rounded(3).border(1.5).border_color(t.dim)))
        .child(div().min_w(0).truncate().child(text));
    };
    return h_flex().flex_none().gap(5).px(10).pb(8).flex_wrap()
      .child(tab(null, "This Mac", false))
      .children(others.map((m) => tab(m.name, m.name, m.layout === "unavailable")));
  }

  monitorCard(t) {
    const mk = this.shownMachine() ?? "";
    const m = this.mons[mk];
    if (!m) {
      const why = this.monErr[mk];
      if (!why) return div().px(4).py(8).text_size(12).text_color(t.dim).child("Reading processes…");
      return v_flex().px(10).py(8).gap(2).rounded(6).border(1).border_color(t.blocked + "55").bg(t.blocked + "14")
        .child(div().text_size(12).font_medium().text_color(t.blocked).whitespace_normal().child(`Can't reach ${mk}`))
        .child(div().text_size(11.5).text_color(t.muted).whitespace_normal().child(why));
    }
    const sys = this.sys[mk];
    const scope = `whole ${mk || "Mac"}`;
    const cap = sys ? sys.cores * 100 : 100;
    const cpuAll = Math.min(1, m.sysCpu / cap), cpuMine = Math.min(1, m.cpu / cap);
    const ram = sys?.ramKb ?? 0;
    const memAll = ram && m.sysMem ? Math.min(1, m.sysMem / ram) : 0, memMine = ram ? Math.min(1, m.mem / ram) : 0;
    const pct1 = (f) => (f >= 0.1 ? `${Math.round(f * 100)}%` : `${(f * 100).toFixed(1)}%`);
    return v_flex().flex_none().gap(12)
      .child(h_flex().gap(GAP)
        .child(this.tile(t, "CPU", scope, cpuColor(t), pct1(cpuAll), sys ? `${sys.cores} cores` : "", cpuAll, pct1(cpuMine), cpuMine))
        .child(this.tile(t, "Memory", scope, memColor(t), m.sysMem ? mem(m.sysMem) : "n/a", ram ? `${Math.round(memAll * 100)}% of ${mem(ram)}` : "", memAll, mem(m.mem), memMine)))
      .child(this.usageList(t, "Spaces", m.spaces))
      .child(this.usageList(t, "Panes", m.panes))
      .child(div().px(4).text_size(11).text_color(t.dim).whitespace_normal()
        .child(`Tiles show the whole ${mk || "Mac"}, like Activity Monitor. Cards below are Herdr's panes only, busiest first: a pane counts its shell and everything it started. CPU on cards is 100% per busy core.`));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const d = this.data;
    const mono = MONO();
    const here = this.shownMachine();
    // Only agents still running: a closed session's last reading would sit here forever.
    const live = new Set(agents().map((a) => a.address));
    const contexts = [...(d?.contexts ?? [])].filter((c) => live.has(c.address) && (c.address.includes("/") ? c.address.split("/")[0] : null) === here).sort((a, b) => b.context - a.context);
    // What needs a look, counted in the header like the other panels: limits and contexts at 90% or more.
    const fresh = (w) => w && !(w.resetAt != null && w.resetAt <= now) && w.pct >= 90;
    const highLimits = here === null ? [this.acct.claude?.five, this.acct.claude?.week, this.acct.codex?.five, this.acct.codex?.week, this.acct.antigravity?.week].filter(fresh).length : 0;
    const highCtx = d ? contexts.filter((c) => c.context >= 90).length : 0;
    // Keyboard rows, registered as they are drawn. `section` is the scroll area child that holds them.
    const kbd = this.nav.focused();
    const items = [];
    this.reg = (open, section) => { items.push({ open, section }); return kbd && this.nav.sel === items.length - 1; };
    const monitor = this.monitorCard(t);
    const ctxSection = 1 + (d ? 0 : 1) + (here === null ? 2 : 0);
    const ctxOn = contexts.map((c) => this.reg(() => run("agent.focus", { terminal: c.address }), ctxSection));
    this.reg = null;
    this.items = items;
    this.nav.clamp(items.length);
    const tabs = this.machineTabs(t);
    const many = contexts.length > CTX_SHOWN;
    return v_flex().id("usage-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Monitoring"))
        .when(highLimits > 0, (el) => el.child(div().flex_none().text_size(11.5).font_medium().text_color(t.blocked)
          .child(highLimits === 1 ? "1 limit high" : `${highLimits} limits high`)))
        .when(highCtx > 0, (el) => el.child(div().flex_none().text_size(11.5).font_medium().text_color(t.ansi3)
          .child(highCtx === 1 ? "1 context full" : `${highCtx} contexts full`)))
        .child(div().flex_1())
        .when(Boolean(d?.at), (el) => el.child(div().flex_none().font_family(mono).text_size(10.5).text_color(t.dim).child(ago(now - d.at))))
        .child(this.iconButton(t, "usage-refresh", "mods/cockpit-usage/refresh.svg", "Refresh (r)", (cx) => { this.refresh(cx); this.monitor(cx); })))
      .children(tabs ? [tabs] : [])
      .child(v_flex().id("usage-scroll").flex_1().min_h(0).px(10).pb(12).gap(10).overflow_y_scrollbar().track_scroll(this.scroll)
        .on_mouse_move((e, cx) => {
          if (!this.drag) return;
          this.heights = { ...this.heights, [this.drag.title]: Math.max(CARD, Math.round(this.drag.h + e.position.y - this.drag.y)) };
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          if (!this.drag) return;
          // Snap to whole rows of cards.
          const { title } = this.drag;
          const step = (title === "Spaces" ? CARD2 : CARD) + GAP;
          // A press with no move leaves the rows as they were.
          if (this.heights[title] != null) this.rows = { ...this.rows, [title]: Math.max(1, Math.round((this.heights[title] + GAP) / step)) };
          const { [title]: _done, ...rest } = this.heights;
          this.heights = rest;
          this.drag = null;
          save("monitor-rows", this.rows);
          cx.notify();
        })
        .child(monitor)
        .when(!d, (el) => el.child(div().px(4).py(8).text_size(12).text_color(t.dim).child("Reading the agents' status lines…")))
        // Account limits are not shown on another machine's tab for now.
        // Two to a row (flexbox, no grid); the odd one out keeps a half-width slot.
        .when(here === null, (el) => el.child(h_flex().flex_none().gap(GAP).items_start()
          .child(div().flex_1().min_w(0).child(this.account(t, "Claude", t.ansi3, this.acct.claude, now)))
          .child(div().flex_1().min_w(0).child(this.account(t, "Codex", t.ansi4, this.acct.codex, now))))
          .child(h_flex().flex_none().gap(GAP).items_start()
            .child(div().flex_1().min_w(0).child(this.account(t, "Antigravity", t.ansi5, this.acct.antigravity, now, true)))
            .child(div().flex_1().min_w(0))))
        .when(Boolean(d) && contexts.length > 0, (el) => el.child(v_flex().flex_none().gap(4)
          .child(this.foldHeader(t, "Context", contexts.length))
          .when(!this.folded.Context, (sec) => sec.child(v_flex().id("ctx-list").p(CTX_PAD).rounded(8).border(1).border_color(t.border).bg(t.chrome).min_h(0)
            .when(many, (l) => l.h(CTX_ROW * CTX_SHOWN + CTX_GAP * (CTX_SHOWN - 1) + CTX_PAD * 2 + 2))
            .child(v_flex().id("ctx-scroll").gap(CTX_GAP).flex_1().min_h(0)
              .when(many, (l) => l.overflow_y_scrollbar())
              .children(contexts.map((c, i) => v_flex().id(`ctx-${c.address}`).flex_none().h(CTX_ROW).px(8).gap(5).justify_center().rounded(6).cursor_pointer()
                .when(ctxOn[i], (el) => el.bg(t.selected))
                .accessibility_label(`${c.title}, context ${c.context} percent full. Go to it`)
                .hover((s) => s.bg(ctxOn[i] ? t.selected : t.hover)).active((s) => s.bg(t.selected))
                .on_click(() => run("agent.focus", { terminal: c.address }))
                .child(h_flex().gap(7).items_center()
                  .child(c.icon?.icon ? (c.icon.tint ? svg(c.icon.icon).size(14).flex_none().text_color(t.foreground) : image(c.icon.icon).size(14).flex_none()) : div().size(14).flex_none())
                  .child(div().id(`ctx-title-${c.address}`).flex_1().min_w(0).truncate().text_size(12.5).tooltip(c.title).child(c.title))
                  .child(div().id(`ctx-addr-${c.address}`).flex_none().max_w(110).h(16).px(5).flex().items_center().rounded(4).bg(t.raised)
                    .text_color(t.dim).font_family(mono).text_size(10.5).tooltip(c.address).child(div().min_w(0).truncate().child(c.address)))
                  .child(div().flex_none().min_w(38).text_right().font_family(mono).text_size(11.5).font_medium()
                    .text_color(c.context >= 70 ? this.tone(t, c.context) : t.muted).child(`${c.context}%`)))
                .child(this.bar(t, c.context / 100, this.tone(t, c.context))))))))))
        .when(Boolean(d) && contexts.length === 0, (el) => el.child(v_flex().flex_none().py(18).px(12).gap(6).items_center()
          .child(svg(`${ICONS}/terminal.svg`).size(18).text_color(t.dim))
          .child(div().text_size(12.5).font_medium().text_color(t.muted).child("No context meters"))
          .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal()
            .child("No agent is showing a context meter. Run Claude with its status line, or Codex, in a terminal."))))
        .when(Boolean(d) && here === null, (el) => el.child(div().px(4).pt(2).text_size(11).text_color(t.dim).whitespace_normal()
          .child("Read from the agents' own status lines, once a minute."))))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ o", "go to it"], ["[ ]", "machine"], ["r", "refresh"]], this.nav.help)));
  }
}
