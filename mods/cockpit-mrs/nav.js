// Vim-style keyboard navigation for a Cockpit panel or sidebar list. The same file lives in every mod
// that uses it (mods can't import each other); tests/feedlib.test.mjs checks the copies stay equal.
//
// Everywhere:
//   j k / ↓ ↑        move (a count first: 5j)       gg G        top, bottom
//   ctrl-d ctrl-u    half a page                     ctrl-h/j/k/l  to the pane on that side (tmux-navigator)
//   h / esc          back to where you came from     ?           all keys for this panel
//   q                close this panel (its half)
// Panels add their own: enter/o/l open, x/space toggle, dd delete, yy copy, r refresh, / filter…
//
// A copy takes the keyboard on the "focus" command ("focus-lower" for a copy in the panel's lower half),
// which the tab bar sends after opening it from the keyboard, and pane.go sends when you move onto it.

const PAGE = 6;
const PREFIX = new Set(["g", "d", "y", "z"]);

// "shift-g" → "G", "ctrl-d" stays, "enter" stays: one spelling per key for the action tables.
export function keyName(e) {
  const m = e.modifiers ?? {};
  if (m.platform || m.alt || m.function) return null;
  const key = e.key;
  if (m.control) return `ctrl-${key}`;
  if (key.length === 1) return m.shift ? (e.key_char ?? key.toUpperCase()) : key;
  if (key === "space") return m.shift ? null : "space";
  return m.shift ? `shift-${key}` : key;
}

export class Nav {
  // leave: which way h / esc go (a side panel sits right of the terminal: "left").
  // slot: "lower" for a copy in the panel's lower half (q closes that half, not the whole panel).
  constructor(cx, { leave = "left", slot = null } = {}) {
    this.slot = slot;
    this.handle = cx.focus_handle();
    this.sel = 0;
    this.count = "";
    this.pending = null;
    this.leave = leave;
    this.help = false;
  }

  focused() {
    return this.handle.is_focused();
  }

  // Focus has no "lost" event: redraw when the keyboard arrives or leaves, so the highlighted row and
  // the key footer never outstay it. It redraws only on a change, and looks often (300 ms) only while
  // this copy has the keyboard: arriving goes through focus() or a click, which redraw anyway, so the
  // slow look (1.5 s) is just a safety net. Every panel copy runs one, shown or not.
  watch(cx) {
    this.shown = this.focused();
    const look = (cx) => {
      const k = this.focused();
      if (k !== this.shown) { this.shown = k; cx.notify(); }
      cx.timer.after(k ? 300 : 1500, look);
    };
    cx.timer.after(300, look);
  }

  // Whether a nextCommand string asks this copy (upper or lower half) to take the keyboard.
  wants(command, slot) {
    return command === (slot === "lower" ? "focus-lower" : "focus");
  }

  focus() {
    this.handle.focus();
  }

  // Keeps `sel` inside a list of n rows.
  clamp(n) {
    this.sel = Math.max(0, Math.min(this.sel, n - 1));
    return this.sel;
  }

  // Handles one key. n: how many rows; actions: { "enter": (i) => …, "dd": (i) => …, … }.
  // Returns true when the key was used (the caller stops it and redraws).
  key(e, n, actions = {}, run) {
    const k = keyName(e);
    if (!k) return false;
    // A pending prefix: gg, dd, yy, zz…
    if (this.pending) {
      const combo = this.pending + k;
      this.pending = null;
      if (combo === "gg") { this.sel = 0; this.count = ""; return true; }
      if (actions[combo]) { actions[combo](this.clamp(n)); this.count = ""; return true; }
      this.count = "";
      return true; // an unknown pair is swallowed, as in vim
    }
    if (/^[1-9]$/.test(k) || (k === "0" && this.count)) { this.count += k; return true; }
    const times = Math.max(1, Number(this.count) || 1);
    const hadCount = Boolean(this.count);
    this.count = "";
    if (k === "?") { this.help = !this.help; return true; }
    if (actions[k]) { actions[k](this.clamp(n), times); return true; }
    switch (k) {
      case "j": case "down": this.sel = Math.min(n - 1, this.sel + times); this.clamp(n); return true;
      case "k": case "up": this.sel = Math.max(0, this.sel - times); return true;
      case "G": this.sel = hadCount ? times - 1 : n - 1; this.clamp(n); return true;
      case "ctrl-d": this.sel = Math.min(n - 1, this.sel + PAGE); this.clamp(n); return true;
      case "ctrl-u": this.sel = Math.max(0, this.sel - PAGE); return true;
      case "ctrl-h": run("pane.go", { direction: "left" }); return true;
      case "ctrl-j": run("pane.go", { direction: "down" }); return true;
      case "ctrl-k": run("pane.go", { direction: "up" }); return true;
      case "ctrl-l": run("pane.go", { direction: "right" }); return true;
      // A side panel closes (only that half when it's the lower one); the sidebar has nothing to close.
      case "q":
        if (this.leave !== "left") return false;
        run(this.slot === "lower" ? "cockpit-tabs.close-lower" : "cockpit-tabs.close-panel"); return true;
      case "h": case "escape": case "ctrl-[":
        if (this.help) { this.help = false; return true; }
        run("pane.go", { direction: this.leave }); return true;
    }
    if (PREFIX.has(k)) { this.pending = k; return true; }
    return false;
  }
}

// What the footer shows while the panel has the keyboard: a few keys, or every key after `?`.
// items: [["j k", "move"], ["↵", "open"], …]
export const BASE_KEYS = [["j k", "move"], ["gg G", "top, bottom"], ["^d ^u", "half page"], ["^h ^j ^k ^l", "next pane"], ["h esc", "back"], ["q", "close panel"], ["?", "all keys"]];

// The footer, drawn with the caller's builders (this file imports nothing, so node can test it).
// keys: the panel's own [["↵", "open"], …]; help: show every key, base ones included.
export function footer({ h_flex, div }, t, keys, help) {
  const items = help ? [...keys, ...BASE_KEYS] : [...keys.slice(0, 4), ["?", "all keys"]];
  return h_flex().id("nav-footer").flex_none().flex_wrap().px(14).py(7).gap_x(12).gap_y(4).border_t(1).border_color(t.border).bg(t.chrome)
    .text_size(10.5).text_color(t.dim)
    .children(items.map(([k, what], i) => h_flex().id(`nav-key-${i}`).gap(4).items_center()
      .child(div().text_color(t.muted).font_medium().child(k))
      .child(div().child(what))));
}
