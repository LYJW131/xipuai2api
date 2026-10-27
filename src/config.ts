import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

export const config = {
  port: int("PORT", 4620),
  // Loopback by default: the gateway spends the logged-in account's points.
  host: process.env.HOST || "127.0.0.1",
  apiKey: process.env.PROXY_API_KEY || "",
  defaultModel: process.env.DEFAULT_MODEL || "deepseek-v4-flash-local",
  envPath: process.env.XJTLU_ENV || path.join(ROOT, ".env"),
  tokenCachePath: process.env.TOKEN_CACHE || path.join(ROOT, ".token-cache.json"),
  sessionPoolSize: int("SESSION_POOL_SIZE", 2),
  modelCacheTtlMs: int("MODEL_CACHE_TTL_MS", 10 * 60_000),
  upstreamIdleTimeoutMs: int("UPSTREAM_IDLE_TIMEOUT_MS", 120_000),
  maxBodyBytes: int("MAX_BODY_BYTES", 16 * 1024 * 1024),
  // Upstream rejects message text over 65,535 UTF-8 bytes (MySQL TEXT); keep a margin.
  upstreamMaxBytes: int("UPSTREAM_MAX_BYTES", 64_000),
  // Debug: write every chat request body here as <id>.json for replay.
  dumpDir: process.env.DUMP_DIR || "",
} as const;

export interface Credentials {
  username: string;
  password: string;
  otpUrl: string;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

// Process env wins over the env file, so launchd/CI can inject credentials directly.
export function loadCredentials(): Credentials {
  let file: Record<string, string> = {};
  try {
    file = parseEnvFile(fs.readFileSync(config.envPath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const pick = (k: string) => process.env[k] || file[k] || "";
  const creds = { username: pick("XJTLU_USERNAME"), password: pick("XJTLU_PASSWORD"), otpUrl: pick("XJTLU_OTP_URL") };
  if (!creds.username || !creds.password) {
    throw new Error(`missing XJTLU_USERNAME / XJTLU_PASSWORD (env or ${config.envPath})`);
  }
  return creds;
}
