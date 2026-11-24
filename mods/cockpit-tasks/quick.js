// Quick add and search, the parts node can test: links pulled out of a typed line, a bare Jira key
// waiting for its summary, and which tasks a search matches.
import { jiraKeys, taskKey } from "./work.js";

// "https://host/a/b?x" shown as "host/a/b".
export function short(url) {
  return url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
}

// Only http(s) links open (`open_url` refuses everything else); a bare domain gets https.
export function toLink(raw) {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\/\S+\.\S+/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`;
  return null;
}

// A quick-add line: http(s) URLs leave the title and become links. Bare domains stay words
// ("Vue 2.7", "main.js" are titles, not links). A title left empty takes the Jira key from a URL,
// else the first URL, shortened.
export function parseQuick(text) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const links = [];
  const rest = [];
  for (const w of words) {
    const link = /^https?:\/\//i.test(w) ? toLink(w) : null;
    if (link) { if (!links.includes(link)) links.push(link); }
    else rest.push(w);
  }
  let title = rest.join(" ");
  if (!title && links.length) {
    title = taskKey({ title: "", links }) ?? links.map((l) => jiraKeys(l)[0]).find(Boolean) ?? short(links[0]);
  }
  return { title, links };
}

// A title that is nothing but a Jira key ("CFE-1998"): worth asking Jira for its summary.
export const bareKey = (title) => /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(String(title ?? "").trim());

// The summary in `acli jira workitem view KEY --fields summary --json` output, or null.
export function summaryOf(json) {
  try {
    const s = JSON.parse(json)?.fields?.summary;
    return typeof s === "string" && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

// Search: every word of the query, case-insensitive, somewhere in the title, details, links or Jira key.
export function matches(task, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [task.title, task.notes, ...(task.links ?? []), taskKey(task)].filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}
