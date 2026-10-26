// Tool-calling eval: replays captured OpenAI requests (DUMP_DIR) through the
// query builders straight against upstream and scores the replies.
//   node test/tool-eval.ts <casesDir> [models=gpt-6-luna,...] [variants=current,v2] [repeat=1]
// Each case file is a request body; its expectation is keyed by file name in EXPECT below.
import fs from "node:fs";
import path from "node:path";
import { TokenManager } from "../src/auth.ts";
import { config, loadCredentials } from "../src/config.ts";
import { buildQuery, parseToolCalls } from "../src/protocol.ts";
import type { ChatRequest } from "../src/protocol.ts";
import { XipuClient } from "../src/upstream.ts";
import { VARIANTS } from "./tool-variants.ts";

type Expect = { call: string[]; arg?: RegExp } | { text: RegExp; not?: RegExp };
const DENIAL = /没有(实际|已接入|可直接|可调用)|未接入|尚未作为|不能直接(读|执行|访问)|无法直接(读|执行|访问|搜索)/;
const EXPECT: Record<string, Expect> = {
  ls_first: { call: ["bash", "codemode"], arg: /ls|readdir/ },
  ls_after_result: { text: /hello\.txt/, not: DENIAL },
  read: { call: ["read", "bash"], arg: /hello\.txt/ },
  write: { call: ["write", "edit", "bash", "read"], arg: /notes\.md/ }, // reading first is fine
  which_tools: { text: /read[\s\S]*bash|bash[\s\S]*read/, not: DENIAL },
  read_after_denial: { call: ["read", "bash"], arg: /hello\.txt/ },
};

const [dir = "", modelsArg = "gpt-6-luna", variantsArg = "current,v2", repeatArg = "1"] = process.argv.slice(2);
if (!dir) throw new Error("usage: node test/tool-eval.ts <casesDir> [models] [variants] [repeat]");
const models = modelsArg.split(",");
const variants = variantsArg.split(",");
const repeat = Number(repeatArg);
const builders: Record<string, (r: ChatRequest) => string> = { current: buildQuery, ...VARIANTS };

const tokens = new TokenManager({ loadCreds: loadCredentials, cachePath: config.tokenCachePath, log: () => {} });
await tokens.restore();
const client = new XipuClient(tokens);

async function ask(text: string, model: string): Promise<string> {
  const sessionId = await client.createSession();
  try {
    let out = "";
    let record = "";
    for await (const ev of client.chat({ sessionId, text, model, thinking: "minimal", online: false }, AbortSignal.timeout(150_000), 120_000)) {
      if (ev.type === "content") out += ev.text;
      if (ev.type === "record") record = ev.record.aiText ?? "";
    }
    return out || record;
  } finally {
    await client.deleteSessions([sessionId]).catch(() => {});
  }
}

function score(name: string, reply: string): [boolean, string] {
  const exp = EXPECT[name]!;
  const calls = parseToolCalls(reply);
  if ("call" in exp) {
    const c = calls?.[0];
    if (!c) return [false, `no call: ${reply.replace(/\s+/g, " ").slice(0, 90)}`];
    const args = JSON.stringify(c.arguments);
    const ok = exp.call.includes(c.name) && (!exp.arg || exp.arg.test(args));
    return [ok, `${c.name}(${args.slice(0, 70)})`];
  }
  if (calls) return [false, `unexpected call ${calls[0]!.name}`];
  const ok = exp.text.test(reply) && !(exp.not && exp.not.test(reply));
  return [ok, reply.replace(/\s+/g, " ").slice(0, 90)];
}

const cases = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json") && EXPECT[path.basename(f, ".json")])
  .sort();
const totals: Record<string, [number, number]> = {};
for (const model of models) {
  for (const variant of variants) {
    for (const file of cases) {
      const name = path.basename(file, ".json");
      const req = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as ChatRequest;
      for (let i = 0; i < repeat; i++) {
        let ok = false;
        let note: string;
        try {
          const reply = await ask(builders[variant]!(req), model);
          [ok, note] = score(name, reply);
          if (!ok && process.env.RAW) note += `\n    raw: ${JSON.stringify(reply.slice(0, 600))}`;
        } catch (e) {
          note = `error: ${(e as Error).message}`;
        }
        const key = `${model} ${variant}`;
        totals[key] ??= [0, 0];
        totals[key][0] += ok ? 1 : 0;
        totals[key][1] += 1;
        console.log(`${ok ? "✔" : "✘"} ${model.padEnd(20)} ${variant.padEnd(8)} ${name.padEnd(18)} ${note}`);
      }
    }
  }
}
console.log("\nscore");
for (const [k, [p, n]] of Object.entries(totals)) console.log(`  ${k.padEnd(32)} ${p}/${n}`);
