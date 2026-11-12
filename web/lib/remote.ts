// Hosted remote MCP (https://mcpal.app/mcp): one isolated MCPal ledger per demo key.
// State (refs, spend, approvals, hash-chained decision log, ledger id, install id) lives in a
// private Vercel Blob per key, so idempotency and policy hold across serverless invocations.
// Writes for one key are serialized with a lock blob; reads bypass the CDN cache.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { del, get, put } from "@vercel/blob";
import { DecisionLog, Ledger, PayPalAuthError, PayPalClient, PayPalError, createContext, type ApprovalRec, type McpalContext, type RefRecord, type VerbResult } from "mcpal";
import type { SpendRow } from "./session";
import { CARD_COUNTRY_HINT, SANDBOX_API, decryptSecret, encryptSecret, secretsKey, type ByoCreds, type StoredCreds } from "./byo";

export const SITE_URL = (process.env.MCPAL_SITE_URL ?? "https://mcpal.app").replace(/\/$/, "");
export const KEY_CALLS_PER_HOUR = 30;
export const IP_CALLS_PER_HOUR = 60;
export const REMOTE_AMOUNT_CAP = 500;
export const REMOTE_POLICY = { approval_threshold: "250.00", daily_cap: "1000.00", refund_ceiling: "250.00" };
/** Same merchant price list as the judge console, so quote_ref works in both. */
export const REMOTE_QUOTE = { quoteRef: "Q-120", amount: "120.00", currency: "USD", description: "Custom engraved walnut sign" };
const HOUR = 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_-]{12,80}$/;

export interface RemoteState {
  v: 1;
  ns: string;
  createdAt: string;
  installId: string;
  ledgerId: string;
  refs: RefRecord[];
  spend: SpendRow[];
  log: string[];
  approvals: ApprovalRec[];
  /** Tool-call timestamps (ms) in the last hour, for the per-key limit. */
  calls: number[];
}

export function courierEmail(): string {
  return process.env.PAYPAL_BUYER_EMAIL || "courier@personal.example.com";
}

/** The demo key from `?key=` or `Authorization: Bearer`. */
export function keyFrom(req: Request): string | undefined {
  const url = new URL(req.url);
  const q = url.searchParams.get("key")?.trim();
  const auth = req.headers.get("authorization") ?? "";
  const b = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  const k = q || b;
  return k && KEY_RE.test(k) ? k : undefined;
}

/** Public namespace id for a key (used in approval links; does not reveal the key). */
export function nsOf(key: string): string {
  return createHash("sha256").update(`mcpal-remote|${key}`).digest("hex").slice(0, 24);
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}

// ---------------- storage (private Vercel Blob; local files when no token, for development) ----------------

const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const localDir = () => {
  const d = join(tmpdir(), "mcpal-remote-store");
  mkdirSync(d, { recursive: true });
  return d;
};
const localPath = (p: string) => join(localDir(), p.replace(/\//g, "__"));

export async function readJson<T>(path: string): Promise<{ data: T; etag: string } | undefined> {
  if (!useBlob()) {
    const f = localPath(path);
    if (!existsSync(f)) return undefined;
    const text = readFileSync(f, "utf8");
    return { data: JSON.parse(text) as T, etag: createHash("md5").update(text).digest("hex") };
  }
  // Blob reads occasionally fail with a transient 5xx: retry a few times before giving up.
  let r: Awaited<ReturnType<typeof get>> | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await get(path, { access: "private", useCache: false });
      break;
    } catch (err) {
      if (attempt >= 3 || !/\b5\d\d\b|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String((err as Error)?.message))) throw err;
      await new Promise((res) => setTimeout(res, 150 * 2 ** attempt));
    }
  }
  if (!r || r.statusCode !== 200) return undefined;
  const text = await new Response(r.stream).text();
  return { data: JSON.parse(text) as T, etag: r.blob.etag };
}

export async function writeJson(path: string, data: unknown, opts: { create?: boolean; ifMatch?: string } = {}): Promise<void> {
  const body = JSON.stringify(data);
  if (!useBlob()) {
    const f = localPath(path);
    if (opts.create && existsSync(f)) throw new Error("exists");
    writeFileSync(f, body);
    return;
  }
  await put(path, body, {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
    ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : opts.create ? { allowOverwrite: false } : { allowOverwrite: true }),
  });
}

async function remove(path: string): Promise<void> {
  if (!useBlob()) {
    rmSync(localPath(path), { force: true });
    return;
  }
  await del(path).catch(() => undefined);
}

const statePath = (ns: string) => `remote/${ns}/state.json`;
const lockPath = (ns: string) => `remote/${ns}/lock.json`;

