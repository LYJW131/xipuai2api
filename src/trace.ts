// Per-request trace of the translation pipeline, kept in memory and streamed
// to the dashboard. Upstream deltas are coalesced so the store stays small.
import { EventEmitter } from "node:events";

export type Stage =
  | "request" // OpenAI request received
  | "translate" // flattened into the upstream query
  | "session" // upstream session acquired
  | "reasoning" // upstream reasoning delta
  | "content" // upstream content delta
  | "record" // upstream final record
  | "tool_calls" // envelope parsed back into OpenAI tool_calls
  | "response" // OpenAI response finished
  | "error";

export interface TraceEvent {
  traceId: string;
  stage: Stage;
  t: number; // ms since trace start
  at: number; // epoch ms
  data: Record<string, unknown>;
}

export interface Trace {
  id: string;
  startedAt: number;
  events: TraceEvent[];
  done: boolean;
}

const MAX_TRACES = 40;
const MAX_TEXT = 200_000;

export class TraceHub extends EventEmitter<{ event: [TraceEvent] }> {
  #traces: Trace[] = [];

  start(id: string): Tracer {
    const trace: Trace = { id, startedAt: Date.now(), events: [], done: false };
    this.#traces.push(trace);
    if (this.#traces.length > MAX_TRACES) this.#traces.shift();
    return new Tracer(trace, (ev) => this.emit("event", ev));
  }

  recent(): Trace[] {
    return this.#traces;
  }
}

export class Tracer {
  #trace: Trace;
  #emit: (ev: TraceEvent) => void;

  constructor(trace: Trace, emit: (ev: TraceEvent) => void) {
    this.#trace = trace;
    this.#emit = emit;
  }

  get id(): string {
    return this.#trace.id;
  }

  elapsed(): number {
    return Date.now() - this.#trace.startedAt;
  }

  add(stage: Stage, data: Record<string, unknown> = {}): void {
    const ev: TraceEvent = { traceId: this.#trace.id, stage, t: this.elapsed(), at: Date.now(), data };
    const last = this.#trace.events.at(-1);
    // Coalesce consecutive deltas in the stored trace; live listeners still get each one.
    if ((stage === "content" || stage === "reasoning") && last?.stage === stage) {
      const prev = String(last.data.text ?? "");
      if (prev.length < MAX_TEXT) last.data.text = prev + String(data.text ?? "");
      last.data.until = ev.t;
    } else {
      this.#trace.events.push({ ...ev, data: { ...data } });
    }
    if (stage === "response" || stage === "error") this.#trace.done = true;
    this.#emit(ev);
  }
}
