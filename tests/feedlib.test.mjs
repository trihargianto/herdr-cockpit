// Pure helpers behind the Studio feed and work items. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, cronJobs, nextJob, parseLimits, durationMs, mrEvents, eventText } from "../mods/studio-tabs/feedlib.js";
import { jiraKeys, taskKey, workOf } from "../mods/studio-home/work.js";
import { readFileSync } from "node:fs";

test("jira keys come from titles and branches, upper case only", () => {
  assert.deepEqual(jiraKeys("feature/CFE-1886-upgrade-node-22"), ["CFE-1886"]);
  assert.deepEqual(jiraKeys("spike/CFE-1973-upgrade-to-vue-2-7"), ["CFE-1973"]);
  assert.deepEqual(jiraKeys("CFE-1904 limit deploy, see LIMO-10997"), ["CFE-1904", "LIMO-10997"]);
  assert.deepEqual(jiraKeys("no key here"), []);
});

test("the two copies of work.js stay equal", () => {
  assert.equal(readFileSync(new URL("../mods/studio-home/work.js", import.meta.url), "utf8"),
    readFileSync(new URL("../mods/studio-tasks/work.js", import.meta.url), "utf8"));
});

test("taskKey prefers the field, then the title, then a Jira link", () => {
  assert.equal(taskKey({ jira: "cfe-1", title: "CFE-2 x" }), "CFE-1");
  assert.equal(taskKey({ title: "Fix CFE-1880 build", links: [] }), "CFE-1880");
  assert.equal(taskKey({ title: "Fix build", links: ["https://mamikos.atlassian.net/browse/LIMO-12"] }), "LIMO-12");
  assert.equal(taskKey({ title: "Fix build", links: [] }), null);
});

test("workOf joins branch, space, agent and MR by key", () => {
  const w = workOf({ title: "CFE-1886 upgrade" }, {
    panes: [{ tab: "tb1", branch: "feature/CFE-1886-upgrade-node", focused: true }, { tab: "tb2", branch: "main" }],
    spaces: [{ id: "sp1", name: "mamikos-web", tabs: [{ id: "tb1" }] }],
    agents: [{ address: "t1", tab: "tb1", status: "working" }, { address: "t2", tab: "tb1", status: "blocked" }],
    mrs: { mine: [{ iid: 7, branch: "feature/CFE-1886-upgrade-node", pipeline: "failed" }], reviews: [] },
    jira: "https://example.atlassian.net/",
  });
  assert.equal(w.key, "CFE-1886");
  assert.equal(w.url, "https://example.atlassian.net/browse/CFE-1886");
  assert.equal(workOf({ title: "CFE-1886 upgrade" }).url, null);
  assert.deepEqual(w.space, { id: "sp1", name: "mamikos-web" });
  assert.equal(w.agent.address, "t2");
  assert.equal(w.mr.iid, 7);
});

test("nextRun finds the next minute a schedule fires", () => {
  const from = new Date(2026, 10, 16, 8, 30).getTime(); // Monday 08:30
  assert.equal(nextRun("0 9 * * *", from), new Date(2026, 10, 16, 9, 0).getTime());
  assert.equal(nextRun("*/15 * * * *", from), new Date(2026, 10, 16, 8, 45).getTime());
  assert.equal(nextRun("0 9 * * 1", new Date(2026, 10, 16, 10).getTime()), new Date(2026, 10, 23, 9, 0).getTime());
  assert.equal(nextRun("@hourly", from), new Date(2026, 10, 16, 9, 0).getTime());
  assert.equal(nextRun("@reboot", from), null);
  assert.equal(nextRun("61 * * * *", from), null);
});

test("cron jobs keep Studio names and skip disabled lines", () => {
  const text = "# herdr-studio-name: Daily backup\n0 9 * * * /x/backup.sh\n# herdr-studio-disabled: 0 8 * * * vim\nPATH=/bin\n@hourly /y/ping\n";
  assert.deepEqual(cronJobs(text).map((j) => j.name), ["Daily backup", "ping"]);
  const from = new Date(2026, 10, 16, 8, 30).getTime();
  assert.equal(nextJob(text, from).name, "Daily backup");
});

