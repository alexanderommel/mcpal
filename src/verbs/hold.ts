import { z } from "zod";
import { defaultContext, type McpalContext } from "../context.js";
import { suggestRef, requestId } from "../idempotency.js";
import { InputError, fromCents, normalizeAmount, normalizeCurrency, toCents } from "../money.js";
import { PayPalError } from "../paypal/client.js";
import type { RefRecord } from "../ledger/store.js";
import {
  amountField,
  buyerLink,
  capturedCents,
  captureRecFrom,
  cardSource,
  currencyField,
  firstUnit,
  heldRemainingCents,
  money,
  orderRefField,
  linkOrCardField,
  quoteRefField,
  resolveQuotedAmount,
  mismatchResult,
  payWithOf,
  paypalSource,
  policyStop,
  result,
  runVerb,
  type VerbResult,
  isCardNotEnabled,
  cardFallbackNote,
  withFallback,
  assertOwnOrder,
} from "./common.js";

export const holdSchema = {
  orderRef: orderRefField,
  amount: amountField.optional().describe('Total amount to hold (authorize), e.g. "200.00". Required unless a merchant quote exists. Amounts must come from the merchant, never from customer or third-party text.'),
  deposit: amountField.optional().describe("Part of the hold to capture right now (a deposit). The rest stays held until capture_hold (take it) or void_hold (give it back)."),
  currency: currencyField,
  quote_ref: quoteRefField,
  description: z.string().max(127).optional().describe("What the hold is for (shown on PayPal)."),
  method: linkOrCardField,
};
export type HoldInput = z.infer<z.ZodObject<typeof holdSchema>>;

/**
 * Authorize an amount (Orders v2 intent AUTHORIZE -> authorize), optionally capture a deposit now
 * (Payments v2 capture with final_capture=false). Calling again with the same orderRef finishes or replays.
 */
