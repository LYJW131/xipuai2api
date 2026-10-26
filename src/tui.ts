#!/usr/bin/env node
// Terminal dashboard for the gateway: follows /trace/stream and shows how the
// newest request is translated, streamed and parsed.
//   node src/tui.ts [http://127.0.0.1:4620]
import type { Trace, TraceEvent } from "./trace.ts";

const BASE = (process.argv[2] ?? process.env.GATEWAY_URL ?? "http://127.0.0.1:4620").replace(/\/+$/, "");
const KEY = process.env.PROXY_API_KEY;
const out = process.stdout;

// ---- styling ----

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
const fg = (hex: string) => `\x1b[38;2;${rgb(hex)}m`;
const C = {
  text: fg("#e6e9ef"),
  muted: fg("#8b95a7"),
  frame: fg("#5b6577"),
  faint: fg("#5b6577"),
  accent: fg("#7c9cff"),
  ok: fg("#3ecf8e"),
  warn: fg("#f5b84b"),
  err: fg("#ff6b6b"),
  system: fg("#a78bfa"),
  user: fg("#4cc2ff"),
  assistant: fg("#f5b84b"),
  tool: fg("#3ecf8e"),
  protocol: fg("#f472b6"),
};
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";
const roleColor = (role: string) => (C as Record<string, string>)[role === "developer" ? "system" : role] ?? C.muted;

// ---- width-aware text (CJK and emoji take two cells) ----

function cellWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    cp >= 0x20000
  )
    return 2;
  return 1;
}
const strWidth = (s: string) => [...s].reduce((w, ch) => w + cellWidth(ch.codePointAt(0)!), 0);

type Seg = [text: string, style?: string];

// Renders styled segments clipped to `width` cells, with an ellipsis when cut.
function line(width: number, ...segs: Seg[]): string {
  let used = 0;
  let res = "";
  for (const [text, style = ""] of segs) {
    let chunk = "";
    for (const ch of text) {
      const w = cellWidth(ch.codePointAt(0)!);
      if (used + w > width) {
        if (chunk.length) chunk = chunk.slice(0, -1);
        return res + style + chunk + C.faint + "…" + RESET;
      }
      used += w;
      chunk += ch;
    }
    res += style + chunk + RESET;
  }
  return res;
}

function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const raw of text.replace(/\t/g, "  ").split("\n")) {
    let row = "";
    let w = 0;
    for (const ch of raw) {
      const cw = cellWidth(ch.codePointAt(0)!);
      if (w + cw > width) {
        rows.push(row);
        row = "";
        w = 0;
      }
      row += ch;
      w += cw;
    }
    rows.push(row);
  }
  return rows;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const fmtN = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtMs = (ms: number | null | undefined) => (ms == null ? "–" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - strWidth(s)));

// ---- trace state (mirrors the server's coalescing) ----

