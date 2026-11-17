// A work item: one task followed through Jira, its branch and space, the agent on it, and its MR.
// The Jira key joins them: it is in the task's title or links, and in the branch name
// ("feature/CFE-1886-upgrade-node"). Pure: the caller passes Herdr's live lists in.
// The same file lives in studio-home and studio-tasks (mods can't import each other); keep them equal.

export const JIRA = "https://mamikos.atlassian.net/browse/";

// Upper case only ("CFE-1880"): lower case would read "upgrade-node-22" as NODE-22.
export function jiraKeys(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d{1,6})(?![0-9])/g)) {
    const key = m[1];
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

// The task's key: its own `jira` field, else the first key in its title, else in a Jira link.
export function taskKey(task) {
  if (task?.jira) return String(task.jira).toUpperCase();
  const fromTitle = jiraKeys(task?.title)[0];
  if (fromTitle) return fromTitle;
  for (const link of task?.links ?? []) {
    const m = String(link).match(/\/browse\/([A-Z][A-Z0-9]{1,9}-\d{1,6})/);
    if (m) return m[1];
  }
  return null;
}

const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };

// { key, url, branch, space: {id, name} | null, tab, agent: {address, status} | null, mr | null }, or null
// without a key. `mrs` is shared("studio.mrs").
export function workOf(task, { panes = [], spaces = [], agents = [], mrs = null } = {}) {
  const key = taskKey(task);
  if (!key) return null;
  const onBranch = panes.filter((p) => p.branch && jiraKeys(p.branch).includes(key));
  const tabs = new Set(onBranch.map((p) => p.tab));
  const space = spaces.find((s) => s.tabs?.some((t) => tabs.has(t.id))) ?? null;
  const agent = agents.filter((a) => tabs.has(a.tab)).sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))[0] ?? null;
  const all = [...(mrs?.mine ?? []), ...(mrs?.reviews ?? [])];
  const mr = all.find((m) => jiraKeys(m.branch).includes(key) || jiraKeys(m.title).includes(key)) ?? null;
  return {
    key, url: `${JIRA}${key}`,
    branch: onBranch[0]?.branch ?? mr?.branch ?? null,
    space: space ? { id: space.id, name: space.name } : null,
    tab: onBranch.find((p) => p.focused)?.tab ?? onBranch[0]?.tab ?? null,
    agent: agent ? { address: agent.address, status: agent.status } : null,
    mr,
  };
}