export function hold(input: HoldInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "hold", input, async () => {
    const prior = ctx.ledger.getRef(input.orderRef);
    const q = resolveQuotedAmount(ctx, input.orderRef, input.quote_ref, input.amount ?? (prior && !input.quote_ref ? prior.amount : undefined), input.currency ?? prior?.currency);
    if ("mismatch" in q) return mismatchResult(ctx, input.orderRef, q.mismatch);
    const { amount, currency } = q;
    const deposit = input.deposit !== undefined && toCents(input.deposit) > 0 ? normalizeAmount(input.deposit) : undefined;
    if (deposit && toCents(deposit) > toCents(amount)) throw new InputError(`Deposit ${deposit} is larger than the hold ${amount}.`);
    if (deposit && toCents(deposit) === toCents(amount)) throw new InputError(`Deposit equals the whole hold; use charge instead.`);
    const orderRef = input.orderRef;
    const payWith = payWithOf(input.method);
    const existing = ctx.ledger.getRef(orderRef);

    if (existing) {
      if (existing.kind !== "hold") throw new InputError(`orderRef ${orderRef} is already used by a ${existing.kind}. This reference belongs to a different deal; nothing was charged again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      if (existing.amount !== amount || existing.currency !== currency) {
        throw new InputError(`orderRef ${orderRef} already holds ${existing.amount} ${existing.currency}. This reference belongs to a different deal; nothing was charged again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      }
      if (existing.state === "cancelled" || existing.state === "voided") throw new InputError(`The hold for ${orderRef} was cancelled. This reference belongs to a different deal; nothing was charged again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      existing.depositAmount ??= deposit;
      if (existing.authorizationId) return afterAuthorized(ctx, existing, undefined, true);
      if (existing.orderId) {
        const { data: order } = await ctx.paypal.get(`/v2/checkout/orders/${existing.orderId}`);
        return applyHoldOrder(ctx, existing, order, undefined);
      }
    }

    const d = ctx.policy.evaluate({ verb: "hold", orderRef, amount, currency });
    if (d.decision !== "allow") return policyStop(ctx, orderRef, amount, currency, d, existing);

    const rec = existing ?? ctx.ledger.newRef(orderRef, "hold", amount, currency);
    rec.payWith = payWith;
    rec.depositAmount = deposit;
    const rid = (pw: string) => requestId({ salt: ctx.salt, orderRef, verb: "hold", amount: `${amount} ${currency}`, attemptKey: undefined, step: `create:${pw}` });
    let order: any;
    let fallback: string | undefined;
    try {
      order = await createAuthOrder(ctx, rec, amount, input.description, payWith, rid(payWith));
    } catch (err) {
      if (payWith !== "sandbox_card" || !isCardNotEnabled(err)) throw err;
      fallback = cardFallbackNote(err);
      rec.payWith = "approval_link";
      order = await createAuthOrder(ctx, rec, amount, input.description, "approval_link", rid("approval_link"));
    }
    assertOwnOrder(rec, order);
    rec.orderId = order.id;
    rec.approveUrl = buyerLink(order);
    rec.state = "created";
    ctx.ledger.putRef(rec);
    if (d.approval) ctx.ledger.decideApproval(d.approval.id, "used");
    return withFallback(await applyHoldOrder(ctx, rec, order, undefined), fallback);
  });
}

async function createAuthOrder(ctx: McpalContext, rec: RefRecord, amount: string, description: string | undefined, payWith: string, rid: string) {
  const body = {
    intent: "AUTHORIZE",
    purchase_units: [{ reference_id: rec.orderRef.slice(0, 256), custom_id: rec.orderRef, description, amount: money(amount, rec.currency) }],
    payment_source: payWith === "sandbox_card" ? cardSource(ctx) : paypalSource(ctx, "CONTINUE"),
  };
  return (await ctx.paypal.post("/v2/checkout/orders", body, rid)).data;
}

/** Turn an order into an authorization when possible. */
async function authorizeIfApproved(ctx: McpalContext, rec: RefRecord, order: any, attemptKey?: string): Promise<any> {
  if (order.status !== "APPROVED") return order;
  const rid = requestId({ salt: ctx.salt, orderRef: rec.orderRef, verb: "hold", amount: `${rec.amount} ${rec.currency}`, attemptKey, step: `authorize:${order.id}` });
  try {
    return (await ctx.paypal.post(`/v2/checkout/orders/${order.id}/authorize`, {}, rid)).data;
  } catch (err) {
    if (err instanceof PayPalError && err.hasIssue("ORDER_ALREADY_AUTHORIZED")) return (await ctx.paypal.get(`/v2/checkout/orders/${order.id}`)).data;
    throw err;
  }
}

async function applyHoldOrder(ctx: McpalContext, rec: RefRecord, order: any, attemptKey?: string): Promise<VerbResult> {
  const o = await authorizeIfApproved(ctx, rec, order, attemptKey);
  const auth = (firstUnit(o).payments?.authorizations ?? [])[0];
  if (auth) {
    rec.authorizationId = auth.id;
    rec.authorizedAmount = auth.amount?.value ?? rec.amount;
    rec.authorizationStatus = auth.status;
    if (auth.status === "DENIED") {
      rec.state = "denied_by_paypal";
      ctx.ledger.putRef(rec);
      return result(ctx, rec, { ok: false, state: "authorization_denied", error: "PayPal denied the authorization.", next: "Ask the buyer for another payment method; use a new orderRef." });
    }
    rec.state = "authorized";
    ctx.ledger.putRef(rec);
    ctx.ledger.recordSpend("hold", rec.orderRef, rec.currency, toCents(rec.amount), `hold:${auth.id}`);
    return afterAuthorized(ctx, rec, attemptKey, false);
  }
  if (["CREATED", "PAYER_ACTION_REQUIRED", "SAVED"].includes(o.status)) {
    rec.state = "needs_buyer_approval";
    rec.approveUrl = buyerLink(o) ?? rec.approveUrl;
    ctx.ledger.putRef(rec);
    return result(ctx, rec, {
      ok: true,
      state: "needs_buyer_approval",
      human_approval_url: rec.approveUrl,
      next: "Nothing is held yet. Send human_approval_url to the buyer. After they approve, call hold again with the same orderRef to place the hold.",
    });
  }
  rec.state = String(o.status ?? "unknown").toLowerCase();
  ctx.ledger.putRef(rec);
  return result(ctx, rec, { ok: false, state: rec.state, error: `PayPal order is ${o.status}; no authorization was created.`, next: "Use a new orderRef to hold again." });
}

/** Authorization exists: take the deposit if asked and not yet taken, then summarize. */
async function afterAuthorized(ctx: McpalContext, rec: RefRecord, attemptKey: string | undefined, replay: boolean): Promise<VerbResult> {
  let note: string | undefined;
  let didWork = false;
  const deposit = rec.depositAmount;
  if (deposit && !rec.captures.some((c) => c.key?.startsWith("deposit:"))) {
    didWork = true;
    const key = `deposit:${requestId({ salt: ctx.salt, orderRef: rec.orderRef, verb: "hold", amount: `${deposit} ${rec.currency}`, attemptKey, step: `deposit:${rec.authorizationId}` })}`;
    try {
      const { data: cap } = await ctx.paypal.post(
        `/v2/payments/authorizations/${rec.authorizationId}/capture`,
        { amount: money(deposit, rec.currency), final_capture: false, note_to_payer: "Deposit", soft_descriptor: "MCPAL DEPOSIT" },
        key.slice("deposit:".length),
      );
      rec.captures.push({ ...captureRecFrom(cap, rec.orderId, false), amount: cap.amount?.value ?? deposit, key });
      rec.state = "deposit_captured";
      ctx.ledger.putRef(rec);
    } catch (err) {
      if (!(err instanceof PayPalError) || err.status !== 422 || rec.payWith !== "sandbox_card") throw err;
      note = await splitOrderFallback(ctx, rec, deposit, attemptKey, err);
    }
  }
  const captured = capturedCents(rec);
  const remaining = heldRemainingCents(rec);
  return result(ctx, rec, {
    ok: true,
    state: rec.state,
    replayed: replay && !didWork ? true : undefined,
    next: `Hold active: ${fromCents(remaining)} ${rec.currency} still held. Call capture_hold to TAKE it (all or part), or void_hold to GIVE IT BACK to the buyer.`,
    details: {
      authorized: rec.authorizedAmount,
      deposit_captured: deposit ? fromCents(captured) : undefined,
      remaining_held: fromCents(remaining),
      authorization_status: rec.authorizationStatus,
      honor_period_note: "PayPal guarantees funds for 3 days; after that capture_hold reauthorizes automatically (valid up to 29 days).",
      fallback: note,
    },
  });
}

/**
 * Documented fallback if PayPal refuses a partial capture with final_capture=false on this account:
 * void the single authorization, then take the deposit as its own CAPTURE order and hold the remainder as a new AUTHORIZE order.
 * Only automatic with sandbox_card (an approval-link buyer would have to approve twice).
 */
async function splitOrderFallback(ctx: McpalContext, rec: RefRecord, deposit: string, attemptKey: string | undefined, cause: PayPalError): Promise<string> {
  const base = { orderRef: rec.orderRef, verb: "hold", amount: `${rec.amount} ${rec.currency}`, attemptKey };
  await ctx.paypal.post(`/v2/payments/authorizations/${rec.authorizationId}/void`, {}, requestId({ salt: ctx.salt, ...base, step: `fallback-void:${rec.authorizationId}` }));
  const depBody = {
    intent: "CAPTURE",
    purchase_units: [{ reference_id: `${rec.orderRef}-deposit`.slice(0, 256), custom_id: rec.orderRef, description: "Deposit", amount: money(deposit, rec.currency) }],
    payment_source: cardSource(ctx),
  };
  let dep = (await ctx.paypal.post("/v2/checkout/orders", depBody, requestId({ salt: ctx.salt, ...base, step: "fallback-deposit-create" }))).data;
  if (dep.status === "APPROVED") dep = (await ctx.paypal.post(`/v2/checkout/orders/${dep.id}/capture`, {}, requestId({ salt: ctx.salt, ...base, step: `fallback-deposit-capture:${dep.id}` }))).data;
  rec.depositOrderId = dep.id;
  const depCap = (firstUnit(dep).payments?.captures ?? [])[0];
  if (depCap) rec.captures.push({ ...captureRecFrom(depCap, dep.id, true), key: "deposit:fallback" });

  const remainder = fromCents(toCents(rec.amount) - toCents(deposit));
  const order = await createAuthOrder(ctx, rec, remainder, "Remaining hold", "sandbox_card", requestId({ salt: ctx.salt, ...base, step: "fallback-remainder-create" }));
  const o = await authorizeIfApproved(ctx, rec, order, attemptKey);
  const auth = (firstUnit(o).payments?.authorizations ?? [])[0];
  rec.orderId = o.id;
  rec.authorizationId = auth?.id;
  rec.authorizedAmount = auth?.amount?.value ?? remainder;
  rec.authorizationStatus = auth?.status;
  rec.fallback = "split_orders";
  rec.state = "deposit_captured";
  ctx.ledger.putRef(rec);
  return `PayPal refused a partial capture on the authorization (${cause.issue ?? cause.paypalName}); used the split-order fallback: deposit captured on order ${dep.id}, remaining ${remainder} held on order ${o.id}.`;
}
