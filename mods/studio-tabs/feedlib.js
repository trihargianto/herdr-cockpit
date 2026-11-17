// Pure helpers for the Studio feed: no Herdr imports, so `node --test` can load them.

// ---- cron: the next moment a five-field schedule (or @alias) fires, in local time.

const ALIASES = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};

function field(spec, min, max) {
  const set = new Set();
  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo, hi;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) { [lo, hi] = range.split("-").map(Number); }
    else { lo = Number(range); hi = stepText ? max : lo; }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

// null for @reboot and anything it can't read. Looks up to eight days ahead.
export function nextRun(schedule, from = Date.now()) {
  const text = ALIASES[schedule.trim()] ?? schedule.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts;
  const sets = [field(mi, 0, 59), field(h, 0, 23), field(dom, 1, 31), field(mon, 1, 12), field(dow.replace(/\b7\b/g, "0"), 0, 6)];
  if (sets.some((s) => !s)) return null;
  const [M, H, D, MO, W] = sets;
  // Standard cron: when both day fields are restricted, either one matches.
  const domAny = dom === "*", dowAny = dow === "*";
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const dayOk = domAny && dowAny ? true
      : domAny ? W.has(d.getDay())
        : dowAny ? D.has(d.getDate())
          : D.has(d.getDate()) || W.has(d.getDay());
    if (M.has(d.getMinutes()) && H.has(d.getHours()) && dayOk && MO.has(d.getMonth() + 1)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Enabled jobs from `crontab -l`, with Studio's "# herdr-studio-name:" labels. Disabled ones are skipped.
export function cronJobs(text) {
  const jobs = [];
  const lines = String(text ?? "").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^\w+\s*=/.test(line)) return;
    const alias = line.startsWith("@");
    const parts = line.split(/\s+/);
    const n = alias ? 1 : 5;
    if (parts.length <= n) return;
    const schedule = parts.slice(0, n).join(" ");
    const command = parts.slice(n).join(" ");
    const label = lines[i - 1]?.match(/^# herdr-studio-name:\s*(.+)$/)?.[1]?.trim();
    jobs.push({ name: label || command.split(/\s+/)[0].split("/").pop(), schedule, command });
  });
  return jobs;
}

// The job that runs soonest, or null.
export function nextJob(text, from = Date.now()) {
  let best = null;
  for (const job of cronJobs(text)) {
    const at = nextRun(job.schedule, from);
    if (at && (!best || at < best.at)) best = { name: job.name, schedule: job.schedule, at };
  }
  return best;
}

// ---- limits from an agent's status line

const BARS = "[█▓▒░]";
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

// Claude:  Context ████ 42% │ Usage █░░ 9% (resets in 3h 21m) | Weekly ███ 98% (resets in 4h 51m)
// Codex:   Context 11% used · 5h 23% left · weekly 82% left
// Percentages come back as "used". The last matching line wins.
export function parseLimits(text) {
  const lines = String(text ?? "").replace(ANSI, "").split("\n");
  const usage = new RegExp(`Usage\\s+${BARS}+\\s*(\\d+)%(?:\\s*\\(resets in ([^)]+)\\))?`);
  const weekly = new RegExp(`Weekly\\s+${BARS}+\\s*(\\d+)%(?:\\s*\\(resets in ([^)]+)\\))?`);
  const context = new RegExp(`Context\\s+${BARS}+\\s*(\\d+)%`);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (context.test(l)) {
      // A narrow pane wraps the status line: Usage and Weekly can sit on the next lines.
      const near = lines.slice(i, i + 4).join(" ");
      const u = near.match(usage), w = near.match(weekly);
      return {
        kind: "claude",
        five: u ? Number(u[1]) : null, fiveReset: u?.[2] ?? null,
        week: w ? Number(w[1]) : null, weekReset: w?.[2] ?? null,
      };
    }
    const x = l.match(/Context (\d+)% used(?:\s*·\s*5h (\d+)% left)?(?:\s*·\s*weekly (\d+)% left)?/);
    if (x) {
      return {
        kind: "codex",
        five: x[2] != null ? 100 - Number(x[2]) : null, fiveReset: null,
        week: x[3] != null ? 100 - Number(x[3]) : null, weekReset: null,
      };
    }
  }
  return null;
}

// "3h 21m", "4d 2h" to milliseconds.
export function durationMs(text) {
  if (!text) return null;
  const get = (u) => Number(String(text).match(new RegExp(`(\\d+)\\s*${u}`))?.[1] ?? 0);
  const ms = ((get("d") * 24 + get("h")) * 60 + get("m")) * 60000;
  return ms || null;
}

// ---- merge request alerts

// What changed between two snapshots of { mine: [...], reviews: [...] } (compact MRs, see feed.js).
// The first snapshot (prev null) only sets the baseline: no alerts for what was already true.
export function mrEvents(prev, next) {
  if (!prev || !next) return [];
  const events = [];
  const before = new Map((prev.mine ?? []).map((m) => [m.id, m]));
  for (const m of next.mine ?? []) {
    const p = before.get(m.id);
    if (!p) continue;
    if (m.pipeline === "failed" && p.pipeline !== "failed" && !m.draft) events.push({ kind: "failed", mr: m });
    else if (m.pipeline === "success" && p.pipeline && p.pipeline !== "success" && p.pipeline !== "failed") events.push({ kind: "passed", mr: m });
    if ((m.approvals ?? 0) > (p.approvals ?? 0)) events.push({ kind: "approved", mr: m });
    if ((m.notes ?? 0) > (p.notes ?? 0)) events.push({ kind: "comments", mr: m, n: m.notes - (p.notes ?? 0) });
  }
  const asked = new Set((prev.reviews ?? []).map((m) => m.id));
  for (const m of next.reviews ?? []) {
    if (!asked.has(m.id) && !m.draft && !m.approvedByMe) events.push({ kind: "review", mr: m });
  }
  return events;
}

// The words for one event: { title, body, level }.
export function eventText(e) {
  const where = `${e.mr.repo} !${e.mr.iid}`;
  switch (e.kind) {
    case "failed": return { title: "Pipeline failed", body: `${e.mr.title} · ${where}`, level: "error" };
    case "passed": return { title: "Pipeline passed", body: `${e.mr.title} · ${where}`, level: "success" };
    case "approved": return { title: "MR approved", body: `${e.mr.title} · ${where}`, level: "success" };
    case "comments": return { title: e.n === 1 ? "New comment on your MR" : `${e.n} new comments on your MR`, body: `${e.mr.title} · ${where}`, level: "info" };
    case "review": return { title: "Review requested", body: `${e.mr.title} · by ${e.mr.author} · ${where}`, level: "info" };
    default: return { title: "Merge request", body: where, level: "info" };
  }
}
