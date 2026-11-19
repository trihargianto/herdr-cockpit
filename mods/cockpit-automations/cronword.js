// A cron schedule in plain English: "51 16 * * 2" → "Every Tuesday at 16:51".
// Covers what cron.py accepts (numbers, *, ranges, lists, steps, @aliases). Returns null for anything
// else, so the form can say the schedule isn't valid yet. Imports nothing, so node can test it.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ALIASES = {
  "@reboot": "When the Mac starts up",
  "@hourly": "Every hour, on the hour",
  "@daily": "Every day at 00:00",
  "@midnight": "Every day at 00:00",
  "@weekly": "Every Sunday at 00:00",
  "@monthly": "On the 1st of every month at 00:00",
  "@yearly": "Every year on 1 January at 00:00",
  "@annually": "Every year on 1 January at 00:00",
};
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

const pad = (n) => String(n).padStart(2, "0");
const clock = (h, m) => `${pad(h)}:${pad(m)}`;
const isNum = (f) => /^\d+$/.test(f);
const step = (f) => f.match(/^\*\/(\d+)$/)?.[1];
const range = (f) => f.match(/^(\d+)-(\d+)$/)?.slice(1).map(Number);
function ordinal(n) {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${tail}`;
}
function join(words, last = "and") {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

// Every value a field allows, or null when it is out of range or not cron syntax.
function values(field, [low, high]) {
  const out = new Set();
  for (const term of field.split(",")) {
    const m = term.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    const every = m[4] == null ? 1 : Number(m[4]);
    if (every < 1) return null;
    let from = low, to = high;
    if (m[1] !== "*") {
      from = Number(m[2]);
      to = m[3] == null ? (m[4] == null ? from : high) : Number(m[3]);
    }
    if (from < low || to > high || from > to) return null;
    for (let v = from; v <= to; v += every) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function time(min, hour, mins, hours) {
  // A few exact clock times: "at 09:00 and 17:30".
  if (mins.length * hours.length <= 4 && min !== "*" && hour !== "*" && !step(min) && !step(hour)) {
    return { at: true, text: `at ${join(hours.flatMap((h) => mins.map((m) => clock(h, m))))}` };
  }
  let often;
  if (min === "*") often = "every minute";
  else if (step(min)) often = `every ${step(min)} minutes`;
  else if (isNum(min)) often = null;
  else if (mins.length <= 4) often = `at minutes ${join(mins.map(String))}`;
  else often = `at minutes ${min}`;

  if (hour === "*") {
    if (often) return { text: often };
    return { text: Number(min) === 0 ? "every hour, on the hour" : `every hour at ${Number(min)} past` };
  }
  if (step(hour)) {
    const n = step(hour);
    if (!often) return { text: `every ${n} hours${Number(min) === 0 ? ", on the hour" : ` at ${Number(min)} past`}` };
    return { text: `${often}, every ${n} hours` };
  }
  const r = range(hour);
  if (r) {
    if (!often) return { text: `every hour from ${clock(r[0], Number(min))} to ${clock(r[1], Number(min))}` };
    return { text: `${often} between ${clock(r[0], 0)} and ${clock(r[1], 59)}` };
  }
  // Hours as a list (or mixed): name them.
  if (!often) return { at: true, text: `at ${join(hours.map((h) => clock(h, Number(min))))}` };
  return { text: `${often} during hours ${join(hours.map((h) => pad(h)))}` };
}

function weekdays(field, list) {
  const set = [...new Set(list.map((d) => d % 7))].sort((a, b) => a - b);
  if (set.join() === "1,2,3,4,5") return "on weekdays";
  if (set.join() === "0,6") return "on weekends";
  const r = range(field);
  if (r && r[1] - r[0] >= 2 && r[1] <= 6) return `${DAYS[r[0]]} to ${DAYS[r[1]]}`;
  return `on ${join(set.map((d) => `${DAYS[d]}s`))}`;
}

function monthDays(field, list) {
  const r = range(field);
  if (r) return `from the ${ordinal(r[0])} to the ${ordinal(r[1])}`;
  if (step(field)) return `every ${step(field)} days`;
  if (list.length <= 5) return `on the ${join(list.map(ordinal))}`;
  return `on days ${field}`;
}

function months(field, list) {
  const r = range(field);
  if (r) return `from ${MONTHS[r[0] - 1]} to ${MONTHS[r[1] - 1]}`;
  if (step(field)) return `every ${step(field)} months`;
  return `in ${join(list.map((m) => MONTHS[m - 1]))}`;
}

// Cards ask on every render; a schedule's words never change.
const cache = new Map();

export function describeCron(schedule) {
  const text = String(schedule ?? "").trim();
  if (!cache.has(text)) {
    if (cache.size > 500) cache.clear();
    cache.set(text, describe(text));
  }
  return cache.get(text);
}

function describe(text) {
  if (ALIASES[text]) return ALIASES[text];
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => values(f, RANGES[i]));
  if (sets.some((s) => !s || !s.length)) return null;
  const [min, hour, dom, month, dow] = fields;

  const when = time(min, hour, sets[0], sets[1]);
  // cron runs on a day that matches either field when both are set.
  const days = [dom !== "*" && monthDays(dom, sets[2]), dow !== "*" && weekdays(dow, sets[4])].filter(Boolean);
  const day = join(days, "or");
  const inMonths = month === "*" ? "" : months(month, sets[3]);

  let out;
  if (when.at) {
    // "Every day at 09:00", "Every Tuesday at 16:51", "On the 1st at 00:00".
    if (!day) out = `Every day ${when.text}`;
    else if (dom === "*" && sets[4].length === 1) out = `Every ${DAYS[sets[4][0] % 7]} ${when.text}`;
    else out = `${day} ${when.text}`;
  } else {
    out = day ? `${when.text}, ${day}` : when.text;
  }
  if (inMonths) out += `, ${inMonths}`;
  return out[0].toUpperCase() + out.slice(1);
}