interface Msg {
  role: string;
  content?: unknown;
  tool_calls?: { function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
interface Call {
  index: number;
  function: { name: string; arguments: string };
}
interface View {
  id: string;
  startedAt: number;
  done: boolean;
  req?: { model: string; stream: boolean; messages: Msg[]; tools: string[]; reasoning_effort: string | null };
  tr?: { model: string; label: string | null; free: boolean | null; score: number | null; thinking: string; queryChars: number; segments: { source: number | "tools" | "frame"; role: string; text: string }[] };
  ses?: { sessionId: number; warm: boolean; retry?: string };
  retries: string[];
  reasoning: string;
  content: string;
  tSes?: number;
  tR0?: number;
  tC0?: number;
  tC1?: number;
  tEnd?: number;
  rec?: { model: string; score: number | null; rerouted: string | null };
  calls?: Call[];
  res?: { finish_reason: string; model: string; usage: { prompt_tokens: number; completion_tokens: number }; firstTokenMs: number | null; totalMs: number };
  err?: { message: string };
}

const traces = new Map<string, Trace>();
let connected = false;
let health: { token?: { valid: boolean; exp: string | null }; sessions?: { idle: number; pendingDelete: number } } = {};

function ingest(ev: TraceEvent): void {
  let t = traces.get(ev.traceId);
  if (!t) {
    t = { id: ev.traceId, startedAt: ev.at - ev.t, events: [], done: false };
    traces.set(ev.traceId, t);
    while (traces.size > 50) traces.delete(traces.keys().next().value!);
  }
  const last = t.events.at(-1);
  if ((ev.stage === "content" || ev.stage === "reasoning") && last?.stage === ev.stage) {
    last.data.text = String(last.data.text ?? "") + String(ev.data.text ?? "");
    last.data.until = ev.t;
  } else {
    t.events.push({ ...ev, data: { ...ev.data } });
  }
  if (ev.stage === "response" || ev.stage === "error") t.done = true;
}

function view(t: Trace): View {
  const v: View = { id: t.id, startedAt: t.startedAt, done: t.done, reasoning: "", content: "", retries: [] };
  for (const e of t.events) {
    const d = e.data as never;
    switch (e.stage) {
      case "request":
        v.req = d;
        break;
      case "translate":
        if ((e.data as { segments?: unknown }).segments) v.tr = d;
        break;
      case "session":
        if ((e.data as { retry?: string }).retry) v.retries.push((e.data as { retry: string }).retry);
        else {
          v.ses = d;
          v.tSes = e.t;
        }
        break;
      case "reasoning":
        v.reasoning += String(e.data.text ?? "");
        v.tR0 ??= e.t;
        break;
      case "content":
        v.content += String(e.data.text ?? "");
        v.tC0 ??= e.t;
        v.tC1 = Number(e.data.until ?? e.t);
        break;
      case "record":
        v.rec = d;
        break;
      case "tool_calls":
        v.calls = (e.data as { calls: Call[] }).calls;
        break;
      case "response":
        v.res = d;
        v.tEnd = e.t;
        break;
      case "error":
        v.err = d;
        v.tEnd = e.t;
        break;
    }
  }
  return v;
}

// ---- rendering ----

const SPIN = ["◐", "◓", "◑", "◒"];
const STAGES = ["Client", "Translate", "Session", "XIPU AI", "Parse", "Respond"];

function stageIndex(v: View): number {
  if (v.res) return 6;
  if (v.rec) return 4;
  if (v.tR0 != null || v.tC0 != null || v.ses) return 3;
  if (v.tr) return 2;
  return 1;
}

function pipeline(v: View | undefined, W: number, now: number): string[] {
  const idx = v ? stageIndex(v) : -1;
  const failed = !!v?.err;
  const cell = Math.max(10, Math.floor(W / STAGES.length));
  let top = "";
  let sub = "";
  const metrics = v
    ? [
        v.req ? `${v.req.messages.length} msg · ${v.req.tools.length} tools` : "",
        v.tr ? `→ ${fmtN(v.tr.queryChars)} chars` : "",
        v.ses ? `#${v.ses.sessionId} ${v.ses.warm ? "warm" : "cold"}` : "",
        v.tr ? `${fmtMs(v.tR0 ?? v.tC0)} ttft` : "",
        v.calls ? v.calls.map((c) => c.function.name).join(",") : v.rec ? "plain text" : "",
        v.res ? `${v.res.finish_reason}` : v.err ? "error" : "",
      ]
    : STAGES.map(() => "");
  STAGES.forEach((name, i) => {
    let mark = `${C.faint}○`;
    let label = C.faint + name;
    if (v && (i < idx || (v.done && !failed))) {
      mark = `${C.accent}●`;
      label = C.text + name;
    }
    if (v && !v.done && i === idx) {
      mark = `${C.accent}${BOLD}${SPIN[Math.floor(now / 120) % 4]}`;
      label = `${C.accent}${BOLD}${name}`;
    }
    if (failed && i === Math.min(idx, 5)) {
      mark = `${C.err}✕`;
      label = C.err + name;
    }
    const conn = i < STAGES.length - 1 ? connector(cell - strWidth(name) - 3, v && !v.done && i === idx - 1 ? now : null) : "";
    top += `${mark}${RESET} ${label}${RESET} ${conn}`;
    sub += line(cell, [pad(metrics[i] ?? "", cell), C.muted]);
  });
  return [top, sub];
}

// The connector leading into the active stage carries a moving packet.
function connector(len: number, now: number | null): string {
  if (len <= 0) return "";
  if (now == null) return `${C.faint}${"─".repeat(len)}${RESET}`;
  const p = Math.floor(now / 70) % len;
  return `${C.faint}${"─".repeat(p)}${C.accent}${BOLD}━${RESET}${C.faint}${"─".repeat(len - p - 1)}${RESET}`;
}

function timeline(v: View, W: number, now: number): string {
  const elapsed = v.done ? (v.tEnd ?? 0) : now - v.startedAt;
  const width = Math.max(10, W - 22);
  const total = Math.max(elapsed, 1);
  const first = Math.min(v.tR0 ?? Infinity, v.tC0 ?? Infinity);
  const cells: string[] = [];
  for (let i = 0; i < width; i++) {
    const ms = (i / width) * total;
    if (v.tSes == null || ms < v.tSes) cells.push(`${C.system}▆`);
    else if (first === Infinity || ms < first) cells.push(`${C.faint}▂`);
    else if (v.tC0 == null || ms < v.tC0) cells.push(`${C.user}▆`);
    else cells.push(`${C.assistant}▆`);
  }
  return `${C.muted}timeline ${RESET}${cells.join("")}${RESET} ${C.text}${BOLD}${fmtMs(elapsed)}${RESET}`;
}

function section(title: string, W: number, right = ""): string {
  const used = strWidth(title) + strWidth(right) + 5;
  return `${C.accent}${BOLD}${title}${RESET} ${C.faint}${"─".repeat(Math.max(2, W - used))}${RESET} ${C.muted}${right}${RESET}`;
}

function msgText(m: Msg): string {
  let s = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: { type: string; text?: string }) => (p.type === "text" ? p.text : `[${p.type}]`)).join(" ") : "";
  if (m.tool_calls?.length) s += (s ? " " : "") + m.tool_calls.map((c) => `→ ${c.function.name}(${c.function.arguments})`).join(" ");
  return s;
}

