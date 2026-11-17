import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, appHome, theme, layout, window, nextCommand, run, props } from "herdr";
import { Nav, footer } from "./nav.js";

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
    this.confirm = null;
    this.name = InputState.new({ placeholder: "Daily backup" });
    this.schedule = InputState.new({ placeholder: "0 9 * * *" });
    this.command = InputState.new({ placeholder: "/absolute/path/to/script.sh" });
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
      if (window()?.active && !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "automations" && !this.form) this.refresh(cx);
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
        const result = await exec("python3", [`${appHome()}/mods/studio-automations/cron.py`, JSON.stringify(request)], { timeout: 15000 });
        if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not access crontab.");
        const data = JSON.parse(result.stdout);
        changed = changed || this.revision !== data.revision;
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
      // Home and the status bar show the next run: tell the feed after a change.
      if (!background && !this.error) run("studio-tabs.refresh");
      if (!background || changed || previousError !== this.error) cx.notify();
      const next = this.pending;
      this.pending = null;
      if (next) this.request(next, cx);
    });
  }

  refresh(cx) { this.request({ action: "list" }, cx); }

  edit(job, cx) {
    if (this.busy || !this.ready) return;
    this.form = { id: job?.id ?? null, revision: this.revision };
    this.name.set_value(job?.name ?? "");
    this.schedule.set_value(job?.schedule ?? "0 9 * * *");
    this.command.set_value(job?.command ?? "");
    this.error = null;
    this.name.focus();
    cx.notify();
  }

  onKey(e, cx) {
    // A form field has the keyboard: its keys are its own.
    if (!this.nav.focused()) return;
    const it = () => this.items[this.nav.sel];
    const used = this.nav.key(e, this.items.length, {
      enter: () => { const j = it()?.job; if (j) this.edit(j, cx); },
      e: () => { const j = it()?.job; if (j) this.edit(j, cx); },
      a: () => this.edit(null, cx),
      space: () => { const j = it()?.job; if (j) this.request({ action: "toggle", id: j.id, revision: this.revision }, cx); },
      t: () => { const j = it()?.job; if (j) this.request({ action: "toggle", id: j.id, revision: this.revision }, cx); },
      dd: () => { const j = it()?.job; if (j) this.request({ action: "delete", id: j.id, revision: this.revision }, cx); },
      f: () => { this.filter = { all: "enabled", enabled: "disabled", disabled: "all" }[this.filter]; this.nav.sel = 0; },
      r: () => this.refresh(cx),
    }, run);
    if (!used) return;
    cx.stop_propagation();
    const sec = this.items[this.nav.sel]?.section;
    if (sec != null) this.scroll.scroll_to_item(sec);
    cx.notify();
  }

  button(id, label, action, selected = false) {
    const t = theme();
    return div().id(id).h(26).px(8).flex_none().flex().items_center().rounded(5)
      .text_size(11.5).bg(selected ? t.selected : t.raised).text_color(this.saving ? t.dim : t.foreground)
      .accessibility_label(label)
      .when(!this.saving, el => el.cursor_pointer().hover(s => s.bg(t.hover)).active(s => s.bg(t.selected))
        .on_click((_e, cx) => action(cx)))
      .child(label);
  }

  field(id, label, state) {
    const t = theme();
    return v_flex().gap(4)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(div().id(id).h(32).px(8).flex().items_center().rounded(5).border(1).border_color(t.input).bg(t.background)
        .child(Input.new(state).w_full().text_size(12).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation())));
  }

  editor(t) {
    return v_flex().id("automation-form").flex_none().p(10).gap(10).rounded(7).border(1).border_color(t.accent).bg(t.surface)
      .child(div().font_medium().child(this.form.id === null ? "New automation" : "Edit automation"))
      .child(this.field("automation-name", "Name", this.name))
      .child(this.field("automation-schedule", "Schedule · minute hour day month weekday", this.schedule))
      .child(h_flex().gap(4)
        .children([["Hourly", "0 * * * *"], ["Daily", "0 9 * * *"], ["Weekly", "0 9 * * 1"]].map(([label, value]) =>
          this.button(`preset-${label}`, label, cx => { this.schedule.set_value(value); cx.notify(); }))))
      .child(this.field("automation-command", "Shell command", this.command))
      .child(div().text_size(11).text_color(t.dim).whitespace_normal()
        .child("Uses this Mac’s timezone and cron environment. Use absolute paths; escape literal % as \\%. Mac must be awake. New jobs are saved disabled."))
      .child(h_flex().gap(6)
        .child(this.button("automation-save", "Save", cx => this.request({ action: "save", revision: this.form.revision,
          id: this.form.id, name: this.name.value(), schedule: this.schedule.value(), command: this.command.value() }, cx)))
        .child(this.button("automation-cancel", "Cancel", cx => { this.form = null; this.error = null; this.nav.focus(); cx.notify(); })));
  }

  row(job, t, on = false) {
    return v_flex().id(`automation-${job.id}`).flex_none().px(6).py(10).gap(7).rounded(6).border_b(1).border_color(t.border)
      .when(on, el => el.bg(t.selected))
      .child(h_flex().items_center().gap(7)
        .child(div().size(6).flex_none().rounded(3).bg(job.enabled ? t.done : t.dim))
        .child(div().id(`automation-name-${job.id}`).flex_1().min_w(0).truncate().tooltip(job.name).font_medium().child(job.name))
        .child(div().text_size(10.5).text_color(job.enabled ? t.done : t.dim).child(job.enabled ? "Enabled" : "Disabled")))
      .child(div().id(`automation-schedule-${job.id}`).text_size(12).text_color(t.muted).tooltip(job.schedule).child(job.schedule))
      .child(div().id(`automation-command-${job.id}`).truncate().text_size(11).text_color(t.dim).tooltip(job.command).child(job.command))
      .child(h_flex().gap(5)
        .child(this.button(`automation-toggle-${job.id}`, job.enabled ? "Disable" : "Enable", cx => this.request({ action: "toggle", id: job.id, revision: this.revision }, cx)))
        .child(this.button(`automation-edit-${job.id}`, "Edit", cx => this.edit(job, cx)))
        .child(this.button(`automation-delete-${job.id}`, this.confirm === job.id ? "Delete?" : "Delete", cx => {
          if (this.confirm === job.id) this.request({ action: "delete", id: job.id, revision: this.revision }, cx);
          else { this.confirm = job.id; cx.notify(); cx.timer.after(3000, cx => { if (this.confirm === job.id) this.confirm = null; cx.notify(); }); }
        })));
  }

  render() {
    const t = theme();
    const enabled = this.jobs.filter(j => j.enabled).length;
    const list = this.jobs.filter(j => this.filter === "all" || j.enabled === (this.filter === "enabled"));
    const kbd = this.nav.focused();
    const items = [];
    const kids = [];
    if (this.error) kids.push(div().py(8).text_color(t.blocked).whitespace_normal().child(this.error));
    if (this.form) kids.push(this.editor(t));
    if (!this.ready && !this.error) kids.push(div().py(14).text_color(t.dim).child("Loading cron jobs…"));
    if (this.ready && !this.jobs.length && !this.form) kids.push(v_flex().py(18).gap(6)
      .child(div().child("No automations yet"))
      .child(div().text_size(12).text_color(t.dim).whitespace_normal().child("Create a scheduled command with + New (a). Enabled jobs run even when Herdr is closed.")));
    if (this.ready && this.jobs.length > 0 && !list.length) kids.push(div().py(14).text_color(t.dim).child(`No ${this.filter} automations`));
    for (const j of list) {
      items.push({ job: j, section: kids.length });
      kids.push(this.row(j, t, kbd && this.nav.sel === items.length - 1));
    }
    this.items = items;
    this.nav.clamp(items.length);
    return v_flex().id("automations-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .child(v_flex().flex_none().p(12).gap(9).border_b(1).border_color(t.border)
        .child(h_flex().items_center().gap(5)
          .child(div().flex_1().font_semibold().text_size(13).text_color(kbd ? t.accent : t.foreground).child("Automations"))
          .child(this.button("automations-refresh", "Refresh", cx => this.refresh(cx)))
          .when(this.ready, el => el.child(this.button("automations-new", "+ New", cx => this.edit(null, cx)))))
        .child(div().text_size(11).text_color(t.dim).child(`This Mac · ${enabled} enabled · ${this.jobs.length - enabled} disabled`))
        .child(h_flex().gap(4).children(["all", "enabled", "disabled"].map(f => this.button(`automations-filter-${f}`, f[0].toUpperCase() + f.slice(1), cx => { this.filter = f; cx.notify(); }, this.filter === f)))))
      .child(v_flex().id("automations-scroll").flex_1().min_h(0).px(12).pb(14).gap(8).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(kids))
      .when(kbd, el => el.child(footer({ h_flex, div }, t,
        [["↵ e", "edit"], ["a", "new"], ["space t", "on or off"], ["dd", "delete"], ["f", "filter"], ["r", "refresh"]], this.nav.help)));
  }
}
