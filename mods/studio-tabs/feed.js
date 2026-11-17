// The Studio feed: one poller for the facts several panes show (merge requests and pipelines, the
// Claude and Codex limits, the next automation, Herdr's own errors). It runs inside the tab bar,
// which is always on screen, and publishes small summaries with setShared, only when they change:
//   studio.mrs     { at, me, mine: [mr], reviews: [mr], error }
//   studio.limits  { claude: { five, fiveAt, week, weekAt, at }, codex: {...} }
//   studio.next    { name, schedule, at } | null
//   studio.errors  [string]
// Merge requests keep polling while the window is in the background, so alerts still arrive.
// Read-only `glab api` GETs, `hc read`, `crontab -l` and `herdr-app status`.

import { exec, hc, home, window, agents, shared, setShared, notify, playSound, setBadge, checking } from "herdr";
import { mrEvents, eventText, parseLimits, durationMs, nextJob } from "./feedlib.js";

const MR_EVERY = 180000, LIMITS_EVERY = 60000, CRON_EVERY = 300000, ERRORS_EVERY = 60000;
const DETAIL_LIMIT = 12;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function publish(key, value) {
  if (!same(shared(key), value)) setShared(key, value);
}

async function glab(args) {
  const r = await exec("glab", args, { cwd: home(), timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "glab failed").trim().split("\n")[0]);
  return JSON.parse(r.stdout);
}

// Only what the panes need, so shared.json stays small.
function compact(m, extra = {}) {
  const ref = m.references?.full ?? `!${m.iid}`;
  return {
    id: m.id, iid: m.iid, project: m.project_id,
    title: String(m.title ?? "").replace(/^Draft:\s*/i, ""),
    repo: ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1, ref.lastIndexOf("!")) : ref,
    branch: m.source_branch, url: m.web_url, draft: Boolean(m.draft),
    pipeline: m.head_pipeline?.status ?? null, pipelineId: m.head_pipeline?.id ?? null, conflicts: Boolean(m.has_conflicts),
    notes: m.user_notes_count ?? 0, author: m.author?.username ?? null,
    updated: Date.parse(m.updated_at) || null,
    ...extra,
  };
}

export class Feed {
  constructor() {
    this.busy = {};
    this.last = { mrs: 0, limits: 0, cron: 0, errors: 0 };
    this.me = null;
    this.failures = 0;
    try { this.snapshot = JSON.parse(localStorage.getItem("mr-snapshot") ?? "null"); } catch { this.snapshot = null; }
    this.badge = undefined;
  }

  start(cx) {
    if (checking()) return;
    this.tick(cx, true);
    cx.timer.every(15000, (cx) => this.tick(cx, false));
  }

  tick(cx, first) {
    const now = Date.now();
    const active = window()?.active !== false;
    if (first || now - this.last.mrs >= MR_EVERY) this.mrs(cx);
    if (active && (first || now - this.last.limits >= LIMITS_EVERY)) this.limits(cx);
    if (first || now - this.last.cron >= CRON_EVERY) this.cron(cx);
    if (active && (first || now - this.last.errors >= ERRORS_EVERY)) this.errors(cx);
  }

  // Refresh now (the Home and MRs panes' refresh buttons call this through "studio-tabs.refresh").
  refresh(cx) {
    this.mrs(cx);
    this.limits(cx);
    this.cron(cx);
    this.errors(cx);
  }

  job(name, cx, work) {
    if (this.busy[name]) return;
    this.busy[name] = true;
    this.last[name] = Date.now();
    cx.spawn(async (cx) => {
      try { await work(cx); } catch {}
      this.busy[name] = false;
    });
  }