/** Run fn while holding this key's lock, so two tool calls for one key never interleave. */
export async function withLock<T>(ns: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 25_000;
  const me = randomUUID();
  for (;;) {
    try {
      await writeJson(lockPath(ns), { me, at: Date.now() }, { create: true });
      break;
    } catch {
      const cur = await readJson<{ me: string; at: number }>(lockPath(ns)).catch(() => undefined);
      if (cur && Date.now() - cur.data.at > 70_000) {
        // A crashed invocation left the lock behind: take it over atomically.
        try {
          await writeJson(lockPath(ns), { me, at: Date.now() }, { ifMatch: cur.etag });
          break;
        } catch {
          /* someone else took it */
        }
      }
      if (Date.now() > deadline) throw new Error("Another call for this demo key is still running. Try again in a few seconds.");
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
    }
  }
  try {
    return await fn();
  } finally {
    await remove(lockPath(ns));
  }
}

export async function loadState(ns: string): Promise<RemoteState> {
  const cur = await readJson<RemoteState>(statePath(ns));
  if (cur) return cur.data;
  return { v: 1, ns, createdAt: new Date().toISOString(), installId: randomBytes(16).toString("hex"), ledgerId: randomUUID(), refs: [], spend: [], log: [], approvals: [], calls: [] };
}

export async function saveState(state: RemoteState): Promise<void> {
  await writeJson(statePath(state.ns), state);
}

/** Per-IP limit across all keys (read-modify-write; best effort under races, which only matter at the edge of the limit). */
export async function takeIp(ip: string, now = Date.now(), bucket = "ip", limit = IP_CALLS_PER_HOUR): Promise<{ ok: boolean; retryInMin: number }> {
  const path = `ratelimit/${bucket}-${createHash("sha256").update(`mcpal|${ip}`).digest("hex").slice(0, 24)}.json`;
  const cur = await readJson<{ calls: number[] }>(path).catch(() => undefined);
  const calls = (cur?.data.calls ?? []).filter((t) => now - t < HOUR);
  if (calls.length >= limit) return { ok: false, retryInMin: Math.ceil((HOUR - (now - calls[0]!)) / 60000) };
  calls.push(now);
  await writeJson(path, { calls });
  return { ok: true, retryInMin: 0 };
}

// ---------------- bring your own sandbox (per-key PayPal credentials) ----------------

/** Connect attempts (credential checks) per IP per hour. */
export const CONNECT_PER_HOUR = 10;
const credsPath = (ns: string) => `remote/${ns}/creds.json`;

export type KeyCreds = { kind: "shared" } | { kind: "byo"; creds: ByoCreds; clientId: string } | { kind: "forgotten" };

/** Store a developer's sandbox credentials for a brand-new key (fails if the key already has some). */
export async function storeCreds(ns: string, c: ByoCreds): Promise<void> {
  const rec: StoredCreds = { v: 1, clientId: c.clientId, secretEnc: encryptSecret(c.clientSecret, secretsKey(), `mcpal-byo|${ns}`), connectedAt: new Date().toISOString() };
  await writeJson(credsPath(ns), rec, { create: true });
}

export async function loadCreds(ns: string): Promise<KeyCreds> {
  const cur = await readJson<StoredCreds>(credsPath(ns));
  if (!cur) return { kind: "shared" };
  if (cur.data.forgottenAt || !cur.data.secretEnc) return { kind: "forgotten" };
  return { kind: "byo", clientId: cur.data.clientId, creds: { clientId: cur.data.clientId, clientSecret: decryptSecret(cur.data.secretEnc, secretsKey(), `mcpal-byo|${ns}`) } };
}

/** "Forget my credentials": the secret is deleted; a tombstone keeps the key from silently falling back to the shared account. */
export async function forgetCreds(ns: string): Promise<boolean> {
  const cur = await readJson<StoredCreds>(credsPath(ns));
  if (!cur) return false;
  await writeJson(credsPath(ns), { v: 1, clientId: "", secretEnc: "", connectedAt: cur.data.connectedAt, forgottenAt: new Date().toISOString() } satisfies StoredCreds);
  return true;
}

export const FORGOTTEN_MSG = `This demo key's PayPal sandbox credentials were forgotten, so it can no longer reach PayPal. Connect your sandbox again (new key) or use a shared-sandbox key at ${SITE_URL}/install.`;

/** PayPal client for a developer's own sandbox app: same API, clearer messages for the two failures that depend on their account. */
export class ByoPayPalClient extends PayPalClient {
  override async request<T = any>(method: Parameters<PayPalClient["request"]>[0], path: string, opts?: Parameters<PayPalClient["request"]>[2]) {
    try {
      return await super.request<T>(method, path, opts);
    } catch (err) {
      if (err instanceof PayPalAuthError) err.message = `Your PayPal sandbox app credentials no longer work (PayPal said ${err.issue ?? err.status}). Connect them again at ${SITE_URL}/install.`;
      else if (err instanceof PayPalError && err.hasIssue("PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING")) err.message = `${err.message} ${CARD_COUNTRY_HINT}`;
      throw err;
    }
  }
}

export function takeKey(state: RemoteState, now = Date.now()): { ok: boolean; retryInMin: number; left: number } {
  state.calls = state.calls.filter((t) => now - t < HOUR);
  if (state.calls.length >= KEY_CALLS_PER_HOUR) return { ok: false, retryInMin: Math.ceil((HOUR - (now - state.calls[0]!)) / 60000), left: 0 };
  state.calls.push(now);
  return { ok: true, retryInMin: 0, left: KEY_CALLS_PER_HOUR - state.calls.length };
}

