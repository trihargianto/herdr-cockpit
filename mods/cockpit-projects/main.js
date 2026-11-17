// Projects: folders you always work in. Click one to focus its space, or open a new space there.
// The list is kept in shared state ("cockpit.projects"), so it survives restarts and stays out of git.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import * as fs from "fs/promises";
import { spaces, panes, theme, run, home, notify, shared, setShared, nextCommand, exec, settings, props } from "herdr";
import { Nav, footer } from "./nav.js";

const KEY = "cockpit.projects";
const ICONS = "mods/cockpit-workspace-chrome";
const OWN = "mods/cockpit-projects";
// Cards drawn at once: a view with ~120 rich cards runs out of render time. The keyboard and
// "Show more" draw more.
const PAGE = 60;
const HOME = home().replace(/\/$/, "");

const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;
const parent = (p) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
const abbrev = (p) => (p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
const expand = (raw) => {
  const s = raw.trim();
  const p = s === "~" ? HOME : s.startsWith("~/") ? HOME + s.slice(1) : s;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
};
// How well a project matches what you typed, or 0 for no match. The name counts more than the path;
// letters in order with gaps match too ("mweb" finds mamikos-web), below a plain substring.
function score(path, query) {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const name = base(path).toLowerCase(), full = abbrev(path).toLowerCase();
  if (name.startsWith(q)) return 5;
  if (name.includes(q)) return 4;
  if (full.includes(q)) return 3;
  const inOrder = (text) => { let i = 0; for (const ch of text) if (ch === q[i]) i++; return i === q.length; };
  if (inOrder(name)) return 2;
  return inOrder(full) ? 1 : 0;
}

const inside = (cwd, path) => Boolean(cwd) && (cwd === path || cwd.startsWith(path === "/" ? "/" : path + "/"));

export default class Projects extends View {
  init(_props, cx) {
    const saved = shared(KEY);
    this.list = Array.isArray(saved) ? saved.filter((p) => typeof p === "string") : [];
    this.missing = new Set();
    this.adding = false;
    this.root = HOME;
    this.expanded = new Set();
    this.kids = new Map();
    this.ticked = new Set();
    this.showHidden = false;
    this.invalid = false;
    this.hover = null;
    this.limit = PAGE;

    // Keyboard (vim-style). `sel` is the highlighted project, `cur` the highlighted folder in the tree.
    // The list view uses the shared vim keys (nav.js); the add tree keeps its own below.
    this.nav = new Nav(cx, { slot: props()?.slot ?? null });
    this.nav.watch(cx);
    this.handle = this.nav.handle;
    this.listScroll = ScrollHandle.new();
    this.treeScroll = ScrollHandle.new();
    this.cur = null;
    this.typing = false; // the path field has the keyboard
    // `/` filters the list: the field shows while it has the keyboard or holds text.
    this.query = "";
    this.searching = false; // the filter field has the keyboard
    this.findIn = InputState.new({ placeholder: "Filter projects  ( / )" });
    this.findIn.on("change", (_e, cx) => {
      const q = this.findIn.value();
      if (q === this.query) return;
      this.query = q;
      this.sel = 0;
      this.limit = PAGE;
      cx.notify();
    });
    // Enter keeps the filter and gives the list the keyboard, on the best match.
    this.findIn.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.findIn.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
    this.findIn.on("blur", (_e, cx) => {
      this.searching = false;
      cx.notify();
    });

    this.pathIn = InputState.new({ placeholder: "Go to a folder, press Enter" });
    this.pathIn.on("submit", (_e, cx) => { this.jump(this.pathIn.value(), cx); this.handle.focus(); });
    this.pathIn.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.pathIn.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.checkMissing(cx);
    // Focus handles report no blur: a cheap check redraws once when the keyboard leaves (or arrives),
    // so the highlight and the key footer don't linger.
    // "focus" arrives when pane.go (Ctrl+B l) or the leader moves onto this panel.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // "cockpit-projects.search": open the filter line (as `/` does).
        if (c === "search") { this.search(cx); continue; }
        if (c === "focus") { this.handle.focus(); cx.notify(); }
      }
    });
  }

  async checkMissing(cx) {
    const gone = new Set();
    for (const p of this.list) if (!(await fs.exists(p))) gone.add(p);
    this.missing = gone;
    cx.notify();
  }

  save() {
    setShared(KEY, this.list);
  }

  // ---- add view: a folder tree. Each folder expands in place; tick any number of them.

  openAdd(cx, fromKeys = false) {
    this.adding = true;
    this.cur = HOME;
    this.ticked = new Set();
    this.expanded = new Set();
    this.kids = new Map(); // path -> [{ name, path }] once read, "error" when unreadable
    this.showHidden = false;
    this.invalid = false;
    this.pathIn.set_value(HOME);
    // From the keyboard the tree takes the keys (/ goes to the path field); a click starts in the field.
    if (fromKeys) this.handle.focus();
    else this.pathIn.focus();
    this.setRoot(HOME, cx);
    cx.notify();
  }

  async setRoot(path, cx) {
    this.root = path;
    this.cur = path;
    this.expanded = new Set([path]);
    await this.load(path, cx);
    cx.notify();
  }

  async load(path, cx) {
    if (this.kids.has(path)) return;
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      this.kids.set(path, entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: (path === "/" ? "" : path) + "/" + e.name }))
        .sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      this.kids.set(path, "error");
    }
    cx.notify();
  }

  async jump(raw, cx) {
    const path = expand(raw);
    if (!path.startsWith("/") || !(await fs.exists(path))) {
      this.invalid = true;
      cx.notify();
      return;
    }
    this.invalid = false;
    this.pathIn.set_value(path);
    await this.setRoot(path, cx);
  }

  expandToggle(path, cx) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else {
      this.expanded.add(path);
      this.load(path, cx);
    }
    cx.notify();
  }

  toggle(path, cx) {
    if (this.list.includes(path)) return;
    if (this.ticked.has(path)) this.ticked.delete(path);
    else this.ticked.add(path);
    cx.notify();
  }

  confirmAdd(cx) {
    const add = [...this.ticked].filter((p) => !this.list.includes(p));
    if (add.length) {
      this.list = [...this.list, ...add];
      this.save();
      this.checkMissing(cx);
    }
    this.adding = false;
    cx.notify();
  }

  // ---- list view

  // The spaces and panes, read once: a render asks for every project.
  places() {
    const all = spaces();
    const tabSpace = new Map();
    for (const s of all) for (const t of s.tabs) tabSpace.set(t.id, s.id);
    return { all, tabSpace, panes: panes() };
  }

  spaceFor(path, at = this.places()) {
    const hits = new Set();
    for (const p of at.panes) if (inside(p.cwd, path) && at.tabSpace.has(p.tab)) hits.add(at.tabSpace.get(p.tab));
    const matches = at.all.filter((s) => !s.machine && hits.has(s.id));
    return matches.find((s) => s.active) ?? matches[0] ?? null;
  }

  async open(path) {
    const hit = this.spaceFor(path);
    if (hit) return run("space.select", { id: hit.id });
    if (!(await fs.exists(path))) {
      notify({ title: "Folder not found", body: abbrev(path), level: "warning" });
      return;
    }
    run("space.new", { name: base(path), folder: path });
  }

  // A space set up for work: Agent (Claude), Edit (Neovim) and Runner (a shell, for the dev server)
  // tabs, all in the project folder. `herdr-app do` reports the new space's id for the next two tabs.
  start(path, cx) {
    const hit = this.spaceFor(path);
    if (hit) return run("space.select", { id: hit.id });
    cx.spawn(async () => {
      if (!(await fs.exists(path))) {
        notify({ title: "Folder not found", body: abbrev(path), level: "warning" });
        return;
      }
      try {
        const made = await exec("herdr-app", ["do", "space.new", JSON.stringify({ name: base(path), folder: path, tab: "Agent", argv: ["claude"] })], { cwd: path, timeout: 15000 });
        const space = JSON.parse(made.stdout || "{}").space;
        if (made.code !== 0 || !space) throw new Error((made.stderr || made.stdout).trim());
        await exec("herdr-app", ["do", "tab.new", JSON.stringify({ space, name: "Edit", folder: path, argv: ["nvim"], focus: false })], { cwd: path, timeout: 15000 });
        await exec("herdr-app", ["do", "tab.new", JSON.stringify({ space, name: "Runner", folder: path, focus: false })], { cwd: path, timeout: 15000 });
      } catch (e) {
        notify({ title: "Couldn't start the project", body: String(e.message ?? e).split("\n")[0], level: "error" });
      }
    });
  }

  // Removing takes a second press (click or x) within three seconds. Returns true once removed.
  askRemove(path, cx) {
    if (this.removing !== path) {
      this.removing = path;
      cx.notify();
      cx.timer.after(3000, (cx) => { if (this.removing === path) { this.removing = null; cx.notify(); } });
      return false;
    }
    this.removing = null;
    this.remove(path, cx);
    return true;
  }

  remove(path, cx) {
    this.list = this.list.filter((p) => p !== path);
    this.missing.delete(path);
    this.save();
    cx.notify();
  }

  // ---- keyboard

  // The tree's folders (not its notes), in order.
  folders() {
    return this.flat().filter((r) => !r.note);
  }

  // `sel` is the list's highlighted row; Nav keeps it.
  // The projects shown: all of them, or the matches for the filter, best first.
  view() {
    if (!this.query.trim()) return this.list;
    return this.list.map((p, i) => ({ p, i, s: score(p, this.query) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p);
  }

  // The cards drawn: the first `limit` of view(). Moving near the end draws more.
  shown() {
    return this.view().slice(0, this.limit);
  }

  more(total) {
    if (this.sel >= this.limit - 5 && total > this.limit) this.limit += PAGE;
  }

  // `/`: the filter field takes the keyboard. It is always on screen (a field that appears and is
  // focused in the same moment loses the keyboard), and it's focused here, not from a timer.
  search(cx) {
    this.findIn.focus();
    cx.notify();
  }

  clearSearch(cx) {
    this.query = "";
    this.findIn.set_value("");
    this.sel = 0;
    this.limit = PAGE;
    cx.notify();
  }

  get sel() { return this.nav.sel; }
  set sel(v) { this.nav.sel = v; }

  listKey(e, cx) {
    let list = this.shown();
    const n = list.length;
    const at = () => (list = this.shown())[this.sel];
    // Esc with a filter on clears it first; the next Esc leaves the panel.
    if (e.key === "escape" && this.query) { this.clearSearch(cx); return true; }
    const handled = this.nav.key(e, n, {
      enter: () => n && this.open(at()), l: () => n && this.open(at()), o: () => n && this.open(at()),
      s: () => n && this.start(at(), cx),
      x: () => { if (n && this.askRemove(at(), cx)) this.sel = Math.min(this.sel, this.view().length - 1); },
      dd: () => { if (n) { this.remove(at(), cx); this.sel = Math.min(this.sel, this.view().length - 1); } },
      "/": () => this.search(cx),
      a: () => this.openAdd(cx, true), "+": () => this.openAdd(cx, true),
      // G is the real bottom, not the last card drawn: draw them all (5G still goes to row 5).
      G: (_i, times) => {
        const total = this.view().length;
        if (!total) return;
        const to = times > 1 ? Math.min(total, times) - 1 : total - 1;
        this.limit = Math.max(this.limit, to + 1);
        this.sel = to;
      },
    }, run);
    this.sel = Math.max(0, this.sel);
    if (handled) this.more(this.view().length);
    if (handled && n) this.listScroll.scroll_to_item(this.sel);
    return handled;
  }

  treeKey(k, shift, cx) {
    const rows = this.folders();
    let i = Math.max(0, rows.findIndex((r) => r.path === this.cur));
    const at = rows[i];
    if (k === "j" || k === "down") i = Math.min(rows.length - 1, i + 1);
    else if (k === "k" || k === "up") i = Math.max(0, i - 1);
    else if (k === "g" && shift) i = rows.length - 1;
    else if (k === "g") i = 0;
    else if (k === "l" || k === "right") {
      // Open it; if it is open, step into its first folder.
      if (!this.expanded.has(at.path)) this.expandToggle(at.path, cx);
      else if (rows[i + 1]?.depth > at.depth) i += 1;
    } else if (k === "h" || k === "left") {
      // Close it; if it is closed, step out to its parent.
      if (this.expanded.has(at.path) && at.depth > 0) this.expandToggle(at.path, cx);
      else if (at.depth > 0) i = rows.findIndex((r) => r.path === parent(at.path));
      else if (this.root !== "/") { this.jump(parent(this.root), cx); return true; }
    } else if (k === "space" || k === "x") this.toggle(at.path, cx);
    else if (k === "enter") { if (this.ticked.size) this.confirmAdd(cx); else this.toggle(at.path, cx); }
    else if (k === "/") { this.pathIn.focus(); return true; }
    else if (k === "-") { if (this.root !== "/") this.jump(parent(this.root), cx); return true; }
    else if (k === "`" && shift) { this.jump(HOME, cx); return true; }
    else if (k === "." ) { this.showHidden = !this.showHidden; return true; }
    else if (k === "escape") { this.adding = false; return true; }
    else return false;
    this.cur = rows[Math.max(0, i)]?.path ?? this.cur;
    const flatIndex = this.flat().findIndex((r) => !r.note && r.path === this.cur);
    if (flatIndex >= 0) this.treeScroll.scroll_to_item(flatIndex);
    return true;
  }

  onKey(e, cx) {
    if (this.searching) {
      // In the filter field: Esc clears it and gives the list the keyboard; the arrows, Ctrl+N/P and
      // Ctrl+J/K move through the matches without leaving the field, as in fzf.
      const k = e.keystroke;
      const n = this.shown().length;
      if (k === "escape") { this.clearSearch(cx); this.handle.focus(); cx.stop_propagation(); return; }
      if (k === "down" || k === "ctrl-n" || k === "ctrl-j") { this.sel = Math.min(n - 1, this.sel + 1); }
      else if (k === "up" || k === "ctrl-p" || k === "ctrl-k") { this.sel = Math.max(0, this.sel - 1); }
      else return;
      this.more(this.view().length);
      if (n) this.listScroll.scroll_to_item(this.sel);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.typing) {
      // In the path field only Esc is ours: back to the tree.
      if (e.key === "escape") { this.handle.focus(); cx.stop_propagation(); }
      return;
    }
    const m = e.modifiers;
    if (!this.adding) {
      if (this.listKey(e, cx)) { cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (m.control || m.platform || m.alt) return;
    const handled = this.treeKey(e.key, m.shift, cx);
    if (handled) { cx.stop_propagation(); cx.notify(); }
  }

  // ---- drawing

  // The panel's title line, as in Merge requests and Automations: the title turns accent while the
  // panel has the keyboard, counts that need a look follow it in their color.
  header(t, title, focused, counts, right) {
    return h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
      .child(div().flex_none().text_size(13).font_semibold().text_color(focused ? t.accent : t.foreground).child(title))
      .children(counts.map(([label, color]) => div().flex_none().text_size(11.5).font_medium().text_color(color).child(label)))
      .child(div().flex_1())
      .child(right);
  }

  // A 24px icon button in the title line.
  iconButton(id, label, icon, t, onClick) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .cursor_pointer().text_color(t.dim).tooltip(label).accessibility_label(label)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .on_click(onClick).child(svg(icon).size(13));
  }

  // A quiet bordered button; with no label it's a square icon button and `tip` says what it does.
  button(t, id, label, action, { icon = null, tip = null, danger = false, size = 22 } = {}) {
    return h_flex().id(id).h(size).px(label ? 7 : 0).when(!label, (el) => el.w(size).justify_center()).gap(5).items_center().flex_none()
      .rounded(size > 22 ? 6 : 5).border(1).text_size(11.5).cursor_pointer()
      .border_color(danger ? t.blocked + "66" : t.border).bg(danger ? t.blocked + "1a" : t.chrome)
      .text_color(danger ? t.blocked : t.muted)
      .accessibility_label(tip ?? label).when(Boolean(tip), (el) => el.tooltip(tip))
      .hover((s) => s.bg(danger ? t.blocked + "26" : t.hover).text_color(danger ? t.blocked : t.foreground))
      .active((s) => s.bg(danger ? t.blocked + "33" : t.selected))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .when(Boolean(icon), (el) => el.child(svg(icon).size(12).flex_none()))
      .when(Boolean(label), (el) => el.child(label));
  }

  // The one filled button on screen. Off: a flat raised block that takes no clicks.
  primary(t, id, label, action, { grow = false, off = false } = {}) {
    return div().id(id).h(grow ? 30 : 26).px(12).flex().items_center().justify_center().flex_none().rounded(6)
      .text_size(12).font_medium().when(grow, (el) => el.flex_1())
      .bg(off ? t.raised : t.solid).text_color(off ? t.dim : t.solid_foreground).accessibility_label(label)
      .when(!off, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)).active((s) => s.opacity(0.8))
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .child(label);
  }

  chip(label, color) {
    return div().flex_none().h(16).px(5).flex().items_center().rounded(4).bg(color + "26").text_size(10.5).font_medium().text_color(color).child(label);
  }

  // One project. Click opens its space (or a new one); Start and Remove show on hover or under the
  // keyboard. The remove slot is always reserved so the name doesn't jump when it appears.
  row(path, t, i, kbd, places) {
    const open = Boolean(this.spaceFor(path, places));
    const gone = this.missing.has(path);
    const on = (kbd || this.searching) && i === this.sel;
    const hot = this.hover === path || (kbd && i === this.sel);
    const removing = this.removing === path;
    return h_flex().id(`project-${path}`).w_full().min_w(0).flex_none().px(10).py(8).gap(10).items_center()
      .rounded(8).border(1).border_color(on ? t.accent : gone ? t.blocked + "55" : t.border).bg(on ? t.selected : t.chrome)
      .cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover)).active((s) => s.bg(t.selected))
      .tooltip(gone ? `${path}\nFolder not found` : path)
      .accessibility_label(`${base(path)}, ${abbrev(path)}${open ? ", space open" : ""}${gone ? ", folder not found" : ""}`)
      .on_hover((over, cx2) => {
        if (over) this.hover = path;
        else if (this.hover === path) this.hover = null;
        cx2.notify();
      })
      .on_click(() => this.open(path))
      .child(svg(`${ICONS}/folder.svg`).size(14).flex_none().text_color(gone ? t.blocked : open ? t.done : t.dim))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(13).font_medium().text_color(gone ? t.muted : t.foreground).child(base(path)))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(abbrev(path))))
      .when(gone, (el) => el.child(this.chip("Not found", t.blocked)))
      .when(open && !hot, (el) => el.child(this.chip("Open", t.done)))
      .when(!open && !gone && hot, (el) => el.child(this.button(t, `project-start-${path}`, "Start", (cx2) => this.start(path, cx2), {
        icon: `${ICONS}/terminal.svg`, tip: `Start ${base(path)}: a new space with Agent (Claude), Edit (Neovim) and Runner tabs (s)` })))
      .child(div().flex_none().h(22).when(!removing, (el) => el.w(22))
        .when(hot || removing, (el) => el.child(this.button(t, `project-x-${path}`, removing ? "Remove?" : null, (cx2) => this.askRemove(path, cx2), {
          icon: `${OWN}/trash.svg`, danger: removing,
          tip: removing ? `Click again to remove ${base(path)}` : `Remove ${base(path)} (x twice, or dd)` }))));
  }

  renderList(t, cx) {
    const kbd = this.handle.is_focused();
    const all = this.view();
    const list = all.slice(0, this.limit);
    this.nav.clamp(list.length);
    const places = this.places();
    const openCount = this.list.filter((p) => this.spaceFor(p, places)).length;
    const gone = this.list.filter((p) => this.missing.has(p)).length;
    const counts = [];
    if (openCount) counts.push([`${openCount} open`, t.done]);
    if (gone) counts.push([`${gone} not found`, t.blocked]);
    // Always drawn: a field that is on screen before it's focused takes the keyboard reliably.
    const filtering = this.list.length > 0;
    const left = all.length - list.length;
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(this.header(t, "Projects", kbd || this.searching, counts, h_flex().gap(8).items_center()
        .when(Boolean(this.query) && !this.searching, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${all.length} of ${this.list.length}`)))
        .child(this.button(t, "projects-add", "Add", (cx) => this.openAdd(cx), { icon: `${ICONS}/plus.svg`, tip: "Add projects (a)" }))))
      // The filter line, vim's `/`.
      .when(filtering, (el) => el.child(h_flex().id("projects-filter").flex_none().mx(10).mb(8).h(30).px(9).gap(7).items_center().rounded(6).border(1)
        .border_color(this.searching ? t.accent : t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.search(cx); })
        .child(svg(`${ICONS}/search.svg`).size(12).flex_none().text_color(this.searching ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).child(Input.new(this.findIn).w_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(this.query), (el) => el.child(div().id("projects-filter-clear").flex_none().size(20).flex().items_center().justify_center().rounded(5)
          .text_color(t.dim).cursor_pointer().tooltip("Clear filter (Esc)").accessibility_label("Clear filter")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.clearSearch(cx); })
          .child(svg(`${ICONS}/x.svg`).size(12))))))
      // Cards first: scroll_to_item counts children, so card i must be child i.
      .child(v_flex().id("projects-scroll").flex_1().min_h(0).px(10).pb(12).gap(6).overflow_y_scrollbar().track_scroll(this.listScroll)
        .children(list.map((p, i) => this.row(p, t, i, kbd, places)))
        .when(left > 0, (el) => el.child(h_flex().py(4).justify_center()
          .child(this.button(t, "projects-more", `Show ${Math.min(PAGE, left)} more of ${left}`, (cx) => { this.limit += PAGE; cx.notify(); }))))
        .when(!this.list.length, (el) => el.child(v_flex().py(28).px(12).gap(8).items_center()
          .child(svg(`${ICONS}/folder.svg`).size(20).text_color(t.dim))
          .child(div().font_medium().text_size(13).child("No projects yet"))
          .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal()
            .child("Folders you work in. Click one to jump to its space, or start Agent, Edit and Runner tabs there."))
          .child(div().mt(4).child(this.primary(t, "projects-empty-add", "Add projects", (cx) => this.openAdd(cx))))))
        .when(this.list.length > 0 && !all.length, (el) => el.child(v_flex().px(4).py(8).gap(6)
          .child(div().id("projects-nomatch").truncate().text_color(t.muted).tooltip(this.query.trim()).child(`No project matches "${this.query.trim()}"`))
          .child(this.button(t, "projects-nomatch-clear", "Clear filter", (cx) => { this.clearSearch(cx); this.handle.focus(); }, { tip: "Clear filter (Esc)" }).self_start()))))
      .when(this.searching, (el) => el.child(footer({ h_flex, div }, t, [["↵", "keep filter, back to list"], ["↓ ↑ ^n ^p", "move"], ["Esc", "clear"]], false)))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t, [["/", "filter"], ["↵ o l", "open"], ["s", "start"], ["a", "add"], ["x", "remove (twice)"], ["dd", "remove now"]], this.nav.help)));
  }

  // The add tree's keys, drawn like nav.js's footer (whose `?` and base keys don't apply here).
  hints(t, items) {
    return h_flex().id("projects-tree-keys").flex_none().flex_wrap().px(14).py(7).gap_x(12).gap_y(4).border_t(1).border_color(t.border).bg(t.chrome)
      .text_size(10.5).text_color(t.dim)
      .children(items.map(([k, what], i) => h_flex().id(`projects-tree-key-${i}`).gap(4).items_center()
        .child(div().text_color(t.muted).font_medium().child(k))
        .child(div().child(what))));
  }

  check(on, disabled, t) {
    return div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border(1)
      .border_color(on ? (disabled ? t.dim : t.accent) : t.input).bg(on ? (disabled ? t.dim : t.accent) : t.background)
      .when(on, (el) => el.child(svg(`${ICONS}/check.svg`).size(10).text_color(disabled ? t.chrome : t.accent_foreground)));
  }

  // The visible tree, flattened to rows with a depth.
  flat() {
    const out = [];
    const walk = (path, name, depth) => {
      out.push({ path, name, depth });
      if (!this.expanded.has(path)) return;
      const kids = this.kids.get(path);
      if (kids === undefined) out.push({ path, depth: depth + 1, note: "Loading…" });
      else if (kids === "error") out.push({ path, depth: depth + 1, note: "Can't read this folder" });
      else {
        const shown = kids.filter((k) => this.showHidden || !k.name.startsWith("."));
        if (!shown.length) out.push({ path, depth: depth + 1, note: "No subfolders" });
        for (const k of shown) walk(k.path, k.name, depth + 1);
      }
    };
    walk(this.root, abbrev(this.root), 0);
    return out;
  }

  treeRow(r, t, kbd) {
    const indent = 6 + r.depth * 14;
    if (r.note) {
      return div().id(`note-${r.path}-${r.depth}`).h(26).flex_none().pl(indent + 42).flex().items_center()
        .text_size(11.5).text_color(r.note === "Can't read this folder" ? t.blocked : t.dim).child(r.note);
    }
    const already = this.list.includes(r.path);
    const on = already || this.ticked.has(r.path);
    const open = this.expanded.has(r.path);
    const cur = kbd && r.path === this.cur;
    return h_flex().id(`node-${r.path}`).w_full().min_w(0).h(28).flex_none().pl(indent).pr(8).gap(6).items_center()
      .rounded(6).cursor_pointer().when(cur, (el) => el.bg(t.selected)).hover((s) => s.bg(cur ? t.selected : t.hover)).active((s) => s.bg(t.selected))
      .accessibility_label(`${r.name}${open ? ", expanded" : ", collapsed"}${already ? ", already added" : on ? ", ticked" : ""}`)
      .on_click((_e, cx) => this.expandToggle(r.path, cx))
      .child(svg(`${ICONS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(div().id(`tick-${r.path}`).size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .tooltip(already ? "Already in Projects" : on ? "Untick" : "Add as a project")
        .accessibility_label(already ? `${r.name} is already in Projects` : on ? `Untick ${r.name}` : `Tick ${r.name} to add it`)
        .when(!already, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
        .on_click((_e, cx2) => {
          cx2.stop_propagation();
          this.toggle(r.path, cx2);
        })
        .child(this.check(on, already, t)))
      .child(svg(`${ICONS}/folder.svg`).size(13).flex_none().text_color(on && !already ? t.accent : t.dim))
      .child(div().id(`node-name-${r.path}`).flex_1().min_w(0).truncate().text_color(already ? t.dim : t.foreground)
        .when(r.depth === 0, (el) => el.font_medium()).tooltip(r.path).child(r.name))
      .when(already, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Added")));
  }

  renderAdd(t, cx) {
    const n = this.ticked.size;
    const kbd = this.handle.is_focused();
    const atTop = this.root === "/";
    const cancel = (_e, cx) => { this.adding = false; this.handle.focus(); cx.notify(); };
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(this.header(t, "Add projects", kbd || this.typing, n ? [[`${n} ticked`, t.accent]] : [],
        this.iconButton("projects-cancel", "Cancel (Esc)", `${ICONS}/x.svg`, t, cancel)))
      .child(v_flex().flex_none().px(10).pb(8).gap(8)
        .child(h_flex().gap(6).items_center()
          .child(this.button(t, "projects-up", null, (cx) => { if (!atTop) this.jump(parent(this.root), cx); }, { icon: `${OWN}/arrow-up.svg`, tip: "Up one folder (-)", size: 30 }))
          // The box is the field: a press on it focuses the input and stays away from the panel root,
          // which would take the keyboard (an Input's own on_mouse_down isn't wired).
          .child(div().id("projects-path").flex_1().min_w(0).h(30).px(9).flex().items_center().rounded(6).border(1)
            .border_color(this.invalid ? t.blocked : this.typing ? t.accent : t.input).bg(t.background).cursor_text()
            .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.pathIn.focus(); })
            .child(Input.new(this.pathIn).w_full().text_size(12).text_color(t.foreground).font_family(settings().font_family ?? "JetBrains Mono")))
          .child(this.button(t, "projects-home", null, (cx) => this.jump(HOME, cx), { icon: `${OWN}/house.svg`, tip: "Home (~)", size: 30 })))
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.invalid ? t.blocked : t.dim)
            .child(this.invalid ? "Not a folder" : "Open folders with the arrow, tick the ones to add"))
          .child(h_flex().id("projects-hidden").h(24).px(8).gap(5).items_center().flex_none().rounded(6).text_size(11.5)
            .border(1).border_color(this.showHidden ? t.accent : t.border).bg(this.showHidden ? t.selected : t.chrome)
            .text_color(this.showHidden ? t.foreground : t.muted).cursor_pointer()
            .tooltip("Show folders that start with a dot (.)").accessibility_label(`Hidden folders, ${this.showHidden ? "shown" : "hidden"}`)
            .hover((s) => s.bg(this.showHidden ? t.selected : t.hover)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => { this.showHidden = !this.showHidden; cx.notify(); })
            .child("Hidden folders"))))
      .child(v_flex().id("projects-tree").flex_1().min_h(0).px(8).gap(1).overflow_y_scrollbar().track_scroll(this.treeScroll)
        .children(this.flat().map((r) => this.treeRow(r, t, kbd))))
      .when(kbd, (el) => el.child(this.hints(t, [["j k", "move"], ["l h", "open, close"], ["␣", "tick"], ["↵", "add"], ["/", "path"], ["-", "up"], ["Esc", "cancel"]])))
      .child(h_flex().flex_none().px(10).py(10).border_t(1).border_color(t.border).child(
        this.primary(t, "projects-confirm", n ? `Add ${n} ${n === 1 ? "project" : "projects"}` : "Tick folders to add", (cx) => this.confirmAdd(cx), { grow: true, off: !n })));
  }

  render(cx) {
    const t = theme();
    return div().id("projects-root").size_full().track_focus(this.handle)
      // A click anywhere in the panel gives it the keyboard (rows still do their own thing).
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.adding ? this.renderAdd(t, cx) : this.renderList(t, cx));
  }
}
