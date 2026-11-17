import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clip, message, defaultTarget, groups, queue, unqueue, remove, queuedByTarget, notesOf, ready, MAX_QUOTE } from "../mods/cockpit-annotate/annolib.js";

test("both copies of annolib.js are the same", () => {
  assert.equal(readFileSync(new URL("../mods/cockpit-annotate/annolib.js", import.meta.url), "utf8"),
    readFileSync(new URL("../mods/cockpit-tabs/annolib.js", import.meta.url), "utf8"));
});

const src = (terminal, extra = {}) => ({ terminal, space: "s1", label: terminal === "t3" ? "Claude Code" : "npm test", agent: terminal === "t3", ...extra });
const note = (id, at, terminal, extra = {}) => ({ id, at, quote: "", comment: "", source: src(terminal), ...extra });

test("clip trims blank edges and trailing spaces, and caps the length", () => {
  assert.equal(clip("\n\n  a  \r\nb   \n\n"), "  a\nb");
  assert.equal(clip(undefined), "");
  const long = clip("x".repeat(MAX_QUOTE + 50));
  assert.equal(long.length, MAX_QUOTE + 1);
  assert.ok(long.endsWith("…"));
});

test("message: oldest first, quotes as blockquotes, names a source other than the target", () => {
  const text = message([
    note("b", 2, "t5", { quote: "FAIL x", comment: "flaky" }),
    note("a", 1, "t3", { quote: "line 1\n\nline 3", comment: " pin react " }),
  ], "t3");
  assert.equal(text, [
    "## Annotation 1", "Comment on:", "> line 1\n>\n> line 3", "pin react",
    "",
    "## Annotation 2", "From npm test (t5)", "Comment on:", "> FAIL x", "flaky",
  ].join("\n"));
});

test("defaultTarget: the one agent the notes came from, else the focused agent, else nobody", () => {
  assert.equal(defaultTarget([note("a", 1, "t3"), note("b", 2, "t3")], ["t3", "t9"], "t9"), "t3");
  assert.equal(defaultTarget([note("a", 1, "t3"), note("b", 2, "t5")], ["t3", "t9"], "t9"), "t9");
  assert.equal(defaultTarget([note("a", 1, "t5")], ["t3"], null), null);
  assert.equal(defaultTarget([note("a", 1, "t3")], ["t9"], "gone"), null); // t3 closed
});

test("groups follow the first note of each terminal", () => {
  const g = groups([note("c", 3, "t3"), note("a", 1, "t5"), note("b", 2, "t3")]);
  assert.deepEqual(g.map((x) => [x.terminal, x.notes.map((n) => n.id)]), [["t5", ["a"]], ["t3", ["b", "c"]]]);
});

test("queue, unqueue with an error, and remove", () => {
  let notes = [note("a", 1, "t3"), note("b", 2, "t5", { error: "old" }), note("c", 3, "t5")];
  notes = queue(notes, ["a", "b"], "t3", 100);
  assert.deepEqual(notes.map((n) => n.queued?.to ?? null), ["t3", "t3", null]);
  assert.equal(notes[1].error, undefined);
  assert.deepEqual(queuedByTarget(notes).map((q) => [q.to, q.notes.length]), [["t3", 2]]);
  const back = unqueue(notes, { ids: ["a"], error: "busy" });
  assert.equal(back[0].queued, undefined);
  assert.equal(back[0].error, "busy");
  assert.equal(back[1].queued.to, "t3");
  assert.deepEqual(unqueue(notes, { to: "t9" }), notes);
  assert.deepEqual(remove(notes, ["a", "c"]).map((n) => n.id), ["b"]);
});

test("notesOf and ready", () => {
  assert.deepEqual(notesOf(null), []);
  assert.deepEqual(notesOf({ notes: "x" }), []);
  assert.ok(ready("idle") && ready("done"));
  assert.ok(!ready("working") && !ready("blocked"));
});

import { lastReply, reviewMessage } from "../mods/cockpit-annotate/annolib.js";

test("a review's feedback goes without a heading, and doesn't take an annotation number", () => {
  const text = message([
    note("r", 1, "t3", { kind: "review", comment: "The user approved your last reply." }),
    note("a", 2, "t3", { comment: "and this" }),
  ], "t3");
  assert.equal(text, "The user approved your last reply.\n\n## Annotation 1\nand this");
});

test("lastReply: the text after the last prompt or tool result, skipping thinking, tools and sidechains", () => {
  const L = (o) => JSON.stringify(o);
  const lines = [
    L({ type: "user", message: { content: "plan it" } }),
    L({ type: "assistant", message: { content: [{ type: "text", text: "Let me look." }, { type: "tool_use" }] } }),
    L({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    L({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hm" }] } }),
    L({ type: "assistant", message: { content: [{ type: "text", text: "## Plan\n1. a" }] } }),
    L({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub-agent" }] } }),
    L({ type: "assistant", message: { content: [{ type: "text", text: "2. b" }] } }),
    L({ type: "system" }),
    "not json",
  ];
  assert.equal(lastReply(lines), "## Plan\n1. a\n\n2. b");
  assert.equal(lastReply([L({ type: "user", message: { content: "hi" } })]), "");
});

test("reviewMessage", () => {
  assert.equal(reviewMessage({ decision: "dismissed" }, "x"), null);
  assert.equal(reviewMessage(null, "x"), null);
  assert.equal(reviewMessage({ decision: "approved" }, "your last reply"), "The user approved your last reply.");
  assert.equal(reviewMessage({ decision: "approved", feedback: "nit" }, "it"), "The user approved it.\n\nNotes, not blocking:\n\nnit");
  assert.equal(reviewMessage({ decision: "annotated", feedback: " fix 2 " }, "it"), "The user reviewed it in Plannotator:\n\nfix 2");
  assert.equal(reviewMessage({ decision: "annotated", feedback: "" }, "it"), null);
});
