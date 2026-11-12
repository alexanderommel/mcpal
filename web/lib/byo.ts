// "Bring your own sandbox": a developer pastes THEIR PayPal sandbox app credentials on /install and
// gets a demo key whose remote MCP calls run against their own sandbox account.
// Pure helpers only (node:crypto + fetch), so they are unit-tested without Vercel Blob.
// - The client secret is encrypted at rest with AES-256-GCM under MCPAL_SECRETS_KEY (32 random bytes,
//   base64), with the key namespace as associated data so a stored blob cannot be moved to another key.
// - Credentials are accepted only if they get an OAuth token from api-m.sandbox.paypal.com AND do not
//   get one from api-m.paypal.com (live).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";
export const LIVE_API = "https://api-m.paypal.com";

export interface ByoCreds {
  clientId: string;
  clientSecret: string;
}

/** What is stored per key (remote/<ns>/creds.json). Never contains the plain secret. */
export interface StoredCreds {
  v: 1;
  clientId: string;
  /** base64(iv[12] | tag[16] | ciphertext) */
  secretEnc: string;
  connectedAt: string;
  /** Set when the developer pressed "Forget my credentials"; the secret is gone. */
  forgottenAt?: string;
}

export function secretsKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.MCPAL_SECRETS_KEY ?? "";
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("Server is missing MCPAL_SECRETS_KEY (32 random bytes, base64).");
  return k;
}

export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(enc: string, key: Buffer, aad: string): string {
  const buf = Buffer.from(enc, "base64");
  if (buf.length < 29) throw new Error("Stored secret is corrupt.");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const ID_RE = /^[A-Za-z0-9_-]{20,128}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{20,128}$/;

/** Cheap format checks before any network call. Returns an error sentence or undefined. */
export function credsShapeError(c: { clientId?: unknown; clientSecret?: unknown }): string | undefined {
  const id = typeof c.clientId === "string" ? c.clientId.trim() : "";
  const secret = typeof c.clientSecret === "string" ? c.clientSecret.trim() : "";
  if (!id || !secret) return "Paste both the sandbox Client ID and the Secret.";
  if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return "That does not look like a PayPal REST app Client ID and Secret (letters, digits, - and _ only).";
  if (id === secret) return "The Client ID and the Secret must be different values.";
  return undefined;
}

async function tokenWorks(base: string, c: ByoCreds, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number; error?: string }> {
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  try {
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    return { ok: res.ok && !!data.access_token, status: res.status, error: data.error };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).name === "TimeoutError" ? "timeout" : "network" };
  }
}

export type VerifyResult = { ok: true } | { ok: false; status: number; error: string };

/** Sandbox token must work; a live token must NOT. Never sends the secret anywhere else. */
export async function verifySandboxCreds(c: ByoCreds, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  const shape = credsShapeError(c);
  if (shape) return { ok: false, status: 400, error: shape };
  const [sb, live] = await Promise.all([tokenWorks(SANDBOX_API, c, fetchImpl), tokenWorks(LIVE_API, c, fetchImpl)]);
  if (live.ok)
    return { ok: false, status: 400, error: "These are LIVE PayPal credentials. MCPal's hosted demo only accepts sandbox apps; nothing was stored. Rotate this secret if you pasted it by mistake." };
  if (!sb.ok) {
    if (sb.status === 0) return { ok: false, status: 502, error: "Could not reach the PayPal sandbox to check these credentials. Try again in a minute." };
    return { ok: false, status: 400, error: "PayPal's sandbox rejected these credentials. Copy the Client ID and Secret from a Sandbox app (developer.paypal.com → Apps & Credentials → Sandbox)." };
  }
  return { ok: true };
}

/** Client id shown back to the developer (never the secret). */
export function maskId(id: string): string {
  return id.length <= 10 ? "…" : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export const CARD_COUNTRY_HINT =
  "Your sandbox business account cannot process cards, so card_on_file does not work with it. Use method payment_link, or create a US sandbox business account (developer.paypal.com → Sandbox accounts → Create account → Business, United States), make a sandbox app on it and connect that app.";
