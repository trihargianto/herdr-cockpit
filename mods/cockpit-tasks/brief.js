// The markdown brief an agent reads for a task: the task itself, then what Cockpit knows around it
// (Jira, branch, MR, a block, progress so far), so an agent picking it up mid-way starts where it
// stands. Pure, so node can test it. `work` is workOf(...) from work.js, or null.

// "2026-11-18" in local time.
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function brief(task, work = null) {
  const lines = [`# Task: ${task.title}`, ""];
  if (task.notes) lines.push(task.notes, "");
  if (task.links?.length) lines.push("## Links", ...task.links.map((l) => `- ${l}`), "");
  const item = [];
  if (work?.key) item.push(`- Jira: ${work.key}${work.url ? ` (${work.url})` : ""}`);
  if (work?.branch) item.push(`- Branch: ${work.branch}`);
  if (work?.mr?.url) item.push(`- MR: ${work.mr.url}${work.mr.pipeline ? ` (pipeline: ${work.mr.pipeline})` : ""}`);
  if (item.length) lines.push("## Work item", ...item, "");
  if (task.blocked && task.status !== "done") lines.push(`Blocked: ${task.blocked.reason}`, "");
  const log = task.log ?? [];
  if (log.length) lines.push("## Progress so far", ...log.map((n) => `- ${localDay(n.at)}: ${n.text}`), "");
  lines.push(`_From Herdr Cockpit tasks · ${task.id}_`, "");
  return lines.join("\n");
}
