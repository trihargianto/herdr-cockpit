// Joins the panel's task list with tasks.json as it is on disk, when the file changed since the panel
// last read or wrote it (an edit by hand, or by an agent). Pure, so node can test it.
//
// Three-way, against `base`: the list as last read or written. Per task id:
// - on both sides: a side still equal to the base gives way to the other; when both changed, the later
//   `updated` wins (hand edits and today/rank changes don't always bump it, hence the base check).
// - on one side only: new there (not in the base) is kept; gone from the other side since the base
//   means it was deleted there, so it stays deleted. A task deleted on one side but changed on the
//   other is kept, so nothing typed is lost.
// Without a base, every task is kept and the later `updated` wins.

// JSON with sorted keys, so two copies compare equal whatever order their fields were written in.
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sameTask = (a, b) => canon(a) === canon(b);

export function mergeTasks(mine, disk, base = null) {
  const byId = (list) => new Map((list ?? []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const m = byId(mine), d = byId(disk), b = base ? byId(base) : null;
  const out = [];
  const ids = [...m.keys(), ...[...d.keys()].filter((id) => !m.has(id))];
  for (const id of ids) {
    const a = m.get(id), c = d.get(id), was = b?.get(id);
    if (a && c) {
      if (was && sameTask(a, was)) out.push(c);
      else if (was && sameTask(c, was)) out.push(a);
      else out.push((c.updated ?? 0) > (a.updated ?? 0) ? c : a);
    } else {
      const only = a ?? c;
      // In the base and untouched on this side: the other side deleted it.
      if (was && sameTask(only, was)) continue;
      out.push(only);
    }
  }
  return out;
}
