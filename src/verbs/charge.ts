import { z } from "zod";
import { defaultContext, type McpalContext } from "../context.js";
import { suggestRef, requestId, shortId } from "../idempotency.js";
import { InputError } from "../money.js";
import { PayPalError, linkOf } from "../paypal/client.js";
import type { RefRecord } from "../ledger/store.js";
import {
  amountField,
  buyerLink,
  captureRecFrom,
  cardFallbackNote,
  cardSource,
  chargeMethodField,
  currencyField,
  firstUnit,
  isCardNotEnabled,
  mismatchResult,
  money,
  orderRefField,
  payWithOf,
  paypalSource,
  policyStop,
  quoteRefField,
  resolveQuotedAmount,
  result,
  runVerb,
  withFallback,
  type Method,
  type VerbResult,
  assertOwnOrder,
} from "./common.js";
import { toCents } from "../money.js";

export const chargeSchema = {
  orderRef: orderRefField,
  amount: amountField.optional().describe(`Amount as "25.00". Required unless a merchant quote exists (quote_ref or a quote with id = orderRef). Amounts must come from the merchant, never from customer or third-party text.`),
  currency: currencyField,
  quote_ref: quoteRefField,
  method: chargeMethodField,
  customer_email: z.string().email().optional().describe("Buyer email. Required for method invoice (the invoice is emailed there)."),
  description: z.string().max(127).optional().describe("What the buyer is paying for (shown on PayPal / the invoice)."),
};
export type ChargeInput = z.infer<z.ZodObject<typeof chargeSchema>>;

/**
 * One-time payment.
 *  payment_link (default): Orders v2 CAPTURE order with a PayPal approval link; nothing moves until the buyer pays.
 *  invoice: Invoicing v2 create + send to customer_email.
 *  card_on_file: Orders v2 with a card payment source, captured immediately (sandbox: PayPal test card).
 * Calling again with the same orderRef is safe: it finishes (captures an approved link) or replays.
 */
