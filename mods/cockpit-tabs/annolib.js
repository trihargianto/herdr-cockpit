// Annotations: notes on text selected in a terminal, sent to an agent as one message.
// The same file lives in cockpit-annotate (the panel and the note dialog) and cockpit-tabs (capture and
// the send queue): mods can't import each other, and tests/annolib.test.mjs checks the copies stay equal.
// It imports nothing, so node can test it.
//
// The notes live in shared("cockpit.annotations") as { notes: [note] }. A note:
//   { id, at, quote, comment,
//     source: { terminal, space, space_name, tab, tab_name, label, agent },
//     queued?: { to, at },   waiting for agent `to` to be idle (cockpit-tabs sends it)
//     error?: string,        why the last send failed
//     kind?: "review" }      a Plannotator review's feedback: sent as it is, without a heading
// A sent note leaves the list; cockpit-tabs and the panel append it to cockpit-annotate/sent.jsonl.

export const KEY = "cockpit.annotations";
export const MAX_QUOTE = 6000;
export const QUOTE_LINES = 8; // shown in the note dialog

// The note dialog's height for a quote, so it opens at its size.
export function dialogHeight(quote) {
  const lines = quote ? quote.split("\n").length : 0;
  const shown = Math.min(lines, QUOTE_LINES) + (lines > QUOTE_LINES ? 1 : 0);
  return 32 + 26 + 12 + (shown ? shown * 16 + 18 + 12 : 0) + 120 + 12 + 30;
}

export function notesOf(value) {
  return Array.isArray(value?.notes) ? value.notes : [];
}

export function newId(now = Date.now()) {
  return `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Selected terminal text, tidied: no trailing spaces, no blank lines around it, at most MAX_QUOTE characters.
export function clip(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const out = lines.join("\n");
  return out.length > MAX_QUOTE ? `${out.slice(0, MAX_QUOTE)}…` : out;
}

// An agent takes a message when it's idle, or has finished and waits for you.
export const ready = (status) => status === "idle" || status === "done";

// "Claude · fix booking flow (t3)": what a source is called in the panel and in the message.
export function sourceName(s) {
  if (!s) return "a terminal";
  const label = s.label || "Terminal";
  return s.terminal ? `${label} (${s.terminal})` : label;
}

// Who gets the notes when you haven't picked: the one agent they all came from, else the focused agent.
export function defaultTarget(notes, agentAddresses, focusedAgent) {
  const live = new Set(agentAddresses);
  const from = [...new Set(notes.map((n) => n.source?.terminal).filter(Boolean))];
  if (from.length === 1 && live.has(from[0])) return from[0];
  if (focusedAgent && live.has(focusedAgent)) return focusedAgent;
  return null;
}

// The message an agent gets: oldest note first. A note from another terminal says where it came from.
// A review's feedback goes as it is.
export function message(notes, to) {
  const sorted = [...notes].sort((a, b) => a.at - b.at);
  let i = 0;
  return sorted.map((n) => {
    if (n.kind === "review") return (n.comment ?? "").trim();
    const out = [`## Annotation ${++i}`];
    if (n.source?.terminal && n.source.terminal !== to) out.push(`From ${sourceName(n.source)}`);
    if (n.quote) {
      out.push("Comment on:");
      out.push(n.quote.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
    }
    if (n.comment?.trim()) out.push(n.comment.trim());
    return out.join("\n");
  }).join("\n\n");
}

// Notes grouped by the terminal they came from, groups in the order of their first note.
export function groups(notes) {
  const by = new Map();
  for (const n of [...notes].sort((a, b) => a.at - b.at)) {
    const key = n.source?.terminal ?? "?";
    if (!by.has(key)) by.set(key, { terminal: key, source: n.source, notes: [] });
    by.get(key).notes.push(n);
  }
  return [...by.values()];
}

// Puts notes in the queue for `to`. They stay listed (as queued) until they are sent.
export function queue(notes, ids, to, now = Date.now()) {
  const set = new Set(ids);
  return notes.map((n) => (set.has(n.id) ? { ...n, queued: { to, at: now }, error: undefined } : n));
}

// Takes notes out of the queue (all of them for `to`, or only `ids`), with an error to show if given.
export function unqueue(notes, { to = null, ids = null, error = undefined } = {}) {
  const set = ids && new Set(ids);
  return notes.map((n) => {
    if (!n.queued) return n;
    if (to && n.queued.to !== to) return n;
    if (set && !set.has(n.id)) return n;
    const { queued: _q, ...rest } = n;
    return error ? { ...rest, error } : rest;
  });
}

export function remove(notes, ids) {
  const set = new Set(ids);
  return notes.filter((n) => !set.has(n.id));
}

// What the queue holds, per agent: [{ to, notes }], oldest queue first.
export function queuedByTarget(notes) {
  const by = new Map();
  for (const n of notes) {
    if (!n.queued) continue;
    if (!by.has(n.queued.to)) by.set(n.queued.to, { to: n.queued.to, at: n.queued.at, notes: [] });
    by.get(n.queued.to).notes.push(n);
  }
  return [...by.values()].sort((a, b) => a.at - b.at);
}

// The agent's last reply, from Claude Code transcript lines (JSONL, oldest first): the text it wrote after
// your last prompt or its last tool result. "" when there is none (it's still working, or only ran tools).
export function lastReply(lines) {
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (!d || d.isSidechain) continue;
    if (d.type === "assistant") {
      const c = d.message?.content;
      const texts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text) : [];
      for (const t of texts.reverse()) if (t?.trim()) out.unshift(t.trim());
    } else if (d.type === "user" && !d.isMeta && out.length) {
      break;
    }
  }
  return out.join("\n\n");
}

// What the agent gets from a Plannotator review (its --result-file JSON), or null when there's nothing to
// send (closed without a decision, or no feedback). `what`: "your last reply", "the docs folder"...
export function reviewMessage(result, what) {
  if (!result || result.decision === "dismissed") return null;
  const feedback = String(result.feedback ?? "").trim();
  if (result.decision === "approved") return feedback ? `The user approved ${what}.\n\nNotes, not blocking:\n\n${feedback}` : `The user approved ${what}.`;
  return feedback ? `The user reviewed ${what} in Plannotator:\n\n${feedback}` : null;
}
