// Annotations: notes on text you selected in a terminal, sent to an agent as one message.
//
// Two jobs, one mod:
// - The note dialog (opened as an overlay with props.mode "new" or "edit"): the quote, a comment box,
//   Cmd+Enter saves. cockpit-tabs opens it after copying the selection (Ctrl+B A, or right-click >
//   Annotate selection), so the selection is read before any overlay takes the keyboard.
// - The side panel: notes of the space you're in (or every space), grouped by the terminal they came
//   from. Send queues them for an agent; cockpit-tabs (always on screen) delivers them when that agent
//   is idle. Paste puts them in the agent's prompt without pressing Enter.
// Notes live in shared state (see annolib.js), which is written at once: a dialog that closes right
// after saving loses nothing.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, EditorState, Editor, ScrollHandle } from "gpui-base";
import * as fs from "fs/promises";
import { agents, spaces, panes, run, theme, settings, props, nextCommand, shared, setShared, focused, closeOverlay, openOverlay, appHome, notify, layout, checking } from "herdr";
import { Nav, footer } from "./nav.js";
import { KEY, QUOTE_LINES, dialogHeight, notesOf, newId, groups, message, defaultTarget, queue, unqueue, remove, queuedByTarget, sourceName, ready } from "./annolib.js";

const ICONS = "mods/cockpit-workspace-chrome";
const OWN = "mods/cockpit-annotate";
const CARD_LINES = 3; // on a card

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(src, size, color) {
  if (!src?.icon) return svg(`${ICONS}/terminal.svg`).size(size).flex_none().text_color(color);
  return src.tint ? svg(src.icon).size(size).flex_none().text_color(color) : image(src.icon).size(size).flex_none();
}

