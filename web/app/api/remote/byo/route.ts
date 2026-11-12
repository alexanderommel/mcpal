// "Use your own sandbox": verify a developer's PayPal SANDBOX app credentials, then mint a new demo key
// bound to them (secret encrypted at rest). Also "status" and "forget" for a key the browser holds.
// The request body is never logged and the secret is never returned.
import { randomBytes } from "node:crypto";
import { maskId, secretsKey, verifySandboxCreds } from "@/lib/byo";
import { CONNECT_PER_HOUR, clientIp, forgetCreds, loadCreds, nsOf, storeCreds, takeIp } from "@/lib/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY_RE = /^dk_[a-z0-9]{24}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function newKey(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 252 = 7 * 36: rejection sampling keeps every character uniform.
  let out = "";
  while (out.length < 24) for (const b of randomBytes(32)) if (b < 252 && out.length < 24) out += abc[b % 36];
  return "dk_" + out;
}

export async function POST(req: Request): Promise<Response> {
  let body: { action?: string; key?: string; clientId?: unknown; clientSecret?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  const action = body.action;

  if (action === "status" || action === "forget") {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!KEY_RE.test(key)) return json({ error: "Send your demo key." }, 400);
    const ns = nsOf(key);
    try {
      if (action === "forget") {
        const had = await forgetCreds(ns);
        return json({ forgotten: had });
      }
      const kc = await loadCreds(ns);
      return json({ mode: kc.kind, clientId: kc.kind === "byo" ? maskId(kc.clientId) : undefined });
    } catch {
      return json({ error: "Could not read this key's settings. Try again." }, 500);
    }
  }

  if (action !== "connect") return json({ error: "Unknown action." }, 400);
  try {
    secretsKey();
  } catch {
    return json({ error: "Bring-your-own sandbox is not configured on this server yet." }, 503);
  }
  const lim = await takeIp(clientIp(req), Date.now(), "connect", CONNECT_PER_HOUR).catch(() => ({ ok: true, retryInMin: 0 }));
  if (!lim.ok) return json({ error: `Too many connect attempts from this network (${CONNECT_PER_HOUR} per hour). Try again in about ${lim.retryInMin} min.` }, 429);

  const creds = { clientId: String(body.clientId ?? "").trim(), clientSecret: String(body.clientSecret ?? "").trim() };
  const v = await verifySandboxCreds(creds);
  if (!v.ok) return json({ error: v.error }, v.status);
  const key = newKey();
  try {
    await storeCreds(nsOf(key), creds);
  } catch {
    return json({ error: "Could not save the credentials. Try again." }, 500);
  }
  return json({ key, clientId: maskId(creds.clientId), mode: "byo" });
}
