// XIPU AI web API client: sessions, model config, and the SSE chat stream.
import crypto from "node:crypto";
import { AuthError, UA, XIPUAI } from "./auth.ts";
import type { TokenManager } from "./auth.ts";

const API = `${XIPUAI}/jmapi`;
export const SESSION_NAME = "openai-proxy";

export class UpstreamError extends Error {
  override name = "UpstreamError";
}

export type Thinking = "minimal" | "low" | "medium" | "high";

export interface UpstreamModel {
  id: number;
  label: string;
  value: string;
  groupLabelEn: string;
  isFree: number;
  score: number;
  thinking: number;
  multimodal: number;
  online: number;
  integral: string;
}

export interface UpstreamSession {
  id: number;
  name: string;
  model: string;
  contextCount: number;
  created?: string; // "YYYY-MM-DD HH:mm:ss", China time
  updated?: string;
}

// The persisted record sent as the last SSE event.
export interface ChatRecord {
  id: number;
  sessionId: number;
  aiText: string | null;
  reason: string | null;
  model: string;
  status: string;
  score: number;
  responseId: string;
}

export type ChatEvent =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "record"; record: ChatRecord };

export interface ChatParams {
  sessionId: number;
  text: string;
  model: string;
  thinking: Thinking;
  online: boolean;
}

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T;
}

const AUTH_MSG = /token|登录|login|过期|expire|授权|unauthori/i;
const RATE_LIMIT_MSG = /too fast|too many|频繁|太快/i;
// Failures upstream itself says are worth retrying (only retried before any output).
const TRANSIENT_MSG = /too fast|too many|频繁|太快|try again later|稍后再试/i;

export class XipuClient {
  #tokens: TokenManager;

  constructor(tokens: TokenManager) {
    this.#tokens = tokens;
  }

  // One retry with a fresh token when upstream rejects the current one. A bad
  // token shows up as an nginx 400/401/403 HTML page, not as JSON.
  async #fetch(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.get();
      const res = await fetch(`${API}${path}`, {
        method: init.method ?? "GET",
        headers: { "User-Agent": UA, "Content-Type": "application/json", "Jm-Token": token, "x-lang": "zh-cn", "x-platform": "web" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
      const type = res.headers.get("content-type") ?? "";
      let authFailure = [400, 401, 403].includes(res.status) || !/json|event-stream/.test(type);
      let body: Envelope<unknown> | undefined;
      if (!authFailure && type.includes("json")) {
        body = (await res.json()) as Envelope<unknown>;
        authFailure = body.code !== 0 && AUTH_MSG.test(body.msg ?? "");
      }
      if (authFailure) {
        await res.body?.cancel().catch(() => {});
        this.#tokens.invalidate(token);
        if (attempt === 0) continue;
        throw new AuthError(`upstream rejected token on ${path} (HTTP ${res.status})`);
      }
      if (!res.ok) throw new UpstreamError(`${path}: HTTP ${res.status}`);
      // Hand JSON bodies back re-wrapped since we already consumed the stream.
      return body ? Response.json(body) : res;
    }
  }

  async #json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const env = (await (await this.#fetch(path, init)).json()) as Envelope<T>;
      if (env.code === 0) return env.data;
      if (RATE_LIMIT_MSG.test(env.msg ?? "") && attempt < 4) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      throw new UpstreamError(`${path}: ${env.msg ?? `code ${env.code}`}`);
    }
  }

  async createSession(): Promise<number> {
    const data = await this.#json<{ id: string | number }>("/api/chat/saveSession", {
      method: "POST",
      body: { name: SESSION_NAME, contextCount: 0 },
    });
    const id = Number(data?.id);
    if (!id) throw new UpstreamError("saveSession returned no id");
    return id;
  }

  async deleteSessions(ids: number[]): Promise<void> {
    await this.#json("/api/chat/delSession", { method: "POST", body: { ids } });
  }

  listSessions(): Promise<UpstreamSession[]> {
    return this.#json<UpstreamSession[]>("/api/chat/session");
  }

  async listModels(): Promise<{ models: UpstreamModel[]; defaultModel: string }> {
    const data = await this.#json<{ model: { chat: { defaultModel: string; list: UpstreamModel[] } } }>("/api/v2/chat/configV3");
    return { models: data.model.chat.list, defaultModel: data.model.chat.defaultModel };
  }

  // Upstream rate-limits concurrent chats per account and sometimes fails a
  // generation outright, reporting either as the first SSE event. Nothing has
  // reached the caller yet in that case, so retry with backoff.
  async *chat(params: ChatParams, signal: AbortSignal, idleTimeoutMs: number, onRetry?: (reason: string) => void): AsyncGenerator<ChatEvent> {
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const ev of this.#chatOnce(params, signal, idleTimeoutMs)) {
          yielded = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (yielded || attempt >= 4 || !(e instanceof UpstreamError) || !TRANSIENT_MSG.test(e.message)) throw e;
        onRetry?.(e.message);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 500));
        signal.throwIfAborted();
      }
    }
  }

  // Streams one upstream reply. Upstream always answers HTTP 200; failures
  // arrive as events with code != 0.
  async *#chatOnce(params: ChatParams, signal: AbortSignal, idleTimeoutMs: number): AsyncGenerator<ChatEvent> {
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(), idleTimeoutMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), idleTimeoutMs);
    };
    const combined = AbortSignal.any([signal, idle.signal]);
    try {
      const res = await this.#fetch("/api/v2/chat/response", {
        method: "POST",
        signal: combined,
        body: {
          sessionId: params.sessionId,
          text: params.text,
          intent: "chat",
          thinking: params.thinking,
          online: params.online ? 1 : 0,
          attachments: [],
          options: null,
          usedFiles: [],
          model: params.model,
          responseId: crypto.randomUUID(),
        },
      });
      if (!(res.headers.get("content-type") ?? "").includes("event-stream")) {
        const env = (await res.json()) as Envelope<unknown>;
        throw new UpstreamError(`chat: ${env.msg ?? `code ${env.code}`}`);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        bump();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) yield* parseLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) yield* parseLine(line);
    } catch (e) {
      if (idle.signal.aborted && !signal.aborted) throw new UpstreamError(`no data from upstream for ${idleTimeoutMs / 1000}s`);
      // XIPU resets any response stream at ~120s (HTTP/2 stream error), e.g. long high-effort reasoning.
      if (e instanceof TypeError && e.message === "terminated" && !signal.aborted) {
        throw new UpstreamError("upstream cut the response stream (XIPU caps a single reply at ~120s; try a lower reasoning_effort)");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface WireEvent {
  type?: string;
  data?: unknown;
  reasoning_data?: string;
  code?: number;
  msg?: string;
}

function* parseLine(line: string): Generator<ChatEvent> {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  let ev: WireEvent;
  try {
    ev = JSON.parse(payload) as WireEvent;
  } catch {
    return;
  }
  if (ev.code !== undefined && ev.code !== 0) throw new UpstreamError(ev.msg || `upstream error code ${ev.code}`);
  if (ev.reasoning_data) yield { type: "reasoning", text: ev.reasoning_data };
  if (ev.type === "string" && typeof ev.data === "string" && ev.data) yield { type: "content", text: ev.data };
  if (ev.type === "object" && ev.data && typeof ev.data === "object") yield { type: "record", record: ev.data as ChatRecord };
}
