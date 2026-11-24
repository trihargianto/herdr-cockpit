// Joining the panel's tasks with an outside edit of tasks.json. Run: node --test tests/merge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTasks, sameTask } from "../mods/cockpit-tasks/merge.js";

const base = [
  { id: "a", title: "A", status: "todo", updated: 1 },
  { id: "b", title: "B", status: "doing", updated: 1 },
];
const ids = (list) => list.map((x) => x.id).sort();
const get = (list, id) => list.find((x) => x.id === id);

test("a hand edit that doesn't bump updated survives", () => {
  const disk = [{ ...base[0], title: "A by hand" }, base[1]];
  const out = mergeTasks(base, disk, base);
  assert.equal(get(out, "a").title, "A by hand");
});

test("a panel change without an updated bump (today, rank) survives", () => {
  const mine = [{ ...base[0], todayAt: 5 }, base[1]];
  const disk = [base[0], { ...base[1], title: "B by hand" }];
  const out = mergeTasks(mine, disk, base);
  assert.equal(get(out, "a").todayAt, 5);
  assert.equal(get(out, "b").title, "B by hand");
});

test("when both sides changed one task, the later updated wins", () => {
  const mine = [{ ...base[0], title: "panel", updated: 3 }, base[1]];
  const disk = [{ ...base[0], title: "disk", updated: 2 }, base[1]];
  assert.equal(get(mergeTasks(mine, disk, base), "a").title, "panel");
  const later = [{ ...base[0], title: "disk", updated: 4 }, base[1]];
  assert.equal(get(mergeTasks(mine, later, base), "a").title, "disk");
});

test("a panel delete stays deleted", () => {
  assert.deepEqual(ids(mergeTasks([base[1]], base, base)), ["b"]);
});

test("an outside delete stays deleted", () => {
  assert.deepEqual(ids(mergeTasks(base, [base[0]], base)), ["a"]);
});

test("new tasks on either side are kept", () => {
  const mine = [...base, { id: "p", title: "panel new" }];
  const disk = [...base, { id: "d", title: "disk new" }];
  assert.deepEqual(ids(mergeTasks(mine, disk, base)), ["a", "b", "d", "p"]);
});

test("deleted on one side but changed on the other is kept", () => {
  const mine = [{ ...base[0], title: "A changed", updated: 2 }, base[1]];
  assert.equal(get(mergeTasks(mine, [base[1]], base), "a").title, "A changed");
});

test("without a base everything is kept and the later updated wins", () => {
  const out = mergeTasks([{ ...base[0], updated: 2, title: "new" }], [base[0], base[1]], null);
  assert.deepEqual(ids(out), ["a", "b"]);
  assert.equal(get(out, "a").title, "new");
});

test("field order doesn't make two copies differ", () => {
  assert.ok(sameTask({ id: "a", title: "x", log: [{ at: 1, text: "t" }] }, { log: [{ text: "t", at: 1 }], title: "x", id: "a" }));
});
