// Review: opens Hunk (https://www.hunk.dev/) on the repository of the terminal you are in, and
// lists the Hunk windows that are open so you can jump to a file or a comment inside one.
// Runs `git` (read-only, in the focused terminal's folder) and `hunk` (`session list`/`navigate`
// against the local daemon). A Hunk window opens only when you press a button.
// Local repositories only: Hunk's daemon lives on this computer.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { exec, focused, panes, spaces, terminals, run, theme, window, settings, layout, props, nextCommand } from "herdr";
import { Nav, footer } from "./nav.js";

const ICONS = "mods/cockpit-workspace-chrome";
// Hunk windows drawn at once: a view with ~120 rich cards runs out of render time. More on request.
const PAGE = 40;

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

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

async function git(cwd, args) {
  const r = await exec("git", args, { cwd, timeout: 15000 });
  return r.code === 0 ? r.stdout.trim() : null;
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
  return Boolean(panel && !panel.hidden && findNode(root, "panel-body")?.active === id);
}

export default class Review extends View {
  init(_props, cx) {
    this.repo = null; // { root, branch, base, changed, staged, ahead } for the focused terminal
    this.note = null;
    this.sessions = [];
    this.open = null; // the expanded Hunk window's id
    this.limit = PAGE; // Hunk windows drawn
    this.place = load("place", "right"); // "right" beside the focused pane, or "tab"
    this.cwd = undefined;
    this.last = 0;
    // Keyboard: the launch rows, then the open Hunk windows (rebuilt on each render).
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
    // The repository follows the terminal you are in and Hunk windows are polled gently, both only
    // while this pane is the one shown (and at once when it opens).
    cx.timer.every(2000, (cx) => {
      // The first look runs even with the window in the background, so the pane never sits on "Looking…".
      if (shown("review") && this.cwd === undefined && !this.firstLook) { this.firstLook = true; this.refreshRepo(cx); return; }
      if (!window()?.active || !shown("review")) return;
      const now = Date.now();
      if (now - this.last > 10000) {
        this.last = now;
        this.refreshRepo(cx);
        this.refreshSessions(cx);
      } else if ((focused()?.cwd ?? null) !== this.cwd) {
        this.refreshRepo(cx);
      }
    });
  }

