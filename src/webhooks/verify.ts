import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpalContext } from "../context.js";
import type { RefRecord } from "../ledger/store.js";

/**
 * PayPal webhook verification via POST /v1/notifications/verify-webhook-signature.
 * The event is embedded as the exact raw bytes PayPal sent (never JSON.parse + re-stringify),
 * because re-serializing can change the payload and break verification.
 * Deliveries are deduplicated by paypal-transmission-id (and by event id once verified).
 */

export const WEBHOOK_HEADERS = ["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url", "paypal-auth-algo"] as const;

export interface WebhookOutcome {
  status: "verified" | "duplicate" | "rejected" | "invalid";
  httpStatus: number;
  eventType?: string;
  eventId?: string;
  orderRef?: string;
  reason?: string;
}

/** Build the verify-webhook-signature body with the raw event bytes spliced in. */
export function buildVerifyBody(rawBody: string, headers: Record<string, string>, webhookId: string): string {
  const head = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: webhookId,
  };
  const prefix = JSON.stringify(head).slice(0, -1);
  return `${prefix},"webhook_event":${rawBody.trim()}}`;
}

export function lowerHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
  return out;
}

export async function handleWebhook(ctx: McpalContext, rawBody: string, rawHeaders: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
  const headers = lowerHeaders(rawHeaders);
  const missing = WEBHOOK_HEADERS.filter((h) => !headers[h]);
  if (missing.length) return { status: "invalid", httpStatus: 400, reason: `Missing headers: ${missing.join(", ")}` };
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: "invalid", httpStatus: 400, reason: "Body is not JSON" };
  }
  const transmissionId = headers["paypal-transmission-id"]!;
  const base = { eventType: event.event_type as string, eventId: event.id as string };

  // Duplicate delivery of the same transmission: acknowledge without re-verifying or re-applying.
  const already = ctx.ledger.db.prepare("SELECT verified FROM webhooks WHERE transmission_id = ?").get(transmissionId) as { verified: number } | undefined;
  if (already) return { ...base, status: "duplicate", httpStatus: 200 };

  const webhookId = ctx.config.webhookId;
  if (!webhookId) return { ...base, status: "rejected", httpStatus: 503, reason: "PAYPAL_WEBHOOK_ID is not configured" };

  const { data } = await ctx.paypal.request("POST", "/v1/notifications/verify-webhook-signature", { rawBody: buildVerifyBody(rawBody, headers, webhookId) });
  const verified = data?.verification_status === "SUCCESS";
  const rec = verified ? findRefForEvent(ctx, event) : undefined;
  const dupEvent = verified && ctx.ledger.hasEvent(event.id);
  ctx.ledger.recordWebhook(
    {
      transmissionId,
      eventId: event.id,
      eventType: event.event_type,
      resourceId: event.resource?.id,
      orderRef: rec?.orderRef,
      verified,
      receivedAt: new Date().toISOString(),
      summary: event.summary ?? event.event_type,
    },
    rawBody,
  );
  if (!verified) return { ...base, status: "rejected", httpStatus: 400, reason: `PayPal verification_status ${data?.verification_status}` };
  if (rec && !dupEvent) applyEvent(ctx, rec, event);
  return { ...base, status: dupEvent ? "duplicate" : "verified", httpStatus: 200, orderRef: rec?.orderRef };
}

export function findRefForEvent(ctx: McpalContext, event: any): RefRecord | undefined {
  const r = event.resource ?? {};
  const candidates: (string | undefined)[] = [
    r.supplementary_data?.related_ids?.authorization_id,
    r.supplementary_data?.related_ids?.capture_id,
    r.supplementary_data?.related_ids?.order_id,
    r.id,
    r.billing_agreement_id,
    r.payout_batch_id,
    r.batch_header?.payout_batch_id,
  ];
  for (const id of candidates) {
    if (!id) continue;
    const rec = ctx.ledger.findRefByPayPalId(id);
    if (rec) return rec;
  }
  if (typeof r.custom_id === "string") return ctx.ledger.getRef(r.custom_id);
  return undefined;
}

/** Light state sync from verified events (status still re-reads PayPal). */
function applyEvent(ctx: McpalContext, rec: RefRecord, event: any) {
  const r = event.resource ?? {};
  const type: string = event.event_type ?? "";
  if (type.startsWith("PAYMENT.CAPTURE.")) {
    const c = rec.captures.find((x) => x.id === r.id);
    if (c && r.status) c.status = r.status;
    const ref = rec.refunds.find((x) => x.id === r.id);
    if (ref && r.status) ref.status = r.status;
  } else if (type.startsWith("PAYMENT.AUTHORIZATION.") && r.id === rec.authorizationId && r.status) {
    rec.authorizationStatus = r.status;
  } else if (type.startsWith("BILLING.SUBSCRIPTION.") && r.status) {
    rec.state = `subscription_${String(r.status).toLowerCase()}`;
  } else if (type.startsWith("PAYMENT.PAYOUTS-ITEM.") && r.transaction_status) {
    rec.state = `payout_${String(r.transaction_status).toLowerCase()}`;
  }
  ctx.ledger.putRef(rec);
}

export async function readRawBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Tiny route: POST /webhooks/paypal */
export async function webhookRoute(ctx: McpalContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readRawBody(req);
    const out = await handleWebhook(ctx, raw, req.headers);
    res.writeHead(out.httpStatus, { "content-type": "application/json" }).end(JSON.stringify(out));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ status: "error", reason: (err as Error).message }));
  }
}