// Sent notes are kept, one JSON line each, in case one is needed again.
async function archive(notes, to, how) {
  if (checking() || !notes.length) return;
  const dir = `${appHome()}/cockpit-annotate`;
  const lines = notes.map((n) => JSON.stringify({ ...n, queued: undefined, sent: { to, how, at: Date.now() } })).join("\n") + "\n";
  try {
    await fs.mkdir(dir, { recursive: true });
    const file = `${dir}/sent.jsonl`;
    const before = (await fs.exists(file)) ? await fs.readFile(file, "utf8") : "";
    await fs.writeFile(file, before + lines);
  } catch {}
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
function shown() {
  const root = layout();
  const panel = findNode(root, "panel"), body = findNode(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "annotate");
}

export default class Annotate extends View {
  init(_props, cx) {
    this.dialog = Boolean(props()?.mode);
    if (this.dialog) this.initDialog(cx);
    else this.initPanel(cx);
  }

  // ---------------------------------------------------------------- the note dialog

  initDialog(cx) {
    const p = props();
    const t = theme();
    this.editor = EditorState.new({
      language: "markdown", soft_wrap: true, line_numbers: false, folding: false, font_size: 13,
      font_family: settings().font_family, value: p.comment ?? "",
      syntax: { keyword: t.accent, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi6, number: t.ansi3, constant: t.ansi5, punctuation: t.dim },
    });
    // Enter and Shift+Enter add a line (the editor reports them as "submit" without `secondary`);
    // Cmd+Enter saves.
    this.editor.on("submit", (e) => { if (e.secondary) this.save(false); });
    // The editor would keep Esc for itself: a binding scoped to the form, and the editor in it, wins.
    cx.bind_keys([
      { keystroke: "escape", action: "cockpit-annotate.cancel", context: "AnnotateForm" },
      { keystroke: "escape", action: "cockpit-annotate.cancel", context: "AnnotateForm > Editor" },
    ]);
    this.editor.focus();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  // `send`: also queue it for the agent it came from.
  save(send) {
    const p = props();
    const comment = this.editor.value().trim();
    if (!comment && !p.quote) { this.close(); return; }
    let notes = notesOf(shared(KEY));
    if (p.mode === "edit") {
      notes = notes.map((n) => (n.id === p.id ? { ...n, comment } : n));
    } else {
      const note = { id: newId(), at: Date.now(), quote: p.quote ?? "", comment, source: p.source ?? null };
      notes = [...notes, note];
      if (send && p.source?.agent) notes = queue(notes, [note.id], p.source.terminal);
    }
    setShared(KEY, { notes });
    this.close();
  }

  button(t, id, label, action, primary = false) {
    return div().id(id).h(28).px(11).flex().items_center().flex_none().rounded(7).text_size(12.5).cursor_pointer()
      .accessibility_label(label)
      .border(1).border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.chrome).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.bg(primary ? t.solid : t.hover)).active((s) => s.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  renderDialog() {
    const t = theme();
    const p = props();
    const mono = settings().font_family ?? "JetBrains Mono";
    const lines = p.quote ? p.quote.split("\n") : [];
    const more = lines.length - QUOTE_LINES;
    const fromAgent = p.mode !== "edit" && p.source?.agent;
    return v_flex().id("annotate-dialog").key_context("AnnotateForm").size_full().p(16).gap(12)
      .bg(t.popover ?? t.chrome).text_color(t.foreground).text_size(13)
      .on_action("cockpit-annotate.cancel", () => this.close())
      .child(h_flex().h(26).gap(8).items_center().flex_none()
        .child(svg(`${OWN}/quote.svg`).size(15).flex_none().text_color(t.accent))
        .child(div().font_semibold().child(p.mode === "edit" ? "Edit note" : "Annotate"))
        .child(div().id("annotate-source").flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
          .tooltip(sourceName(p.source)).child(sourceName(p.source)))
        .when(p.from === "clipboard", (el) => el.child(div().id("annotate-from").flex_none().h(18).px(6).flex().items_center().rounded(4)
          .bg(t.raised ?? t.surface).text_size(11).text_color(t.muted)
          .tooltip("Nothing was selected in Herdr, so this quotes what you copied last").child("From clipboard"))))
      .when(lines.length > 0, (el) => el.child(v_flex().id("annotate-quote").flex_none().px(10).py(9).gap(0).rounded(7)
        .bg(t.background).border(1).border_color(t.border).overflow_hidden()
        .font_family(mono).text_size(11.5).text_color(t.muted)
        .children(lines.slice(0, QUOTE_LINES).map((l, i) => div().id(`annotate-q-${i}`).h(16).truncate().child(l || " ")))
        .when(more > 0, (el) => el.child(div().h(16).text_color(t.dim).child(`+${more} more ${more === 1 ? "line" : "lines"}`)))))
      .child(div().id("annotate-comment").flex_none().h(120).px(6).py(5).rounded(8).border(1).border_color(t.accent).bg(t.background).cursor_text()
        .child(Editor.new(this.editor).size_full()))
      .child(h_flex().h(30).gap(6).items_center().flex_none()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child("⌘↵ save · esc cancel"))
        .child(this.button(t, "annotate-cancel", "Cancel", () => this.close()))
        .when(Boolean(fromAgent), (el) => el.child(this.button(t, "annotate-save-send", "Save and send", () => this.save(true))))
        .child(this.button(t, "annotate-save", "Save", () => this.save(false), true)));
  }

  // ---------------------------------------------------------------- the panel

  initPanel(cx) {
    try { this.all = localStorage.getItem("all") === "1"; } catch { this.all = false; }
    this.marked = new Set();
    this.target = null; // an agent you picked; otherwise annolib's defaultTarget
    this.picking = false;
    this.hover = null;
    this.flash = null;
    this.items = [];
    this.nav = new Nav(cx, { slot: props()?.slot ?? null });
    this.nav.watch(cx);
    this.scroll = ScrollHandle.new();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.nav.wants(c, props()?.slot)) { this.nav.focus(); cx.notify(); }
      }
    });
    // The times on the cards ("5m") redraw twice a minute while the panel shows.
    cx.timer.every(30000, (cx) => { if (shown()) cx.notify(); });
  }

  setNotes(notes) {
    setShared(KEY, { notes });
  }

  say(text, ok, cx) {
    this.flash = { text, ok };
    cx.notify();
    cx.timer.after(2400, (cx) => {
      if (this.flash?.text === text) { this.flash = null; cx.notify(); }
    });
  }

  // The agents you can send to: those in this space first.
  agentList() {
    const here = focused()?.space;
    const list = agents();
    return [...list.filter((a) => a.space === here), ...list.filter((a) => a.space !== here)];
  }

  agentName(address) {
    const a = agents().find((x) => x.address === address);
    if (!a) return address;
    const title = (a.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
    const name = title && title !== a.program?.name && !/^[~/]/.test(title) ? title : a.tab_name || a.program?.name || "Agent";
    return `${name} (${address})`;
  }

  // What Send, Paste and Copy act on: the marked notes, else every waiting note in view.
  chosen(pending) {
    const marked = pending.filter((n) => this.marked.has(n.id));
    return marked.length ? marked : pending;
  }

  targetFor(notes) {
    const live = agents().map((a) => a.address);
    if (this.target && live.includes(this.target)) return this.target;
    const f = focused();
    const focusedAgent = f?.agent ?? agents().find((a) => a.focused)?.address ?? null;
    return defaultTarget(notes, live, focusedAgent);
  }

  send(pending, cx) {
    const notes = this.chosen(pending);
    if (!notes.length) return;
    const to = this.targetFor(notes);
    if (!to) { this.picking = true; this.say("Pick an agent to send to", false, cx); return; }
    this.setNotes(queue(notesOf(shared(KEY)), notes.map((n) => n.id), to));
    this.marked.clear();
    const agent = agents().find((a) => a.address === to);
    this.say(agent && ready(agent.status) ? `Sending to ${this.agentName(to)}` : `Queued: ${this.agentName(to)} gets it when it's idle`, true, cx);
  }

  // Into the agent's prompt without pressing Enter, so you can add to it. It goes through the clipboard.
  paste(pending, cx) {
    const notes = this.chosen(pending);
    if (!notes.length) return;
    const to = this.targetFor(notes);
    if (!to) { this.picking = true; this.say("Pick an agent to paste into", false, cx); return; }
    cx.write_to_clipboard(message(notes, to));
    run("agent.focus", { terminal: to });
    cx.timer.after(80, () => run("terminal.paste"));
    this.setNotes(remove(notesOf(shared(KEY)), notes.map((n) => n.id)));
    for (const n of notes) this.marked.delete(n.id);
    archive(notes, to, "paste");
  }

  copy(pending, cx) {
    const notes = this.chosen(pending);
    if (!notes.length) return;
    cx.write_to_clipboard(message(notes, null));
    this.say(`Copied ${notes.length} ${notes.length === 1 ? "note" : "notes"} as Markdown`, true, cx);
  }

  edit(n) {
    openOverlay({
      mod: "cockpit-annotate", kind: "dialog", width: 540, height: dialogHeight(n.quote),
      props: { mode: "edit", id: n.id, quote: n.quote, comment: n.comment, source: n.source },
    });
  }

  drop(ids) {
    this.setNotes(remove(notesOf(shared(KEY)), ids));
    for (const id of ids) this.marked.delete(id);
  }

  toggleMark(id) {
    if (this.marked.has(id)) this.marked.delete(id);
    else this.marked.add(id);
  }

  // Back to where the note came from: the agent, or the terminal's space and tab.
  jump(n, cx) {
    const address = n.source?.terminal;
    if (agents().some((a) => a.address === address)) { run("agent.focus", { terminal: address }); return; }
    const pane = panes().find((p) => p.terminal === address);
    if (!pane) { this.say("That terminal is closed", false, cx); return; }
    const space = spaces().find((s) => s.tabs.some((tab) => tab.id === pane.tab));
    if (space) run("space.select", { id: space.id });
    run("tab.select", { id: pane.tab });
    run("pane.focus", { pane: pane.pane });
  }

  cycleTarget(pending) {
    const list = this.agentList().map((a) => a.address);
    if (!list.length) return;
    const now = this.targetFor(this.chosen(pending));
    this.target = list[(list.indexOf(now) + 1) % list.length];
  }

  onKey(e, cx, pending) {
    const it = () => this.items[this.nav.sel];
    const used = this.nav.key(e, this.items.length, {
      enter: () => { const n = it(); if (n) this.jump(n, cx); },
      o: () => { const n = it(); if (n) this.jump(n, cx); },
      l: () => { const n = it(); if (n) this.jump(n, cx); },
      x: () => { const n = it(); if (n) this.toggleMark(n.id); },
      space: () => { const n = it(); if (n) this.toggleMark(n.id); },
      e: () => { const n = it(); if (n) this.edit(n); },
      dd: () => { const n = it(); if (n) this.drop([n.id]); },
      s: () => this.send(pending, cx),
      p: () => this.paste(pending, cx),
      yy: () => this.copy(pending, cx),
      t: () => this.cycleTarget(pending),
      a: () => { this.all = !this.all; try { localStorage.setItem("all", this.all ? "1" : "0"); } catch {} },
      u: () => { this.setNotes(unqueue(notesOf(shared(KEY)), { ids: this.queuedHere.map((n) => n.id) })); },
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  smallButton(t, id, iconName, tip, action) {
    return div().id(id).size(22).flex().items_center().justify_center().flex_none().rounded(5).cursor_pointer()
      .text_color(t.dim).tooltip(tip).accessibility_label(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); })
      .child(svg(`${OWN}/${iconName}.svg`).size(13));
  }

  card(t, n, index, on, now, mono) {
    const marked = this.marked.has(n.id);
    const hovered = this.hover === n.id;
    const lines = n.quote ? n.quote.split("\n") : [];
    const more = lines.length - CARD_LINES;
    return v_flex().id(`an-${n.id}`).w_full().flex_none().px(10).py(8).gap(6).rounded(8).border(1)
      .border_color(on ? t.accent : marked ? t.accent + "66" : t.border).bg(on || marked ? t.surface : t.chrome)
      .cursor_pointer()
      .accessibility_label(`Note${n.comment ? `: ${n.comment}` : ""}. ${marked ? "Marked" : "Not marked"}`)
      .on_hover((h, cx) => { const next = h ? n.id : this.hover === n.id ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
      .on_click((e, cx) => {
        this.nav.sel = index;
        this.nav.focus();
        if (e.click_count === 2) this.edit(n);
        cx.notify();
      })
      .child(h_flex().h(20).gap(8).items_center()
        .child(div().id(`an-mark-${n.id}`).size(14).flex_none().rounded(4).border(1).flex().items_center().justify_center()
          .border_color(marked ? t.accent : t.border).when(marked, (el) => el.bg(t.accent))
          .cursor_pointer().tooltip(marked ? "Unmark" : "Mark: send only the marked notes").accessibility_label(marked ? "Unmark" : "Mark")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleMark(n.id); cx.notify(); })
          .when(marked, (el) => el.child(svg(`${OWN}/check.svg`).size(10).text_color(t.solid_foreground ?? t.background))))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(ago(now - n.at)))
        .when(on || hovered, (el) => el
          .child(this.smallButton(t, `an-edit-${n.id}`, "square-pen", "Edit (e)", () => this.edit(n)))
          .child(this.smallButton(t, `an-del-${n.id}`, "trash", "Delete (dd)", () => this.drop([n.id])))))
      .when(lines.length > 0, (el) => el.child(v_flex().id(`an-q-${n.id}`).pl(8).border_l(2).border_color(t.border)
        .font_family(mono).text_size(11).text_color(t.muted)
        .children(lines.slice(0, CARD_LINES).map((l, i) => div().id(`an-q-${n.id}-${i}`).truncate().child(l || " ")))
        .when(more > 0, (el) => el.child(div().text_color(t.dim).child(`+${more} more`)))))
      .child(n.comment
        ? div().text_size(12.5).text_color(t.foreground).child(n.comment)
        : div().text_size(12).text_color(t.dim).child("No comment"))
      .when(Boolean(n.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(`Not sent: ${n.error}`)));
  }

  groupHead(t, g) {
    const name = g.source?.label || "Terminal";
    const where = [this.all ? g.source?.space_name : null, g.source?.tab_name].filter(Boolean).join(" / ");
    return h_flex().id(`an-g-${g.terminal}`).h(26).px(2).mt(4).gap(7).items_center().flex_none().rounded(5).cursor_pointer()
      .text_size(11.5).tooltip(`Go to ${sourceName(g.source)}`).accessibility_label(`${name}, ${g.notes.length} notes. Go there`)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => this.jump(g.notes[0], cx))
      .child(icon(g.source, 13, t.muted))
      .child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(name))
      .child(div().flex_none().text_color(t.dim).child(g.terminal))
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(where)))
      .child(div().flex_1())
      .child(div().flex_none().pr(4).text_color(t.dim).child(String(g.notes.length)));
  }

  queueStrip(t, q) {
    const agent = agents().find((a) => a.address === q.to);
    const sending = agent && ready(agent.status);
    const color = sending ? t.working : t.dim;
    return h_flex().id(`an-queue-${q.to}`).w_full().flex_none().px(10).py(7).gap(8).items_center().rounded(8)
      .bg(color + "14").border(1).border_color(color + "40")
      .child(sending
        ? svg(`${ICONS}/spinner.svg`).size(12).flex_none().text_color(color).spin(900)
        : svg(`${OWN}/clock.svg`).size(12).flex_none().text_color(color))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12).child(`${q.notes.length} for ${this.agentName(q.to)}`))
        .child(div().text_size(11).text_color(t.dim).child(sending ? "Sending…" : `Sends when it's idle${agent ? ` (now ${agent.status === "blocked" ? "needs you" : agent.status})` : ""}`)))
      .child(div().id(`an-unqueue-${q.to}`).flex_none().px(6).h(22).flex().items_center().rounded(5).text_size(11.5).text_color(t.muted)
        .cursor_pointer().accessibility_label(`Cancel sending to ${q.to}`).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.setNotes(unqueue(notesOf(shared(KEY)), { to: q.to })); })
        .child("Cancel"));
  }

  actionBar(t, pending) {
    const notes = this.chosen(pending);
    const n = notes.length;
    const to = n ? this.targetFor(notes) : null;
    const some = this.marked.size > 0;
    const btn = (id, label, tip, action, primary = false) => div().id(id).h(26).px(9).flex().items_center().flex_none().rounded(6)
      .text_size(12).accessibility_label(tip).tooltip(tip)
      .border(1).border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.chrome).text_color(primary ? t.solid_foreground : t.foreground)
      .when(n > 0, (el) => el.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); }))
      .when(n === 0, (el) => el.opacity(0.5))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(label);
    const list = this.agentList();
    return v_flex().id("an-actions").flex_none().px(10).py(8).gap(6).border_t(1).border_color(t.border).bg(t.chrome)
      .when(this.picking, (el) => el.child(v_flex().id("an-pick").gap(1).max_h(200).overflow_y_scrollbar()
        .when(!list.length, (el) => el.child(div().px(6).py(4).text_size(12).text_color(t.dim).child("No agents running")))
        .children(list.map((a) => h_flex().id(`an-pick-${a.address}`).h(26).px(6).gap(7).items_center().rounded(5).cursor_pointer()
          .text_size(12).bg(a.address === to ? t.selected : t.chrome)
          .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.target = a.address; this.picking = false; cx.notify(); })
          .child(icon(a.program, 13, t.foreground))
          .child(div().flex_1().min_w(0).truncate().child(this.agentName(a.address)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(a.space_name ?? ""))
          .child(div().size(6).flex_none().rounded(3).bg(t[a.status] ?? t.dim))))))
      .child(h_flex().gap(6).items_center()
        .child(h_flex().id("an-target").flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(6).border(1)
          .border_color(this.picking ? t.accent : t.border).cursor_pointer().text_size(12)
          .tooltip("Who gets them (t)").accessibility_label(`Send to ${to ? this.agentName(to) : "nobody yet"}. Change`)
          .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.picking = !this.picking; cx.notify(); })
          .child(div().flex_none().text_color(t.dim).child("To"))
          .child(div().flex_1().min_w(0).truncate().text_color(to ? t.foreground : t.dim).child(to ? this.agentName(to) : "Pick an agent"))
          .child(div().flex_none().text_size(9).text_color(t.dim).child(this.picking ? "▴" : "▾")))
        .child(btn("an-copy", "Copy", `Copy ${some ? "marked" : "all"} as Markdown (yy)`, (cx) => this.copy(pending, cx)))
        .child(btn("an-paste", "Paste", "Paste into the agent's prompt without sending (p)", (cx) => this.paste(pending, cx)))
        .child(btn("an-send", n ? `Send ${n}` : "Send", "Send as the agent's next message; waits until it's idle (s)", (cx) => this.send(pending, cx), true)))
      .when(Boolean(this.flash), (el) => el.child(div().text_size(11.5).text_color(this.flash.ok ? t.ansi2 : t.blocked).child(this.flash.text)));
  }

  renderPanel() {
    const t = theme();
    const now = Date.now();
    const mono = settings().font_family ?? "JetBrains Mono";
    const space = focused()?.space;
    const all = notesOf(shared(KEY));
    const inView = all.filter((n) => this.all || n.source?.space === space);
    const pending = inView.filter((n) => !n.queued);
    const queued = queuedByTarget(inView);
    this.queuedHere = inView.filter((n) => n.queued);
    // Marks for notes that are gone (sent, deleted, another space) don't count.
    for (const id of [...this.marked]) if (!pending.some((n) => n.id === id)) this.marked.delete(id);
    const elsewhere = all.length - inView.length;
    const kbd = this.nav.focused();
    const items = [];
    const kids = [];
    for (const q of queued) kids.push(this.queueStrip(t, q));
    for (const g of groups(pending)) {
      kids.push(this.groupHead(t, g));
      for (const n of g.notes) {
        items.push({ ...n, section: kids.length });
        kids.push(this.card(t, n, items.length - 1, kbd && this.nav.sel === items.length - 1, now, mono));
      }
    }
    if (!pending.length && !queued.length) kids.push(v_flex().px(4).py(8).gap(4)
      .child(div().text_color(t.muted).child(this.all ? "No annotations" : "No annotations in this space"))
      .child(div().text_size(12).text_color(t.dim).child("Select text in a terminal, then press Ctrl+B A or right-click › Annotate selection."))
      .when(elsewhere > 0, (el) => el.child(div().id("an-show-all").mt(4).text_size(12).text_color(t.accent).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.all = true; try { localStorage.setItem("all", "1"); } catch {} cx.notify(); })
        .child(`Show ${elsewhere} in other spaces`))));
    this.items = items;
    this.nav.clamp(items.length);
    return v_flex().id("annotate-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx, pending))
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Annotations"))
        .when(pending.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(pending.length))))
        .child(div().flex_1())
        .child(div().id("an-scope").h(22).px(7).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
          .text_color(t.muted).border(1).border_color(t.border)
          .tooltip(this.all ? "Showing every space (a)" : "Showing this space (a)").accessibility_label(this.all ? "All spaces. Show this space only" : "This space. Show all spaces")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.all = !this.all; try { localStorage.setItem("all", this.all ? "1" : "0"); } catch {} cx.notify(); })
          .child(this.all ? "All spaces" : "This space")))
      .child(v_flex().id("annotate-scroll").flex_1().min_h(0).px(10).pb(10).gap(6).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(kids))
      .when(pending.length > 0, (el) => el.child(this.actionBar(t, pending)))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["s", "send"], ["x", "mark"], ["p", "paste"], ["t", "to"], ["↵", "go to source"], ["e", "edit"], ["dd", "delete"], ["yy", "copy"], ["a", "all spaces"], ["u", "cancel queued"]], this.nav.help)));
  }

  render() {
    return this.dialog ? this.renderDialog() : this.renderPanel();
  }
}
