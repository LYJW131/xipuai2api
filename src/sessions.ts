// Upstream needs a session per chat call. Requests take pre-created sessions
// from a small warm pool (refilled in the background) and hand them back to a
// batched delete queue, so neither create nor delete sits on the request path.
//
// Several gateways may share one account (e.g. a dev instance next to the
// service), so the startup sweep must never delete another live instance's
// sessions: pooled sessions are rotated after IDLE_MAX_MS, and the sweep only
// removes ours-by-name sessions untouched for longer than STALE_MS.
import { SESSION_NAME } from "./upstream.ts";
import type { UpstreamSession, XipuClient } from "./upstream.ts";

const FLUSH_DELAY_MS = 1_000;
const RETRY_DELAY_MS = 15_000;
const MAX_DELETE_ATTEMPTS = 3;
const IDLE_MAX_MS = 30 * 60_000;
const STALE_MS = 60 * 60_000;

// Upstream timestamps look like "2026-10-27 05:20:55" in China time.
function updatedAt(s: UpstreamSession): number {
  const t = Date.parse(`${(s.updated ?? s.created ?? "").replace(" ", "T")}+08:00`);
  return Number.isNaN(t) ? 0 : t;
}

export class SessionPool {
  #client: XipuClient;
  #size: number;
  #log: (msg: string) => void;
  #idle: { id: number; at: number }[] = [];
  // Every session this process created and has not yet deleted (idle or in use).
  #owned = new Set<number>();
  #creating = 0;
  #pendingDelete = new Map<number, number>(); // id -> failed attempts
  #flushTimer: NodeJS.Timeout | null = null;
  #flushing: Promise<void> | null = null;

  constructor(client: XipuClient, size: number, log: (msg: string) => void = console.log) {
    this.#client = client;
    this.#size = size;
    this.#log = log;
    setInterval(() => this.#rotate(), 5 * 60_000).unref();
  }

  // Returns a session id and whether it came warm from the pool.
  async acquire(): Promise<{ id: number; warm: boolean }> {
    this.#rotate();
    const entry = this.#idle.shift();
    this.fill();
    if (entry) return { id: entry.id, warm: true };
    return { id: await this.#create(), warm: false };
  }

  async #create(): Promise<number> {
    const id = await this.#client.createSession();
    this.#owned.add(id);
    return id;
  }

  release(id: number): void {
    if (!this.#pendingDelete.has(id)) this.#pendingDelete.set(id, 0);
    this.#scheduleFlush(FLUSH_DELAY_MS);
  }

  // One create at a time: upstream rate-limits parallel saveSession calls.
  fill(): void {
    if (this.#creating || this.#idle.length >= this.#size) return;
    this.#creating = 1;
    this.#create()
      .then((id) => {
        this.#idle.push({ id, at: Date.now() });
        this.#creating = 0;
        this.fill();
      })
      .catch((e: Error) => {
        this.#creating = 0;
        this.#log(`[sessions] prewarm failed: ${e.message}`);
      });
  }

  // Swap out pooled sessions before they could look stale to another instance.
  #rotate(): void {
    const now = Date.now();
    const old = this.#idle.filter((e) => now - e.at > IDLE_MAX_MS);
    if (!old.length) return;
    this.#idle = this.#idle.filter((e) => now - e.at <= IDLE_MAX_MS);
    for (const e of old) this.release(e.id);
    this.fill();
  }

  // Delete sessions a crashed gateway left behind. Only touches sessions with
  // our name that nobody has used for STALE_MS — never the user's own chats,
  // never another running instance's pool.
  async sweep(): Promise<number> {
    const cutoff = Date.now() - STALE_MS;
    const listed = await this.#client.listSessions();
    const stale = listed.filter((s) => s.name === SESSION_NAME && !this.#owned.has(s.id) && updatedAt(s) < cutoff).map((s) => s.id);
    if (stale.length) await this.#client.deleteSessions(stale);
    return stale.length;
  }

  async drain(): Promise<void> {
    for (const e of this.#idle.splice(0)) this.release(e.id);
    await this.#flush();
  }

  stats(): { idle: number; creating: number; pendingDelete: number } {
    return { idle: this.#idle.length, creating: this.#creating, pendingDelete: this.#pendingDelete.size };
  }

  #scheduleFlush(delay: number): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flush();
    }, delay);
    this.#flushTimer.unref();
  }

  #flush(): Promise<void> {
    this.#flushing ??= (async () => {
      const ids = [...this.#pendingDelete.keys()];
      if (!ids.length) return;
      try {
        await this.#client.deleteSessions(ids);
        for (const id of ids) {
          this.#pendingDelete.delete(id);
          this.#owned.delete(id);
        }
      } catch (e) {
        for (const id of ids) {
          const attempts = (this.#pendingDelete.get(id) ?? 0) + 1;
          if (attempts >= MAX_DELETE_ATTEMPTS) {
            this.#pendingDelete.delete(id);
            this.#owned.delete(id);
          } else this.#pendingDelete.set(id, attempts);
        }
        this.#log(`[sessions] delete of ${ids.length} failed: ${(e as Error).message}`);
        if (this.#pendingDelete.size) this.#scheduleFlush(RETRY_DELAY_MS);
      }
    })().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }
}
