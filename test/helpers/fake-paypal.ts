/**
 * In-memory PayPal sandbox stand-in for unit tests. Models just enough of Orders v2, Payments v2,
 * Payouts v1 and Subscriptions v1 to exercise MCPal's flows, including PayPal-Request-Id replay.
 */
import { createContext, type McpalContext } from "../../src/context.js";
import { PayPalClient } from "../../src/paypal/client.js";
import { Ledger } from "../../src/ledger/store.js";
import { DecisionLog } from "../../src/ledger/decision-log.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let n = 0;
const id = (p: string) => `${p}${String(++n).padStart(8, "0")}`;
const cents = (v: string) => Math.round(Number(v) * 100);
const val = (c: number) => (c / 100).toFixed(2);

export class FakePayPal {
  calls: { method: string; path: string; body: any; requestId?: string }[] = [];
  replay = new Map<string, { status: number; body: any }>();
  orders = new Map<string, any>();
  auths = new Map<string, any>();
  captures = new Map<string, any>();
  refunds = new Map<string, any>();
  payouts = new Map<string, any>();
  subs = new Map<string, any>();
  plans = new Map<string, any>();
  invoices = new Map<string, any>();
  allowPartialCapture = true;
  cardProcessing = true;

  writes(pathPart: string) {
    return this.calls.filter((c) => c.method !== "GET" && c.path.includes(pathPart));
  }