// ---------------- MCPal context per key ----------------

export interface RemoteContext {
  ctx: McpalContext;
  dir: string;
  logPath: string;
}

export function buildRemoteContext(state: RemoteState, creds?: ByoCreds, policyOverride?: Partial<typeof REMOTE_POLICY>): RemoteContext {
  const dir = mkdtempSync(join(tmpdir(), "mcpal-remote-"));
  const logPath = join(dir, "decisions.jsonl");
  if (state.log.length) writeFileSync(logPath, state.log.join("\n") + "\n");
  // Install id + ledger id are persisted per key, so PayPal-Request-Ids stay stable across invocations.
  writeFileSync(join(dir, "install-id"), state.installId + "\n");
  const ledger = new Ledger(":memory:");
  ledger.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('ledger_id', ?)").run(state.ledgerId);
  for (const r of state.refs) ledger.putRef(r);
  ledger.putQuote(REMOTE_QUOTE);
  const ins = ledger.db.prepare("INSERT OR IGNORE INTO spend(day, verb, order_ref, currency, cents, request_id, at) VALUES (?,?,?,?,?,?,?)");
  for (const s of state.spend) ins.run(s.day, s.verb, s.order_ref, s.currency, s.cents, s.request_id, s.at);
  const insA = ledger.db.prepare("INSERT OR IGNORE INTO approvals(id, order_ref, verb, amount, currency, reason, status, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const a of state.approvals) insA.run(a.id, a.orderRef, a.verb, a.amount, a.currency, a.reason, a.status, a.createdAt, a.decidedAt ?? null);

  const publicUrl = `${SITE_URL}/r/${state.ns}`;
  const ctx = createContext({
    config: {
      dataDir: dir,
      publicUrl,
      returnUrl: `${publicUrl}/paypal/return`,
      cancelUrl: `${SITE_URL}/install`,
      paypalEnv: "sandbox",
      sandboxCard: "4012000077777777",
    },
    ledger,
    log: new DecisionLog(logPath),
    policy: { ...REMOTE_POLICY, ...policyOverride, payout_allowlist: [courierEmail()] },
    // Always the sandbox host: a developer's own credentials are only ever sent to api-m.sandbox.paypal.com.
    paypal: creds
      ? new ByoPayPalClient({ clientId: creds.clientId, clientSecret: creds.clientSecret, baseUrl: SANDBOX_API })
      : new PayPalClient({
          clientId: process.env.PAYPAL_CLIENT_ID ?? "",
          clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
          baseUrl: SANDBOX_API,
        }),
  });
  return { ctx, dir, logPath };
}

export function exportRemote(state: RemoteState, b: RemoteContext): RemoteState {
  const refs = b.ctx.ledger.listRefs(1000).reverse();
  const spend = b.ctx.ledger.db.prepare("SELECT day, verb, order_ref, currency, cents, request_id, at FROM spend ORDER BY id").all() as SpendRow[];
  const log = existsSync(b.logPath) ? readFileSync(b.logPath, "utf8").split("\n").filter(Boolean) : [];
  const approvals = b.ctx.ledger.listApprovals().reverse();
  return { ...state, refs, spend, log, approvals };
}

export function disposeRemote(b: RemoteContext): void {
  try {
    b.ctx.ledger.close();
  } catch {
    /* ignore */
  }
  rmSync(b.dir, { recursive: true, force: true });
}

/** Hosted-demo limits, checked before a verb reaches MCPal's own policy or PayPal. */
export function demoGuard(name: string, args: Record<string, unknown>): string | undefined {
  for (const k of ["amount", "deposit"]) {
    const v = args[k];
    if ((typeof v === "string" || typeof v === "number") && Number(v) > REMOTE_AMOUNT_CAP)
      return `The hosted demo caps every amount at ${REMOTE_AMOUNT_CAP}.00 USD; ${v} was refused before reaching PayPal.`;
  }
  if (typeof args.currency === "string" && args.currency.toUpperCase() !== "USD") return "The hosted demo runs in USD only.";
  if (name === "pay_out") {
    const to = String(args.to ?? "");
    if (!/^[^@\s]+@[a-z0-9.-]*example\.com$/i.test(to))
      return `The hosted demo only pays out to PayPal sandbox accounts (addresses ending in example.com). Known courier: ${courierEmail()}.`;
  }
  if (name === "charge" && args.method === "invoice" && typeof args.customer_email === "string" && !/example\.com$/i.test(args.customer_email))
    return "The hosted demo only sends invoices to PayPal sandbox addresses (ending in example.com).";
  return undefined;
}

export function refused(name: string, args: Record<string, unknown>, state: string, error: string, next: string): VerbResult {
  return { ok: false, state, orderRef: String(args.orderRef ?? ""), paypal: { ids: {} }, next, error } as VerbResult;
}
