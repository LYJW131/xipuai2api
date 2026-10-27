#!/usr/bin/env node
// OpenAI-compatible gateway over XIPU AI (君谋), https://xipuai.xjtlu.edu.cn/chat
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AuthError, TokenManager } from "./auth.ts";
import { ROOT, config, loadCredentials } from "./config.ts";
import { ModelCatalog } from "./models.ts";
import { ToolReplySniffer, buildSegments, fitToBudget, mapThinking, parseToolCalls, toOpenAICalls, usageOf, validateRequest } from "./protocol.ts";
import type { ChatRequest, ToolCall, Usage } from "./protocol.ts";
import { SessionPool } from "./sessions.ts";
import { TraceHub } from "./trace.ts";
import type { Tracer } from "./trace.ts";
import { UpstreamError, XipuClient } from "./upstream.ts";
import type { ChatRecord, UpstreamModel } from "./upstream.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const tokens = new TokenManager({ loadCreds: loadCredentials, cachePath: config.tokenCachePath, log });
const client = new XipuClient(tokens);
const pool = new SessionPool(client, config.sessionPoolSize, log);
const models = new ModelCatalog(client, config.modelCacheTtlMs, log);
const traces = new TraceHub();
const startedAt = Date.now();

// ---- HTTP helpers ----

class HttpError extends Error {
  status: number;
  type: string;
  code: string | undefined;
  constructor(status: number, message: string, type = "invalid_request_error", code?: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, e: HttpError): void {
  sendJson(res, e.status, { error: { message: e.message, type: e.type, code: e.code ?? null } });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (e) {
    throw new HttpError(400, `invalid JSON: ${(e as Error).message}`);
  }
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!config.apiKey) return true;
  return req.headers.authorization === `Bearer ${config.apiKey}` || url.searchParams.get("key") === config.apiKey;
}

function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof AuthError) return new HttpError(502, `upstream auth: ${e.message}`, "upstream_error", "upstream_auth");
  if (e instanceof UpstreamError) return new HttpError(502, `upstream: ${e.message}`, "upstream_error");
  return new HttpError(500, (e as Error)?.message ?? String(e), "server_error");
}

// ---- OpenAI streaming writer (headers deferred until the first chunk) ----

class ChunkStream {
  #res: http.ServerResponse;
  #id: string;
  #created = Math.floor(Date.now() / 1000);
  #roleSent = false;
  model: string;

  constructor(res: http.ServerResponse, id: string, model: string) {
    this.#res = res;
    this.#id = id;
    this.model = model;
  }

  get started(): boolean {
    return this.#res.headersSent;
  }

