// The brief an agent reads for a task. Run: node --test tests/brief.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { brief } from "../mods/cockpit-tasks/brief.js";

const task = { id: "task-1", title: "CFE-1 fix build", notes: "", links: [], status: "doing" };

test("a bare task is its title and the footer", () => {
  assert.equal(brief(task), "# Task: CFE-1 fix build\n\n_From Herdr Cockpit tasks · task-1_\n");
});

test("details and links come first", () => {
  const md = brief({ ...task, notes: "Why it broke", links: ["https://a.dev/x"] });
  assert.match(md, /^# Task: CFE-1 fix build\n\nWhy it broke\n\n## Links\n- https:\/\/a\.dev\/x\n/);
});

test("the work item lists Jira, branch and MR with its pipeline", () => {
  const md = brief(task, { key: "CFE-1", url: "https://j.net/browse/CFE-1", branch: "feature/CFE-1-x", mr: { url: "https://gl/mr/2", pipeline: "failed" } });
  assert.match(md, /## Work item\n- Jira: CFE-1 \(https:\/\/j\.net\/browse\/CFE-1\)\n- Branch: feature\/CFE-1-x\n- MR: https:\/\/gl\/mr\/2 \(pipeline: failed\)\n/);
});

test("a key without a Jira site still shows, with no link", () => {
  assert.match(brief(task, { key: "CFE-1", url: null, branch: null, mr: null }), /- Jira: CFE-1\n/);
});

test("a block shows on an open task, not on a done one", () => {
  const blocked = { reason: "waiting on API", at: 1 };
  assert.match(brief({ ...task, blocked }), /\nBlocked: waiting on API\n/);
  assert.doesNotMatch(brief({ ...task, status: "done", blocked }), /Blocked/);
});

test("progress notes are listed by local day, oldest first", () => {
  const log = [{ at: new Date(2026, 10, 18, 9).getTime(), text: "found it" }, { at: new Date(2026, 10, 19, 17).getTime(), text: "MR up" }];
  assert.match(brief({ ...task, log }), /## Progress so far\n- 2026-11-18: found it\n- 2026-11-19: MR up\n/);
});