  fetch: typeof fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET") as string;
    const headers = init.headers ?? {};
    const body = init.body && method !== "GET" && !String(init.body).startsWith("grant_type") ? JSON.parse(init.body) : undefined;
    const rid: string | undefined = headers["PayPal-Request-Id"];
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "fake", expires_in: 3600 });
    this.calls.push({ method, path: url.pathname, body, requestId: rid });
    const key = rid ? `${url.pathname}|${rid}` : undefined;
    if (key && this.replay.has(key)) {
      const r = this.replay.get(key)!;
      return json(r.status, r.body);
    }
    const r = this.route(method, url.pathname, body);
    if (key && r.status < 500) this.replay.set(key, r);
    return json(r.status, r.body);
  };

  private err(status: number, issue: string, description = issue) {
    return { status, body: { name: status === 422 ? "UNPROCESSABLE_ENTITY" : "INVALID_REQUEST", details: [{ issue, description }], debug_id: "dbg" } };
  }

  private route(method: string, path: string, body: any): { status: number; body: any } {
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/v2/checkout/orders") {
      if (body.payment_source?.card && !this.cardProcessing) return this.err(422, "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING");
      const o: any = { id: id("ORD"), create_time: new Date().toISOString(), intent: body.intent, status: "CREATED", purchase_units: [{ ...body.purchase_units[0], payments: {} }], links: [] };
      if (body.payment_source?.card) o.status = "APPROVED";
      else o.links.push({ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` });
      this.orders.set(o.id, o);
      return { status: 201, body: o };
    }
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && method === "GET") {
      const o = this.orders.get(m[1]!);
      return o ? { status: 200, body: o } : this.err(404, "RESOURCE_NOT_FOUND");
    }
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/(capture|authorize)$/.exec(path))) {
      const o = this.orders.get(m[1]!);
      if (!o) return this.err(404, "RESOURCE_NOT_FOUND");
      if (o.status === "COMPLETED") return this.err(422, m[2] === "capture" ? "ORDER_ALREADY_CAPTURED" : "ORDER_ALREADY_AUTHORIZED");
      if (o.status !== "APPROVED") return this.err(422, "ORDER_NOT_APPROVED");
      const amount = o.purchase_units[0].amount;
      if (m[2] === "capture") {
        const c = { id: id("CAP"), status: "COMPLETED", amount, final_capture: true };
        this.captures.set(c.id, { ...c, refunded: 0 });
        o.purchase_units[0].payments.captures = [c];
      } else {
        const a = { id: id("AUTH"), status: "CREATED", amount, expiration_time: "2026-12-10T00:00:00Z", captured: 0, final: false };
        this.auths.set(a.id, a);
        o.purchase_units[0].payments.authorizations = [{ id: a.id, status: a.status, amount, expiration_time: a.expiration_time }];
      }
      o.status = "COMPLETED";
      return { status: 201, body: o };
    }
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)(?:\/(capture|void|reauthorize))?$/.exec(path))) {
      const a = this.auths.get(m[1]!);
      if (!a) return this.err(404, "RESOURCE_NOT_FOUND");
      if (method === "GET") return { status: 200, body: { id: a.id, status: a.status, amount: a.amount, expiration_time: a.expiration_time } };
      if (m[2] === "void") {
        if (a.status === "VOIDED") return this.err(422, "PREVIOUSLY_VOIDED");
        if (a.status === "CAPTURED") return this.err(422, "PREVIOUSLY_CAPTURED");
        a.status = "VOIDED";
        return { status: 204, body: undefined };
      }
      if (m[2] === "capture") {
        if (a.status === "VOIDED" || a.status === "CAPTURED") return this.err(422, "AUTHORIZATION_ALREADY_CAPTURED");
        const want = cents(body.amount.value);
        if (!body.final_capture && !this.allowPartialCapture) return this.err(422, "PARTIAL_CAPTURE_NOT_ALLOWED");
        if (a.captured + want > cents(a.amount.value)) return this.err(422, "MAX_CAPTURE_AMOUNT_EXCEEDED");
        a.captured += want;
        a.status = body.final_capture ? "CAPTURED" : "PARTIALLY_CAPTURED";
        const c = { id: id("CAP"), status: "COMPLETED", amount: body.amount, final_capture: !!body.final_capture };
        this.captures.set(c.id, { ...c, refunded: 0 });
        return { status: 201, body: c };
      }
    }
    if ((m = /^\/v2\/payments\/captures\/([^/]+)(\/refund)?$/.exec(path))) {
      const c = this.captures.get(m[1]!);
      if (!c) return this.err(404, "RESOURCE_NOT_FOUND");
      if (method === "GET") return { status: 200, body: { id: c.id, status: c.status, amount: c.amount } };
      const want = cents(body.amount.value);
      if (c.refunded + want > cents(c.amount.value)) return this.err(422, "REFUND_AMOUNT_EXCEEDED");
      c.refunded += want;
      if (c.refunded === cents(c.amount.value)) c.status = "REFUNDED";
      else c.status = "PARTIALLY_REFUNDED";
      const r = { id: id("REF"), status: "COMPLETED", amount: body.amount };
      this.refunds.set(r.id, r);
      return { status: 201, body: r };
    }
    if ((m = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path))) {
      const r = this.refunds.get(m[1]!);
      return r ? { status: 200, body: r } : this.err(404, "RESOURCE_NOT_FOUND");
    }
    if (method === "POST" && path === "/v1/payments/payouts") {
      if (!body.items?.[0]?.amount?.currency) return this.err(400, "VALIDATION_ERROR", "may not be null (field items[0].amount.currency)");
      const b = { batch_header: { payout_batch_id: id("BATCH"), batch_status: "PENDING", sender_batch_header: body.sender_batch_header }, items: [{ payout_item_id: id("ITEM"), transaction_status: "SUCCESS", payout_item: body.items[0] }] };
      this.payouts.set(b.batch_header.payout_batch_id, b);
      return { status: 201, body: { batch_header: b.batch_header } };
    }
    if ((m = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(path))) {
      const b = this.payouts.get(m[1]!);
      return b ? { status: 200, body: b } : this.err(404, "RESOURCE_NOT_FOUND");
    }
    if (path === "/v1/catalogs/products") return { status: 201, body: { id: id("PROD-") } };
    if (method === "POST" && path === "/v1/billing/plans") {
      const p = { id: id("P-"), status: "ACTIVE", product_id: body.product_id, billing_cycles: body.billing_cycles };
      this.plans.set(p.id, p);
      return { status: 201, body: p };
    }
    if ((m = /^\/v1\/billing\/plans\/([^/]+)$/.exec(path))) {
      const p = this.plans.get(m[1]!);
      return p ? { status: 200, body: p } : this.err(404, "INVALID_RESOURCE_ID");
    }
    if (method === "POST" && path === "/v2/invoicing/invoices") {
      if (!body.primary_recipients?.[0]?.billing_info?.email_address) return this.err(400, "MISSING_REQUIRED_PARAMETER", "billing_info.email_address");
      if ([...this.invoices.values()].some((i) => i.detail.invoice_number === body.detail.invoice_number)) return this.err(422, "DUPLICATE_INVOICE_NUMBER");
      const inv = { id: id("INV2-"), status: "DRAFT", detail: { ...body.detail, metadata: {} }, primary_recipients: body.primary_recipients, amount: body.items[0].unit_amount };
      this.invoices.set(inv.id, inv);
      return { status: 201, body: inv };
    }
    if ((m = /^\/v2\/invoicing\/invoices\/([^/]+)(?:\/(send|cancel))?$/.exec(path))) {
      const inv = this.invoices.get(m[1]!);
      if (!inv) return this.err(404, "RESOURCE_NOT_FOUND");
      if (m[2] === "send") {
        inv.status = "SENT";
        inv.detail.metadata.recipient_view_url = `https://www.sandbox.paypal.com/invoice/p/#${inv.id}`;
        return { status: 200, body: { href: inv.detail.metadata.recipient_view_url } };
      }
      if (m[2] === "cancel") {
        inv.status = "CANCELLED";
        return { status: 204, body: undefined };
      }
      return { status: 200, body: inv };
    }
    if (method === "POST" && path === "/v1/billing/subscriptions") {
      const s = { id: id("I-"), status: body.subscriber?.payment_source ? "ACTIVE" : "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=X" }] };
      this.subs.set(s.id, s);
      return { status: 201, body: s };
    }
    if ((m = /^\/v1\/billing\/subscriptions\/([^/]+)(\/cancel)?$/.exec(path))) {
      const s = this.subs.get(m[1]!);
      if (!s) return this.err(404, "RESOURCE_NOT_FOUND");
      if (m[2]) {
        s.status = "CANCELLED";
        return { status: 204, body: undefined };
      }
      return { status: 200, body: s };
    }
    if (path === "/v1/notifications/verify-webhook-signature") return { status: 200, body: { verification_status: "SUCCESS" } };
    return this.err(404, "NOT_FOUND", `${method} ${path}`);
  }
}

function json(status: number, body: any): Response {
  return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": "fakedebug" },
  });
}

export function fakeContext(policy: Partial<{ approval_threshold: string; daily_cap: string; refund_ceiling: string; payout_allowlist: string[] }> = {}, shared?: FakePayPal) {
  const fake = shared ?? new FakePayPal();
  const dir = mkdtempSync(join(tmpdir(), "mcpal-test-"));
  const ctx: McpalContext = createContext({
    config: { dataDir: dir, policyFile: join(dir, "none.json"), publicUrl: "http://localhost:8787", paypalEnv: "sandbox", webhookId: "WH-TEST" },
    paypal: new PayPalClient({ clientId: "x", clientSecret: "y", fetch: fake.fetch, backoffMs: 1 }),
    ledger: new Ledger(join(dir, "mcpal.sqlite")),
    log: new DecisionLog(join(dir, "decisions.jsonl")),
    policy: { currency: "USD", approval_threshold: "500.00", daily_cap: "2000.00", refund_ceiling: "250.00", payout_allowlist: ["seller@example.com", "a@example.com"], ...policy },
  });
  return { ctx, fake, dir };
}
