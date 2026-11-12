// PayPal webhook receiver: verifies every delivery with POST /v1/notifications/verify-webhook-signature
// (MCPal's handleWebhook, raw bytes untouched) and keeps the last outcomes in memory for GET.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, handleWebhook, type McpalContext } from "mcpal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let ctx: McpalContext | undefined;
function context(): McpalContext {
  ctx ??= createContext({ config: { dataDir: join(tmpdir(), "mcpal-webhooks"), webhookId: process.env.PAYPAL_WEBHOOK_ID, paypalEnv: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com" } });
  return ctx;
}

interface Seen {
  at: string;
  status: string;
  event_type?: string;
  event_id?: string;
  reason?: string;
}
const recent: Seen[] = [];

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 1_000_000) return Response.json({ status: "invalid", reason: "Body too large" }, { status: 413 });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  try {
    const out = await handleWebhook(context(), raw, headers);
    const seen: Seen = { at: new Date().toISOString(), status: out.status, event_type: out.eventType, event_id: out.eventId, reason: out.reason };
    recent.unshift(seen);
    recent.length = Math.min(recent.length, 20);
    console.log(`[webhook] ${JSON.stringify(seen)}`);
    return Response.json(out, { status: out.httpStatus });
  } catch (err) {
    console.log(`[webhook] error ${(err as Error).message}`);
    return Response.json({ status: "error", reason: (err as Error).message }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ webhook_id_configured: !!process.env.PAYPAL_WEBHOOK_ID, note: "Outcomes seen by this server instance (in memory).", recent });
}
