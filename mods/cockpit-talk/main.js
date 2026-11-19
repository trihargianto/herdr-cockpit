// Agent talk: who messages whom, as a small map.
// Agents that talked are cards joined by curved connectors, an arrowhead at the receiver; a new
// message flies along its connector as a dot, and the line runs dashed in the "working" colour for a
// few seconds. The chrome (header, buttons, cards, empty state) follows the theme like Merge requests.
// Herdr has no "message sent" event, so this reads what the agents already show (`hc read`, read-only):
// a received message is pasted as <hc from="t64">…</hc>, a sent one is a `hc send t7m "…"` command.
// Both sides are matched up, so one message counts once. Agents started by another (`hc run`) get a
// dotted line from their parent.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, hc, exec, home, layout, run, settings, theme, window as win, props, nextCommand } from "herdr";
import { Nav, footer } from "./nav.js";

const ASSET = "mods/cockpit-talk";
const FLY_MS = 760; // sender to receiver, along the curve
const STEPS = 8; // waypoints the dot moves through, so it follows the curve instead of cutting across
const RING_MS = 650; // the receiver's ring fading out
const HOT_MS = 8000; // how long a connector stays lit after a message
const SHOWN_EVERY = 2500, HIDDEN_EVERY = 4; // read every 2.5 s while shown, every 4th tick while hidden
const NODE_H = 70;
const HEADER_H = 41;
const TOP = 12; // the canvas's top margin above the cards
const DOT = 24; // the background dots: fixed to the screen
const KEEP = 200;
const STORE = "cockpit-talk";
const mono = () => settings()?.font_family ?? "JetBrains Mono";

