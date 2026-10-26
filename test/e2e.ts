// Live end-to-end checks against a running gateway (uses free models only).
//   node test/e2e.ts [baseUrl]
const BASE = process.argv[2] ?? "http://127.0.0.1:4620/v1";
const FREE = "deepseek-v4-flash-local";

let failed = 0;
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`✔ ${name} (${Date.now() - t0}ms)${note ? ` — ${note}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`✘ ${name} (${Date.now() - t0}ms) — ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const post = (body: unknown, signal?: AbortSignal) =>
  fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

interface Chunk {
  choices: { delta: { content?: string; reasoning_content?: string; tool_calls?: { function: { name: string; arguments: string } }[] }; finish_reason: string | null }[];
  usage?: { total_tokens: number };
  error?: { message: string };
}
async function readStream(res: Response) {
  const text = await res.text();
  const chunks = text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Chunk);
  const content = chunks.map((c) => c.choices?.[0]?.delta.content ?? "").join("");
  const reasoning = chunks.map((c) => c.choices?.[0]?.delta.reasoning_content ?? "").join("");
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta.tool_calls ?? []);
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).find(Boolean);
  return { chunks, content, reasoning, calls, finish, done: text.trimEnd().endsWith("data: [DONE]"), usage: chunks.find((c) => c.usage)?.usage };
}

const writeTool = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file to disk",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
};

await check("GET /models lists upstream catalog", async () => {
  const j = (await (await fetch(`${BASE}/models`)).json()) as { data: { id: string; free: boolean }[] };
  assert(j.data.length > 5, "too few models");
  assert(j.data.some((m) => m.id === "DeepSeek-V4.1-Flash"), "DeepSeek-V4.1-Flash missing");
  return `${j.data.length} models, ${j.data.filter((m) => m.free).length} free`;
});

await check("unknown model -> 404 model_not_found (no silent paid fallback)", async () => {
  const res = await post({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] });
  const j = (await res.json()) as { error: { code: string } };
  assert(res.status === 404 && j.error.code === "model_not_found", `got ${res.status} ${JSON.stringify(j)}`);
});

await check("bad JSON -> 400", async () => {
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", body: "{nope" });
  assert(res.status === 400, `got ${res.status}`);
});

await check("empty messages -> 400", async () => {
  const res = await post({ messages: [] });
  assert(res.status === 400, `got ${res.status}`);
});

await check("non-stream chat, case-insensitive model name", async () => {
  const res = await post({ model: "Qwen3.6-27B", messages: [{ role: "user", content: "Reply with exactly: PONG" }] });
  const j = (await res.json()) as { model: string; choices: { message: { content: string } }[]; usage: { total_tokens: number } };
  assert(res.ok, JSON.stringify(j));
  assert(j.model === "qwen3.6-27b", `model ${j.model}`);
  assert(/PONG/.test(j.choices[0]!.message.content), `content ${j.choices[0]!.message.content}`);
  assert(j.usage.total_tokens > 0, "no usage estimate");
  return `${j.model}: ${j.choices[0]!.message.content.trim()}`;
});

await check("stream chat with reasoning + include_usage", async () => {
  const res = await post({
    model: FREE,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "1+1=? Answer with the digit only." }],
  });
  const s = await readStream(res);
  assert(s.done, "no [DONE]");
  assert(s.finish === "stop", `finish ${s.finish}`);
  assert(/2/.test(s.content), `content ${s.content}`);
  assert(s.usage, "no usage chunk");
  return `${s.chunks.length} chunks, reasoning ${s.reasoning.length}ch, content "${s.content.trim()}"`;
});

await check("tool call (non-stream)", async () => {
  const res = await post({
    model: FREE,
    tools: [writeTool],
    messages: [{ role: "user", content: "Create hello.txt containing the word hi." }],
  });
  const j = (await res.json()) as { choices: { finish_reason: string; message: { content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[] };
  const c = j.choices[0]!;
  assert(c.finish_reason === "tool_calls", `finish ${c.finish_reason}: ${c.message.content}`);
  const args = JSON.parse(c.message.tool_calls![0]!.function.arguments) as { path: string };
  assert(c.message.tool_calls![0]!.function.name === "write_file" && args.path.includes("hello"), "wrong call");
  return c.message.tool_calls![0]!.function.arguments;
});

await check("tool call (stream) does not leak envelope as text", async () => {
  const res = await post({
    model: FREE,
    stream: true,
    tools: [writeTool],
    messages: [{ role: "user", content: "Create hello.txt containing the word hi." }],
  });
  const s = await readStream(res);
  assert(s.finish === "tool_calls", `finish ${s.finish}, content ${s.content}`);
  assert(!s.content.includes("tool_calls"), "envelope leaked into content");
  return `${s.calls[0]?.function.name}(${s.calls[0]?.function.arguments})`;
});

await check("tool result round-trip -> final text answer", async () => {
  const res = await post({
    model: FREE,
    tools: [writeTool],
    messages: [
      { role: "user", content: "Create hello.txt containing the word hi, then tell me you're done." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"hello.txt","content":"hi"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "wrote 2 bytes" },
    ],
  });
  const j = (await res.json()) as { choices: { finish_reason: string; message: { content: string } }[] };
  assert(j.choices[0]!.finish_reason === "stop", `finish ${j.choices[0]!.finish_reason}`);
  return j.choices[0]!.message.content.trim().slice(0, 60);
});

await check("stream with tools but prose answer streams live", async () => {
  const res = await post({
    model: FREE,
    stream: true,
    tools: [writeTool],
    messages: [{ role: "user", content: "What is the capital of France? One word, no tools." }],
  });
  const s = await readStream(res);
  const contentChunks = s.chunks.filter((c) => c.choices?.[0]?.delta.content).length;
  assert(s.finish === "stop" && /Paris|巴黎/.test(s.content), `finish ${s.finish} content ${s.content}`);
  return `${contentChunks} content chunks`;
});

await check("client abort mid-stream frees the request", async () => {
  const ac = new AbortController();
  const res = await post({ model: FREE, stream: true, messages: [{ role: "user", content: "Count from 1 to 300, one number per line." }] }, ac.signal);
  const reader = res.body!.getReader();
  await reader.read();
  ac.abort();
  await new Promise((r) => setTimeout(r, 500));
});

await check("3 concurrent requests", async () => {
  const rs = await Promise.all(
    [1, 2, 3].map((n) => post({ model: FREE, messages: [{ role: "user", content: `Reply with exactly the number ${n}.` }] }).then((r) => r.json() as Promise<{ choices: { message: { content: string } }[] }>)),
  );
  const answers = rs.map((r) => r.choices[0]!.message.content.trim());
  assert(answers.every((a, i) => a.includes(String(i + 1))), `answers ${answers}`);
  return answers.join(", ");
});

await check("health shows token + session pool", async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const j = (await (await fetch(`${BASE}/health`)).json()) as { token: { valid: boolean }; sessions: { idle: number; pendingDelete: number } };
  assert(j.token.valid, "token invalid");
  assert(j.sessions.pendingDelete === 0, `pendingDelete ${j.sessions.pendingDelete}`);
  return JSON.stringify(j.sessions);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