  mrs(cx) {
    this.job("mrs", cx, async () => {
      try {
        this.me ??= (await glab(["api", "user"])).username;
        const me = this.me;
        const [mineList, askedRaw] = await Promise.all([
          glab(["api", "merge_requests?scope=created_by_me&state=opened&per_page=20"]),
          glab(["api", `merge_requests?scope=all&state=opened&reviewer_username=${encodeURIComponent(me)}&per_page=20`]),
        ]);
        const askedList = askedRaw.filter((m) => m.author?.username !== me);
        const approvals = async (m) => {
          try { return await glab(["api", `projects/${m.project_id}/merge_requests/${m.iid}/approvals`]); } catch { return null; }
        };
        const full = async (m) => {
          try { return await glab(["api", `projects/${m.project_id}/merge_requests/${m.iid}`]); } catch { return m; }
        };
        // Comments by other people only: your own replies on your MR are not news.
        const othersNotes = async (m) => {
          try {
            const notes = await glab(["api", `projects/${m.project_id}/merge_requests/${m.iid}/notes?per_page=100`]);
            return notes.filter((n) => !n.system && n.author?.username !== me).length;
          } catch { return null; }
        };
        const mine = await Promise.all(mineList.map(async (m, i) => {
          if (i >= DETAIL_LIMIT) return compact(m);
          const [f, a, n] = await Promise.all([full(m), approvals(m), othersNotes(m)]);
          return compact(f, { approvals: (a?.approved_by ?? []).length, ...(n != null ? { notes: n } : {}) });
        }));
        const reviews = await Promise.all(askedList.map(async (m, i) => {
          if (i >= DETAIL_LIMIT) return compact(m, { approvedByMe: false });
          const [f, a] = await Promise.all([full(m), approvals(m)]);
          return compact(f, { approvedByMe: (a?.approved_by ?? []).some((x) => x.user?.username === me) });
        }));
        const next = { at: Date.now(), me, mine, reviews, error: null };
        this.alert(mrEvents(this.snapshot, next));
        this.snapshot = { mine, reviews };
        try { localStorage.setItem("mr-snapshot", JSON.stringify(this.snapshot)); } catch {}
        this.failures = 0;
        // `at` changes every poll; publish it only with a real change, or every mod redraws for nothing.
        const prev = shared("studio.mrs");
        if (!prev || !same({ ...prev, at: 0 }, { ...next, at: 0 }) || Date.now() - (prev.at ?? 0) > 600000) setShared("studio.mrs", next);
      } catch (e) {
        // One miss may be a blip; two in a row and the counts can't be trusted.
        this.failures += 1;
        if (this.failures >= 2) {
          const prev = shared("studio.mrs");
          publish("studio.mrs", { at: prev?.at ?? null, me: this.me, mine: prev?.mine ?? [], reviews: prev?.reviews ?? [], error: String(e.message ?? e) });
        }
      }
    });
  }

  // Toasts in Herdr; with the window in the background, a system notification too (and a sound for
  // a failed pipeline). Quiet mode (shared "studio.quiet") keeps only the Dock badge.
  alert(events) {
    if (!events.length || shared("studio.quiet")) return;
    const away = window()?.active === false;
    for (const e of events.slice(0, 4)) {
      const { title, body, level } = eventText(e);
      notify({ title, body, level, timeout: e.kind === "failed" ? 12000 : 6000, action: { name: "studio-tabs.panel", args: {} } });
      if (away) {
        const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        exec("osascript", ["-e", `display notification "${esc(body)}" with title "Herdr Studio" subtitle "${esc(title)}"`], { cwd: home(), timeout: 5000 }).catch(() => {});
      }
    }
    if (away && events.some((e) => e.kind === "failed")) playSound("blocked");
  }

  // The freshest Claude and Codex screens' status lines. Two `hc read`s a minute at most.
  limits(cx) {
    this.job("limits", cx, async () => {
      const prev = shared("studio.limits") ?? {};
      const out = { ...prev };
      const now = Date.now();
      for (const kind of ["claude", "codex"]) {
        const a = agents().filter((x) => (x.program?.key ?? "") === kind || (kind === "claude" && x.app === "claude-code"))
          .sort((x, y) => y.seq - x.seq)[0];
        if (!a) continue;
        const r = await hc(["read", a.address, "--lines", "30"]);
        const got = r.code === 0 ? parseLimits(r.stdout) : null;
        if (!got || got.kind !== kind) continue;
        const reset = (text, old) => {
          const ms = durationMs(text);
          // Minute rounding: keep the old moment when it's within two minutes, so the value doesn't churn.
          const at = ms ? now + ms : old ?? null;
          return old && at && Math.abs(at - old) < 120000 ? old : at;
        };
        out[kind] = {
          five: got.five ?? prev[kind]?.five ?? null, fiveAt: reset(got.fiveReset, prev[kind]?.fiveAt),
          week: got.week ?? prev[kind]?.week ?? null, weekAt: reset(got.weekReset, prev[kind]?.weekAt),
        };
      }
      publish("studio.limits", out);
    });
  }

  cron(cx) {
    this.job("cron", cx, async () => {
      const r = await exec("crontab", ["-l"], { cwd: home(), timeout: 10000 });
      publish("studio.next", r.code === 0 ? nextJob(r.stdout) : null);
    });
  }

  errors(cx) {
    this.job("errors", cx, async () => {
      const r = await exec("herdr-app", ["status"], { cwd: home(), timeout: 10000 });
      if (r.code !== 0) return;
      const list = JSON.parse(r.stdout).errors ?? [];
      publish("studio.errors", list.map((e) => String(e)).slice(0, 8));
    });
  }

  // The Dock badge: agents that need you plus your failed pipelines. Called from the tab bar's render.
  updateBadge() {
    const blocked = agents().filter((a) => a.status === "blocked").length;
    const failed = (shared("studio.mrs")?.mine ?? []).filter((m) => m.pipeline === "failed" && !m.draft).length;
    const n = blocked + failed;
    const text = n ? String(n) : null;
    if (text !== this.badge) {
      this.badge = text;
      setBadge(text);
    }
  }
}
