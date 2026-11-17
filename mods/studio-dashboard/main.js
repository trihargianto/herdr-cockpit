// Agents panel: triage first. What needs you sits on top, each row says what the
// agent is doing, where, on which branch and for how long.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, run, theme, setAgentOrder, layout, settings, nextCommand } from "herdr";
import { Nav, footer } from "./nav.js";

const ICONS = "mods/studio-workspace-chrome";
const ORDER = ["blocked", "done", "working", "idle"];
const LABELS = { blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" };
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// Animated characters: one full two-frame cycle, in ms. Typing is brisk; the "!" blinks slower.
const FLIPS = { working: 700, blocked: 1100 };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Agents prefix titles with a status glyph; keep a leading ~ or / of a path.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

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

// The program's icon: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return div().size(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).size(size).flex_none();
}

// A sub-agent without a pane reports a raw word: error counts as blocked, and it is
// never done (its parent's done is the news).
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

export default class Dashboard extends View {
  init(_props, cx) {
    this.scope = load("scope", "space");
    this.filter = null;
    this.folded = new Set(load("folded", ["idle"]));
    // Each agent's last state and since when (ms). Done and idle count as one:
    // looking at a finished agent is not the agent doing anything.
    this.changed = load("changed", {});
    this.hovered = null;
    // Keyboard (vim keys, nav.js): j/k over the agents as listed. The terminal is to the right.
    this.nav = new Nav(cx, { leave: "right" });
    this.nav.watch(cx);
    this.scroll = ScrollHandle.new();
    this.list = []; // the agents in display order, from the last render
    this.at = {}; // address -> its index among the scroll area's children
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") {
          const here = this.list.findIndex((a) => a.focused);
          if (here >= 0) this.nav.sel = here;
          this.nav.focus();
          cx.notify();
        }
      }
    });
    // Focus handles report no blur: a cheap check redraws once when the keyboard leaves (or arrives),
    // so the highlight and the key footer don't linger.
    // The address just copied, shown as "Copied" for a moment.
    this.copied = null;
    // Durations read in minutes: redraw for them twice a minute, nothing else polls.
    // (The rail shows no times, so it skips these.)
    cx.timer.every(30000, (cx) => { if (!narrow()) cx.notify(); });
  }

  track(list, tabs, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      const known = this.changed[a.address];
      if (known?.s === s) continue;
      // First sight: borrow the tab's clock rather than pretend it just started.
      const tab = tabs.get(a.tab);
      const at = known ? now : (s === "working" ? tab?.working_since : tab?.changed_at) ?? null;
      this.changed[a.address] = { s, at };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) {
      if (!listed.has(k) && (!c.at || now - c.at > 7 * 86400000)) delete this.changed[k];
    }
    save("changed", this.changed);
  }

  since(a) {
    return this.changed[a.address]?.at ?? null;
  }

  title(a, tab) {
    const prog = a.program?.name;
    const live = clean(a.title);
    const telling = live && live !== prog && live.toLowerCase() !== a.program?.key && !/^[~/]/.test(live) && !live.includes("@");
    if (telling) return live;
    return tab?.named ? tab.name : prog || "Agent";
  }

  where(a, tab, all) {
    // An automatic tab number says nothing: name the tab only when someone named it.
    const tabName = tab?.named ? tab.name : null;
    return all ? [a.space_name, tabName].filter(Boolean).join(" / ") : tabName;
  }

  // Status at a glance: spinner working, ! needs you, dot done, ring idle.
  mark(t, status, size = 12) {
    if (status === "working") return svg(`${ICONS}/spinner.svg`).size(size).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().size(size + 2).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold()
      .text_color(t.blocked).flex().items_center().justify_center().child("!");
    const box = h_flex().size(size).flex_none().items_center().justify_center();
    if (status === "done") return box.child(div().size(7).rounded(4).bg(t.done));
    return box.child(div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim));
  }

  // The row's character (art/agent-sprite). Drawn at 2x, so 24pt on a Retina screen is one
  // image pixel per screen pixel. Busy states flip two frames natively: the second frame sits
  // on the first and loops its opacity far past 0..1 (-10..11), which clamps into a switch
  // shorter than one animation frame. (A GIF only advances when the view redraws: it froze here.)
  sprite(a, quiet) {
    const base = "mods/studio-dashboard/sprites";
    const flip = FLIPS[a.status];
    if (!flip) return image(`${base}/${a.status === "done" ? "done" : "idle"}.png`).w(24).h(25).flex_none()
      .when(quiet, (el) => el.opacity(0.55));
    const frame = (i) => image(`${base}/${a.status}-${i}.png`).absolute().top(0).left(0).w(24).h(25);
    return div().relative().w(24).h(25).flex_none()
      .child(frame(0))
      .child(frame(1).loop("opacity", { from: -10, to: 11, period: flip, easing: "linear" }));
  }

  iconButton(t, id, path, label, action) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).cursor_pointer().tooltip(label).accessibility_label(label)
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .active((s) => s.bg(t.selected).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
        cx.notify();
      })
      .child(svg(path).size(13));
  }

  // The herdr address (t43, mac15/t15) to name an agent in a prompt. Click copies it.
  address(t, address, small = false) {
    const copied = this.copied === address;
    return h_flex().id(`addr-${address}`).flex_none().h(small ? 16 : 18).px(4).gap(3).items_center().rounded(4)
      .bg(copied ? t.done + "26" : t.raised).text_color(copied ? t.done : t.muted)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(small ? 10.5 : 11)
      .cursor_pointer().tooltip(copied ? "Copied" : `Copy ${address}`).accessibility_label(`Copy address ${address}`)
      .hover((s) => s.text_color(t.foreground))
      .active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(address);
        this.copied = address;
        cx.notify();
        cx.timer.after(1200, (cx) => {
          if (this.copied === address) this.copied = null;
          cx.notify();
        });
      })
      .when(copied, (el) => el.child(svg(`${ICONS}/check.svg`).size(small ? 9 : 10).flex_none()))
      .child(address);
  }

  onKey(e, cx) {
    const a = () => this.list[this.nav.sel];
    const go = () => a() && run("pane.focus", { pane: a().pane });
    const used = this.nav.key(e, this.list.length, {
      enter: go, l: go, o: go,
      p: () => a() && run("terminal.peek", { terminal: a().address }),
      P: () => a() && run("terminal.pin", { terminal: a().address, pinned: !a().pinned }),
      // The status filter: all, then each state in turn.
      f: () => { const i = ORDER.indexOf(this.filter); this.filter = i === ORDER.length - 1 ? null : ORDER[i + 1]; this.nav.sel = 0; },
      s: () => { this.setScope(this.scope === "all" ? "space" : "all"); this.nav.sel = 0; },
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const at = this.at[this.list[this.nav.sel]?.address];
    if (at != null) this.scroll.scroll_to_item(at);
    cx.notify();
  }

  setScope(scope) {
    this.scope = scope;
    save("scope", scope);
  }

  toggleFold(id) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    save("folded", [...this.folded]);
  }

  // The character on the left shows the status, so rows under Pinned (mixed statuses) need no extra mark.
  row(t, a, ctx, mixed) {
    const tab = ctx.tabs.get(a.tab);
    const pane = ctx.panes.get(a.pane);
    const name = this.title(a, tab);
    const where = this.where(a, tab, ctx.all);
    // The Spaces list already shows each space's branch: only say it when it differs.
    const branch = pane?.branch && pane.branch !== ctx.spaceBranch.get(a.space) ? pane.branch : null;
    const at = this.since(a);
    // The keyboard's row shows its actions too, as a hover does.
    const keyed = this.kbdAddr === a.address;
    const hovered = this.hovered === a.address || keyed;
    const quiet = a.status === "idle" && !a.focused;
    const kids = ctx.kids(a.address);
    const state = `${LABELS[a.status] ?? a.status}${at ? ` for ${ago(ctx.now - at)}` : ""}`;

    const actions = h_flex().gap(2).flex_none()
      .child(this.iconButton(t, `peek-${a.address}`, "mods/studio-dashboard/eye.svg", "Peek without leaving your work",
        () => run("terminal.peek", { terminal: a.address })))
      .child(this.iconButton(t, `pin-${a.address}`, `${ICONS}/${a.pinned ? "pin-off" : "pin"}.svg`, a.pinned ? "Unpin" : "Pin to top", () => {
        run("terminal.pin", { terminal: a.address, pinned: !a.pinned });
        // The row moves out from under the pointer and no hover-out follows.
        this.hovered = null;
      }));

    const card = h_flex().id(`agent-${a.address}`).w_full().flex_none().pl(6).pr(8).py(6).gap(8).items_center().rounded(7)
      .cursor_pointer()
      .accessibility_label(`${[`${name} (${a.address})`, state, where].filter(Boolean).join(", ")}. Focus terminal`)
      .when(a.focused, (el) => el.bg(t.selected))
      .when(keyed, (el) => el.border_1().border_color(t.accent))
      .hover((s) => s.bg(a.focused ? t.selected : t.hover))
      .active((s) => s.bg(t.selected))
      .on_hover((on, cx) => {
        if (on) this.hovered = a.address;
        else if (this.hovered === a.address) this.hovered = null;
        cx.notify();
      })
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(this.sprite(a, quiet))
      .child(v_flex().flex_1().min_w(0).gap(3)
      .child(h_flex().h(22).gap(8).items_center()
        .child(icon(a.program, 16, quiet ? t.muted : t.foreground))
        .child(div().id(`title-${a.address}`).flex_1().min_w(0).truncate().tooltip(name)
          .text_color(quiet ? t.muted : t.foreground).when(a.status === "blocked", (el) => el.font_medium()).child(name))
        .when(hovered, (el) => el.child(actions))
        .when(!hovered && Boolean(at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).tooltip(state).child(ago(ctx.now - at)))))
      .child(h_flex().pl(24).gap(5).items_center().text_size(11.5).text_color(t.dim)
        .child(this.address(t, a.address))
        .when(Boolean(where), (el) => el.child(div().id(`where-${a.address}`).min_w(0).truncate().tooltip(where).child(where)))
        .when(Boolean(branch), (el) => el
          .child(svg(`${ICONS}/git-branch.svg`).size(11).flex_none().ml(3))
          .child(div().id(`branch-${a.address}`).flex_1().min_w(0).truncate().tooltip(branch).child(branch)))));

    if (!kids.length) return [card];
    return [card, ...kids.map((k, i) => this.kidRow(t, k, i === kids.length - 1, ctx))];
  }

  kidRow(t, k, last, ctx) {
    const st = kidStatus(k, ctx.listed);
    const name = k.name || k.template || k.program?.name || k.address;
    const own = ctx.listed.has(k.address);
    return h_flex().id(`sub-${k.address}`).w_full().flex_none().h(24).pl(18).pr(8).gap(6).items_center().rounded(6)
      .text_size(12).cursor_pointer()
      .accessibility_label(`Sub-agent ${name}, ${LABELS[st] ?? st}. ${own ? "Focus" : "Peek"}`)
      .hover((s) => s.bg(t.hover))
      .active((s) => s.bg(t.selected))
      .on_click(() => run(own ? "pane.focus" : "terminal.peek", { terminal: k.address }))
      .child(div().w(10).flex_none().text_color(t.input).child(last ? "└" : "├"))
      .child(icon(k.program, 13, t.muted))
      .child(div().id(`sub-name-${k.address}`).flex_1().min_w(0).truncate().tooltip(name).text_color(t.muted).child(name))
      .child(this.address(t, k.address, true))
      .child(this.mark(t, st, 10));
  }

  header(t, id, label, color, count) {
    const open = !this.folded.has(id);
    return h_flex().id(`sec-${id}`).w_full().flex_none().h(26).px(8).mt(4).gap(6).items_center().rounded(6)
      .text_size(11).font_medium().cursor_pointer()
      .accessibility_label(`${label}, ${count}. ${open ? "Collapse" : "Expand"}`)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.toggleFold(id);
        cx.notify();
      })
      .child(div().text_color(color).child(label))
      .when(id === "pinned", (el) => el.child(div().text_color(t.dim).child(String(count))))
      .child(div().flex_1())
      .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim));
  }

  // A filter: the status in words and how many, so it reads without telling colours apart.
  // Selected: tinted, with a border and the status colour; a count of 0 is dimmed and can't be picked.
  chip(t, status, count) {
    const on = this.filter === status;
    const empty = count === 0 && !on;
    const color = t[status] ?? t.dim;
    return h_flex().id(`chip-${status}`).flex_none().h(24).px(8).gap(6).items_center().rounded(6)
      .border(1).border_color(on ? color + "80" : t.border).bg(on ? color + "1f" : t.chrome)
      .text_size(11.5).font_medium()
      .tooltip(`${LABELS[status]} · ${count}${on ? " (click to show all)" : empty ? "" : " (click to show only these)"}`)
      .accessibility_label(`${LABELS[status]}, ${count}. ${on ? "Clear filter" : "Show only these"}`)
      .when(!empty, (el) => el.cursor_pointer()
        .hover((s) => s.bg(on ? color + "2a" : t.hover))
        .active((s) => s.bg(color + "33"))
        .on_click((_e, cx) => {
          this.filter = on ? null : status;
          cx.notify();
        }))
      .child(div().text_color(empty ? t.dim : on ? color : t.muted).child(LABELS[status]))
      .child(div().font_semibold().text_color(empty ? t.dim : on ? color : t.foreground).child(String(count)));
  }

  segment(t, id, label, on, action) {
    return div().id(id).h(20).px(8).flex().items_center().rounded(4).text_size(11)
      .cursor_pointer().accessibility_label(label)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
      .when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => {
        action();
        cx.notify();
      })
      .child(label);
  }

  empty(t, title, body, action) {
    return v_flex().px(8).py(10).gap(4)
      .child(div().text_color(t.muted).child(title))
      .when(Boolean(body), (el) => el.child(div().text_size(12).text_color(t.dim).child(body)))
      .when(Boolean(action), (el) => el.child(div().id("empty-action").mt(4).self_start().px(9).h(24).flex().items_center()
        .rounded(6).border(1).border_color(t.border).text_size(12).cursor_pointer()
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => {
          action.run();
          cx.notify();
        })
        .child(action.label)));
  }

  // The rail: the same agents as the full list (sub-agents under their parent stay out), most urgent
  // first and, within a state, in the list's time order. The » on top unfolds the sidebar: on macOS
  // the window buttons take the top row's toggle away.
  rail(t, list) {
    const listed = new Set(list.map((a) => a.address));
    const nested = new Set(terminals().filter((k) => k.parent && k.state === "live" && listed.has(k.parent)).map((k) => k.address));
    const top = list.filter((a) => a.pinned || !nested.has(a.address));
    const sorted = [...top].sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0)
      || (x.status === "blocked" ? (this.since(x) ?? 0) - (this.since(y) ?? 0) : (this.since(y) ?? 0) - (this.since(x) ?? 0)) || y.seq - x.seq);
    setAgentOrder(sorted.map((a) => a.address));
    this.list = sorted;
    this.nav.clamp(sorted.length);
    const kbd = this.nav.focused();
    const keyed = kbd ? sorted[this.nav.sel]?.address : null;
    return v_flex().id("agents-rail")
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx)).size_full().min_h(0).bg(t.chrome).items_center().gap(4).py(8).overflow_y_scrollbar()
      .child(div().id("rail-expand").w(32).h(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
        .tooltip("Unfold the sidebar (Cmd+B)").accessibility_label("Unfold the sidebar")
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
        .on_click(() => run("studio-tabs.sidebar"))
        .child(svg("mods/studio-workspace-chrome/chevron-right.svg").size(13)))
      .when(!sorted.length, (el) => el.child(div().id("rail-empty").w(32).h(24).flex().items_center().justify_center().text_color(t.dim).tooltip("No agents running").child("–")))
      .children(sorted.map((a) => v_flex().id(`rail-${a.address}`).w(32).py(5).gap(4).flex_none().items_center().rounded(7)
        .cursor_pointer().tooltip(`${a.address} · ${clean(a.title) || a.program?.name || "Agent"} · ${LABELS[a.status] ?? a.status}`)
        .accessibility_label(`${clean(a.title) || a.program?.name || "Agent"}, ${LABELS[a.status] ?? a.status}. Go to it`)
        .when(a.focused, (el) => el.bg(t.selected))
        .when(keyed === a.address, (el) => el.border_1().border_color(t.accent))
        .when(a.status === "idle" && !a.focused, (el) => el.opacity(0.55))
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .child(icon(a.program, 16, t.foreground))
        .child(this.mark(t, a.status, 10))));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const everyone = agents();
    const allSpaces = spaces();
    const tabs = new Map(allSpaces.flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    this.track(everyone, tabs, now);
    if (narrow()) return this.rail(t, everyone);

    const space = allSpaces.find((s) => s.active);
    const all = this.scope === "all";
    const listed = new Map(everyone.map((a) => [a.address, a.status]));
    const terms = terminals();
    const kidsOf = new Map();
    for (const k of terms) {
      if (!k.parent || k.state !== "live") continue;
      if (!kidsOf.has(k.parent)) kidsOf.set(k.parent, []);
      kidsOf.get(k.parent).push(k);
    }
    // A kept sub-agent (one with a pane) shows under its parent, not on its own row.
    const nested = new Set([...kidsOf.entries()].filter(([p]) => listed.has(p)).flatMap(([, ks]) => ks.map((k) => k.address)));
    const top = everyone.filter((a) => a.pinned || !nested.has(a.address));
    const scoped = top.filter((a) => all || a.space === space?.id);
    const counts = Object.fromEntries(ORDER.map((s) => [s, scoped.filter((a) => a.status === s).length]));
    if (this.filter && !counts[this.filter]) this.filter = null;
    const shown = scoped.filter((a) => !this.filter || a.status === this.filter);
    const elsewhere = all ? 0 : top.filter((a) => a.space !== space?.id && a.status === "blocked").length;

    const ctx = {
      now, all, tabs, listed,
      spaceBranch: new Map(allSpaces.map((sp) => [sp.id, sp.branch])),
      panes: new Map(panes().filter((p) => p.terminal).map((p) => [p.pane, p])),
      kids: (address) => kidsOf.get(address) ?? [],
    };

    // Needs you: waiting longest first. Everything else: latest change first.
    const byTime = (status) => (x, y) => {
      const a = this.since(x) ?? 0, b = this.since(y) ?? 0;
      return (status === "blocked" ? a - b : b - a) || y.seq - x.seq;
    };
    const groups = [];
    const pinned = shown.filter((a) => a.pinned).sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0));
    if (pinned.length) groups.push({ id: "pinned", label: "Pinned", color: t.muted, members: pinned });
    for (const status of ORDER) {
      const members = shown.filter((a) => !a.pinned && a.status === status).sort(byTime(status));
      if (members.length) groups.push({ id: status, label: LABELS[status], color: status === "blocked" || status === "done" ? t[status] : t.muted, members });
    }
    setAgentOrder(groups.flatMap((g) => g.members.map((a) => a.address)));

    // The keyboard walks the agents shown (folded groups are skipped), in this order.
    const kbd = this.nav.focused();
    const walk = groups.flatMap((g) => (this.folded.has(g.id) ? [] : g.members));
    const was = this.list[this.nav.sel]?.address;
    this.list = walk;
    if (was) { const i = walk.findIndex((a) => a.address === was); if (i >= 0) this.nav.sel = i; }
    this.nav.clamp(walk.length);
    this.kbdAddr = kbd ? walk[this.nav.sel]?.address : null;

    const rows = [];
    this.at = {};
    for (const g of groups) {
      rows.push(this.header(t, g.id, g.label, g.color, g.members.length));
      if (this.folded.has(g.id)) continue;
      for (const a of g.members) {
        this.at[a.address] = rows.length;
        rows.push(...[].concat(this.row(t, a, ctx, g.id === "pinned")));
      }
    }

    let emptyState = null;
    if (!everyone.length) emptyState = this.empty(t, "No agents yet", "Agents appear here once they report a status.");
    else if (!scoped.length) emptyState = this.empty(t, "No agents in this space", null,
      { label: `Show all spaces · ${top.length}`, run: () => this.setScope("all") });
    else if (!shown.length) emptyState = this.empty(t, `No ${LABELS[this.filter].toLowerCase()} agents`, null,
      { label: "Clear filter", run: () => { this.filter = null; } });

    if (emptyState) for (const k of Object.keys(this.at)) this.at[k] += 1;
    return v_flex().id("agents-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .border_t(1).border_color(t.border)
      .child(v_flex().flex_none().px(8).pt(10).pb(8).gap(8)
        .child(h_flex().px(8).gap(6).items_center()
          .child(div().text_size(11.5).font_medium().text_color(kbd ? t.accent : t.dim).child("Agents"))
          .child(div().id("scope-label").min_w(0).flex_1().truncate().text_size(11).text_color(t.dim)
            .tooltip(all ? "Across all spaces" : space?.name ?? "No space")
            .child(`· ${all ? "all spaces" : space?.name ?? "no space"}`))
          .child(h_flex().flex_none().p(2).gap(2).rounded(6).border(1).border_color(t.border)
            .child(this.segment(t, "scope-space", "Space", !all, () => this.setScope("space")))
            .child(this.segment(t, "scope-all", "All", all, () => this.setScope("all")))))
        .child(h_flex().flex_wrap().gap(4).children(ORDER.map((s) => this.chip(t, s, counts[s]))))
        .when(elsewhere > 0, (el) => el.child(h_flex().id("elsewhere").h(26).px(8).gap(6).items_center().rounded(6)
          .bg(t.blocked + "1a").text_size(11.5).font_medium().text_color(t.blocked).cursor_pointer()
          .accessibility_label(`${elsewhere} need you in other spaces. Show them`)
          .hover((s) => s.bg(t.blocked + "2a")).active((s) => s.bg(t.blocked + "33"))
          .on_click((_e, cx) => {
            this.setScope("all");
            this.filter = "blocked";
            cx.notify();
          })
          .child(div().flex_1().child(`${elsewhere} ${elsewhere === 1 ? "needs" : "need"} you in other spaces`))
          .child(svg(`${ICONS}/chevron-right.svg`).size(11).flex_none()))))
      .child(v_flex().id("agents-scroll").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(Boolean(emptyState), (el) => el.child(emptyState))
        .children(rows))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ l", "go"], ["p", "peek"], ["P", "pin"], ["f", "filter"], ["s", "space or all"], ["^k", "spaces"]], this.nav.help)));
  }
}
