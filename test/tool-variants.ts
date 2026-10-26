// Alternative query builders for tool-eval.ts. `v1` is the original protocol
// (tool block first, "[SYSTEM]" markers, no closing cue), kept as a baseline:
// GPT-family models answered it with "OK" or denied having tools.
import { flattenMessages } from "../src/protocol.ts";
import type { ChatRequest, ToolDef } from "../src/protocol.ts";

function defs(tools: ToolDef[]) {
  return tools.map((t) => {
    const f = t.function ?? t;
    return { name: f.name, description: f.description ?? "", parameters: f.parameters ?? { type: "object", properties: {} } };
  });
}

function v1(req: ChatRequest): string {
  const tools = req.tools?.length && req.tool_choice !== "none" ? req.tools : null;
  const protocol = tools
    ? [
        "[SYSTEM — function-calling protocol]",
        "When the user's request needs one of these functions, your ENTIRE reply must be exactly:",
        '{"tool_calls":[{"name":"<name>","arguments":{...}}]}',
        'First char "{", last "}". No prose, no markdown, no "我来", no explanation.',
        "Keep each arguments field compact — the upstream caps single replies, so for large file contents write them in smaller chunks or pick short paths.",
        `Functions: ${JSON.stringify(defs(tools))}`,
        'After a "Tool result (name): ..." message, emit another call or the final plain-text answer.',
        "Plain text only when no function applies.",
        "[/SYSTEM]",
      ].join("\n")
    : null;
  return [protocol, flattenMessages(req.messages)].filter(Boolean).join("\n\n");
}

export const VARIANTS: Record<string, (r: ChatRequest) => string> = { v1 };
