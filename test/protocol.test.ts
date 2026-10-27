import assert from "node:assert/strict";
import { test } from "node:test";
import { totp } from "../src/auth.ts";
import { parseEnvFile } from "../src/config.ts";
import { ToolReplySniffer, buildQuery, buildSegments, fitToBudget, flattenMessages, mapThinking, parseToolCalls, toolPrompt, truncateMiddle } from "../src/protocol.ts";

test("parseToolCalls: bare, fenced, embedded, braces inside strings", () => {
  const env = '{"tool_calls":[{"name":"write","arguments":{"path":"a.html","content":"<b>{x}</b>"}}]}';
  assert.deepEqual(parseToolCalls(env), [{ name: "write", arguments: { path: "a.html", content: "<b>{x}</b>" } }]);
  assert.equal(parseToolCalls("```json\n" + env + "\n```")?.[0]?.name, "write");
  assert.equal(parseToolCalls("好的，我来写文件：\n" + env)?.[0]?.name, "write");
  assert.equal(parseToolCalls('{"tool_calls":[{"name":"a","arguments":{"s":"}"}}]} trailing')?.[0]?.name, "a");
  assert.equal(parseToolCalls("just prose"), null);
  assert.equal(parseToolCalls('{"tool_calls":[]}'), null);
});

test("ToolReplySniffer streams prose, buffers envelopes", () => {
  const prose = new ToolReplySniffer();
  assert.equal(prose.push("  "), "");
  assert.equal(prose.push("Hi"), "  Hi");
  assert.equal(prose.push(" there"), " there");
  assert.equal(prose.mode, "stream");

  const env = new ToolReplySniffer();
  assert.equal(env.push('\n{"tool'), "");
  assert.equal(env.push('_calls":[]}'), "");
  assert.equal(env.mode, "buffer");
  assert.equal(env.held(), '\n{"tool_calls":[]}');
});

test("flattenMessages resolves tool names from tool_call_id", () => {
  const q = flattenMessages([
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"p":1}' } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ]);
  assert.match(q, /^be brief/);
  assert.match(q, /User: hi\n\[image_url omitted\]/);
  assert.match(q, /Assistant: \{"tool_calls":\[\{"name":"read","arguments":\{"p":1\}\}\]\}/);
  assert.match(q, /Tool result \(read\): ok/);
});

test("tool_choice controls the envelope prompt", () => {
  const tools = [{ type: "function" as const, function: { name: "bash" } }];
  assert.equal(toolPrompt(tools, "none"), null);
  assert.match(toolPrompt(tools, "required")!, /must call at least one function/);
  assert.match(toolPrompt(tools, { type: "function", function: { name: "bash" } })!, /must call the function "bash"/);
  const q = buildQuery({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "x" }], tools });
  // instructions, then the conversation, then functions, then the reply cue last
  assert.ok(q.indexOf("<instructions>") < q.indexOf("<conversation>"));
  assert.ok(q.indexOf("</conversation>") < q.indexOf("## Functions"));
  assert.match(q, /next turn, responding to the last entry of the conversation\.$/);
  assert.doesNotMatch(q, /\[SYSTEM/);
});

test("mapThinking", () => {
  assert.equal(mapThinking(undefined), "minimal");
  assert.equal(mapThinking("none"), "minimal");
  assert.equal(mapThinking("medium"), "medium");
  assert.equal(mapThinking("xhigh"), "high");
});

test("totp matches RFC 6238 SHA-1 vector", () => {
  // Secret "12345678901234567890" in base32; T=59s -> 94287082 (8 digits) -> 287082.
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000), "287082");
});

test("parseEnvFile handles comments, quotes and export", () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x=y\'\n'), { A: "1", B: "two words", C: "x=y" });
});

test("lone user message is sent verbatim; framing otherwise", () => {
  assert.equal(buildQuery({ messages: [{ role: "user", content: "你好" }] }), "你好");
  const segs = buildSegments({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] });
  assert.equal(segs[0]!.source, "frame");
  assert.deepEqual(segs.filter((s) => typeof s.source === "number").map((s) => s.text), ["User: a", "Assistant: b", "User: c"]);
});

test("parseToolCalls tolerates schema drift", () => {
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"name":"bash","command":"ls"}]}'), [{ name: "bash", arguments: { command: "ls" } }]);
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"name":"bash","parameters":{"command":"ls"}}]}'), [{ name: "bash", arguments: { command: "ls" } }]);
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]}'), [{ name: "read", arguments: { path: "a" } }]);
  assert.equal(parseToolCalls('{"tool_calls":[{"arguments":{}}]}'), null);
});

test("parseToolCalls reads DeepSeek DSML markup", () => {
  const canonical = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="path" string="true">hello.txt</｜DSML｜parameter>\n<｜DSML｜parameter name="limit" string="false">20</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
  assert.deepEqual(parseToolCalls(canonical), [{ name: "read", arguments: { path: "hello.txt", limit: 20 } }]);
  const seen = '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="bash"> <｜｜DSML｜｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke>';
  assert.deepEqual(parseToolCalls(seen), [{ name: "bash", arguments: { command: "ls -la" } }]);
  const sniff = new ToolReplySniffer();
  assert.equal(sniff.push("<｜DSML｜function_calls>"), "");
  assert.equal(sniff.mode, "buffer");
});

test("truncateMiddle respects a UTF-8 byte budget", () => {
  const text = "网关".repeat(20_000);
  const out = truncateMiddle(text, 10_000);
  assert.ok(Buffer.byteLength(out) <= 10_000);
  assert.ok(out.startsWith("网关") && out.endsWith("网关") && out.includes("chars omitted"));
  assert.equal(truncateMiddle("short", 100), "short");
});

test("fitToBudget keeps the task, the latest turns, functions and the reply cue", () => {
  const big = (c: string, n: number) => c.repeat(n);
  const call = (id: string) => ({ role: "assistant" as const, content: null, tool_calls: [{ id, type: "function" as const, function: { name: "bash", arguments: "{}" } }] });
  const req = {
    messages: [
      { role: "system" as const, content: big("系统", 6_000) },
      { role: "user" as const, content: "TASK: draw a pelican" },
      call("a"),
      { role: "tool" as const, tool_call_id: "a", content: big("x", 30_000) },
      call("b"),
      { role: "tool" as const, tool_call_id: "b", content: big("日志", 15_000) },
      { role: "user" as const, content: "LATEST: hi" },
    ],
    tools: [{ type: "function" as const, function: { name: "bash" } }],
  };
  const built = buildSegments(req);
  const { segments, trim } = fitToBudget(built, 20_000);
  const q = segments.map((s) => s.text).join("\n\n");
  assert.ok(trim && trim.bytesBefore > 20_000 && trim.bytesAfter <= 20_000, JSON.stringify(trim));
  assert.ok(Buffer.byteLength(q) <= 20_000);
  for (const must of ["TASK: draw a pelican", "LATEST: hi", "## Functions", "responding to the last entry"]) assert.ok(q.includes(must), must);
  assert.equal(fitToBudget(built, 10_000_000).trim, null);
});
