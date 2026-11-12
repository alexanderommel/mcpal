// Bring-your-own sandbox: encryption at rest and refusal of live credentials (web/lib/byo.ts).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIVE_API, SANDBOX_API, credsShapeError, decryptSecret, encryptSecret, secretsKey, verifySandboxCreds } from "../../web/lib/byo.js";

const creds = { clientId: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", clientSecret: "EFgh_ijkl-MNOPqrstUVWXyz0123456789abcd" };

/** Fake PayPal: which hosts hand out a token for these credentials. */
function fakeFetch(tokenOn: string[], seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    seen.push(u);
    const ok = tokenOn.some((h) => u.startsWith(h));
    return new Response(JSON.stringify(ok ? { access_token: "tok", expires_in: 3000 } : { error: "invalid_client", error_description: "Client Authentication failed" }), {
      status: ok ? 200 : 401,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("secret encryption (AES-256-GCM)", () => {
  const key = randomBytes(32);

  it("round-trips and never stores the plain secret", () => {
    const enc = encryptSecret(creds.clientSecret, key, "mcpal-byo|ns1");
    expect(enc).not.toContain(creds.clientSecret);
    expect(decryptSecret(enc, key, "mcpal-byo|ns1")).toBe(creds.clientSecret);
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("same", key, "a")).not.toBe(encryptSecret("same", key, "a"));
  });

  it("fails with the wrong key, the wrong namespace, or a tampered blob", () => {
    const enc = encryptSecret(creds.clientSecret, key, "mcpal-byo|ns1");
    expect(() => decryptSecret(enc, randomBytes(32), "mcpal-byo|ns1")).toThrow();
    expect(() => decryptSecret(enc, key, "mcpal-byo|ns2")).toThrow();
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1]! ^= 1;
    expect(() => decryptSecret(buf.toString("base64"), key, "mcpal-byo|ns1")).toThrow();
  });

  it("requires a 32-byte MCPAL_SECRETS_KEY", () => {
    expect(() => secretsKey({})).toThrow(/MCPAL_SECRETS_KEY/);
    expect(() => secretsKey({ MCPAL_SECRETS_KEY: randomBytes(16).toString("base64") })).toThrow();
    expect(secretsKey({ MCPAL_SECRETS_KEY: randomBytes(32).toString("base64") }).length).toBe(32);
  });
});

describe("sandbox-only credential check", () => {
  it("accepts credentials that work on sandbox and not on live", async () => {
    const seen: string[] = [];
    expect(await verifySandboxCreds(creds, fakeFetch([SANDBOX_API], seen))).toEqual({ ok: true });
    expect(seen.sort()).toEqual([`${LIVE_API}/v1/oauth2/token`, `${SANDBOX_API}/v1/oauth2/token`].sort());
  });

  it("rejects live credentials", async () => {
    const r = await verifySandboxCreds(creds, fakeFetch([LIVE_API]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/LIVE/);
  });

  it("rejects credentials that somehow work on both (treated as live)", async () => {
    const r = await verifySandboxCreds(creds, fakeFetch([LIVE_API, SANDBOX_API]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/LIVE/);
  });

  it("rejects credentials the sandbox refuses", async () => {
    const r = await verifySandboxCreds(creds, fakeFetch([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sandbox rejected/);
  });

  it("rejects malformed input without any network call", async () => {
    const seen: string[] = [];
    expect((await verifySandboxCreds({ clientId: "short", clientSecret: "x" }, fakeFetch([SANDBOX_API], seen))).ok).toBe(false);
    expect(seen).toEqual([]);
    expect(credsShapeError({ clientId: creds.clientId, clientSecret: creds.clientId })).toMatch(/different/);
    expect(credsShapeError({ clientId: "A".repeat(30), clientSecret: "bad secret with spaces!!" })).toBeDefined();
  });
});
