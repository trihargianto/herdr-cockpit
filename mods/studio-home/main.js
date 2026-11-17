// Home: one look at what needs you now. Agents that are stuck or finished, merge requests waiting for
// your review, your MRs that are failing or blocked, the tasks you are doing (each followed through
// Jira, branch, agent and MR), your limits and the next automation, and what you shipped, with a
// standup you can copy.
// Most facts come from the tab bar's feed (shared "studio.mrs", "studio.limits", "studio.next");
// this pane reads tasks.json and, while shown, your merged MRs (`glab api`, read-only, every 10 min).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, spaces, panes, run, theme, settings, layout, props, shared, setShared, readTextFile, appHome, exec, home, window, nextCommand } from "herdr";
import { workOf } from "./work.js";
import { Nav, footer } from "./nav.js";

const ICONS = "mods/studio-workspace-chrome";
const OWN = "mods/studio-home";
const RUNNING = ["running", "pending", "created", "preparing", "waiting_for_resource"];

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function until(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function icon(p, size, color) {
  if (!p?.icon) return div().size(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).size(size).flex_none();
}

// Monday 00:00 of this week, and the start of the previous working day (Friday when today is Monday).
function weekStart(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
function lastWorkday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1));
  return d.getTime();
}

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
  const lower = props()?.slot === "lower";
  const stack = findNode(root, lower ? "panel-lower" : "panel-body");
  return Boolean(stack && !stack.hidden && stack.active === (lower ? `lower-${id}` : id));
}

// Panels open through the tab bar, which is always on screen, so every opener agrees.
const openPanel = (id) => run(`studio-tabs.show-${id}`);

export default class Home extends View {
  init(_props, cx) {
    this.tasks = [];
    this.archived = [];
    this.merged = null; // your MRs merged this week
    this.mergedAt = 0;
    this.range = (() => { try { return localStorage.getItem("range") ?? "day"; } catch { return "day"; } })();
    this.copied = false;
    // Keyboard: every row you can open, in screen order (rebuilt on each render), and where it sits.
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
    this.readTasks(cx);
    // Every 2 seconds: notices Home opening (merged MRs load then, not on the next slow tick) and keeps
    // tasks fresh while it's shown. Merged MRs refresh every 10 minutes; times redraw every 30 seconds.
    cx.timer.every(2000, (cx) => {
      const on = shown("home");
      const opened = on && !this.wasShown;
      this.wasShown = on;
      if (!on) return;
      const now = Date.now();
      if (opened || now - (this.tasksAt ?? 0) >= 5000) { this.tasksAt = now; this.readTasks(cx); }
      // The first load runs even in the background; later ones only with the window in front.
      if (this.merged === null || (window()?.active !== false && now - this.mergedAt > 600000)) this.readMerged(cx);
      if (now - (this.drawnAt ?? 0) >= 30000) { this.drawnAt = now; cx.notify(); }
    });
  }