  #write(payload: unknown): void {
    if (!this.#res.headersSent) {
      this.#res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    }
    this.#res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  delta(delta: Record<string, unknown>, finishReason: string | null = null): void {
    if (!this.#roleSent) {
      delta = { role: "assistant", ...delta };
      this.#roleSent = true;
    }
    this.#write({
      id: this.#id,
      object: "chat.completion.chunk",
      created: this.#created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }

  usage(usage: Usage): void {
    this.#write({ id: this.#id, object: "chat.completion.chunk", created: this.#created, model: this.model, choices: [], usage });
  }

  error(e: HttpError): void {
    this.#write({ error: { message: e.message, type: e.type, code: e.code ?? null } });
  }

  done(): void {
    if (!this.#res.headersSent) this.#write({});
    this.#res.end("data: [DONE]\n\n");
  }
}

// ---- /v1/chat/completions ----

async function resolveModel(requested: string, tracer: Tracer): Promise<{ value: string; info: UpstreamModel | null }> {
  let info: UpstreamModel | null;
  try {
    info = await models.resolve(requested);
  } catch (e) {
    // Catalog unreachable: pass the name through rather than block all traffic.
    tracer.add("translate", { warning: `model catalog unavailable (${(e as Error).message}); passing "${requested}" through` });
    return { value: requested, info: null };
  }
  if (!info) {
    throw new HttpError(404, `model "${requested}" does not exist upstream; see GET /v1/models`, "invalid_request_error", "model_not_found");
  }
  return { value: info.value, info };
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const tracer = traces.start(id);
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  let stream: ChunkStream | null = null;
  let sessionId: number | null = null;
  let requestedModel = config.defaultModel;
  try {
    const raw = await readJson(req);
    const problem = validateRequest(raw);
    if (problem) throw new HttpError(400, problem);
    const body = raw as ChatRequest;
    if (config.dumpDir) {
      fs.mkdir(config.dumpDir, { recursive: true })
        .then(() => fs.writeFile(path.join(config.dumpDir, `${id}.json`), JSON.stringify(raw)))
        .catch((e: Error) => log(`[dump] ${e.message}`));
    }
    requestedModel = body.model || config.defaultModel;
    const hasTools = !!body.tools?.length && body.tool_choice !== "none";

    tracer.add("request", {
      model: requestedModel,
      stream: !!body.stream,
      messages: body.messages,
      tools: (body.tools ?? []).map((t) => (t.function ?? t).name),
      tool_choice: body.tool_choice ?? null,
      reasoning_effort: body.reasoning_effort ?? null,
    });

    const model = await resolveModel(requestedModel, tracer);
    const { segments, trim } = fitToBudget(buildSegments(body), config.upstreamMaxBytes);
    const query = segments.map((s) => s.text).join("\n\n");
    if (trim) log(`[chat] ${id} trimmed query ${trim.bytesBefore} -> ${trim.bytesAfter} bytes (${trim.truncated} truncated, ${trim.dropped} dropped)`);
    const thinking = mapThinking(body.reasoning_effort);
    tracer.add("translate", {
      model: model.value,
      label: model.info?.label ?? null,
      free: model.info ? !!model.info.isFree : null,
      score: model.info?.score ?? null,
      thinking,
      online: !!body.online,
      segments,
      queryChars: query.length,
      trim,
      toolEnvelope: hasTools,
    });

    if (body.stream) stream = new ChunkStream(res, id, model.value);

    const acquired = await pool.acquire();
    sessionId = acquired.id;
    tracer.add("session", { sessionId, warm: acquired.warm, pool: pool.stats() });

    let content = "";
    let reasoning = "";
    let record: ChatRecord | null = null;
    const sniffer = hasTools ? new ToolReplySniffer() : null;
    const forward = (text: string) => {
      const out = sniffer ? sniffer.push(text) : text;
      if (out) stream?.delta({ content: out });
    };

    let firstTokenAt: number | null = null;
    for await (const ev of client.chat(
      { sessionId, text: query, model: model.value, thinking, online: !!body.online },
      abort.signal,
      config.upstreamIdleTimeoutMs,
      (reason) => {
        tracer.add("session", { sessionId, retry: reason });
        log(`[chat] ${id} upstream said "${reason}", retrying`);
      },
    )) {
      firstTokenAt ??= tracer.elapsed();
      if (ev.type === "reasoning") {
        reasoning += ev.text;
        tracer.add("reasoning", { text: ev.text });
        stream?.delta({ reasoning_content: ev.text });
      } else if (ev.type === "content") {
        content += ev.text;
        tracer.add("content", { text: ev.text });
        forward(ev.text);
      } else {
        record = ev.record;
      }
    }

    // Some models only deliver the answer in the final persisted record.
    if (!content && record?.aiText) {
      content = record.aiText;
      forward(content);
    }
    if (!reasoning && record?.reason) {
      reasoning = record.reason;
      stream?.delta({ reasoning_content: reasoning });
    }
    const actualModel = record?.model || model.value;
    tracer.add("record", {
      model: actualModel,
      status: record?.status ?? null,
      score: record?.score ?? null,
      recordId: record?.id ?? null,
      // "memory" means upstream routed the message to its long-term memory feature.
      rerouted: actualModel !== model.value ? actualModel : null,
    });
    if (actualModel !== model.value) log(`[chat] ${id} asked for ${model.value}, upstream answered with ${actualModel}`);

    const parsed = hasTools ? parseToolCalls(content) : null;
    const toolCalls: ToolCall[] | null = parsed ? toOpenAICalls(parsed) : null;
    if (toolCalls) tracer.add("tool_calls", { calls: toolCalls, envelope: content });

    const finishReason = toolCalls ? "tool_calls" : "stop";
    const usage = usageOf(query, content + reasoning);

    if (stream) {
      stream.model = actualModel;
      if (toolCalls) stream.delta({ tool_calls: toolCalls });
      else if (sniffer?.mode === "buffer" || sniffer?.mode === "undecided") {
        if (sniffer.held()) stream.delta({ content: sniffer.held() });
      }
      stream.delta({}, finishReason);
      if (body.stream_options?.include_usage) stream.usage(usage);
      stream.done();
    } else {
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: actualModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: toolCalls ? null : content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage,
      });
    }

    tracer.add("response", { finish_reason: finishReason, model: actualModel, usage, contentChars: content.length, reasoningChars: reasoning.length, firstTokenMs: firstTokenAt, totalMs: tracer.elapsed() });
    log(`[chat] ${id} ${actualModel} ${body.stream ? "stream" : "json"} ${finishReason} ${content.length}ch ttft=${firstTokenAt}ms total=${tracer.elapsed()}ms`);
  } catch (e) {
    if (abort.signal.aborted) {
      tracer.add("error", { message: "client disconnected", totalMs: tracer.elapsed() });
      log(`[chat] ${id} client disconnected after ${tracer.elapsed()}ms`);
      return;
    }
    const err = toHttpError(e);
    tracer.add("error", { message: err.message, status: err.status, totalMs: tracer.elapsed() });
    log(`[chat] ${id} ${requestedModel} failed: ${err.message}`);
    if (stream?.started) {
      stream.error(err);
      stream.done();
    } else if (!res.headersSent) {
      sendError(res, err);
    } else {
      res.end();
    }
  } finally {
    if (sessionId !== null) pool.release(sessionId);
  }
}