test("limits parse Claude's status line, wrapped or not, and Codex's footer", () => {
  const one = "Context ██░░ 42% │ Usage █░░ 9% (resets in 3h 21m) | Weekly ███ 98% (resets in 4h 51m)";
  assert.deepEqual(parseLimits(one), { kind: "claude", five: 9, fiveReset: "3h 21m", week: 98, weekReset: "4h 51m" });
  const wrapped = "  Context █░░░░ 24%\n  Usage ██░░ 25% (resets in 2h 1m)\n  Weekly ████░░ 59% (resets in 3d 7h)";
  assert.equal(parseLimits(wrapped).week, 59);
  assert.equal(parseLimits(wrapped).five, 25);
  assert.deepEqual(parseLimits("Context 11% used · 5h 23% left · weekly 82% left"), { kind: "codex", five: 77, fiveReset: null, week: 18, weekReset: null });
  assert.equal(durationMs("3d 7h"), (3 * 24 + 7) * 3600000);
});

test("MR alerts only on changes, never on the first snapshot", () => {
  const a = { id: 1, iid: 5, repo: "web", title: "T", pipeline: "running", approvals: 0, notes: 1 };
  assert.deepEqual(mrEvents(null, { mine: [a], reviews: [] }), []);
  const ev = mrEvents({ mine: [a], reviews: [] }, { mine: [{ ...a, pipeline: "failed", approvals: 1, notes: 3 }], reviews: [{ id: 9, iid: 2, repo: "x", title: "R", author: "ed" }] });
  assert.deepEqual(ev.map((e) => e.kind), ["failed", "approved", "comments", "review"]);
  assert.equal(eventText(ev[2]).title, "2 new comments on your MR");
  const passed = mrEvents({ mine: [a], reviews: [] }, { mine: [{ ...a, pipeline: "success" }], reviews: [] });
  assert.deepEqual(passed.map((e) => e.kind), ["passed"]);
});

import { Nav, keyName } from "../mods/studio-home/nav.js";
import { readdirSync } from "node:fs";

test("every copy of nav.js is the same", () => {
  const mods = new URL("../mods/", import.meta.url);
  const home = readFileSync(new URL("studio-home/nav.js", mods), "utf8");
  for (const m of readdirSync(mods)) {
    try { assert.equal(readFileSync(new URL(`${m}/nav.js`, mods), "utf8"), home, m); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
  }
});

const ev = (key, mods = {}, key_char) => ({ key, key_char, modifiers: mods });
const fakeCx = { focus_handle: () => ({ is_focused: () => true, focus() {} }) };

test("nav moves like vim: counts, gg, G, half pages, pairs", () => {
  const n = new Nav(fakeCx);
  const runs = [];
  const run = (c, a) => runs.push([c, a?.direction]);
  const press = (k, m, ch, acts) => n.key(ev(k, m, ch), 20, acts, run);
  press("j"); assert.equal(n.sel, 1);
  press("5"); press("j"); assert.equal(n.sel, 6);
  press("k"); assert.equal(n.sel, 5);
  press("g", { shift: true }, "G"); assert.equal(n.sel, 19);
  press("g"); press("g"); assert.equal(n.sel, 0);
  press("d", { control: true }); assert.equal(n.sel, 6);
  press("3"); press("g", { shift: true }, "G"); assert.equal(n.sel, 2);
  let deleted = null;
  press("d", {}, null, { dd: (i) => { deleted = i; } }); press("d", {}, null, { dd: (i) => { deleted = i; } });
  assert.equal(deleted, 2);
  press("l", { control: true }); press("h");
  assert.deepEqual(runs, [["pane.go", "right"], ["pane.go", "left"]]);
  assert.equal(press("w"), false);
  press("q"); assert.deepEqual(runs.at(-1), ["studio-tabs.close-panel", undefined]);
  assert.equal(keyName(ev("p", { platform: true })), null);
});
