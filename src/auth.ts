// Auth chain, all plain HTTP:
//   1. UIM login (RSA-encrypted password, TOTP for MFA) -> TGC cookie
//   2. TGC -> OAuth2 authorize -> code
//   3. code -> /jmapi/api/user/uimLogin -> Jm-Token (JWT, 8h)
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Credentials } from "./config.ts";

export const UIM = "https://uim.xjtlu.edu.cn";
export const XIPUAI = "https://xipuai.xjtlu.edu.cn";
const CLIENT_ID = "9ef0da8960fa8349e15b";
const REDIRECT_URI = `${XIPUAI}/jmapi/api/auth/callback`;
// UIM's WAF lets this UA through (302 instead of a 412 JS challenge).
export const UA = "Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/30.0.1";
const HTTP_TIMEOUT_MS = 15_000;

export class AuthError extends Error {
  override name = "AuthError";
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30s) ----

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = alphabet.indexOf(c);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[19]! & 0xf;
  const code = (((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!) % 1_000_000;
  return String(code).padStart(6, "0");
}

// ---- UIM login ----

class CookieJar {
  #cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0]!;
      const i = pair.indexOf("=");
      if (i > 0) this.#cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }
  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

interface UimResult {
  code?: number | string;
  msg?: string;
  data?: { redirect?: string; param?: { publicKey?: string; publicKeyId?: string } } | string;
}

function encryptPassword(password: string, publicKeyB64: string): string {
  const key = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${publicKeyB64}\n-----END PUBLIC KEY-----`);
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString("base64");
}

async function uimLogin(creds: Credentials): Promise<CookieJar> {
  const jar = new CookieJar();
  const send = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", "Content-Type": "application/json", cookie: jar.header() },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    jar.absorb(res);
    return res;
  };

  const probe = await send(`${UIM}/`);
  const probeText = await probe.text().catch(() => "");
  if (probe.status === 412 || probeText.includes("$_ss")) throw new AuthError("UIM WAF challenge");

  const policy = (await (await send(`${UIM}/esc-sso/api/v3/auth/policy`)).json()) as UimResult;
  const param = typeof policy.data === "object" ? policy.data.param : undefined;
  if (!param?.publicKey || !param.publicKeyId) throw new AuthError("UIM policy returned no public key");

  const doLogin = async (body: unknown) =>
    (await (await send(`${UIM}/esc-sso/api/v3/auth/doLogin`, { method: "POST", body: JSON.stringify(body) })).json()) as UimResult;

  let result = await doLogin({
    authType: "webLocalAuth",
    dataField: { username: creds.username, password: encryptPassword(creds.password, param.publicKey), publicKeyId: param.publicKeyId },
  });

  const redirect = typeof result.data === "object" ? result.data.redirect : result.data;
  if (String(redirect ?? "").includes("mfaLogin") || String(result.code) !== "0") {
    const secret = creds.otpUrl ? new URL(creds.otpUrl).searchParams.get("secret") : null;
    if (!secret) throw new AuthError(`UIM needs MFA but XJTLU_OTP_URL has no secret (${result.code} ${result.msg ?? ""})`);
    result = await doLogin({ authType: "webOtpAuth", dataField: { username: creds.username, password: "", otp: totp(secret) }, redirectUri: "" });
  }
  if (String(result.code) !== "0") throw new AuthError(`UIM login failed: ${result.code} ${result.msg ?? ""}`);
  if (!jar.get("TGC")) throw new AuthError("UIM login returned no TGC cookie");
  return jar;
}

// ---- TGC -> Jm-Token ----

export interface Token {
  token: string;
  exp: number; // ms epoch
}

function decodeExp(jwt: string): number {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as { exp?: number };
  if (!payload.exp) throw new AuthError("Jm-Token has no exp");
  return payload.exp * 1000;
}

async function exchangeForJmToken(jar: CookieJar): Promise<Token> {
  const authorize = `${UIM}/esc-sso/oauth2.0/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=x`;
  const r1 = await fetch(authorize, {
    headers: { "User-Agent": UA, cookie: jar.header() },
    redirect: "manual",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const loc = r1.headers.get("location") ?? "";
  const code = new URL(loc, XIPUAI).searchParams.get("code");
  if (!code) throw new AuthError(`OAuth authorize gave no code (HTTP ${r1.status}, location ${loc.slice(0, 80)})`);

  const r2 = await fetch(`${XIPUAI}/jmapi/api/user/uimLogin`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const j = (await r2.json()) as { code?: number; msg?: string; data?: { token?: string } };
  const token = j.data?.token;
  if (!token) throw new AuthError(`uimLogin failed: ${j.code} ${j.msg ?? ""}`);
  return { token, exp: decodeExp(token) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The code->token exchange fails intermittently ("获取token失败"), so retry it
// with a fresh OAuth code before paying for another full UIM login.
export async function login(creds: Credentials, log: (msg: string) => void = () => {}): Promise<Token> {
  let lastError: unknown;
  for (let round = 0; round < 2; round++) {
    const jar = await uimLogin(creds);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await exchangeForJmToken(jar);
      } catch (e) {
        lastError = e;
        log(`[auth] token exchange attempt ${round * 4 + attempt + 1} failed: ${(e as Error).message}`);
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

// Single-flight token holder: concurrent callers share one refresh, and the
// token is cached on disk so restarts don't trigger a fresh MFA login.
export class TokenManager {
  #current: Token | null = null;
  #inflight: Promise<Token> | null = null;
  #loadCreds: () => Credentials;
  #cachePath: string;
  #log: (msg: string) => void;

  constructor(opts: { loadCreds: () => Credentials; cachePath: string; log?: (msg: string) => void }) {
    this.#loadCreds = opts.loadCreds;
    this.#cachePath = opts.cachePath;
    this.#log = opts.log ?? console.log;
  }

  async restore(): Promise<void> {
    try {
      const cached = JSON.parse(await fs.readFile(this.#cachePath, "utf8")) as Token;
      if (this.#fresh(cached)) {
        this.#current = cached;
        this.#log(`[auth] restored cached Jm-Token, exp ${new Date(cached.exp).toISOString()}`);
      }
    } catch {
      /* no cache yet */
    }
  }

  async get(): Promise<string> {
    if (this.#current && this.#fresh(this.#current)) return this.#current.token;
    return (await this.refresh()).token;
  }

  // Called when upstream rejects `token`; ignored if a newer token already replaced it.
  invalidate(token: string): void {
    if (this.#current?.token === token) this.#current = null;
  }

  refresh(): Promise<Token> {
    this.#inflight ??= (async () => {
      try {
        const t = await login(this.#loadCreds(), this.#log);
        this.#current = t;
        this.#log(`[auth] new Jm-Token, exp ${new Date(t.exp).toISOString()}`);
        await fs.writeFile(this.#cachePath, JSON.stringify(t), { mode: 0o600 }).catch((e: Error) => this.#log(`[auth] cache write failed: ${e.message}`));
        return t;
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }

  status(): { valid: boolean; exp: string | null } {
    const t = this.#current;
    return { valid: !!t && this.#fresh(t), exp: t ? new Date(t.exp).toISOString() : null };
  }

  #fresh(t: Token): boolean {
    return t.exp - Date.now() > 5 * 60_000;
  }
}
