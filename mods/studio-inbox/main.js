// Needs-you inbox: every agent that is blocked or just finished, oldest-waiting first.
// Click one to read the end of its screen and answer it without leaving your work.
// "Other agents" (folded) lists the rest, so any agent can be messaged from here (this replaced Send).
// Runs `hc read` (on expand only) and `hc send` (when you press Enter).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, spaces, run, hc, theme, settings, layout, props, nextCommand } from "herdr";
import { Nav, footer } from "./nav.js";

const ICONS = "mods/studio-workspace-chrome";
const LABELS = { blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" };

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return div().size(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).size(size).flex_none();
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

export default class Inbox extends View {
  init(_props, cx) {
    this.open = null; // the expanded agent's address: one at a time
    this.lines = [];
    this.sending = false;
    this.note = null;
    this.copied = null;
    this.typing = false;
    try { this.others = localStorage.getItem("others") === "1"; } catch { this.others = false; }
    this.input = InputState.new({ placeholder: "Reply…" });
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // Keyboard: the cards in screen order (rebuilt on each render) and which scroll child holds each.
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
    // The screen refreshes only while a card is open; times redraw twice a minute.
    cx.timer.every(4000, (cx) => {
      if (shown("inbox")) this.read(cx);
    });
    cx.timer.every(30000, (cx) => {
      if (shown("inbox")) cx.notify();
    });
  }

  read(cx) {
    const address = this.open;
    if (!address) return;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", address, "--lines", "16"]);
        if (this.open === address) {
          this.lines = r.code === 0
            ? r.stdout.replace(ANSI, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-14)
            : [(r.stderr || "Couldn't read this terminal.").trim()];
        }
      } catch {
        if (this.open === address) this.lines = ["Couldn't read this terminal."];
      }
      cx.notify();
    });
  }

  // Esc in the reply field goes back to the list.
  onInputKey(e, cx) {
    if (e.key === "escape") { this.nav.focus(); cx.stop_propagation(); cx.notify(); }
  }

  onKey(e, cx) {
    const it = () => this.items[this.nav.sel];
    const reply = () => {
      const a = it();
      if (!a) return;
      if (this.open !== a.address) this.toggle(a.address, cx);
      this.input.focus();
    };
    const used = this.nav.key(e, this.items.length, {
      enter: () => { const a = it(); if (a) this.toggle(a.address, cx); },
      l: () => { const a = it(); if (a) this.toggle(a.address, cx); },
      o: () => { const a = it(); if (a) this.toggle(a.address, cx); },
      i: reply, a: reply,
      f: () => { const a = it(); if (a) run("agent.focus", { terminal: a.address }); },
      p: () => { const a = it(); if (a) run("terminal.peek", { terminal: a.address }); },
      O: () => { this.others = !this.others; try { localStorage.setItem("others", this.others ? "1" : "0"); } catch {} },
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  toggle(address, cx) {
    this.open = this.open === address ? null : address;
    this.lines = [];
    this.note = null;
    this.input.set_value("");
    if (this.open) this.read(cx);
    cx.notify();
  }

  send(cx) {
    const address = this.open;
    const text = this.input.value().trim();
    if (!address || !text || this.sending) return;
    const blocked = agents().find((a) => a.address === address)?.status === "blocked";
    this.sending = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // A blocked agent is waiting on a dialog: --force types into it, which is the point.
        const r = await hc(["send", address, text, ...(blocked ? ["--force"] : [])]);
        if (r.code === 0) {
          this.input.set_value("");
          this.note = { ok: true, text: `Sent to ${address}` };
          this.read(cx);
        } else {
          this.note = { ok: false, text: (r.stderr || r.stdout || "Not sent").trim().split("\n")[0] };
        }
      } catch {
        this.note = { ok: false, text: "Not sent" };
      }
      this.sending = false;
      cx.notify();
    });
  }

  address(t, address) {
    const copied = this.copied === address;
    return h_flex().id(`inbox-addr-${address}`).flex_none().h(16).px(4).gap(3).items_center().rounded(4)
      .bg(copied ? t.done + "26" : t.raised).text_color(copied ? t.done : t.dim)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5)
      .cursor_pointer().tooltip(copied ? "Copied" : `Copy ${address}`).accessibility_label(`Copy address ${address}`)
      .hover((s) => s.text_color(t.foreground)).active((s) => s.bg(t.selected))
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
      .child(address);
  }

  button(t, id, label, action, primary = false) {
    return div().id(id).h(24).px(9).flex().items_center().flex_none().rounded(6).text_size(12).cursor_pointer()
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

  card(t, a, tab, now, on = false) {
    const open = this.open === a.address;
    const color = t[a.status] ?? t.dim;
    const prog = a.program?.name;
    const live = clean(a.title);
    const telling = live && live !== prog && live.toLowerCase() !== a.program?.key && !/^[~/]/.test(live) && !live.includes("@");
    const name = telling ? live : tab?.named ? tab.name : prog || "Agent";
    const where = [a.space_name, tab?.named ? tab.name : null].filter(Boolean).join(" / ");
    const at = tab?.changed_at;
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id(`inbox-${a.address}`).w_full().flex_none().rounded(8).border(1)
      .border_color(open ? color + "66" : t.border).bg(open ? t.surface : t.chrome)
      .when(on, (el) => el.border_color(t.accent))
      .child(v_flex().id(`inbox-head-${a.address}`).px(10).py(8).gap(4).rounded(8).cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .accessibility_label(`${name}, ${LABELS[a.status]}${at ? ` ${ago(now - at)}` : ""}. ${open ? "Collapse" : "Expand to read and reply"}`)
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => this.toggle(a.address, cx))
        .child(h_flex().gap(8).items_center().h(22)
          .child(icon(a.program, 16, t.foreground))
          .child(div().id(`inbox-title-${a.address}`).flex_1().min_w(0).truncate().tooltip(name).font_medium().child(name))
          .when(Boolean(at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - at))))
          .child(a.status === "blocked"
            ? div().size(16).flex_none().rounded(4).bg(color + "26").text_size(10.5).font_bold().text_color(color).flex().items_center().justify_center().child("!")
            : a.status === "working" ? svg(`${ICONS}/spinner.svg`).size(12).mx(2).flex_none().text_color(color).spin(900)
              : div().size(7).mx(2).flex_none().rounded(4).bg(color)))
        .child(h_flex().pl(24).gap(6).items_center().text_size(11.5).text_color(t.dim)
          .child(this.address(t, a.address))
          .when(Boolean(where), (el) => el.child(div().id(`inbox-where-${a.address}`).min_w(0).truncate().tooltip(where).child(where)))))
      .when(open, (el) => el.child(v_flex().px(10).pb(10).gap(8)
        .child(v_flex().id(`inbox-screen-${a.address}`).p(8).gap(1).rounded(6).bg(t.background).border(1).border_color(t.border).overflow_hidden()
          .font_family(mono).text_size(10.5).text_color(t.muted)
          .when(!this.lines.length, (el) => el.child(div().text_color(t.dim).child("Reading…")))
          .children(this.lines.map((l, i) => div().id(`inbox-line-${a.address}-${i}`).truncate().child(l))))
        .child(h_flex().gap(6).items_center()
          .child(div().id("inbox-reply").flex_1().min_w(0).h(30).px(9).flex().items_center().rounded(7).border(1)
            .border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_key_down((e, cx) => this.onInputKey(e, cx))
            .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(this.button(t, "inbox-send", this.sending ? "Sending…" : "Send", (cx) => this.send(cx), true)))
        .when(Boolean(this.note), (el) => el.child(div().text_size(11.5).text_color(this.note.ok ? t.ansi2 : t.blocked).child(this.note.text)))
        .child(h_flex().gap(6)
          .child(this.button(t, "inbox-open", "Open", () => run("pane.focus", { pane: a.pane })))
          .child(this.button(t, "inbox-peek", "Peek", () => run("terminal.peek", { terminal: a.address }))))));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const list = agents().filter((a) => a.status === "blocked" || a.status === "done");
    const when = (a) => tabs.get(a.tab)?.changed_at ?? 0;
    // Stuck longest first; finished newest first.
    const blocked = list.filter((a) => a.status === "blocked").sort((x, y) => when(x) - when(y));
    const done = list.filter((a) => a.status === "done").sort((x, y) => when(y) - when(x));
    const rest = agents().filter((a) => a.status !== "blocked" && a.status !== "done");
    // The card you have open stays in view when its agent moves on (a reply turns "needs you" into
    // "working"): Other agents unfolds to keep it. A card whose agent is gone closes.
    if (this.open && !agents().some((a) => a.address === this.open)) this.open = null;
    const keepOpen = Boolean(this.open) && rest.some((a) => a.address === this.open);
    const head = (label, color, n) => h_flex().h(24).px(2).mt(4).gap(6).items_center().flex_none().text_size(11).font_medium()
      .child(div().text_color(color).child(label)).child(div().text_color(t.dim).child(String(n)));
    const kbd = this.nav.focused();
    const items = [];
    const kids = [];
    // Each card registers itself as a keyboard row and learns whether it is the selected one.
    const cardOf = (a) => {
      items.push({ address: a.address, section: kids.length });
      return this.card(t, a, tabs.get(a.tab), now, kbd && this.nav.sel === items.length - 1);
    };
    if (!list.length) kids.push(v_flex().px(4).py(8).gap(4)
      .child(div().text_color(t.muted).child("Nothing needs you"))
      .child(div().text_size(12).text_color(t.dim).child(rest.length ? "Open Other agents below to message one." : "Agents that get stuck or finish appear here.")));
    if (blocked.length > 0) kids.push(head("Needs you", t.blocked, blocked.length));
    for (const a of blocked) kids.push(cardOf(a));
    if (done.length > 0) kids.push(head("Done", t.done, done.length));
    for (const a of done) kids.push(cardOf(a));
    if (rest.length > 0) kids.push(h_flex().id("inbox-others").h(24).px(2).mt(4).gap(6).items_center().flex_none().text_size(11).font_medium()
      .rounded(5).cursor_pointer().text_color(t.dim).active((s) => s.bg(t.selected))
      .accessibility_label(`Other agents, ${rest.length}. ${this.others ? "Hide" : "Show to message one"}`)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        this.others = !this.others;
        try { localStorage.setItem("others", this.others ? "1" : "0"); } catch {}
        cx.notify();
      })
      .child(div().text_size(9).child(this.others ? "▾" : "▸"))
      .child(div().child("Other agents"))
      .child(div().child(String(rest.length))));
    if (this.others || keepOpen) for (const a of rest) kids.push(cardOf(a));
    this.items = items;
    this.nav.clamp(items.length);
    return v_flex().id("inbox-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Inbox")))
      .child(v_flex().id("inbox-scroll").flex_1().min_h(0).px(10).pb(10).gap(6).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(kids))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ o l", "open"], ["i a", "reply"], ["f", "go to agent"], ["p", "peek"], ["O", "other agents"]], this.nav.help)));
  }
}