const MARK = { claude: "claude", "claude-code": "claude", codex: "codex", chatgpt: "codex", openai: "codex" };
const markOf = (app) => (app ? MARK[String(app).toLowerCase()] ?? null : null);
const WORD = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
const tone = (t, status) => ({ working: t.working, blocked: t.blocked, done: t.done })[status] ?? t.dim;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 28);
const flat = (s) => s.replace(/\s*\n\s*/g, " ").trim();
const ADDR = /^(?:[\w-]+\/)?t[0-9a-z]+$/;
// A pasted message starts its own line, after the prompt mark at most; quoted output ("10:❯ <hc") does not.
const RECV = /(?:^|\n)[ \t]*(?:[❯›>»$%#][ \t]*)?<hc\b([^>]*)>/g;
// A send is a command: at a line start, in a tool call (Bash(…), Ran …, $ …) or after && or ;.
const SEND = /(?:Bash\(|Ran |\$ |&& |; |(?:^|\n)[ \t]*)hc[ \t]+send[ \t]+(?:--?[\w-]+[ \t]+)*([^\s"'`]+)[ \t]+(["'])/g;

function ago(at) {
  if (at == null) return "earlier";
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

// A pane in the side panel does its work while it is the one shown.
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
function shown(id) {
  const root = layout();
  const panel = findNode(root, "panel");
  return Boolean(panel && !panel.hidden && findNode(root, "panel-body")?.active === id);
}
const watching = () => shown("talk");

// A point on a connector: the cubic from p0 to p1 through c1 and c2.
function bez(l, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return { x: a * l.p0.x + b * l.c1.x + d * l.c2.x + e * l.p1.x, y: a * l.p0.y + b * l.c1.y + d * l.c2.y + e * l.p1.y };
}

// The one brand colour kept on purpose: the user wants Claude's logo in Claude orange.
const CLAUDE = "#d97757";

export default class AgentTalk extends View {
  init(_props, cx) {
    this.size = null;
    this.events = []; // newest first: { id, from, to, body, at, sides, keys }
    this.keys = new Set(); // every message already counted, so a screen read again adds nothing
    this.read = new Map(); // address → the agent's seq when last read
    this.flights = []; // dots on their way
    this.rings = []; // receivers just reached
    this.queue = [];
    this.next = 1;
    this.tick = 0;
    this.scanning = false;
    this.mem = new Map(); // address → KB, the agent and everything it started
    this.pids = new Map(); // address → its shell's pid
    this.measuring = false;
    // Keyboard: j/k pick a card (in the model's order), enter goes to that agent.
    this.nav = new Nav(cx, { slot: props()?.slot ?? null });
    this.nav.watch(cx);
    this.nodeIds = [];
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.nav.wants(c, props()?.slot)) { this.nav.focus(); cx.notify(); }
      }
    });
    this.restore();
    this.scan(cx);
    this.measure(cx);
    cx.timer.every(SHOWN_EVERY, (cx) => {
      const live = watching();
      this.tick += 1;
      if (live || this.tick % HIDDEN_EVERY === 0) this.scan(cx);
      if (live && this.tick % 2 === 0) this.measure(cx); // memory every 5 s, only while shown
    });
  }

  // Memory as Monitoring counts it: one `ps`, then each terminal's process and everything under it.
  measure(cx) {
    if (this.measuring) return;
    this.measuring = true;
    cx.spawn(async (cx) => {
      try {
        const out = await exec("ps", ["-axo", "pid=,ppid=,rss="], { cwd: home(), timeout: 15000 });
        const rss = new Map(), kids = new Map();
        for (const line of out.stdout.split("\n")) {
          const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
          if (!pid) continue;
          rss.set(pid, kb || 0);
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push(pid);
        }
        const total = (root) => {
          let kb = 0;
          const stack = [root], seen = new Set();
          while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            kb += rss.get(id) ?? 0;
            stack.push(...(kids.get(id) ?? []));
          }
          return kb;
        };
        // Only the agents on the graph. `terminals()` has no pid, so each one is asked once (`hc get`),
        // and again if that process is gone (a lost terminal gets a new shell at the same address).
        const mem = new Map();
        for (const addr of this.model().nodes.filter((n) => !n.gone).map((n) => n.addr)) {
          if (!rss.has(this.pids.get(addr))) {
            const r = await hc(["get", addr, "--json"]);
            const pid = r.code === 0 ? JSON.parse(r.stdout).pid : null;
            if (pid) this.pids.set(addr, pid); else continue;
          }
          if (rss.has(this.pids.get(addr))) mem.set(addr, total(this.pids.get(addr)));
        }
        this.mem = mem;
      } catch {}
      this.measuring = false;
      cx.notify();
    });
  }

  restore() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(STORE) ?? "null");
      if (!saved) return;
      this.events = saved.events ?? [];
      this.keys = new Set(saved.keys ?? []);
      this.next = Math.max(0, ...this.events.map((e) => e.id)) + 1;
    } catch {}
  }

  save() {
    this.dirty = true;
    try { window.sessionStorage.setItem(STORE, JSON.stringify({ events: this.events, keys: [...this.keys].slice(-2000) })); } catch {}
  }

  scan(cx) {
    if (this.scanning) return;
    if (win()?.active === false && !watching()) return;
    this.scanning = true;
    const live = watching();
    this.dirty = false;
    cx.spawn(async (cx) => {
      try {
        for (const a of agents()) {
          const first = !this.read.has(a.address);
          if (!first && this.read.get(a.address) === a.seq && a.status !== "working") continue;
          const out = await hc(["read", a.address, "--lines", "250"]);
          if (out.code !== 0) continue;
          this.read.set(a.address, a.seq);
          this.parse(a.address, out.stdout, !first, live);
        }
      } catch {}
      this.scanning = false;
      this.launch(cx);
      // Each redraw repaints the whole window: only when there are new messages.
      if (this.dirty) cx.notify();
    });
  }

  // What a message says, from where it starts to its end (or 600 characters on).
  static body(text, from, until) {
    const rest = text.slice(from, from + 600);
    const end = until(rest);
    return end >= 0 ? rest.slice(0, end) : rest;
  }

  parse(addr, text, fresh, live) {
    for (const m of text.matchAll(RECV)) {
      const from = m[1].match(/\bfrom="([^"]+)"/)?.[1];
      if (!from || from === addr) continue;
      const body = AgentTalk.body(text, m.index + m[0].length, (s) => s.indexOf("</hc>"));
      this.found("recv", from, addr, body, fresh, live);
    }
    for (const m of text.matchAll(SEND)) {
      const to = this.resolve(m[1]);
      if (!to || to === addr) continue;
      const quote = m[2];
      let body = AgentTalk.body(text, m.index + m[0].length, (s) => {
        for (let i = 0; i < s.length; i++) if (s[i] === quote && s[i - 1] !== "\\") return i;
        return -1;
      });
      body = body.replace(/^\$\(cat\s*<<-?\s*'?\w+'?\s*/, "");
      this.found("send", addr, to, body, fresh, live);
    }
  }

  resolve(target) {
    const t = target.replace(/[),.;:]+$/, "");
    if (ADDR.test(t)) return t;
    return terminals().find((x) => x.name === t)?.address ?? null;
  }

  found(side, from, to, raw, fresh, live) {
    const n = norm(raw);
    if (n.length < 4) return; // `hc send t7m "..."` in a brief is an example, not a message
    const key = `${from}>${to}>${n}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    const now = Date.now();
    const head = (s) => s.slice(0, Math.min(20, s.length));
    // The other side of the same message: same pair, the text agrees, and close in time.
    const twin = this.events.find((e) => e.from === from && e.to === to && !e.sides.includes(side)
      && (!fresh || e.at == null || now - e.at < 90000)
      && e.keys.some((k) => { const o = k.split(">")[2]; return o.startsWith(head(n)) || n.startsWith(head(o)); }));
    if (twin) {
      twin.sides.push(side);
      twin.keys.push(key);
      if (side === "recv") twin.body = flat(raw).slice(0, 240);
      this.save();
      return;
    }
    const ev = { id: this.next++, from, to, body: flat(raw).slice(0, 240), at: fresh ? now : null, sides: [side], keys: [key] };
    this.events.unshift(ev);
    this.events = this.events.slice(0, KEEP);
    this.save();
    if (fresh && live) this.queue.push(ev);
  }

  // New messages fly one after another, a beat apart, so a burst still reads as separate messages.
  launch(cx) {
    this.queue.reverse().forEach((ev, i) => cx.timer.after(i * 260, (cx) => this.fly(ev, cx)));
    this.queue = [];
  }

  // The dot runs along the connector through STEPS waypoints, spaced by an ease-in-out curve, each leg a
  // native linear move: it leaves the sender gently, speeds up, and settles into the receiver.
  fly(ev, cx) {
    const f = { id: ev.id, from: ev.from, to: ev.to, k: 0 };
    this.flights.push(f);
    cx.notify();
    const leg = FLY_MS / STEPS;
    for (let k = 1; k <= STEPS; k++) cx.timer.after(34 + (k - 1) * leg, (cx) => { f.k = k; cx.notify(); });
    cx.timer.after(34 + FLY_MS, (cx) => {
      this.flights = this.flights.filter((x) => x !== f);
      const r = { id: ev.id, at: ev.to, fade: false };
      this.rings.push(r);
      cx.notify();
      cx.timer.after(34, (cx) => { r.fade = true; cx.notify(); });
      cx.timer.after(34 + RING_MS, (cx) => { this.rings = this.rings.filter((x) => x !== r); cx.notify(); });
    });
    cx.timer.after(HOT_MS + 100, (cx) => cx.notify()); // the connector cools down
  }

  clear(cx) {
    this.events = [];
    this.save();
    cx.notify();
  }

  // ---- who's who

  who(addr, terms, live) {
    const t = terms.get(addr);
    const a = live.get(addr);
    const where = t?.labels?.where ?? (a ? `${a.space_name} / ${a.tab_name}` : t?.name ?? addr);
    const [space, tab] = where.split(" / ");
    const name = clean(space) || addr;
    const label = tab && !/^\d+$/.test(tab) ? `${name} · ${clean(tab)}` : name;
    const gone = !t || t.state === "finished";
    return { addr, label, where, status: a?.status ?? null, gone, agent: Boolean(a), mark: markOf(a?.app ?? t?.report?.app) };
  }

  // ---- the graph

  model() {
    const terms = new Map(terminals().map((t) => [t.address, t]));
    const live = new Map(agents().map((a) => [a.address, a]));
    const now = Date.now();
    const pairs = new Map();
    const order = [];
    const see = (id) => { if (!order.includes(id)) order.push(id); };
    for (const e of [...this.events].reverse()) {
      see(e.from); see(e.to);
      const k = [e.from, e.to].sort().join("|");
      const p = pairs.get(k) ?? { a: e.from, b: e.to, n: {}, last: 0, lastFrom: null };
      const d = `${e.from}>${e.to}`;
      p.n[d] = (p.n[d] ?? 0) + 1;
      if ((e.at ?? 0) >= p.last) { p.last = e.at ?? 0; p.lastFrom = e.from; }
      pairs.set(k, p);
    }
    const spawns = [];
    for (const t of terms.values()) {
      if (!t.parent || t.state === "finished" || !live.has(t.address)) continue;
      if (!terms.has(t.parent) && !live.has(t.parent)) continue;
      see(t.parent); see(t.address);
      spawns.push({ from: t.parent, to: t.address });
    }
    const degree = Object.fromEntries(order.map((id) => [id, 0]));
    for (const p of pairs.values()) { degree[p.a] += 1; degree[p.b] += 1; }
    for (const s of spawns) { degree[s.from] += 1; degree[s.to] += 1; }
    const nodes = order.map((id) => this.who(id, terms, live));
    return { nodes, pairs: [...pairs.values()], spawns, degree, now };
  }

  // The busiest agent on top with up to three below it (a lead and its workers); more go in a ring.
  place(m, W, H, top0) {
    const ids = m.nodes.map((n) => n.addr);
    const pos = {};
    let NW = Math.min(176, Math.max(110, W * 0.42));
    const busiest = [...ids].sort((a, b) => m.degree[b] - m.degree[a])[0];
    const hub = ids.length >= 3 && m.degree[busiest] >= 2 ? busiest : null;
    const ring = ids.filter((id) => id !== hub);
    const top = top0 + NODE_H / 2, bottom = H - NODE_H / 2 - 56; // room below for a row's own connectors
    const row = (list, y) => {
      if (list.length === 1) { pos[list[0]] = { x: W / 2, y }; return; }
      NW = Math.min(NW, (W - 32) / list.length - 10);
      const span = W - 32 - NW;
      list.forEach((id, i) => { pos[id] = { x: 16 + NW / 2 + (span * i) / (list.length - 1), y }; });
    };
    if (ids.length <= 2) row(ids, (top + bottom) / 2);
    else if (hub && ring.length <= 3) { pos[hub] = { x: W / 2, y: top }; row(ring, bottom); }
    else {
      NW = Math.min(NW, 128);
      const cy = (top + bottom) / 2;
      if (hub) pos[hub] = { x: W / 2, y: cy };
      const rx = W / 2 - NW / 2 - 16, ry = (bottom - top) / 2;
      ring.forEach((id, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / ring.length;
        pos[id] = { x: W / 2 + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
      });
    }
    return { pos, NW };
  }

  // One curve per direction, from the sender's port to the receiver's: vertical S-curves between rows,
  // horizontal ones within a row (as the Map draws them). When both talk, the two share the ports and
  // bow apart in the middle, so each keeps its own arrowhead and its own path for the dot.
  lanes(m, pos, NW) {
    const lanes = {};
    const curve = (A, B, off) => {
      const dx = B.x - A.x, dy = B.y - A.y;
      if (Math.abs(dy) < 4) {
        // Two cards in the same row: under them, bottom port to bottom port, so it never squeezes between.
        const p0 = { x: A.x, y: A.y + NODE_H / 2 }, p1 = { x: B.x, y: B.y + NODE_H / 2 + 1 };
        const d = 40 + off;
        return { p0, p1, c1: { x: p0.x, y: p0.y + d }, c2: { x: p1.x, y: p1.y + d } };
      }
      if (Math.abs(dy) >= Math.abs(dx) * 0.45) {
        const s = Math.sign(dy) || 1;
        const p0 = { x: A.x, y: A.y + s * NODE_H / 2 }, p1 = { x: B.x, y: B.y - s * (NODE_H / 2 + 1) };
        const k = Math.abs(p1.y - p0.y) * 0.55;
        return { p0, p1, c1: { x: p0.x + off, y: p0.y + s * k }, c2: { x: p1.x + off, y: p1.y - s * k } };
      }
      const s = Math.sign(dx) || 1;
      const p0 = { x: A.x + s * NW / 2, y: A.y }, p1 = { x: B.x - s * (NW / 2 + 1), y: B.y };
      const k = Math.abs(p1.x - p0.x) * 0.5;
      return { p0, p1, c1: { x: p0.x + s * k, y: p0.y + off }, c2: { x: p1.x - s * k, y: p1.y + off } };
    };
    for (const p of m.pairs) {
      const dirs = [[p.a, p.b], [p.b, p.a]].filter(([f, t]) => p.n[`${f}>${t}`]);
      dirs.forEach(([f, t]) => {
        const A = pos[f], B = pos[t];
        if (!A || !B) return;
        const off = dirs.length === 2 ? (f === p.a ? -16 : 16) : 0;
        const hot = m.now - p.last < HOT_MS && p.lastFrom === f;
        lanes[`${f}>${t}`] = { ...curve(A, B, off), n: p.n[`${f}>${t}`], hot, from: f };
      });
    }
    return { lanes, curve };
  }

  path(l, width, dash) {
    let b = PathBuilder.stroke(width);
    if (dash) b = b.dash_array(dash);
    return b.move_to(l.p0.x, l.p0.y).cubic_bezier_to(l.p1.x, l.p1.y, l.c1.x, l.c1.y, l.c2.x, l.c2.y).build();
  }

  head(l) {
    const vx = l.p1.x - l.c2.x, vy = l.p1.y - l.c2.y, len = Math.hypot(vx, vy) || 1;
    const ux = vx / len, uy = vy / len, s = 7;
    const bx = l.p1.x - ux * s * 1.4, by = l.p1.y - uy * s * 1.4;
    return PathBuilder.fill().add_polygon([[l.p1.x, l.p1.y], [bx - uy * s * 0.6, by + ux * s * 0.6], [bx + uy * s * 0.6, by - ux * s * 0.6]], true).build();
  }

  // Connectors: solid in the border colour, dashed in the "working" colour while a message is fresh,
  // dotted and dim for "started by".
  edges(t, m, pos, NW, lanes, curve, W, H) {
    const paint = (path, color) => window.paint_path(path, color).absolute().left(0).top(0).w(W).h(H);
    const out = [];
    for (const s of m.spawns) {
      const A = pos[s.from], B = pos[s.to];
      if (!A || !B || lanes[`${s.from}>${s.to}`] || lanes[`${s.to}>${s.from}`]) continue;
      out.push(paint(this.path(curve(A, B, 0), 1.5, [2, 7]), t.dim));
    }
    for (const l of Object.values(lanes)) {
      const color = l.hot ? t.working : t.border;
      out.push(paint(this.path(l, l.hot ? 2 : 1.5, l.hot ? [5, 8] : null), color));
      out.push(paint(this.head(l), color));
    }
    return out;
  }

  // What a connector says, beside its middle: who just spoke (`t64 ⇢`), else how many messages went.
  labels(t, m, lanes) {
    return m.pairs.map((p) => {
      const ls = [lanes[`${p.a}>${p.b}`], lanes[`${p.b}>${p.a}`]].filter(Boolean);
      if (!ls.length) return null;
      const hot = ls.find((l) => l.hot);
      const mid = bez(ls[ls.length - 1], 0.5);
      const total = ls.reduce((n, l) => n + l.n, 0);
      const ab = p.n[`${p.a}>${p.b}`] ?? 0, ba = p.n[`${p.b}>${p.a}`] ?? 0;
      return div().id(`label-${p.a}-${p.b}`).absolute().left(mid.x + 10).top(mid.y - 9).h(18).px(5).flex().items_center()
        .rounded(4).border(1).border_color(hot ? t.working + "66" : t.border).bg(hot ? t.working + "1a" : t.chrome)
        .whitespace_nowrap().text_size(10.5).font_family(mono()).font_medium().text_color(hot ? t.working : t.dim)
        .tooltip(`${p.a} → ${p.b}: ${plural(ab, "message")} · ${p.b} → ${p.a}: ${plural(ba, "message")}`)
        .child(hot ? `${hot.from} ⇢` : `×${total}`);
    }).filter(Boolean);
  }

  // A status glyph sized to sit on the card's text line, as Automations draws its last run. Static on
  // purpose: an agent works for minutes at a time, and a spinner repaints the window every frame.
  mark(t, n) {
    const dot = (color) => div().size(7).mx(2).flex_none().rounded(4).bg(color);
    const ring = (color) => div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(color);
    if (n.gone) return ring(t.dim);
    if (n.status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold()
      .text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (n.status === "working") return dot(t.working);
    if (n.status === "done") return dot(t.done);
    return ring(t.dim);
  }

  onKey(e, cx) {
    const go = () => { const id = this.nodeIds[this.nav.sel]; if (id) run("agent.focus", { terminal: id }); };
    const used = this.nav.key(e, this.nodeIds.length, {
      enter: go, o: go, l: go,
      c: () => this.clear(cx),
    }, run);
    if (!used) return;
    cx.stop_propagation();
    cx.notify();
  }

  // A card in the MR list's look: bordered, chrome background; the keyboard's pick gets the accent
  // border, a card in a fresh message gets the "working" one.
  card(t, n, p, NW, hot, on = false) {
    const word = n.gone ? "Ended" : WORD[n.status] ?? (n.agent ? "Agent" : "Terminal");
    const kb = n.gone ? null : this.mem.get(n.addr) ?? null;
    const memText = kb == null ? null : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
    return div().id(`node-${n.addr}`).absolute().left(p.x - NW / 2).top(p.y - NODE_H / 2).w(NW).h(NODE_H)
      .transition("left", { duration: 300, easing: "ease-in-out" }).transition("top", { duration: 300, easing: "ease-in-out" })
      .rounded(8).border(1)
      .border_color(on ? t.accent : hot ? t.working : n.status === "blocked" && !n.gone ? t.blocked + "55" : t.border)
      .bg(on ? t.selected : hot ? t.working + "14" : t.chrome)
      .when(n.gone, (el) => el.opacity(0.55))
      .cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover)).active((s) => s.bg(t.selected))
      .tooltip(`${n.label}\n${n.where} · ${n.addr} · ${word}${memText ? ` · ${memText} memory (the agent and everything it started)` : ""}. Click to go there`)
      .accessibility_label(`${n.label}, ${n.addr}, ${word}${memText ? `, ${memText} memory` : ""}. Go there`)
      .on_click(() => run("agent.focus", { terminal: n.addr }))
      .child(v_flex().size_full().px(10).py(8).gap(3).justify_center().min_w(0)
        .child(h_flex().h(14).gap(5).items_center().min_w(0)
          .when(Boolean(n.mark), (el) => el.child(svg(`${ASSET}/agent-${n.mark}.svg`).size(11).flex_none().text_color(n.mark === "claude" ? CLAUDE : t.muted)))
          .child(div().min_w(0).truncate().text_size(10.5).font_family(mono()).text_color(t.dim).child(n.addr)))
        .child(div().h(18).min_w(0).truncate().text_size(12.5).line_height("18px").font_medium().text_color(t.foreground).child(n.label))
        .child(h_flex().h(16).gap(5).items_center().min_w(0).text_size(11.5)
          .child(this.mark(t, n))
          .child(div().flex_none().font_medium().text_color(n.gone ? t.dim : tone(t, n.status)).child(word))
          .when(Boolean(memText), (el) => el
            .child(div().flex_none().text_color(t.dim).child("·"))
            .child(div().min_w(0).truncate().text_size(11).font_family(mono()).text_color(t.dim).child(memText)))));
  }

  // Background dots: dashed lines, so a whole field costs a few paths.
  grid(t, W, H) {
    const key = `${W}x${H}`;
    if (this.gridCache?.key !== key) {
      let path = PathBuilder.stroke(2).dash_array([2, DOT - 2]);
      for (let y = 1; y < H; y += DOT) path = path.move_to(0, y).line_to(W, y);
      this.gridCache = { key, path: path.build() };
    }
    return window.paint_path(this.gridCache.path, t.border).absolute().left(0).top(0).w(W).h(H);
  }

  canvas(t, m, W, H) {
    const box = div().id("talk-canvas").relative().flex_none().w(W).h(H).overflow_hidden().bg(t.chrome);
    if (!m.nodes.length) {
      const watched = agents().length;
      return box.child(v_flex().id("talk-empty").absolute().left(0).top(0).w(W).py(28).px(16).gap(8).items_center()
        .child(svg("mods/cockpit-tabs/talk.svg").size(20).text_color(t.dim))
        .child(div().font_medium().child("No messages yet"))
        .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal()
          .child("When one agent sends another a message with hc send, both show up here as cards, and the message runs along the line between them."))
        .child(div().text_size(11.5).text_color(t.muted).child(watched ? `Watching ${plural(watched, "agent")}` : "No agents running")));
    }
    // The cards keep a readable spread and sit in the middle of a tall panel, so lines never stretch.
    const band = Math.min(H - TOP, Math.max(300, W * 0.85));
    const y0 = TOP + (H - TOP - band) / 2;
    const { pos, NW } = this.place(m, W, y0 + band, y0);
    const { lanes, curve } = this.lanes(m, pos, NW);
    const hot = new Set();
    for (const e of this.events) if (e.at && m.now - e.at < HOT_MS) { hot.add(e.from); hot.add(e.to); }
    const dots = this.flights.map((f) => {
      const l = lanes[`${f.from}>${f.to}`];
      if (!l) return null;
      const at = bez(l, ease(f.k / STEPS));
      const move = (el) => el.transition("left", { duration: FLY_MS / STEPS, easing: "linear" }).transition("top", { duration: FLY_MS / STEPS, easing: "linear" });
      return [
        move(div().id(`glow-${f.id}`).absolute().left(at.x - 9).top(at.y - 9).size(18).rounded(9).bg(t.working + "40")),
        move(div().id(`dot-${f.id}`).absolute().left(at.x - 4.5).top(at.y - 4.5).size(9).rounded(5).bg(t.working)),
      ];
    }).filter(Boolean).flat();
    const rings = this.rings.map((r) => {
      const p = pos[r.at];
      if (!p) return null;
      return div().id(`ring-${r.id}`).absolute().left(p.x - NW / 2 - 4).top(p.y - NODE_H / 2 - 4).w(NW + 8).h(NODE_H + 8)
        .rounded(11).border(2).border_color(t.working).opacity(r.fade ? 0 : 1)
        .transition("opacity", { duration: RING_MS, easing: "ease-out" });
    }).filter(Boolean);
    // Ports where connectors meet the cards.
    const ports = new Map();
    for (const l of Object.values(lanes)) for (const q of [l.p0, l.p1]) ports.set(`${Math.round(q.x)}:${Math.round(q.y)}`, q);
    return box
      .child(this.grid(t, W, H))
      .children(this.edges(t, m, pos, NW, lanes, curve, W, H))
      .children(this.labels(t, m, lanes))
      .children(rings)
      .children(m.nodes.map((n, i) => this.card(t, n, pos[n.addr], NW, hot.has(n.addr), this.nav.focused() && this.nav.sel === i)))
      .children([...ports.values()].map((q) => div().absolute().left(q.x - 4).top(q.y - 4).size(8).rounded(4).bg(t.chrome).border(1).border_color(t.dim)))
      .children(dots);
  }

  // The panel header, as Merge requests and Automations draw it: the name (accent while it has the
  // keyboard), coloured counts of what needs a look, then a summary and Clear on the right.
  header(t, m, kbd) {
    const live = m.nodes.filter((n) => !n.gone);
    const blocked = live.filter((n) => n.status === "blocked").length;
    const working = live.filter((n) => n.status === "working").length;
    const msgs = this.events.length, pairs = m.pairs.length;
    const now = this.events.some((e) => e.at && m.now - e.at < HOT_MS);
    const summary = `${plural(pairs, "pair")} · ${plural(msgs, "message")}`;
    return h_flex().id("talk-header").flex_none().h(HEADER_H).px(14).pt(4).items_center().gap(8).min_w(0)
      .child(div().flex_none().text_size(13).font_semibold().text_color(kbd ? t.accent : t.foreground).child("Agent talk"))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center().overflow_hidden().text_size(11.5).font_medium()
        .when(blocked > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(`${blocked} need${blocked === 1 ? "s" : ""} you`)))
        .when(working > 0, (el) => el.child(div().flex_none().text_color(t.working).child(`${working} working`))))
      .when(msgs > 0, (el) => el
        .child(div().id("talk-summary").min_w(0).truncate().text_size(11).text_color(now ? t.working : t.dim)
          .tooltip(`${now ? "Talking now" : "Last message earlier"} · ${summary}`).child(now ? `now · ${plural(msgs, "message")}` : plural(msgs, "message")))
        .child(h_flex().id("talk-clear").h(22).px(7).gap(5).items_center().flex_none().rounded(5).border(1).text_size(11.5)
          .border_color(t.border).bg(t.chrome).text_color(t.muted)
          .tooltip("Clear the list (c). Messages already seen stay counted").accessibility_label("Clear the message list")
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => { cx.stop_propagation(); this.clear(cx); })
          .child("Clear")));
  }

  render() {
    const t = theme();
    const W = this.size ? Math.max(220, this.size.width) : null;
    const kbd = this.nav.focused();
    // Under the header, and above the key footer while the panel has the keyboard.
    const H = this.size ? Math.max(260, this.size.height - HEADER_H - (kbd ? (this.nav.help ? 64 : 32) : 0)) : 0;
    const m = this.model();
    this.nodeIds = m.nodes.map((n) => n.addr);
    this.nav.clamp(this.nodeIds.length);
    return v_flex().id("talk-root").size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .track_focus(this.nav.handle).on_mouse_down("left", () => this.nav.focus()).on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => { if (size.width !== this.size?.width || size.height !== this.size?.height) { this.size = size; cx.notify(); } })
      .child(this.header(t, m, kbd))
      .when(Boolean(W), (el) => el.child(this.canvas(t, m, W, H)))
      .when(kbd, (el) => el.child(footer({ h_flex, div }, t,
        [["j k", "pick an agent"], ["↵ o", "go to it"], ["c", "clear"]], this.nav.help)));
  }
}
