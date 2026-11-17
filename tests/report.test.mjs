// The Tasks report's pure parts. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastWorkday, reportRows, reportHtml, startedAt } from "../mods/cockpit-tasks/report.js";

const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h).getTime();
const day = (y, m, d) => new Date(y, m - 1, d).getTime();

test("the last working day skips the weekend", () => {
  assert.equal(lastWorkday(at(2026, 11, 16)), day(2026, 11, 13), "Monday looks back to Friday");
  assert.equal(lastWorkday(at(2026, 11, 14)), day(2026, 11, 13), "Saturday looks back to Friday");
  assert.equal(lastWorkday(at(2026, 11, 15)), day(2026, 11, 13), "Sunday looks back to Friday");
  assert.equal(lastWorkday(at(2026, 11, 17)), day(2026, 11, 16), "Tuesday looks back to Monday");
  assert.equal(lastWorkday(at(2026, 11, 17, 0)), day(2026, 11, 16), "just after midnight too");
});

test("a task deleted before it was done stays out; one deleted after still counts", () => {
  const rows = reportRows([
    { id: "a", title: "dropped", status: "todo", deleted: 1 },
    { id: "b", title: "finished then deleted", status: "done", doneAt: 5, deleted: 6 },
    { id: "c", title: "open", status: "doing" },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["b", "c"]);
  assert.equal(rows[0].deleted, 6);
});

test("blocked only shows on a task that isn't done", () => {
  const [a, b] = reportRows([
    { id: "a", status: "doing", blocked: { reason: "waiting on API", at: 1 } },
    { id: "b", status: "done", blocked: { reason: "stale", at: 1 } },
  ]);
  assert.equal(a.blocked.reason, "waiting on API");
  assert.equal(b.blocked, null);
});

test("work starts at the last move to doing before done", () => {
  const row = { doneAt: 50, history: [{ status: "doing", at: 10 }, { status: "blocked", at: 20 }, { status: "doing", at: 30 }, { status: "doing", at: 60 }] };
  assert.equal(startedAt(row), 30);
});

test("the page carries the same lastWorkday code and escapes titles", () => {
  const html = reportHtml([{ id: "x", title: "</script><b>$&", status: "todo" }], at(2026, 11, 17));
  assert.ok(html.includes(lastWorkday.toString()));
  assert.ok(!html.includes("/*__LIB__*/"));
  assert.ok(html.includes("\\u003c/script>\\u003cb>$&"));
});