  readTasks(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/studio-tasks/tasks.json`);
        const list = text ? JSON.parse(text) : [];
        // Done tasks moved to the archive still count for the standup: the last two weeks of it.
        const arch = await readTextFile(`${appHome()}/studio-tasks/tasks-archive.json`).catch(() => null);
        const since = Date.now() - 14 * 24 * 3600 * 1000;
        const archived = (arch ? JSON.parse(arch) : []).filter((x) => (x.archived ?? 0) >= since);
        if (JSON.stringify(list) !== JSON.stringify(this.tasks) || archived.length !== this.archived.length) {
          this.tasks = list;
          this.archived = archived;
          cx.notify();
        }
      } catch {}
    });
  }

  readMerged(cx) {
    if (this.mergingBusy) return;
    this.mergingBusy = true;
    this.mergedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const since = new Date(weekStart(Date.now())).toISOString();
        const r = await exec("glab", ["api", `merge_requests?scope=created_by_me&state=merged&updated_after=${encodeURIComponent(since)}&per_page=50`], { cwd: home(), timeout: 30000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "glab failed").trim().split("\n")[0]);
        this.mergedError = null;
        {
          this.merged = JSON.parse(r.stdout)
            .map((m) => ({ id: m.id, iid: m.iid, title: String(m.title).replace(/^Draft:\s*/i, ""), url: m.web_url, at: Date.parse(m.merged_at ?? m.updated_at), repo: (m.references?.full ?? "").replace(/!.*$/, "").split("/").pop() }))
            .filter((m) => m.at >= weekStart(Date.now()));
        }
      } catch (e) {
        // Show what's known and try again in a minute rather than "Loading…" for ten.
        this.merged ??= [];
        this.mergedError = String(e.message ?? e);
        this.mergedAt = Date.now() - 540000;
      }
      this.mergingBusy = false;
      cx.notify();
    });
  }

  // ---- keyboard

  onKey(e, cx) {
    const it = () => this.items[this.nav.sel];
    const used = this.nav.key(e, this.items.length, {
      enter: () => it()?.open(cx), o: () => it()?.open(cx), l: () => it()?.open(cx),
      p: () => { const a = it()?.agent; if (a) run("terminal.peek", { terminal: a }); },
      yy: () => { const u = it()?.url; if (u) cx.write_to_clipboard(u); },
      r: () => { run("studio-tabs.refresh"); this.readMerged(cx); this.readTasks(cx); },
      m: () => setShared("studio.quiet", !shared("studio.quiet")),
      c: () => this.copyStandup(cx),
      w: () => { this.range = this.range === "week" ? "day" : "week"; try { localStorage.setItem("range", this.range); } catch {} },
      i: () => run("studio-tabs.key-inbox"), t: () => run("studio-tabs.key-tasks"),
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  copyStandup(cx) {
    cx.write_to_clipboard(this.standup(Date.now()).text);
    this.copied = true;
    cx.notify();
    cx.timer.after(1400, (cx) => { this.copied = false; cx.notify(); });
  }

  // ---- pieces

  head(t, label, n, color, action) {
    return h_flex().flex_none().h(24).px(2).mt(6).gap(6).items_center().text_size(11).font_medium()
      .child(div().text_color(color ?? t.dim).child(label))
      .when(n != null, (el) => el.child(div().text_color(t.dim).child(String(n))))
      .child(div().flex_1())
      .when(Boolean(action), (el) => el.child(action));
  }

  link(t, id, label, onClick, tip) {
    return div().id(id).flex_none().h(20).px(6).flex().items_center().rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
      .tooltip(tip ?? label).accessibility_label(tip ?? label)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  // One clickable line: a mark on the left, a title, a quiet second part and something on the right.
  row(t, id, { mark, title, sub, right, tip, label, onClick, tone, on }) {
    return h_flex().id(id).w_full().flex_none().min_h(34).px(8).py(5).gap(8).items_center().rounded(7)
      .when(Boolean(tone), (el) => el.bg(tone + "14"))
      .when(Boolean(on), (el) => el.bg(t.selected))
      .cursor_pointer().accessibility_label(label ?? title)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => onClick(cx))
      .child(mark ?? div().size(16).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().id(`${id}-t`).truncate().font_medium().tooltip(tip ?? title).child(title))
        .when(Boolean(sub), (el) => el.child(div().id(`${id}-s`).truncate().text_size(11.5).text_color(t.dim).tooltip(sub).child(sub))))
      .when(Boolean(right), (el) => el.child(right));
  }

  dot(color) {
    return div().size(16).flex_none().flex().items_center().justify_center().child(div().size(7).rounded(4).bg(color));
  }

  bang(color) {
    return div().size(16).flex_none().rounded(4).bg(color + "26").text_size(10.5).font_bold().text_color(color).flex().items_center().justify_center().child("!");
  }

  pipeMark(t, status) {
    if (status === "failed") return this.bang(t.blocked);
    if (RUNNING.includes(status)) return div().size(16).flex_none().flex().items_center().justify_center().child(svg(`${ICONS}/spinner.svg`).size(12).text_color(t.working).spin(900));
    if (status === "success") return this.dot(t.ansi2);
    return this.dot(t.dim);
  }

  chip(t, id, text, color, onClick, tip) {
    return div().id(id).flex_none().h(18).px(5).flex().items_center().rounded(4).bg(color + "1f").text_size(10.5).font_medium().text_color(color)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(color + "33")).active((s) => s.bg(color + "40"))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .when(Boolean(tip), (el) => el.tooltip(tip).accessibility_label(tip))
      .child(text);
  }

  // A bar for one limit: green, then amber past 70%, red past 90%.
  meter(t, id, label, pct, resetAt, now) {
    const color = pct >= 90 ? t.blocked : pct >= 70 ? t.ansi3 : t.ansi2;
    const reset = resetAt && resetAt > now ? `resets in ${until(resetAt - now)}` : null;
    return v_flex().id(id).flex_1().min_w(0).gap(4)
      .tooltip(`${label}: ${pct}% used${reset ? `, ${reset}` : ""}`)
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().text_color(t.muted).child(label))
        .child(div().flex_1())
        .child(div().font_family(settings().font_family ?? "JetBrains Mono").text_color(pct >= 70 ? color : t.foreground).child(`${pct}%`)))
      .child(div().h(4).w_full().rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(color).w(`${Math.max(2, Math.min(100, pct))}%`)))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(reset ?? " "));
  }

  // ---- the standup

  standup(now) {
    const from = this.range === "week" ? weekStart(now) : lastWorkday(now);
    const merged = (this.merged ?? []).filter((m) => m.at >= from);
    const done = [...this.tasks, ...this.archived].filter((x) => x.status === "done" && (x.doneAt ?? x.updated ?? x.created ?? 0) >= from);
    const doing = this.tasks.filter((x) => x.status === "doing");
    const mrs = shared("studio.mrs");
    const failing = (mrs?.mine ?? []).filter((m) => m.pipeline === "failed" && !m.draft);
    const conflicts = (mrs?.mine ?? []).filter((m) => m.conflicts && !m.draft);
    const lines = [this.range === "week" ? "**This week**" : "**Since last workday**", ""];
    lines.push("Done:");
    if (!merged.length && !done.length) lines.push("- (nothing yet)");
    for (const m of merged) lines.push(`- ${m.title} (${m.repo} !${m.iid}, merged)`);
    for (const x of done) lines.push(`- ${x.title}`);
    lines.push("", "Doing:");
    if (!doing.length) lines.push("- (nothing in progress)");
    for (const x of doing) lines.push(`- ${x.title}`);
    lines.push("", "Blockers:");
    if (!failing.length && !conflicts.length) lines.push("- None");
    for (const m of failing) lines.push(`- Pipeline failing: ${m.title} (${m.repo} !${m.iid})`);
    for (const m of conflicts) lines.push(`- Conflicts: ${m.title} (${m.repo} !${m.iid})`);
    return { text: lines.join("\n"), merged, done };
  }

  // ---- render

  render() {
    const t = theme();
    const now = Date.now();
    const quiet = Boolean(shared("studio.quiet"));
    const mrs = shared("studio.mrs");
    const limits = shared("studio.limits") ?? {};
    const next = shared("studio.next");
    // Errors you dismissed stay hidden until their text changes.
    const dismissed = shared("studio.errors.dismissed") ?? [];
    const errors = (shared("studio.errors") ?? []).filter((e) => !dismissed.includes(e));
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const when = (a) => tabs.get(a.tab)?.changed_at ?? 0;

    const blocked = agents().filter((a) => a.status === "blocked").sort((x, y) => when(x) - when(y));
    const done = agents().filter((a) => a.status === "done").sort((x, y) => when(y) - when(x));
    const reviews = (mrs?.reviews ?? []).filter((m) => !m.approvedByMe && !m.draft);
    const mine = (mrs?.mine ?? []).filter((m) => !m.draft);
    const trouble = mine.filter((m) => m.pipeline === "failed" || m.conflicts);
    const running = mine.filter((m) => RUNNING.includes(m.pipeline) && !m.conflicts);
    // Approved, passing, no conflicts: only the merge button left.
    const ready = mine.filter((m) => (m.approvals ?? 0) > 0 && m.pipeline === "success" && !m.conflicts);
    const fine = mine.length - trouble.length - running.length - ready.length;
    const doing = this.tasks.filter((x) => x.status === "doing");
    const todo = this.tasks.filter((x) => x.status === "todo");
    const ctx = { panes: panes(), spaces: spaces(), agents: agents(), mrs };
    const calm = !blocked.length && !done.length && !reviews.length && !trouble.length;
    const { text: standupText, merged, done: doneTasks } = this.standup(now);

    // The rows the keyboard walks, in screen order. `section` is the direct child of the scroll area
    // that holds the row (set while the list below is built), so j/k can scroll it into view.
    const kbd = this.nav.focused();
    const items = [];
    const reg = (item) => { items.push(item); return kbd && this.nav.sel === items.length - 1; };
    const kids = [];

    const agentRow = (a) => {
      const tab = tabs.get(a.tab);
      const live = clean(a.title);
      const name = live && live !== a.program?.name && !/^[~/]/.test(live) ? live : tab?.named ? tab.name : a.program?.name ?? "Agent";
      const where = [a.space_name, tab?.named ? tab.name : null].filter(Boolean).join(" / ");
      const at = tab?.changed_at;
      return this.row(t, `home-agent-${a.address}`, {
        mark: icon(a.program, 16, t.foreground),
        title: name, sub: where || a.address,
        tone: a.status === "blocked" ? t.blocked : null,
        on: reg({ open: () => run("agent.focus", { terminal: a.address }), agent: a.address, section: kids.length }),
        label: `${name}, ${a.status === "blocked" ? "needs you" : "done"}. Go to it`,
        right: h_flex().gap(6).items_center().flex_none()
          .when(Boolean(at), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(now - at))))
          .child(a.status === "blocked" ? this.bang(t.blocked) : div().size(7).rounded(4).bg(t.done)),
        onClick: () => run("agent.focus", { terminal: a.address }),
      });
    };

    const mrRow = (m, theirs) => this.row(t, `home-mr-${m.id}`, {
      mark: theirs ? this.dot(t.working) : this.pipeMark(t, m.pipeline),
      title: m.title,
      sub: [`${m.repo} !${m.iid}`, theirs ? `by ${m.author}` : m.branch].filter(Boolean).join(" · "),
      label: `${m.title}${m.pipeline ? `, pipeline ${m.pipeline}` : ""}${m.conflicts ? ", conflicts" : ""}. Open in browser`,
      on: reg({ open: (cx) => cx.open_url(m.url), url: m.url, section: kids.length }),
      right: h_flex().gap(4).items_center().flex_none()
        .when(m.conflicts, (el) => el.child(this.chip(t, `home-mr-c-${m.id}`, "Conflicts", t.blocked)))
        .when(!theirs && m.pipeline === "failed", (el) => el.child(this.chip(t, `home-mr-f-${m.id}`, "Failed", t.blocked)))
        .when(!theirs && m.pipeline === "success" && !m.conflicts && (m.approvals ?? 0) > 0, (el) => el.child(this.chip(t, `home-mr-r-${m.id}`, "Ready to merge", t.ansi2)))
        .when(Boolean(m.updated), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(now - m.updated)))),
      onClick: (cx) => cx.open_url(m.url),
    });

    // A task you're doing, with its Jira key, space, agent and MR in a strip under the title.
    const taskRow = (x) => {
      const w = workOf(x, ctx);
      const on = reg({ open: () => openPanel("tasks"), url: w?.url, agent: w?.agent?.address, section: kids.length });
      const strip = w && h_flex().gap(4).items_center().flex_wrap()
        .child(this.chip(t, `home-jira-${x.id}`, w.key, t.ansi4, (cx) => cx.open_url(w.url), `Open ${w.key} in Jira`))
        .when(Boolean(w.space), (el) => el.child(this.chip(t, `home-space-${x.id}`, w.space.name, t.muted,
          () => { run("space.select", { id: w.space.id }); if (w.tab) run("tab.select", { id: w.tab }); }, `Go to ${w.space.name}${w.branch ? ` on ${w.branch}` : ""}`)))
        .when(Boolean(w.agent), (el) => el.child(this.chip(t, `home-agentchip-${x.id}`, w.agent.status === "blocked" ? "Agent needs you" : `Agent ${w.agent.status}`,
          t[w.agent.status] ?? t.muted, () => run("agent.focus", { terminal: w.agent.address }), "Go to the agent")))
        .when(Boolean(w.mr), (el) => el.child(this.chip(t, `home-mrchip-${x.id}`, `!${w.mr.iid}${w.mr.pipeline ? ` ${w.mr.pipeline}` : ""}`,
          w.mr.pipeline === "failed" ? t.blocked : w.mr.pipeline === "success" ? t.ansi2 : t.working, (cx) => cx.open_url(w.mr.url), `Open ${w.mr.repo} !${w.mr.iid}`)));
      return v_flex().id(`home-task-${x.id}`).w_full().flex_none().px(8).py(6).gap(5).rounded(7).cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .accessibility_label(`${x.title}, doing. Open Tasks`)
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_click(() => openPanel("tasks"))
        .child(h_flex().gap(8).items_center()
          .child(this.dot(t.working))
          .child(div().id(`home-task-t-${x.id}`).flex_1().min_w(0).truncate().font_medium().tooltip(x.title).child(x.title)))
        .when(Boolean(strip), (el) => el.child(div().pl(24).child(strip)));
    };

    const limitRow = (kind, label) => {
      const l = limits[kind];
      if (!l || (l.five == null && l.week == null)) return null;
      return v_flex().gap(6)
        .child(div().text_size(11).text_color(t.dim).child(label))
        .child(h_flex().gap(12)
          .when(l.five != null, (el) => el.child(this.meter(t, `home-${kind}-five`, "5 hours", l.five, l.fiveAt, now)))
          .when(l.week != null, (el) => el.child(this.meter(t, `home-${kind}-week`, "Week", l.week, l.weekAt, now))));
    };
    const limitRows = [limitRow("claude", "Claude"), limitRow("codex", "Codex")].filter(Boolean);

    const iconButton = (id, path, tip, onClick, on) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim).cursor_pointer().tooltip(tip).accessibility_label(tip)
      .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => onClick(cx))
      .child(svg(path).size(13));

    const rangeTab = (id, label) => div().id(`home-range-${id}`).h(20).px(7).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(this.range === id ? t.selected : t.chrome).text_color(this.range === id ? t.foreground : t.dim)
      .accessibility_label(`${label}${this.range === id ? ", selected" : ""}`)
      .hover((s) => s.bg(this.range === id ? t.selected : t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        this.range = id;
        try { localStorage.setItem("range", id); } catch {}
        cx.notify();
      })
      .child(label);

    const card = (id, children) => v_flex().id(id).w_full().flex_none().p(4).gap(1).rounded(9).border(1).border_color(t.border).bg(t.background).children(children);

    // The scroll area's children, in order (pushing one at a time keeps `section` right for each row).
    if (errors.length > 0) kids.push(v_flex().id("home-errors").flex_none().p(8).gap(3).rounded(8).bg(t.blocked + "14").border(1).border_color(t.blocked + "44")
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.blocked).child(errors.length === 1 ? "Herdr reports an error" : `Herdr reports ${errors.length} errors`))
        // An unreachable machine is fixed (or removed) in Settings > Machines.
        .when(errors.some((e) => /cannot reach|unreachable|ssh/i.test(e)), (el) => el.child(this.link(t, "home-errors-machines", "Machines",
          () => run("app.settings", { section: "machines" }), "Open Settings > Machines")))
        .child(this.link(t, "home-errors-dismiss", "Dismiss", () => setShared("studio.errors.dismissed", [...dismissed, ...errors].slice(-20)),
          "Hide these until they change")))
      .children(errors.map((e, i) => div().id(`home-error-${i}`).text_size(11).text_color(t.muted).truncate().tooltip(e).child(e))));
    if (calm) kids.push(v_flex().flex_none().px(8).py(10).gap(3)
      .child(div().text_color(t.muted).child("All clear"))
      .child(div().text_size(12).text_color(t.dim).child("No agent needs you and no review is waiting.")));
    if (blocked.length + done.length > 0) {
      kids.push(this.head(t, "Agents", blocked.length + done.length, null, this.link(t, "home-to-inbox", "Inbox", () => openPanel("inbox"), "Open the Inbox to read and reply")));
      kids.push(card("home-agents", [...blocked, ...done].slice(0, 6).map(agentRow)));
      if (blocked.length + done.length > 6) kids.push(this.link(t, "home-agents-more", `${blocked.length + done.length - 6} more in the Inbox`, () => openPanel("inbox")).self_start().ml(4));
    }
    if (reviews.length > 0) {
      kids.push(this.head(t, "To review", reviews.length, null, this.link(t, "home-to-mrs", "All MRs", () => openPanel("mrs"))));
      kids.push(card("home-reviews", reviews.slice(0, 5).map((m) => mrRow(m, true))));
    }
    if (trouble.length + running.length + ready.length > 0) {
      kids.push(this.head(t, "Your MRs", null, null, fine > 0 ? this.link(t, "home-mine-more", `${fine} more passing`, () => openPanel("mrs"), "Open Merge requests") : null));
      kids.push(card("home-mine", [...trouble, ...ready, ...running].slice(0, 6).map((m) => mrRow(m, false))));
    }
    if (mrs?.error) kids.push(div().px(8).text_size(11.5).text_color(t.dim).child(`Merge requests: ${mrs.error}`));
    kids.push(this.head(t, "Doing", doing.length || null, null, this.link(t, "home-to-tasks", todo.length ? `${todo.length} to do` : "Tasks", () => openPanel("tasks"))));
    kids.push(doing.length
      ? card("home-doing", doing.slice(0, 5).map(taskRow))
      : div().px(8).pb(2).text_size(12).text_color(t.dim).child(todo.length ? "Nothing in progress. Start a task from Tasks." : "No tasks yet."));
    if (limitRows.length > 0 || next) {
      kids.push(this.head(t, "Limits", null, null, this.link(t, "home-to-usage", "Monitoring", () => openPanel("usage"))));
      kids.push(v_flex().id("home-limits").flex_none().p(10).gap(12).rounded(9).border(1).border_color(t.border).bg(t.background)
        .children(limitRows)
        .when(Boolean(next), (el) => el.child(h_flex().id("home-next").gap(6).items_center().text_size(11.5).text_color(t.muted).cursor_pointer().rounded(5)
          .active((s) => s.bg(t.selected))
          .tooltip(`${next.name} · ${next.schedule}`).accessibility_label(`Next automation ${next.name}. Open Automations`)
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => openPanel("automations"))
          .child(svg(`${OWN}/clock.svg`).size(12).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(`${next.name}`))
          .child(div().flex_none().text_color(t.dim).child(next.at > now ? `in ${until(next.at - now)}` : "now")))));
    }
    kids.push(this.head(t, "Shipped", merged.length + doneTasks.length || null, null, h_flex().gap(2).items_center()
      .child(rangeTab("day", "Since yesterday"))
      .child(rangeTab("week", "Week"))));
    const shippedRows = [
      ...merged.slice(0, 8).map((m) => this.row(t, `home-merged-${m.id}`, {
        mark: div().size(16).flex_none().flex().items_center().justify_center().text_color(t.ansi5).child(svg(`${ICONS}/git-branch.svg`).size(12)),
        title: m.title, sub: `${m.repo} !${m.iid} · merged ${ago(now - m.at) === "now" ? "just now" : `${ago(now - m.at)} ago`}`, onClick: (cx) => cx.open_url(m.url),
        on: reg({ open: (cx) => cx.open_url(m.url), url: m.url, section: kids.length }),
      })),
      ...doneTasks.slice(0, 8).map((x) => this.row(t, `home-done-${x.id}`, {
        mark: div().size(16).flex_none().flex().items_center().justify_center().text_color(t.ansi2).child(svg(`${ICONS}/check.svg`).size(12)),
        title: x.title, sub: "Task done", onClick: () => openPanel("tasks"),
        on: reg({ open: () => openPanel("tasks"), section: kids.length }),
      })),
    ];
    kids.push(v_flex().id("home-shipped").flex_none().p(4).gap(1).rounded(9).border(1).border_color(t.border).bg(t.background)
      .when(this.merged === null, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("Loading merged MRs…")))
      .when(Boolean(this.mergedError), (el) => el.child(div().px(8).pt(6).text_size(11.5).text_color(t.dim).truncate().child(`Merged MRs: ${this.mergedError}`)))
      .when(this.merged !== null && !merged.length && !doneTasks.length, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("Nothing shipped in this range yet.")))
      .children(shippedRows)
      .child(h_flex().px(4).pt(4).pb(2).gap(6)
        .child(div().id("home-standup").h(26).px(10).gap(6).flex().items_center().rounded(6).text_size(12).cursor_pointer()
          .border(1).border_color(this.copied ? t.ansi2 + "66" : t.border).bg(this.copied ? t.ansi2 + "1a" : t.chrome)
          .text_color(this.copied ? t.ansi2 : t.foreground)
          .tooltip("Copies Done, Doing and Blockers as Markdown (c)").accessibility_label(this.copied ? "Standup copied" : "Copy standup")
          .hover((s) => s.bg(this.copied ? t.ansi2 + "1a" : t.hover)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => this.copyStandup(cx))
          .child(svg(this.copied ? `${ICONS}/check.svg` : `${OWN}/copy.svg`).size(12))
          .child(this.copied ? "Copied" : "Copy standup"))));
    this.items = items;
    this.nav.clamp(items.length);

    return v_flex().id("home-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Home"))
        .when(blocked.length > 0, (el) => el.child(div().text_size(11.5).font_medium().text_color(t.blocked).child(`${blocked.length} ${blocked.length === 1 ? "needs" : "need"} you`)))
        .child(div().flex_1())
        .when(Boolean(mrs?.at), (el) => el.child(div().text_size(11).text_color(t.dim).tooltip("Merge requests last checked").child(ago(now - mrs.at))))
        .child(iconButton("home-quiet", `${OWN}/${quiet ? "bell-off" : "bell"}.svg`, quiet ? "Alerts off (quiet). Click to turn on (m)" : "Alerts on. Click for quiet (m)",
          (cx) => { setShared("studio.quiet", !quiet); cx.notify(); }, quiet))
        .child(iconButton("home-refresh", `${OWN}/refresh.svg`, "Refresh merge requests and limits (r)",
          (cx) => { run("studio-tabs.refresh"); this.readMerged(cx); this.readTasks(cx); })))
      .child(v_flex().id("home-scroll").flex_1().min_h(0).px(10).pb(12).gap(4).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(kids))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["↵ o", "open"], ["p", "peek agent"], ["yy", "copy link"], ["r", "refresh"], ["c", "copy standup"], ["w", "day or week"], ["m", "quiet"], ["i t", "Inbox, Tasks"]], this.nav.help)));
  }
}
