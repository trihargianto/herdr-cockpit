import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, appHome, theme, layout, window, nextCommand, run, props, settings } from "herdr";
import { Nav, footer } from "./nav.js";
import { describeCron } from "./cronword.js";

const ICONS = "mods/cockpit-workspace-chrome";
const OWN = "mods/cockpit-automations";
const PRESETS = [["Hourly", "0 * * * *"], ["Daily 09:00", "0 9 * * *"], ["Weekdays 09:00", "0 9 * * 1-5"], ["Mondays 09:00", "0 9 * * 1"]];
// Cards drawn at once: a view with ~120 rich cards runs out of render time. More on request.
const PAGE = 40;
const FILTERS = [["all", "All"], ["enabled", "On"], ["disabled", "Off"]];

// "just now", "5m ago", "3h ago", "2d ago".
function ago(seconds) {
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function took(run) {
  const s = run.ended - run.started;
  return s < 1 ? "" : s < 60 ? ` in ${s}s` : ` in ${Math.round(s / 60)}m`;
}

// The job's last run: kind (ok, failed, running, never, untracked), label, tooltip.
function lastRun(job) {
  const run = job.last_run;
  if (!job.key) return { kind: "untracked", label: "No run history yet", tip: "Edit and save this automation to start keeping its runs and log" };
  if (!run) return { kind: "never", label: "Not run yet", tip: "Its first run starts the log" };
  const at = new Date(run.started * 1000).toLocaleString();
  if (run.ended == null && run.interrupted) return { kind: "interrupted", label: `Stopped before finishing · started ${ago(run.started)}`, tip: `Started ${at}. It ended without reporting back: killed, or the Mac slept or shut down` };
  if (run.ended == null) return { kind: "running", label: `Running · started ${ago(run.started)}`, tip: `Started ${at}` };
  if (run.code === 0) return { kind: "ok", label: `Ran ${ago(run.ended)}${took(run)}`, tip: `Succeeded. Started ${at}` };
  return { kind: "failed", label: `Failed ${ago(run.ended)} · exit ${run.code}`, tip: `Exited with ${run.code}. Started ${at}. Open the log to see why` };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const match = find(child, id); if (match) return match; }
  return null;
}

export default class Automations extends View {
  init(_props, cx) {
    this.jobs = [];
    this.ready = false;
    this.busy = false;
    this.saving = false;
    this.error = null;
    this.form = null;
    this.filter = "all";
    this.limit = PAGE;
    this.confirm = null;
    this.name = InputState.new({ placeholder: "Daily backup" });
    this.description = InputState.new({ placeholder: "What it does, for later you (optional)" });
    this.schedule = InputState.new({ placeholder: "0 9 * * *" });
    // The plain-English line under the field follows each keystroke.
    this.schedule.on("change", (_e, cx) => cx.notify());
    this.command = InputState.new({ placeholder: "/absolute/path/to/script.sh" });
    // Enter in any field saves; the field with the keyboard gets the accent border.
    this.focusField = null;
    // Bindings run before key handlers, so the field's own Esc and the app's Tab would win over onKey:
    // bind them in the fields' context instead (as Tasks does).
    const keys = [];
    for (const context of ["AutomationField", "AutomationField > Input"]) {
      keys.push({ keystroke: "escape", action: "cockpit-automations.cancel", context });
      keys.push({ keystroke: "tab", action: "cockpit-automations.next-field", context });
      keys.push({ keystroke: "shift-tab", action: "cockpit-automations.prev-field", context });
    }
    cx.bind_keys(keys);
    for (const [key, state] of [["name", this.name], ["description", this.description], ["schedule", this.schedule], ["command", this.command]]) {
      state.on("submit", (_e, cx) => this.save(cx));
      state.on("focus", (_e, cx) => { this.focusField = key; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focusField === key) this.focusField = null; cx.notify(); });
    }
    // Keyboard: the jobs shown, in order (rebuilt on each render).
    this.nav = new Nav(cx, { slot: props()?.slot ?? null });
    this.nav.watch(cx);
    this.scroll = ScrollHandle.new();
    this.items = [];
    this.refresh(cx);
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (this.nav.wants(command, props()?.slot)) this.nav.focus();
        if (command === "new") this.edit(null, cx);
        if (command === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
    cx.timer.every(15000, cx => {
      const root = layout();
      if (window()?.active && !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "automations" && !this.form) {
        this.refresh(cx);
        // "5m ago" moves on even when nothing ran.
        if (this.jobs.some(j => j.last_run)) cx.notify();
      }
    });
  }