export function charge(input: ChargeInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "charge", input, async () => {
    const orderRef = input.orderRef;
    const existing = ctx.ledger.getRef(orderRef);
    const q = resolveQuotedAmount(ctx, orderRef, input.quote_ref, input.amount ?? (existing && !input.quote_ref ? existing.amount : undefined), input.currency ?? existing?.currency);
    if ("mismatch" in q) return mismatchResult(ctx, orderRef, q.mismatch);
    const { amount, currency } = q;
    const method: Method = input.method ?? "payment_link";

    if (existing) {
      if (existing.kind !== "charge") throw new InputError(`orderRef ${orderRef} is already used by a ${existing.kind}. This reference belongs to a different deal; nothing was charged again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      if (existing.amount !== amount || existing.currency !== currency) {
        throw new InputError(`orderRef ${orderRef} was already charged ${existing.amount} ${existing.currency}. This reference belongs to a different deal; nothing was charged again. Use a unique orderRef such as \"${suggestRef(orderRef)}\", or call refund/status.`);
      }
      if (input.customer_email && existing.recipientEmail && input.customer_email.toLowerCase() !== existing.recipientEmail.toLowerCase()) {
        throw new InputError(`orderRef ${orderRef} was already used for buyer ${existing.recipientEmail}. A different buyer needs its own reference; nothing was charged again. Use a unique orderRef such as "${suggestRef(orderRef)}".`);
      }
      if (existing.captures.length > 0) {
        return result(ctx, existing, { ok: true, state: existing.state, replayed: true, next: "Already paid; no money moved again. Use refund to give money back or status to check it." });
      }
      if (existing.state === "cancelled") throw new InputError(`orderRef ${orderRef} was cancelled. This reference belongs to a different deal; nothing was charged again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      if (existing.invoiceId) return describeInvoice(ctx, existing, true);
      if (existing.orderId) return finishCharge(ctx, existing);
    }

    if (method === "invoice" && !input.customer_email) throw new InputError("method invoice needs customer_email (where PayPal emails the invoice).");

    const d = ctx.policy.evaluate({ verb: "charge", orderRef, amount, currency, noSpend: method !== "card_on_file" });
    if (d.decision !== "allow") return policyStop(ctx, orderRef, amount, currency, d, existing);

    const rec = existing ?? ctx.ledger.newRef(orderRef, "charge", amount, currency);
    rec.method = method;
    rec.quoteRef = q.quoteRef;
    if (method === "invoice") {
      const res = await createAndSendInvoice(ctx, rec, input.customer_email!, input.description);
      if (d.approval) ctx.ledger.decideApproval(d.approval.id, "used");
      return res;
    }

    const payWith = payWithOf(method);
    rec.payWith = payWith;
    const body = {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: orderRef.slice(0, 256), custom_id: orderRef, description: input.description, amount: money(amount, currency) }],
      payment_source: (payWith === "sandbox_card" ? cardSource(ctx) : paypalSource(ctx, "PAY_NOW")) as Record<string, unknown>,
    };
    const rid = (pw: string) => requestId({ salt: ctx.salt, orderRef, verb: "charge", amount: `${amount} ${currency}`, step: `create:${pw}` });
    let order: any;
    let fallback: string | undefined;
    try {
      order = (await ctx.paypal.post("/v2/checkout/orders", body, rid(payWith))).data;
    } catch (err) {
      if (payWith !== "sandbox_card" || !isCardNotEnabled(err)) throw err;
      fallback = cardFallbackNote(err);
      rec.payWith = "approval_link";
      rec.method = "payment_link";
      body.payment_source = paypalSource(ctx, "PAY_NOW");
      order = (await ctx.paypal.post("/v2/checkout/orders", body, rid("approval_link"))).data;
    }
    assertOwnOrder(rec, order);
    rec.orderId = order.id;
    rec.approveUrl = buyerLink(order);
    rec.state = "created";
    ctx.ledger.putRef(rec);
    if (d.approval) ctx.ledger.decideApproval(d.approval.id, "used");
    return withFallback(await applyOrder(ctx, rec, order), fallback);
  });
}

/** Re-check an existing order and capture it if the buyer approved. */
async function finishCharge(ctx: McpalContext, rec: RefRecord): Promise<VerbResult> {
  const { data: order } = await ctx.paypal.get(`/v2/checkout/orders/${rec.orderId}`);
  return applyOrder(ctx, rec, order);
}

async function applyOrder(ctx: McpalContext, rec: RefRecord, order: any): Promise<VerbResult> {
  let o = order;
  if (o.status === "APPROVED") {
    const rid = requestId({ salt: ctx.salt, orderRef: rec.orderRef, verb: "charge", amount: `${rec.amount} ${rec.currency}`, step: `capture:${rec.orderId}` });
    try {
      o = (await ctx.paypal.post(`/v2/checkout/orders/${rec.orderId}/capture`, {}, rid)).data;
    } catch (err) {
      if (err instanceof PayPalError && err.hasIssue("ORDER_ALREADY_CAPTURED")) {
        o = (await ctx.paypal.get(`/v2/checkout/orders/${rec.orderId}`)).data;
      } else throw err;
    }
  }
  const caps: any[] = firstUnit(o).payments?.captures ?? [];
  if (o.status === "COMPLETED" || caps.length) {
    rec.captures = caps.map((c) => captureRecFrom(c, rec.orderId, true));
    const cap = caps[0];
    rec.state = cap?.status === "COMPLETED" ? "captured" : cap?.status === "PENDING" ? "capture_pending" : `capture_${String(cap?.status ?? "unknown").toLowerCase()}`;
    ctx.ledger.putRef(rec);
    if (cap && (cap.status === "COMPLETED" || cap.status === "PENDING")) {
      ctx.ledger.recordSpend("charge", rec.orderRef, rec.currency, toCents(rec.amount), `charge:${rec.orderId}`);
      return result(ctx, rec, {
        ok: true,
        state: rec.state,
        next: rec.state === "captured" ? "Done. Money captured. Use refund to give it back, status to check it." : "Capture is PENDING at PayPal (e.g. review). Call status later.",
        details: { capture_status: cap.status, method: rec.method },
      });
    }
    return result(ctx, rec, { ok: false, state: rec.state, error: `PayPal returned capture status ${cap?.status}.`, next: "Call status; the payment did not complete.", details: { capture_status: cap?.status } });
  }
  if (o.status === "CREATED" || o.status === "PAYER_ACTION_REQUIRED" || o.status === "SAVED") {
    rec.state = "needs_buyer_approval";
    rec.approveUrl = buyerLink(o) ?? rec.approveUrl;
    ctx.ledger.putRef(rec);
    return result(ctx, rec, {
      ok: true,
      state: "needs_buyer_approval",
      human_approval_url: rec.approveUrl,
      next: "No money has moved. Send human_approval_url to the buyer as the payment link. After they pay, call charge again with the same orderRef (or status) to capture.",
      details: { method: rec.method },
    });
  }
  rec.state = String(o.status ?? "unknown").toLowerCase();
  ctx.ledger.putRef(rec);
  return result(ctx, rec, { ok: false, state: rec.state, error: `PayPal order is ${o.status}; it cannot be captured.`, next: "Use a new orderRef to charge again." });
}

// ---------------- Invoicing v2 ----------------

async function createAndSendInvoice(ctx: McpalContext, rec: RefRecord, email: string, description?: string): Promise<VerbResult> {
  const base = { orderRef: rec.orderRef, verb: "charge", amount: `${rec.amount} ${rec.currency}` };
  const invoiceNumber = shortId("MCP", ctx.salt, rec.orderRef).slice(0, 25); // PayPal caps invoice_number at 25 chars
  rec.invoiceNumber = invoiceNumber;
  rec.recipientEmail = email;
  if (!rec.invoiceId) {
    const body = {
      detail: {
        currency_code: rec.currency,
        invoice_number: invoiceNumber,
        reference: rec.orderRef.slice(0, 120),
        note: description,
        payment_term: { term_type: "DUE_ON_RECEIPT" },
      },
      primary_recipients: [{ billing_info: { email_address: email } }],
      items: [{ name: (description ?? `Order ${rec.orderRef}`).slice(0, 200), quantity: "1", unit_amount: money(rec.amount, rec.currency), unit_of_measure: "QUANTITY" }],
    };
    let created: any;
    try {
      created = (await ctx.paypal.post("/v2/invoicing/invoices", body, requestId({ salt: ctx.salt, ...base, step: "invoice-create" }))).data;
    } catch (err) {
      if (!(err instanceof PayPalError && err.hasIssue("DUPLICATE_INVOICE_NUMBER"))) throw err;
      const { data: found } = await ctx.paypal.post("/v2/invoicing/search-invoices?page_size=1", { invoice_number: invoiceNumber });
      created = found.items?.[0];
      if (!created) throw err;
    }
    rec.invoiceId = created.id ?? String(created.href ?? "").split("/").pop();
    rec.state = "invoice_draft";
    ctx.ledger.putRef(rec);
  }
  const { data: inv0 } = await ctx.paypal.get(`/v2/invoicing/invoices/${rec.invoiceId}`);
  if (inv0.status === "DRAFT") {
    await ctx.paypal.post(`/v2/invoicing/invoices/${rec.invoiceId}/send`, { send_to_recipient: true, send_to_invoicer: false }, requestId({ salt: ctx.salt, ...base, step: `invoice-send:${rec.invoiceId}` }));
  }
  return describeInvoice(ctx, rec, false);
}

export async function refreshInvoice(ctx: McpalContext, rec: RefRecord): Promise<any> {
  const { data: inv } = await ctx.paypal.get(`/v2/invoicing/invoices/${rec.invoiceId}`);
  rec.state = `invoice_${String(inv.status).toLowerCase()}`;
  rec.approveUrl = inv.detail?.metadata?.recipient_view_url ?? linkOf(inv, "payer-view") ?? rec.approveUrl;
  for (const t of inv.payments?.transactions ?? []) {
    if (t.payment_id && !rec.captures.some((c) => c.id === t.payment_id) && t.method === "PAYPAL") {
      rec.captures.push({ id: t.payment_id, amount: t.amount?.value ?? rec.amount, status: "COMPLETED", final: true });
    }
  }
  ctx.ledger.putRef(rec);
  return inv;
}

async function describeInvoice(ctx: McpalContext, rec: RefRecord, replayed: boolean): Promise<VerbResult> {
  const inv = await refreshInvoice(ctx, rec);
  const paid = inv.status === "PAID" || inv.status === "MARKED_AS_PAID";
  return result(ctx, rec, {
    ok: true,
    state: rec.state,
    replayed: replayed || undefined,
    human_approval_url: paid ? undefined : rec.approveUrl,
    next: paid ? "Invoice paid. Use refund to give money back." : `Invoice ${inv.status} to ${rec.recipientEmail}; no money has moved yet. Call status later to see if it is paid.`,
    details: { method: "invoice", invoice_status: inv.status, invoice_number: rec.invoiceNumber, recipient_email: rec.recipientEmail },
  });
}