function summarizeArgs(json: string, W: number): string {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, val]) => {
        const s = typeof val === "string" ? val : JSON.stringify(val);
        const short = oneLine(s);
        return `${k}=${short.length > 48 ? `${short.slice(0, 44)}… (${fmtN(s.length)})` : short}`;
      })
      .join("  ")
      .slice(0, W * 2);
  } catch {
    return oneLine(json);
  }
}

function render(): string {
  const W = Math.max(60, out.columns ?? 100);
  const H = Math.max(20, out.rows ?? 40);
  const now = Date.now();
  const all = [...traces.values()];
  const t = all.at(-1);
  const v = t ? view(t) : undefined;
  const rows: string[] = [];

  // header
  const tok = health.token?.exp ? new Date(health.token.exp).getTime() - now : 0;
  const right = `${connected ? `${C.ok}● live` : `${C.err}● offline`}${RESET}${C.muted}  token ${C.text}${health.token?.valid ? `${Math.floor(tok / 3.6e6)}h${String(Math.floor(tok / 6e4) % 60).padStart(2, "0")}m` : "–"}${C.muted}  warm ${C.text}${health.sessions?.idle ?? "–"}${C.muted}  requests ${C.text}${all.length}${RESET}`;
  const left = `${BOLD}${C.text}XIPU Gateway${RESET} ${C.muted}OpenAI ⇄ 君谋 · live trace${RESET}`;
  const gap = W - strWidth(oneLine(stripAnsi(left))) - strWidth(stripAnsi(right));
  rows.push(left + " ".repeat(Math.max(1, gap)) + right);
  rows.push("");
  rows.push(...pipeline(v, W, now));
  if (!v) {
    rows.push("", `${C.faint}  waiting for requests on ${BASE}/v1/chat/completions …${RESET}`);
    return finish(rows, H);
  }
  rows.push(timeline(v, W, now));

  const budget = H - rows.length - 1;
  const req: string[] = [];
  const trn: string[] = [];
  const str: string[] = [];
  const res: string[] = [];

  // ① request
  if (v.req) {
    req.push(section("① OpenAI request", W, `${v.req.model} · ${v.req.stream ? "stream" : "json"}${v.req.reasoning_effort ? ` · effort ${v.req.reasoning_effort}` : ""}`));
    if (v.req.tools.length) req.push(line(W, ["  tools  ", C.muted], [v.req.tools.map((n) => `ƒ ${n}`).join("  "), C.protocol]));
    const msgs = v.req.messages;
    const maxMsgs = 5;
    if (msgs.length > maxMsgs) req.push(line(W, [`  … ${msgs.length - maxMsgs} earlier messages`, C.faint]));
    msgs.slice(-maxMsgs).forEach((m, k) => {
      const i = msgs.length - Math.min(msgs.length, maxMsgs) + k;
      const body = msgText(m);
      req.push(line(W, ["  "], [pad(m.role, 10), roleColor(m.role) + BOLD], [pad(`[${i}] ${fmtN(body.length)}`, 10), C.faint], [oneLine(body) || "(empty)", C.text]));
    });
  }

  // ② transcript
  if (v.tr) {
    const cost = v.tr.free ? "free" : `${v.tr.score ?? "?"} pts/1k`;
    trn.push(section("② Upstream transcript", W, `${v.tr.model} · ${cost} · thinking ${v.tr.thinking}${v.ses ? ` · session #${v.ses.sessionId}` : ""}`));
    const segs = v.tr.segments;
    const maxSegs = 5;
    const shown = segs.length > maxSegs ? [...segs.slice(0, 2), ...segs.slice(-(maxSegs - 2))] : segs;
    shown.forEach((s, k) => {
      if (segs.length > maxSegs && k === 2) trn.push(line(W, [`  ┊ … ${segs.length - maxSegs} more segments`, C.faint]));
      const label = s.source === "tools" ? "protocol" : s.source === "frame" ? "frame" : `msg[${s.source}]`;
      trn.push(line(W, ["  ▌", roleColor(s.role)], [pad(label, 9), roleColor(s.role)], [pad(fmtN(s.text.length), 7), C.faint], [oneLine(s.text), C.muted]));
    });
    trn.push(line(W, ["  └▶ ", C.accent], [`one text field, ${fmtN(v.tr.queryChars)} chars → POST /api/v2/chat/response`, C.faint]));
  }

  // ④ response (computed before ③ so the stream gets the leftover rows)
  if (v.rec || v.err) {
    res.push(section("④ OpenAI response", W, v.res ? `${fmtMs(v.res.totalMs)} total` : ""));
    if (v.rec?.rerouted) res.push(line(W, ["  ! ", C.warn], [`upstream answered with ${v.rec.rerouted} instead of the requested model`, C.warn]));
    for (const c of v.calls ?? []) {
      res.push(line(W, ["  ƒ ", C.protocol], [`tool_calls[${c.index}] `, C.faint], [c.function.name, C.protocol + BOLD], ["  "], [summarizeArgs(c.function.arguments, W), C.text]));
    }
    if (v.res) {
      const u = v.res.usage;
      res.push(
        line(
          W,
          ["  finish ", C.muted],
          [v.res.finish_reason, (v.res.finish_reason === "tool_calls" ? C.protocol : C.ok) + BOLD],
          ["   ttft ", C.muted],
          [fmtMs(v.res.firstTokenMs), C.text],
          ["   points ", C.muted],
          [String(v.rec?.score ?? "–"), C.text],
          ["   tokens≈ ", C.muted],
          [`${fmtN(u.prompt_tokens)} → ${fmtN(u.completion_tokens)}`, C.text],
          ["   model ", C.muted],
          [v.res.model, C.text],
        ),
      );
    }
    if (v.err) res.push(line(W, ["  ✕ ", C.err], [v.err.message, C.err]));
  }

  // recent requests
  const recent: string[] = [];
  const older = all.slice(-5, -1).reverse();
  if (older.length) {
    recent.push(section("recent", W));
    for (const o of older.map(view)) {
      const status = o.err ? [`error`, C.err] : o.res ? [o.res.finish_reason, o.res.finish_reason === "tool_calls" ? C.protocol : C.ok] : ["live", C.accent];
      const what = o.calls?.map((c) => c.function.name).join(",") ?? (o.content ? oneLine(o.content).slice(0, 40) : "");
      recent.push(
        line(W, ["  "], [new Date(o.startedAt).toLocaleTimeString([], { hour12: false }) + "  ", C.faint], [pad(o.rec?.model ?? o.tr?.model ?? o.req?.model ?? "…", 22), C.text], [pad(status[0]!, 11), status[1]!], [pad(fmtMs(o.tEnd), 8), C.muted], [what, C.faint]),
      );
    }
  }

  // ③ stream gets whatever space is left
  const fixed = req.length + trn.length + res.length + recent.length + 1;
  const room = Math.max(3, budget - fixed);
  if (v.ses || v.err) {
    const live = !v.done;
    const env = v.req?.tools.length && /^\s*[{`]/.test(v.content);
    str.push(section("③ Upstream SSE stream", W, `${fmtN(v.reasoning.length)} reasoning · ${fmtN(v.content.length)} content${env ? " · envelope held back" : ""}`));
    for (const r of v.retries) str.push(line(W, ["  ↻ ", C.warn], [`upstream: ${r} — retrying`, C.warn]));
    const inner = W - 4;
    const rLines = v.reasoning ? wrap(oneLine(v.reasoning), inner) : [];
    const cLines = v.content ? wrap(v.content.trimStart(), inner) : [];
    const avail = room - 1 - v.retries.length;
    const rShow = cLines.length ? Math.min(rLines.length, Math.max(1, Math.floor(avail / 4))) : Math.min(rLines.length, avail);
    const cShow = Math.max(0, avail - rShow - (rShow ? 1 : 0));
    if (rShow) {
      for (const l of rLines.slice(-rShow)) str.push(line(W, ["  ┆ ", C.system], [l, C.muted + ITALIC + DIM]));
    }
    if (cLines.length) {
      const shown = cLines.slice(-cShow);
      shown.forEach((l, k) => {
        const caret = live && k === shown.length - 1 && Math.floor(now / 500) % 2 === 0 ? `${C.accent}▍${RESET}` : "";
        str.push(line(W, ["  │ ", env ? C.protocol : C.assistant], [l, env ? C.protocol : C.text]) + caret);
      });
    } else if (live) {
      str.push(line(W, ["  │ ", C.faint], [v.reasoning ? "thinking…" : "waiting for first token…", C.faint]));
    }
  }

  const body = [...req, ...trn, ...str, ...res, ...recent];
  rows.push(...body);
  return finish(rows, H);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function finish(rows: string[], H: number): string {
  return rows
    .slice(0, H)
    .map((r) => r + "\x1b[K")
    .join("\r\n");
}

let pending = false;
function draw(): void {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    out.write(`\x1b[H${render()}\x1b[J`);
  }, 33);
}

// ---- data feed ----

async function follow(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/trace/stream${KEY ? `?key=${encodeURIComponent(KEY)}` : ""}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      connected = true;
      draw();
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = block.match(/^event: (.*)$/m)?.[1] ?? "message";
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (!data) continue;
          if (event === "hello") {
            traces.clear();
            for (const t of (JSON.parse(data) as { traces: Trace[] }).traces) traces.set(t.id, t);
          } else {
            ingest(JSON.parse(data) as TraceEvent);
          }
          draw();
        }
      }
    } catch {
      /* reconnect below */
    }
    connected = false;
    draw();
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function pollHealth(): Promise<void> {
  try {
    health = (await (await fetch(`${BASE}/v1/health`)).json()) as typeof health;
  } catch {
    health = {};
  }
  draw();
}

out.write("\x1b[?1049h\x1b[?25l");
const restore = () => out.write("\x1b[?25h\x1b[?1049l");
process.on("exit", restore);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
out.on("resize", draw);
setInterval(() => {
  const t = [...traces.values()].at(-1);
  if (t && !t.done) draw();
}, 100);
setInterval(pollHealth, 5000);
void pollHealth();
void follow();
draw();