  refreshRepo(cx) {
    const f = focused();
    const cwd = f?.cwd ?? null;
    this.cwd = cwd;
    if (!cwd || (f?.terminal ?? "").includes("/")) {
      this.repo = null;
      this.remote = Boolean(cwd);
      cx.notify();
      return;
    }
    this.remote = false;
    // The terminal you are in first; if it isn't in a repository, the others in this space.
    const tabIds = new Set((spaces().find((s) => s.active)?.tabs ?? []).map((tab) => tab.id));
    // The folder a program runs in (an agent's worktree) is in the terminal list, not the pane's own folder.
    // The folder the pane reports as you move around. The terminal list's folder is only where the
    // terminal started, so it is the last resort.
    const started = new Map(terminals().map((x) => [x.address, x.cwd]));
    const folderOf = (p) => p.cwd ?? started.get(p.terminal);
    const inTab = panes().filter((p) => p.terminal && tabIds.has(p.tab));
    const mine = inTab.find((p) => p.terminal === f?.terminal);
    const candidates = [...new Set([mine ? folderOf(mine) : cwd, cwd, ...inTab.map(folderOf)].filter(Boolean))].slice(0, 6);
    cx.spawn(async (cx) => {
      try {
        let root = null;
        for (const c of candidates) {
          root = await git(c, ["rev-parse", "--show-toplevel"]);
          if (root) break;
        }
        if (!root) {
          this.repo = null;
        } else {
          const [branch, status, head] = await Promise.all([
            git(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
            git(root, ["status", "--porcelain=v1"]),
            git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]),
          ]);
          let baseRef = head;
          // No origin/HEAD recorded: fall back to a branch that exists.
          for (const guess of baseRef ? [] : ["origin/develop", "origin/main", "origin/master"]) {
            if (await git(root, ["rev-parse", "--verify", "-q", guess])) { baseRef = guess; break; }
          }
          const ahead = baseRef ? Number(await git(root, ["rev-list", "--count", `${baseRef}..HEAD`])) || 0 : 0;
          let changed = 0, staged = 0;
          for (const line of (status ?? "").split("\n").filter(Boolean)) {
            const x = line[0], y = line[1];
            if (x !== " " && x !== "?") staged++;
            if (y !== " " || x === "?") changed++;
          }
          this.repo = { root, branch: branch ?? "detached", base: baseRef, changed, staged, ahead };
        }
      } catch {
        this.repo = null;
      }
      cx.notify();
    });
  }

  refreshSessions(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hunk", ["session", "list", "--json"], { timeout: 15000 });
        // No daemon running means no Hunk window is open.
        this.sessions = r.code === 0 ? JSON.parse(r.stdout).sessions ?? [] : [];
      } catch {
        this.sessions = [];
      }
      cx.notify();
    });
  }

  launch(label, argv, cx) {
    const repo = this.repo;
    if (!repo) return;
    this.note = null;
    run("terminal.open", { argv, folder: repo.root, place: this.place, name: `Hunk · ${label}` });
    this.note = { ok: true, text: `Opened ${label.toLowerCase()} in Hunk` };
    cx.notify();
    // The window registers with the daemon a moment after it starts.
    cx.timer.after(1800, (cx) => this.refreshSessions(cx));
  }

  onKey(e, cx) {
    const it = () => this.items[this.nav.sel];
    const open = () => it()?.open(cx);
    const used = this.nav.key(e, this.items.length, {
      enter: open, o: open, l: open,
      t: () => { this.place = this.place === "tab" ? "right" : "tab"; save("place", this.place); },
      r: () => { this.refreshRepo(cx); this.refreshSessions(cx); },
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  // Jump inside an open Hunk window without switching to it.
  jump(session, args, cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hunk", ["session", "navigate", session.sessionId, ...args, "--json"], { timeout: 15000 });
        this.note = r.code === 0 ? { ok: true, text: "Moved in Hunk" } : { ok: false, text: (r.stderr || r.stdout || "Hunk didn't move").trim().split("\n")[0] };
      } catch {
        this.note = { ok: false, text: "Hunk didn't move" };
      }
      cx.notify();
    });
  }

  // The pane showing this Hunk window, found by its folder and program.
  paneOf(session) {
    return panes().find((p) => p.terminal && (p.cwd === session.cwd || p.cwd === session.repoRoot) && /hunk/i.test(`${p.program?.key ?? ""} ${p.program?.name ?? ""} ${p.title ?? ""}`)) ?? null;
  }

  // A quiet bordered button, as in Merge requests; `icon` puts a glyph before the label.
  button(t, id, label, action, { icon = null, tip = null } = {}) {
    return h_flex().id(id).h(22).px(7).gap(5).items_center().flex_none().rounded(5).border(1).text_size(11.5).cursor_pointer()
      .accessibility_label(tip ?? label).when(Boolean(tip), (el) => el.tooltip(tip))
      .border_color(t.border).bg(t.chrome).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .when(Boolean(icon), (el) => el.child(svg(icon).size(12).flex_none()))
      .child(label);
  }

  // A small coloured count, as the status chips in Merge requests.
  count(t, n, color) {
    const on = n > 0;
    return div().flex_none().h(18).min_w(18).px(5).flex().items_center().justify_center().rounded(4)
      .bg(on ? color + "26" : t.raised).text_size(11).font_medium().text_color(on ? color : t.dim).child(String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  }

  // A launch card: what it opens, how much there is to review, and the command it runs.
  launcher(t, id, icon, title, hint, count, argv, enabled, on = false) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const command = `hunk ${argv.slice(1).join(" ")}`;
    return h_flex().id(id).w_full().flex_none().px(10).py(8).gap(10).items_center().rounded(8).border(1)
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome)
      .accessibility_label(`${title}${count != null ? `, ${count}` : ""}. ${enabled ? "Open in Hunk" : "Nothing to review"}`)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => this.launch(title, argv, cx)))
      .child(div().size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .bg(enabled ? t.surface : t.chrome).border(1).border_color(t.border)
        .child(svg(icon).size(13).text_color(enabled ? t.muted : t.dim)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().id(`${id}-title`).truncate().font_medium().text_color(enabled ? t.foreground : t.dim).tooltip(title).child(title))
        .child(div().id(`${id}-hint`).truncate().text_size(10.5).text_color(t.dim).font_family(mono).tooltip(command).child(hint)))
      .when(count != null, (el) => el.child(this.count(t, count, t.working)))
      .when(enabled, (el) => el.child(svg(`${ICONS}/chevron-right.svg`).size(12).flex_none().text_color(on ? t.foreground : t.dim)));
  }

  // A file in an open Hunk window: its name first (it is what you look for), the folder after it.
  fileRow(t, s, f, i) {
    const cut = f.path.lastIndexOf("/");
    const name = cut < 0 ? f.path : f.path.slice(cut + 1);
    const dir = cut < 0 ? "" : f.path.slice(0, cut);
    return h_flex().id(`hunk-file-${s.sessionId}-${i}`).h(24).px(6).gap(6).items_center().rounded(5)
      .text_size(11.5).cursor_pointer().accessibility_label(`Go to ${f.path} in Hunk`).tooltip(f.path)
      .hover((c) => c.bg(t.hover)).active((c) => c.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.jump(s, ["--file", f.path, "--hunk", "1"], cx);
      })
      .child(div().id(`hunk-file-name-${s.sessionId}-${i}`).min_w(0).truncate().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
      .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.additions ?? 0}`))
      .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.deletions ?? 0}`));
  }

  windowCard(t, s, on = false) {
    const open = this.open === s.sessionId;
    const pane = this.paneOf(s);
    const files = s.files ?? [];
    const adds = files.reduce((n, f) => n + (f.additions ?? 0), 0);
    const dels = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
    const where = s.repoRoot ?? s.cwd ?? "";
    const title = s.title || base(where) || "Hunk window";
    const n = s.fileCount ?? files.length;
    return v_flex().id(`hunk-${s.sessionId}`).w_full().flex_none().rounded(8).border(1)
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : open ? t.surface : t.chrome)
      .child(h_flex().id(`hunk-head-${s.sessionId}`).px(10).py(8).gap(8).items_center().rounded(8).cursor_pointer()
        .accessibility_label(`${title}, ${n} ${n === 1 ? "file" : "files"}. ${open ? "Hide files" : "Show files"}`)
        .when(!on, (el) => el.hover((c) => c.bg(t.hover))).active((c) => c.bg(t.selected))
        .on_click((_e, cx) => {
          this.open = open ? null : s.sessionId;
          cx.notify();
        })
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().id(`hunk-title-${s.sessionId}`).truncate().font_medium().tooltip(title).child(title))
          .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim)
            .child(div().flex_none().child(`${n} ${n === 1 ? "file" : "files"}`))
            .child(div().flex_none().text_color(t.ansi2).child(`+${adds}`))
            .child(div().flex_none().text_color(t.ansi1).child(`−${dels}`))
            .child(div().id(`hunk-repo-${s.sessionId}`).flex_1().min_w(0).truncate().text_right().tooltip(where || "Unknown folder").child(base(where)))))
        .child(svg(`${ICONS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(open || on ? t.foreground : t.dim)))
      .when(open, (el) => el.child(v_flex().px(6).pb(8).gap(6)
        .child(div().mx(4).h(1).bg(t.border))
        .when(!files.length, (el) => el.child(div().px(6).text_size(11.5).text_color(t.dim).child("No files in this diff")))
        .child(v_flex().gap(1).children(files.slice(0, 14).map((f, i) => this.fileRow(t, s, f, i))))
        .when(files.length > 14, (el) => el.child(div().px(6).text_size(11).text_color(t.dim).child(`and ${files.length - 14} more in Hunk`)))
        .child(h_flex().px(4).gap(5).flex_wrap()
          .when(Boolean(pane), (el) => el.child(this.button(t, `hunk-focus-${s.sessionId}`, "Go to window", () => run("pane.focus", { pane: pane.pane }), { icon: `${ICONS}/terminal.svg` })))
          .child(this.button(t, `hunk-prev-${s.sessionId}`, "Previous", (cx) => this.jump(s, ["--prev-comment"], cx), { icon: `${ICONS}/chevron-left.svg`, tip: "Previous comment" }))
          .child(this.button(t, `hunk-next-${s.sessionId}`, "Next comment", (cx) => this.jump(s, ["--next-comment"], cx), { icon: `${ICONS}/chevron-right.svg` })))));
  }

  // Where Hunk opens: a toggle chip, as the filters in Merge requests.
  segment(t, id, label, icon, on, action) {
    return h_flex().id(id).h(24).px(8).gap(5).items_center().flex_none().rounded(6).text_size(11.5)
      .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .accessibility_label(`Open Hunk ${label.toLowerCase()}${on ? ", chosen" : ""}`).tooltip(on ? `${label} (t switches)` : `Open ${label.toLowerCase()} (t)`)
      .cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
        cx.notify();
      })
      .child(svg(icon).size(12).flex_none())
      .child(label);
  }

  // Nothing to show: a glyph, what is going on, and what to do about it.
  empty(t, icon, title, text) {
    return v_flex().py(24).px(12).gap(6).items_center()
      .child(svg(icon).size(20).text_color(t.dim))
      .child(div().font_medium().text_center().child(title))
      .when(Boolean(text), (el) => el.child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal().child(text)));
  }

  section(t, label, n, extra = null) {
    return h_flex().flex_none().h(24).px(2).mt(4).gap(6).items_center().text_size(11).font_medium()
      .child(div().text_color(t.dim).child(label))
      .when(n != null, (el) => el.child(div().text_color(t.dim).child(String(n))))
      .when(Boolean(extra), (el) => el.child(div().flex_1()).child(extra));
  }

  render() {
    const t = theme();
    const r = this.repo;
    const kbd = this.nav.focused();
    const mono = settings().font_family ?? "JetBrains Mono";
    const items = [];
    const kids = [];
    const sel = () => kbd && this.nav.sel === items.length - 1;
    // A launch card that has something to open; `section` is its place among the scroll area's children.
    const launch = (id, icon, title, hint, count, argv, enabled) => {
      if (enabled) items.push({ open: (cx) => this.launch(title, argv, cx), section: kids.length });
      kids.push(this.launcher(t, id, icon, title, hint, count, argv, enabled, enabled && sel()));
    };
    if (this.note && !this.note.ok) kids.push(div().px(10).py(8).rounded(6).border(1).border_color(t.blocked + "55").bg(t.blocked + "14")
      .text_size(12).text_color(t.blocked).whitespace_normal().child(this.note.text));
    if (this.note?.ok) kids.push(h_flex().px(4).gap(6).items_center().text_size(11.5).text_color(t.done)
      .child(svg(`${ICONS}/check.svg`).size(12).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(this.note.text)));
    if (this.remote) kids.push(this.empty(t, `${ICONS}/monitor.svg`, "Remote terminal",
      "This terminal is on another machine. Hunk reviews repositories on this computer only."));
    if (!r && !this.remote && this.cwd === undefined) kids.push(div().px(4).py(8).text_size(12).text_color(t.dim).child("Looking for the repository…"));
    if (!r && !this.remote && this.cwd !== undefined) kids.push(this.empty(t, `${ICONS}/folder.svg`, "Not a git repository",
      "The terminal you are in isn't inside a git repository. Move to one and this follows."));
    if (r) {
      const name = base(r.root);
      kids.push(h_flex().flex_none().h(30).px(10).gap(7).items_center().rounded(6).bg(t.surface)
        .child(svg(`${ICONS}/folder.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().id("review-repo").min_w(0).max_w(160).truncate().font_medium().tooltip(r.root).child(name))
        .child(svg(`${ICONS}/git-branch.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().id("review-branch").flex_1().min_w(0).truncate().font_family(mono).text_size(11).text_color(t.muted).tooltip(r.branch).child(r.branch)));
      kids.push(this.section(t, "Open a diff", null, h_flex().gap(4)
        .child(this.segment(t, "place-right", "Beside", `${ICONS}/panel-right.svg`, this.place === "right", () => { this.place = "right"; save("place", "right"); }))
        .child(this.segment(t, "place-tab", "New tab", `${ICONS}/plus.svg`, this.place === "tab", () => { this.place = "tab"; save("place", "tab"); }))));
      launch("open-working", `${ICONS}/square-pen.svg`, "Working changes", "hunk diff --watch", r.changed, ["hunk", "diff", "--watch"], r.changed > 0);
      launch("open-staged", `${ICONS}/circle-check.svg`, "Staged", "hunk diff --staged", r.staged, ["hunk", "diff", "--staged"], r.staged > 0);
      launch("open-commit", `${ICONS}/clock.svg`, "Last commit", "hunk show", null, ["hunk", "show"], true);
      if (r.base) launch("open-branch", `${ICONS}/git-compare.svg`, `Branch vs ${r.base}`, `hunk diff ${r.base}...HEAD`, r.ahead, ["hunk", "diff", `${r.base}...HEAD`], r.ahead > 0);
    }
    kids.push(this.section(t, "Open in Hunk", this.sessions.length));
    if (!this.sessions.length) kids.push(h_flex().px(10).py(10).gap(8).items_center().rounded(8).border(1).border_color(t.border)
      .child(svg(`${ICONS}/git-compare.svg`).size(14).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).whitespace_normal()
        .child(r ? "No Hunk window is open. Pick a diff above." : "No Hunk window is open.")));
    for (const s of this.sessions.slice(0, this.limit)) {
      // Enter on a window shows its files (or hides them), as a click does.
      items.push({ open: (cx) => { this.open = this.open === s.sessionId ? null : s.sessionId; cx.notify(); }, section: kids.length });
      kids.push(this.windowCard(t, s, sel()));
    }
    // A view with ~120 rich cards runs out of render time: more on request.
    if (this.sessions.length > this.limit) kids.push(h_flex().py(4).justify_center()
      .child(this.button(t, "review-more", `Show ${Math.min(PAGE, this.sessions.length - this.limit)} more of ${this.sessions.length - this.limit}`,
        (cx) => { this.limit += PAGE; cx.notify(); })));
    this.items = items;
    this.nav.clamp(items.length);
    const windows = this.sessions.length;
    return v_flex().id("review-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().flex_none().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Review"))
        .when(windows > 0, (el) => el.child(div().flex_none().text_size(11.5).font_medium().text_color(t.working)
          .child(`${windows} open`)))
        .child(div().flex_1())
        .child(div().id("review-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .tooltip("Refresh (r)").accessibility_label("Refresh review")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => {
            this.refreshRepo(cx);
            this.refreshSessions(cx);
          })
          .child(svg("mods/cockpit-review/refresh.svg").size(13))))
      .child(v_flex().id("review-scroll").flex_1().min_h(0).px(10).pb(12).gap(6).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(kids))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ o", "open"], ["t", "beside or new tab"], ["r", "refresh"]], this.nav.help)));
  }
}