  request(request, cx) {
    // A change made while the background list is still running waits for it instead of being dropped.
    if (this.busy) {
      if (request.action !== "list") this.pending = request;
      return;
    }
    this.busy = true;
    const background = request.action === "list";
    const previousError = this.error;
    let changed = !this.ready;
    this.saving = !background;
    if (!background) {
      this.error = null;
      cx.notify();
    }
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [`${appHome()}/mods/cockpit-automations/cron.py`, JSON.stringify(request)], { timeout: 15000 });
        if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not access crontab.");
        const data = JSON.parse(result.stdout);
        // revision is the crontab; state also covers runs and logs, which change without it.
        changed = changed || this.revision !== data.revision || this.state !== data.state;
        this.state = data.state;
        if (changed) this.jobs = data.jobs;
        this.revision = data.revision;
        this.error = null;
        this.ready = true;
        // The list takes the keyboard back once the form closes.
        if (request.action === "save") { this.form = null; this.nav.focus(); }
        if (changed || !background) this.confirm = null;
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      this.busy = false;
      this.saving = false;
      this.refreshing = false;
      // Home and the status bar show the next run: tell the feed after a change.
      if (!background && !this.error) run("cockpit-tabs.refresh");
      if (!background || changed || previousError !== this.error) cx.notify();
      const next = this.pending;
      this.pending = null;
      if (next) this.request(next, cx);
    });
  }

  // manual: the person asked, so the refresh button spins until the list is back.
  refresh(cx, manual = false) {
    if (manual && !this.busy) { this.refreshing = true; cx.notify(); }
    this.request({ action: "list" }, cx);
  }

  save(cx) {
    if (!this.form || this.saving) return;
    this.request({ action: "save", revision: this.form.revision, id: this.form.id, name: this.name.value(),
      description: this.description.value(), schedule: this.schedule.value(), command: this.command.value() }, cx);
  }

  cancel(cx) {
    this.form = null;
    this.error = null;
    this.nav.focus();
    cx.notify();
  }

  // Tab and Shift+Tab walk the form's fields, wrapping around.
  step(by, cx) {
    const order = [["name", this.name], ["description", this.description], ["schedule", this.schedule], ["command", this.command]];
    const at = Math.max(0, order.findIndex(([key]) => key === this.focusField));
    order[(at + by + order.length) % order.length][1].focus();
    cx.notify();
  }

  toggle(job, cx) { this.request({ action: "toggle", id: job.id, revision: this.revision }, cx); }

  remove(job, cx) {
    if (this.confirm === job.id) return this.request({ action: "delete", id: job.id, revision: this.revision }, cx);
    this.confirm = job.id;
    cx.notify();
    cx.timer.after(3000, cx => { if (this.confirm === job.id) { this.confirm = null; cx.notify(); } });
  }

  edit(job, cx) {
    if (this.busy || !this.ready) return;
    this.form = { id: job?.id ?? null, revision: this.revision };
    this.name.set_value(job?.name ?? "");
    this.description.set_value(job?.description ?? "");
    this.schedule.set_value(job?.schedule ?? "0 9 * * *");
    this.command.set_value(job?.command ?? "");
    this.error = null;
    this.name.focus();
    cx.notify();
  }

  onKey(e, cx) {
    if (this.form && e.key === "escape") { cx.stop_propagation(); return this.cancel(cx); }
    // A form field has the keyboard: its keys are its own.
    if (!this.nav.focused()) return;
    const it = () => this.items[this.nav.sel];
    const used = this.nav.key(e, this.items.length, {
      enter: () => { const j = it()?.job; if (j) this.edit(j, cx); },
      e: () => { const j = it()?.job; if (j) this.edit(j, cx); },
      a: () => this.edit(null, cx),
      space: () => { const j = it()?.job; if (j) this.toggle(j, cx); },
      t: () => { const j = it()?.job; if (j) this.toggle(j, cx); },
      dd: () => { const j = it()?.job; if (j) this.request({ action: "delete", id: j.id, revision: this.revision }, cx); },
      f: () => { this.filter = { all: "enabled", enabled: "disabled", disabled: "all" }[this.filter]; this.nav.sel = 0; this.limit = PAGE; },
      r: () => this.refresh(cx, true),
      L: () => { const j = it()?.job; if (j) this.openLog(j); },
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  // The log opens in a terminal beside the shell, at its end: q closes it.
  openLog(job) {
    if (job.log) run("terminal.open", { argv: ["less", "+G", job.log], place: "right" });
  }

  // A quiet bordered button; `icon` puts a glyph before the label (or alone, with `tip` saying what it does).
  button(t, id, label, action, { icon = null, tip = null, disabled = false, danger = false } = {}) {
    const off = this.saving || disabled;
    return h_flex().id(id).h(22).px(label ? 7 : 0).when(!label, el => el.w(22).justify_center()).gap(5).items_center().flex_none()
      .rounded(5).border(1).text_size(11.5)
      .border_color(danger ? t.blocked + "66" : t.border).bg(danger ? t.blocked + "1a" : t.chrome)
      .text_color(off ? t.dim : danger ? t.blocked : t.muted)
      .accessibility_label(tip ?? label).when(Boolean(tip), el => el.tooltip(tip))
      .when(!off, el => el.cursor_pointer()
        .hover(s => s.bg(danger ? t.blocked + "26" : t.hover).text_color(danger ? t.blocked : t.foreground))
        .active(s => s.bg(danger ? t.blocked + "33" : t.selected))
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .when(Boolean(icon), el => el.child(svg(icon).size(12).flex_none()))
      .when(Boolean(label), el => el.child(label));
  }

  // The one filled button on screen: what the form is for.
  primary(t, id, label, action) {
    const off = this.saving;
    return div().id(id).h(26).px(12).flex().items_center().flex_none().rounded(6).text_size(12).font_medium()
      .bg(t.solid).text_color(t.solid_foreground).when(off, el => el.opacity(0.6))
      .accessibility_label(label)
      .when(!off, el => el.cursor_pointer().hover(s => s.opacity(0.9)).active(s => s.opacity(0.8))
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .child(label);
  }

  chip(t, id, label, count, on, action) {
    return h_flex().id(id).h(24).px(8).gap(5).items_center().flex_none().rounded(6).text_size(11.5)
      .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .accessibility_label(`${label}${count != null ? `, ${count}` : ""}${on ? ", shown" : ""}`)
      .cursor_pointer().hover(s => s.bg(on ? t.selected : t.hover)).active(s => s.bg(t.selected))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); })
      .child(label)
      .when(count != null, el => el.child(div().text_color(t.dim).child(String(count))));
  }

  // On/off switch. Instant on purpose: it's a frequent action, and the card's colors change with it.
  switch(t, job) {
    const on = job.enabled;
    const off = this.saving;
    const what = on ? "On. Click to switch off" : "Off. Click to switch on";
    return h_flex().id(`automation-toggle-${job.id}`).w(28).h(16).p(2).flex_none().rounded(8)
      .when(on, el => el.justify_end()).bg(on ? t.done : t.raised).border(1).border_color(on ? t.done : t.input)
      .tooltip(what).accessibility_label(`${job.name}: ${what}`)
      .when(!off, el => el.cursor_pointer().hover(s => s.border_color(on ? t.done : t.muted))
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(job, cx); }))
      .child(div().size(10).rounded(5).bg(on ? t.background : t.dim));
  }

  // A status glyph for the last run, sized to sit on a text line.
  mark(t, kind) {
    if (kind === "ok") return div().size(7).mx(2).flex_none().rounded(4).bg(t.done);
    if (kind === "failed") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold()
      .text_color(t.blocked).flex().items_center().justify_center().child("!");
    // Static on purpose: a job can run for hours, and a spinner repaints the window every frame.
    if (kind === "running") return div().size(7).mx(2).flex_none().rounded(4).bg(t.working);
    if (kind === "interrupted") return div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(t.blocked);
    return div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(t.dim);
  }

  field(t, key, label, state, { mono = false, hint = null } = {}) {
    const focused = this.focusField === key;
    return v_flex().gap(5)
      .child(div().text_size(11).font_medium().text_color(t.muted).child(label))
      // The whole box is the field: a press on its padding must not reach the panel root, which would
      // hand the keyboard to the job list. It focuses the input instead.
      .child(div().id(`automation-${key}`).key_context("AutomationField").h(30).px(9).flex().items_center().rounded(6).border(1)
        .border_color(focused ? t.accent : t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); state.focus(); })
        .child(Input.new(state).w_full().text_size(mono ? 11.5 : 12).text_color(t.foreground)
          .when(mono, el => el.font_family(settings().font_family ?? "JetBrains Mono"))))
      .when(Boolean(hint), el => el.child(hint));
  }

  editor(t) {
    const says = describeCron(this.schedule.value());
    const value = this.schedule.value().trim();
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id("automation-form").flex_none().p(12).gap(12).rounded(8).border(1).border_color(t.accent).bg(t.surface)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().font_semibold().text_size(12.5).child(this.form.id === null ? "New automation" : "Edit automation"))
        .child(div().text_size(10.5).text_color(t.dim).child("↵ save · tab next · esc cancel")))
      .child(this.field(t, "name", "Name", this.name))
      .child(this.field(t, "description", "Description · optional", this.description))
      .child(this.field(t, "schedule", "Schedule", this.schedule, { mono: true, hint: v_flex().gap(7)
        .child(h_flex().id("automation-schedule-says").gap(6).items_start()
          .child(svg(`${ICONS}/clock.svg`).size(12).mt(1).flex_none().text_color(says ? t.accent : t.dim))
          .child(div().flex_1().min_w(0).text_size(11.5).whitespace_normal().text_color(says ? t.foreground : t.dim)
            .child(says ?? "Five fields: minute hour day month weekday. Or @hourly, @daily, @weekly.")))
        .child(h_flex().gap(4).flex_wrap()
          .children(PRESETS.map(([label, preset]) => this.chip(t, `preset-${label}`, label, null, value === preset,
            () => this.schedule.set_value(preset))))) }))
      .child(this.field(t, "command", "Command", this.command, { mono: true }))
      .child(div().text_size(11).text_color(t.dim).whitespace_normal()
        .child("Runs in this Mac’s time zone with cron’s bare PATH (/usr/bin:/bin): use absolute paths, and write % as \\%. The Mac must be awake. New automations start switched off."))
      .child(h_flex().gap(6).items_center()
        .child(this.primary(t, "automation-save", this.saving ? "Saving…" : "Save", cx => this.save(cx)))
        .child(this.button(t, "automation-cancel", "Cancel", cx => this.cancel(cx))));
  }

  card(t, job, on = false) {
    const last = lastRun(job);
    const says = describeCron(job.schedule);
    const mono = settings().font_family ?? "JetBrains Mono";
    const failing = job.enabled && last.kind === "failed";
    const color = { ok: t.muted, failed: t.blocked, running: t.working, interrupted: t.blocked }[last.kind] ?? t.dim;
    const confirming = this.confirm === job.id;
    return v_flex().id(`automation-${job.id}`).w_full().flex_none().px(11).py(10).gap(7).rounded(8).border(1)
      .border_color(on ? t.accent : failing ? t.blocked + "55" : t.border).bg(on ? t.selected : t.chrome)
      // Name and switch: what it is, and whether it runs.
      .child(h_flex().gap(8).items_center()
        .child(div().id(`automation-name-${job.id}`).flex_1().min_w(0).truncate().font_medium().text_size(13)
          .text_color(job.enabled ? t.foreground : t.muted).tooltip(job.name).child(job.name))
        .child(this.switch(t, job)))
      .when(Boolean(job.description), el => el.child(div().text_size(12).text_color(t.muted).whitespace_normal().child(job.description)))
      // When: in words first, the cron line after it for those who read cron.
      .child(h_flex().id(`automation-schedule-${job.id}`).gap(6).items_start().tooltip(job.schedule)
        .child(svg(`${ICONS}/clock.svg`).size(12).mt(1).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).text_size(12).whitespace_normal().text_color(job.enabled ? t.foreground : t.muted)
          .child(says ?? job.schedule))
        .when(Boolean(says), el => el.child(div().flex_none().mt(1).font_family(mono).text_size(10.5).text_color(t.dim).child(job.schedule))))
      // What: the command, as code.
      .child(div().id(`automation-command-${job.id}`).h(22).px(7).flex().items_center().rounded(5).bg(t.background).tooltip(job.command)
        .child(div().min_w(0).truncate().font_family(mono).text_size(10.5).text_color(t.muted).child(job.command)))
      // How it went, and the actions.
      .child(h_flex().gap(6).items_center().h(22)
        .child(this.mark(t, last.kind))
        .child(div().id(`automation-last-${job.id}`).flex_1().min_w(0).truncate().text_size(11.5).text_color(color).tooltip(last.tip).child(last.label))
        .child(this.button(t, `automation-log-${job.id}`, "Log", () => this.openLog(job), {
          icon: `${OWN}/file-text.svg`, disabled: !job.log,
          tip: job.log ? "Open the output of every run (L)" : "No log yet: the first run starts it" }))
        .child(this.button(t, `automation-edit-${job.id}`, null, cx => this.edit(job, cx), { icon: `${ICONS}/square-pen.svg`, tip: "Edit (e)" }))
        .child(this.button(t, `automation-delete-${job.id}`, confirming ? "Delete?" : null, cx => this.remove(job, cx), {
          icon: `${OWN}/trash.svg`, danger: confirming, tip: confirming ? "Click again to delete" : "Delete (dd)" })));
  }

  render() {
    const t = theme();
    const enabled = this.jobs.filter(j => j.enabled).length;
    const failing = this.jobs.filter(j => j.enabled && lastRun(j).kind === "failed").length;
    const running = this.jobs.filter(j => lastRun(j).kind === "running").length;
    const list = this.jobs.filter(j => this.filter === "all" || j.enabled === (this.filter === "enabled"));
    const counts = { all: this.jobs.length, enabled, disabled: this.jobs.length - enabled };
    const kbd = this.nav.focused();
    const items = [];
    const kids = [];
    if (this.error) kids.push(div().px(10).py(8).rounded(6).border(1).border_color(t.blocked + "55").bg(t.blocked + "14")
      .text_size(12).text_color(t.blocked).whitespace_normal().child(this.error));
    if (this.form) kids.push(this.editor(t));
    if (!this.ready && !this.error) kids.push(div().px(4).py(8).text_color(t.dim).child("Loading cron jobs…"));
    if (this.ready && !this.jobs.length && !this.form) kids.push(v_flex().py(28).px(12).gap(8).items_center()
      .child(svg(`${ICONS}/clock.svg`).size(20).text_color(t.dim))
      .child(div().font_medium().child("No automations yet"))
      .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal()
        .child("Run a command on a schedule. It keeps running while Herdr is closed."))
      .child(div().mt(4).child(this.primary(t, "automations-empty-new", "New automation", cx => this.edit(null, cx)))));
    if (this.ready && this.jobs.length > 0 && !list.length) kids.push(div().px(4).py(8).text_size(12).text_color(t.dim)
      .child(this.filter === "enabled" ? "None switched on" : "None switched off"));
    for (const j of list.slice(0, this.limit)) {
      items.push({ job: j, section: kids.length });
      kids.push(this.card(t, j, kbd && this.nav.sel === items.length - 1));
    }
    if (list.length > this.limit) kids.push(h_flex().py(4).justify_center()
      .child(this.button(t, "automations-more", `Show ${Math.min(PAGE, list.length - this.limit)} more of ${list.length - this.limit}`,
        cx => { this.limit += PAGE; cx.notify(); })));
    this.items = items;
    this.nav.clamp(items.length);
    const spinning = this.refreshing;
    return v_flex().id("automations-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .on_action("cockpit-automations.cancel", (_e, cx) => this.cancel(cx))
      .on_action("cockpit-automations.next-field", (_e, cx) => this.step(1, cx))
      .on_action("cockpit-automations.prev-field", (_e, cx) => this.step(-1, cx))
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Automations"))
        .when(failing > 0, el => el.child(div().text_size(11.5).font_medium().text_color(t.blocked).child(`${failing} failing`)))
        .when(running > 0, el => el.child(div().text_size(11.5).font_medium().text_color(t.working).child(`${running} running`)))
        .child(div().flex_1())
        .child(div().id("automations-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .tooltip("Refresh (r)").accessibility_label("Refresh automations")
          .when(!spinning, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).active(s => s.bg(t.selected))
            .on_click((_e, cx) => this.refresh(cx, true)))
          .child(spinning ? svg(`${ICONS}/spinner.svg`).size(13).text_color(t.muted).spin(900) : svg(`${OWN}/refresh.svg`).size(13)))
        .when(this.ready && !this.form, el => el.child(this.button(t, "automations-new", "New", cx => this.edit(null, cx),
          { icon: `${ICONS}/plus.svg`, tip: "New automation (a)" }))))
      .when(this.jobs.length > 0, el => el.child(h_flex().flex_none().px(10).pb(8).gap(5)
        .children(FILTERS.map(([f, label]) => this.chip(t, `automations-filter-${f}`, label, counts[f], this.filter === f,
          () => { this.filter = f; this.nav.sel = 0; this.limit = PAGE; })))))
      .child(v_flex().id("automations-scroll").flex_1().min_h(0).px(10).pb(12).gap(6).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(kids))
      .when(kbd, el => el.child(footer({ h_flex, div }, t,
        [["↵ e", "edit"], ["a", "new"], ["space t", "on or off"], ["dd", "delete"], ["L", "log"], ["f", "filter"], ["r", "refresh"]], this.nav.help)));
  }
}