// ---- other routes ----

async function handleModels(res: http.ServerResponse): Promise<void> {
  const list = await models.list();
  sendJson(res, 200, {
    object: "list",
    data: list.map((m) => ({
      id: m.value,
      object: "model",
      created: Math.floor(startedAt / 1000),
      owned_by: m.groupLabelEn || "xipuai",
      name: m.label,
      free: !!m.isFree,
      score: m.score,
      pricing: m.integral || null,
      thinking: !!m.thinking,
      multimodal: !!m.multimodal,
      online: !!m.online,
    })),
  });
}

function handleTraceStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify({ traces: traces.recent() })}\n\n`);
  const onEvent = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  traces.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    traces.off("event", onEvent);
  });
}

async function serveDashboard(res: http.ServerResponse): Promise<void> {
  try {
    const html = await fs.readFile(path.join(ROOT, "public", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
  } catch {
    sendError(res, new HttpError(404, "dashboard not built"));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
  try {
    if (route === "GET /v1/health" || route === "GET /health") {
      return sendJson(res, 200, { ok: true, uptimeS: Math.round((Date.now() - startedAt) / 1000), token: tokens.status(), sessions: pool.stats() });
    }
    if (route === "GET /" || route === "GET /ui") return await serveDashboard(res);
    if (!authorized(req, url)) throw new HttpError(401, "invalid api key", "authentication_error", "invalid_api_key");
    switch (route) {
      case "GET /v1/models":
        return await handleModels(res);
      case "POST /v1/chat/completions":
        return await handleChat(req, res);
      case "GET /trace/recent":
        return sendJson(res, 200, { traces: traces.recent() });
      case "GET /trace/stream":
        return handleTraceStream(req, res);
      default:
        throw new HttpError(404, `no route for ${route}`);
    }
  } catch (e) {
    const err = toHttpError(e);
    if (!res.headersSent) sendError(res, err);
    else res.end();
  }
});

async function warmUp(): Promise<void> {
  try {
    await tokens.get();
    // Sweep before prewarming so freshly created pool sessions can't be swept.
    const [list, swept] = await Promise.all([models.list(), pool.sweep()]);
    pool.fill();
    log(`[startup] ready: ${list.length} upstream models, swept ${swept} stale sessions`);
  } catch (e) {
    log(`[startup] warm-up failed, will retry on first request: ${(e as Error).message}`);
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[shutdown] ${signal}: deleting pooled sessions`);
  server.close();
  await Promise.race([pool.drain(), new Promise((r) => setTimeout(r, 3_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await tokens.restore();
server.listen(config.port, config.host, () => {
  log(`xipuai gateway on http://${config.host}:${config.port}/v1 (dashboard at /)`);
  void warmUp();
});
