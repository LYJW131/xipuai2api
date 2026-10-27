// OpenAI chat-completions <-> XIPU AI translation. Upstream takes one text
// blob per call and has no native function calling, so the conversation is
// flattened into a transcript and tools ride on a JSON envelope convention.
import crypto from "node:crypto";
import type { Thinking } from "./upstream.ts";

// ---- OpenAI wire types (the subset we read or write) ----

export interface ContentPart {
  type: string;
  text?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  index?: number;
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type?: "function";
  function?: { name: string; description?: string; parameters?: unknown };
  name?: string;
  description?: string;
  parameters?: unknown;
}

export type ToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

export interface ChatRequest {
  model?: string;
  messages: Message[];
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  reasoning_effort?: string;
  // Non-standard: enable upstream web search.
  online?: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ParsedCall {
  name: string;
  arguments: unknown;
}

// ---- request validation ----

export function validateRequest(body: unknown): string | null {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Partial<ChatRequest>;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return "messages must be a non-empty array";
  for (const [i, m] of b.messages.entries()) {
    if (!m || typeof m !== "object" || typeof m.role !== "string") return `messages[${i}].role is required`;
  }
  if (b.model !== undefined && typeof b.model !== "string") return "model must be a string";
  if (b.tools !== undefined && !Array.isArray(b.tools)) return "tools must be an array";
  return null;
}

// ---- request translation ----

export function contentText(c: Message["content"]): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type} omitted]`)).join("\n");
  return "";
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// One piece of the upstream query, tagged with where it came from (the
// dashboard uses this to draw the request -> transcript mapping).
export interface Segment {
  source: number | "tools" | "frame"; // index into messages, the function block, or framing text
  role: Message["role"] | "protocol" | "frame";
  text: string;
}

const isSystem = (role: string) => role === "system" || role === "developer";

export function flattenSegments(messages: Message[]): Segment[] {
  const toolNames = new Map<string, string>();
  const segments: Segment[] = [];
  for (const [i, m] of messages.entries()) {
    const push = (text: string) => segments.push({ source: i, role: m.role, text });
    switch (m.role) {
      case "system":
      case "developer":
        push(contentText(m.content));
        break;
      case "user":
        push(`User: ${contentText(m.content)}`);
        break;
      case "assistant": {
        const text = contentText(m.content);
        if (m.tool_calls?.length) {
          for (const tc of m.tool_calls) toolNames.set(tc.id, tc.function.name);
          const envelope = JSON.stringify({
            tool_calls: m.tool_calls.map((tc) => ({ name: tc.function.name, arguments: safeParse(tc.function.arguments) })),
          });
          push(`Assistant: ${text ? `${text}\n` : ""}${envelope}`);
        } else {
          push(`Assistant: ${text}`);
        }
        break;
      }
      case "tool": {
        const name = m.name ?? (m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined) ?? "tool";
        push(`Tool result (${name}): ${contentText(m.content)}`);
        break;
      }
    }
  }
  return segments;
}

export function flattenMessages(messages: Message[]): string {
  return flattenSegments(messages)
    .map((s) => s.text)
    .join("\n\n");
}

function toolDefs(tools: ToolDef[]) {
  return tools.map((t) => {
    const f = t.function ?? t;
    return { name: f.name, description: f.description ?? "", parameters: f.parameters ?? { type: "object", properties: {} } };
  });
}

// The function block goes after the conversation, right before the reply cue.
// Upstream sees all of this as one user message, so it must read as a real,
// connected toolset (GPT-family models otherwise treat it as pasted text and
// answer "OK" or "I have no tools"), with no "[SYSTEM]" markers that look like
// prompt injection.
export function toolPrompt(tools: ToolDef[] | undefined, choice: ToolChoice | undefined): string | null {
  if (!tools?.length || choice === "none") return null;
  const must =
    choice === "required"
      ? "You must call at least one function in this turn."
      : typeof choice === "object"
        ? `You must call the function "${choice.function.name}" in this turn.`
        : "";
  return [
    "## Functions",
    "The client application has connected the following functions and runs them for you on the user's machine:",
    JSON.stringify(toolDefs(tools)),
    "",
    "To call one or more functions, reply with ONLY this JSON — first character `{`, last character `}`, nothing else. Put every parameter inside `arguments`:",
    '{"tool_calls":[{"name":"<function name>","arguments":{"<parameter>":"<value>"}}]}',
    'The client runs the calls and sends the output back as a "Tool result" entry in the conversation.',
    "Calling a function is how you act. Whenever the latest request needs reading files, running commands, editing or writing files, searching, etc., call the function instead of describing what you would do. These functions are real and available to you — never say you lack tools or cannot access the user's machine.",
    "Keep arguments compact: the upstream caps a single reply, so write large files in parts.",
    "When no function is needed, or a Tool result already gives you what you need, answer the user in plain text.",
    must,
  ]
    .filter(Boolean)
    .join("\n");
}

const FRAME_HEAD =
  "You are the assistant in the conversation below. You are connected through an API to a client application (a coding agent running on the user's computer). Follow the instructions and continue the conversation.";
const FRAME_TAIL = "Now write the assistant's next turn, responding to the last entry of the conversation.";

export function buildSegments(req: ChatRequest): Segment[] {
  const protocol = toolPrompt(req.tools, req.tool_choice);
  const segments = flattenSegments(req.messages);
  // A lone user message needs no framing: send it as-is, like the web chat would.
  if (!protocol && segments.length === 1 && segments[0]!.role === "user") {
    return [{ ...segments[0]!, text: contentText(req.messages[0]!.content) }];
  }
  const frame = (text: string): Segment => ({ source: "frame", role: "frame", text });
  const instructions = segments.filter((s) => isSystem(s.role));
  const conversation = segments.filter((s) => !isSystem(s.role));
  return [
    frame(FRAME_HEAD),
    ...(instructions.length ? [frame("<instructions>"), ...instructions, frame("</instructions>")] : []),
    frame("<conversation>"),
    ...conversation,
    frame("</conversation>"),
    ...(protocol ? [{ source: "tools" as const, role: "protocol" as const, text: protocol }] : []),
    frame(FRAME_TAIL),
  ];
}

// ---- upstream size limit ----

// XIPU stores the message text in a MySQL TEXT column: anything over 65,535
// UTF-8 bytes fails with "Generation failed" for every model. Long agent
// sessions (big tool outputs) cross that quickly, so trim to a byte budget,
// cheapest losses first.
export interface TrimReport {
  bytesBefore: number;
  bytesAfter: number;
  truncated: number; // segments shortened in the middle
  dropped: number; // early conversation entries removed
}

const SEP = "\n\n";
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const totalBytes = (segs: Segment[]) => segs.reduce((n, s) => n + bytes(s.text), 0) + SEP.length * Math.max(0, segs.length - 1);

// Keeps the head and tail of `text` within `max` bytes, marking the cut.
export function truncateMiddle(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const chars = [...text];
  const marker = (n: number) => `\n…[${n} chars omitted to fit the upstream size limit]…\n`;
  let keep = Math.max(0, Math.floor((chars.length * (max - 80)) / bytes(text)));
  for (;;) {
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    const out = chars.slice(0, head).join("") + marker(chars.length - keep) + (tail ? chars.slice(-tail).join("") : "");
    if (bytes(out) <= max || keep === 0) return out;
    keep = Math.floor(keep * 0.95);
  }
}

export function fitToBudget(segments: Segment[], maxBytes: number): { segments: Segment[]; trim: TrimReport | null } {
  const before = totalBytes(segments);
  if (before <= maxBytes) return { segments, trim: null };
  let segs = segments.map((s) => ({ ...s }));
  let truncated = 0;
  let dropped = 0;
  const over = () => totalBytes(segs) - maxBytes;
  const shorten = (s: Segment, cap: number) => {
    if (bytes(s.text) > cap) {
      s.text = truncateMiddle(s.text, cap);
      truncated++;
    }
  };
  const convo = () => segs.filter((s) => typeof s.source === "number" && !isSystem(s.role));

  // 1. Tool results, oldest first; the newest keeps a larger share.
  const results = convo().filter((s) => s.role === "tool");
  for (const [i, s] of results.entries()) {
    if (over() <= 0) break;
    shorten(s, Math.max(i === results.length - 1 ? 12_000 : 1_500, bytes(s.text) - over()));
  }
  // 2. Drop early entries, keeping the first user message and the latest two.
  const entries = convo();
  const firstUser = entries.find((s) => s.role === "user");
  const droppable = entries.slice(0, -2).filter((s) => s !== firstUser);
  for (const s of droppable) {
    if (over() <= 0) break;
    segs = segs.filter((x) => x !== s);
    dropped++;
  }
  if (dropped) {
    const at = segs.indexOf(firstUser ?? segs.find((s) => s.source === "frame" && s.text === "<conversation>")!) + 1;
    segs.splice(at, 0, { source: "frame", role: "frame", text: `[… ${dropped} earlier conversation entries omitted to fit the upstream size limit …]` });
  }
  // 3. Long instructions (e.g. skill catalogs), then 4. whatever is still largest.
  for (const s of segs.filter((x) => isSystem(x.role))) if (over() > 0) shorten(s, Math.max(4_000, bytes(s.text) - over()));
  while (over() > 0) {
    const big = segs.filter((s) => s.role !== "protocol" && s.source !== "frame").sort((a, b) => bytes(b.text) - bytes(a.text))[0];
    if (!big || bytes(big.text) <= 600) break;
    shorten(big, Math.max(500, bytes(big.text) - over()));
  }
  return { segments: segs, trim: { bytesBefore: before, bytesAfter: totalBytes(segs), truncated, dropped } };
}

export function buildQuery(req: ChatRequest): string {
  return buildSegments(req)
    .map((s) => s.text)
    .join("\n\n");
}

export function mapThinking(effort: string | undefined): Thinking {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort;
    case "xhigh":
    case "max":
      return "high";
    default:
      return "minimal";
  }
}

// ---- response translation ----

// Models drift from the envelope schema: arguments under "parameters"/"args"/
// "input", OpenAI-style {"function":{...}} entries, JSON-string arguments, or
// parameters spread next to "name". Normalize all of them.
function normalizeCall(raw: unknown): ParsedCall | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const fn = c.function && typeof c.function === "object" ? (c.function as Record<string, unknown>) : undefined;
  const name = typeof c.name === "string" ? c.name : typeof fn?.name === "string" ? fn.name : null;
  if (!name) return null;
  let args: unknown = c.arguments ?? c.parameters ?? c.args ?? c.input ?? fn?.arguments ?? fn?.parameters;
  if (args === undefined) {
    const { name: _n, id: _i, type: _t, function: _f, ...rest } = c;
    args = rest;
  }
  if (typeof args === "string") args = safeParse(args);
  return { name, arguments: args ?? {} };
}

function tryEnvelope(s: string): ParsedCall[] | null {
  try {
    const j = JSON.parse(s) as { tool_calls?: unknown };
    if (Array.isArray(j?.tool_calls) && j.tool_calls.length) {
      const calls = j.tool_calls.map(normalizeCall);
      if (calls.every((c) => c)) return calls as ParsedCall[];
    }
  } catch {
    /* not JSON */
  }
  return null;
}

// DeepSeek sometimes falls back to its native tool-call markup, e.g.
//   <｜DSML｜function_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.txt</｜DSML｜parameter>…
// Seen with doubled bars and spaces too ("<｜｜DSML｜｜ invoke …>").
const BAR = "[｜|]+\\s*";
const DSML_INVOKE = new RegExp(`<${BAR}DSML\\s*${BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)(?=<\\/\\s*${BAR}DSML\\s*${BAR}invoke|<${BAR}DSML\\s*${BAR}invoke\\s|$)`, "g");
const DSML_PARAM = new RegExp(`<${BAR}DSML\\s*${BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)<\\/\\s*${BAR}DSML\\s*${BAR}parameter\\s*>`, "g");

function parseDsml(text: string): ParsedCall[] | null {
  if (!/DSML/.test(text)) return null;
  const calls: ParsedCall[] = [];
  for (const inv of text.matchAll(DSML_INVOKE)) {
    const args: Record<string, unknown> = {};
    for (const p of inv[2]!.matchAll(DSML_PARAM)) args[p[1]!] = p[2] === "false" ? safeParse(p[3]!.trim()) : p[3]!;
    calls.push({ name: inv[1]!, arguments: args });
  }
  return calls.length ? calls : null;
}

// Finds a {"tool_calls":[...]} envelope: the whole reply, a fenced block, or
// embedded after some prose. Brace matching skips over JSON strings.
export function parseToolCalls(text: string): ParsedCall[] | null {
  const t = text.trim();
  if (!t) return null;
  const direct = tryEnvelope(t);
  if (direct) return direct;
  const dsml = parseDsml(t);
  if (dsml) return dsml;
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const r = tryEnvelope(m[1]!.trim());
    if (r) return r;
  }
  for (const m of t.matchAll(/"tool_calls"/g)) {
    const start = t.lastIndexOf("{", m.index);
    if (start < 0) continue;
    const end = matchBrace(t, start);
    if (end < 0) continue;
    const r = tryEnvelope(t.slice(start, end + 1));
    if (r) return r;
  }
  return null;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export function toOpenAICalls(calls: ParsedCall[]): ToolCall[] {
  return calls.map((c, index) => ({
    index,
    id: `call_${crypto.randomBytes(12).toString("hex")}`,
    type: "function",
    function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) },
  }));
}

// Upstream reports no token counts. Rough estimate: CJK ~1 token/char, other text ~4 chars/token.
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-鿿가-힯＀-￯]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function usageOf(prompt: string, completion: string): Usage {
  const p = estimateTokens(prompt);
  const c = estimateTokens(completion);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

// With tools in play the reply is either an envelope (must not leak to the
// client as text) or plain prose (should stream live). Decide from the first
// non-whitespace character: `{`, a code fence or DSML markup means buffer, anything else streams.
export class ToolReplySniffer {
  mode: "undecided" | "buffer" | "stream" = "undecided";
  #held = "";

  // Returns text that may be forwarded to the client now.
  push(delta: string): string {
    if (this.mode === "stream") return delta;
    this.#held += delta;
    if (this.mode === "buffer") return "";
    const lead = this.#held.trimStart();
    if (!lead) return "";
    if (lead.startsWith("{") || lead.startsWith("`") || /^<[｜|]/.test(lead)) {
      this.mode = "buffer";
      return "";
    }
    this.mode = "stream";
    const out = this.#held;
    this.#held = "";
    return out;
  }

  held(): string {
    return this.#held;
  }
}
