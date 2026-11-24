// Quick add, the Jira summary lookup and search. Run: node --test tests/quick.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuick, bareKey, summaryOf, matches, toLink } from "../mods/cockpit-tasks/quick.js";

test("a pasted Jira URL becomes a link, and its key the title", () => {
  assert.deepEqual(parseQuick("https://team.atlassian.net/browse/CFE-1998"),
    { title: "CFE-1998", links: ["https://team.atlassian.net/browse/CFE-1998"] });
  assert.deepEqual(parseQuick("https://team.atlassian.net/jira/software/projects/CFE/boards/1?selectedIssue=CFE-7"),
    { title: "CFE-7", links: ["https://team.atlassian.net/jira/software/projects/CFE/boards/1?selectedIssue=CFE-7"] });
});

test("words stay the title and URLs leave it", () => {
  assert.deepEqual(parseQuick("Fix login https://gl.dev/mr/3 today"), { title: "Fix login today", links: ["https://gl.dev/mr/3"] });
});

test("a URL with no key titles the task by its short form", () => {
  assert.deepEqual(parseQuick("https://example.com/a/b?x=1"), { title: "example.com/a/b", links: ["https://example.com/a/b?x=1"] });
});

test("bare domains and file names are words, not links", () => {
  assert.deepEqual(parseQuick("Upgrade to Vue 2.7"), { title: "Upgrade to Vue 2.7", links: [] });
  assert.deepEqual(parseQuick("Split main.js"), { title: "Split main.js", links: [] });
  assert.equal(toLink("example.com"), "https://example.com", "the form's link field still takes them");
});

test("only a title that is just a key asks Jira", () => {
  assert.ok(bareKey("CFE-1998"));
  assert.ok(!bareKey("CFE-1998 fix"));
  assert.ok(!bareKey("cfe-1998"));
});

test("the summary comes out of acli's JSON, anything else is null", () => {
  assert.equal(summaryOf('{"key":"CFE-1","fields":{"summary":" Remove stale listeners "}}'), "Remove stale listeners");
  assert.equal(summaryOf('{"fields":{}}'), null);
  assert.equal(summaryOf("Error: unauthorized"), null);
});

test("search matches every word in title, details, links or key", () => {
  const task = { title: "Fix build", notes: "The **cache** step fails", links: ["https://team.atlassian.net/browse/CFE-12"] };
  assert.ok(matches(task, "CACHE build"));
  assert.ok(matches(task, "cfe-12"));
  assert.ok(matches(task, ""));
  assert.ok(!matches(task, "cache deploy"));
});
