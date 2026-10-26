// Ask the gateway for a pelican-riding-a-bicycle page and save the HTML.
//   node scripts/pelican.ts [model] [outFile]
import fs from "node:fs/promises";

const model = process.argv[2] ?? "DeepSeek-V4.1-Flash";
const out = process.argv[3] ?? `demo/pelican-${model}.html`;
const base = process.env.BASE_URL ?? "http://127.0.0.1:4620/v1";

const t0 = Date.now();
const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    stream: true,
    messages: [
      {
        role: "user",
        content:
          "Generate a single self-contained HTML file showing an SVG illustration of a pelican riding a bicycle. " +
          "Make it charming and well-composed, with a little animation (wheels turning). Output only the HTML, no explanation.",
      },
    ],
  }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

let text = "";
let firstAt = 0;
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
  buf += decoder.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const j = JSON.parse(line.slice(6));
    if (j.error) throw new Error(j.error.message);
    const d = j.choices?.[0]?.delta?.content;
    if (d) {
      firstAt ||= Date.now() - t0;
      text += d;
      process.stdout.write(".");
    }
  }
}
const html = (text.match(/```(?:html)?\s*([\s\S]*?)```/)?.[1] ?? text).trim();
await fs.writeFile(out, html);
console.log(`\n${model}: ${html.length} chars, first token ${firstAt}ms, total ${Date.now() - t0}ms -> ${out}`);
