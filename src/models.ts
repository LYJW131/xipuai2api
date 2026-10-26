// Live model catalog from upstream configV3. Upstream silently falls back to a
// paid default for unknown names, so every requested model is validated here.
import type { UpstreamModel, XipuClient } from "./upstream.ts";

const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

export class ModelCatalog {
  #client: XipuClient;
  #ttlMs: number;
  #log: (msg: string) => void;
  #models: UpstreamModel[] = [];
  #fetchedAt = 0;
  #inflight: Promise<UpstreamModel[]> | null = null;

  constructor(client: XipuClient, ttlMs: number, log: (msg: string) => void = console.log) {
    this.#client = client;
    this.#ttlMs = ttlMs;
    this.#log = log;
  }

  async list(): Promise<UpstreamModel[]> {
    if (this.#models.length && Date.now() - this.#fetchedAt < this.#ttlMs) return this.#models;
    this.#inflight ??= this.#client
      .listModels()
      .then(({ models }) => {
        this.#models = models;
        this.#fetchedAt = Date.now();
        return models;
      })
      .catch((e: Error) => {
        // Serve the stale list rather than fail requests on a config hiccup.
        if (!this.#models.length) throw e;
        this.#log(`[models] refresh failed, serving cached list: ${e.message}`);
        return this.#models;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  // Exact value, then case-insensitive value/label, then ignoring -, _ and spaces.
  async resolve(name: string): Promise<UpstreamModel | null> {
    const models = await this.list();
    const lower = name.toLowerCase();
    return (
      models.find((m) => m.value === name) ??
      models.find((m) => m.value.toLowerCase() === lower || m.label.toLowerCase() === lower) ??
      models.find((m) => normalize(m.value) === normalize(name) || normalize(m.label) === normalize(name)) ??
      null
    );
  }
}
