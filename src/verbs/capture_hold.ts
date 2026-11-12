import { z } from "zod";
import { defaultContext, type McpalContext } from "../context.js";
import { requestId } from "../idempotency.js";
import { InputError, fromCents, normalizeAmount, toCents } from "../money.js";
import { PayPalError } from "../paypal/client.js";
import { amountField, captureRecFrom, heldRemainingCents, money, orderRefField, result, runVerb, type VerbResult } from "./common.js";

export const captureHoldSchema = {
  orderRef: orderRefField,
  amount: amountField.optional().describe("How much of the hold to TAKE. Omit to take everything still held. Whatever is not taken goes back to the buyer."),
};
export type CaptureHoldInput = z.infer<z.ZodObject<typeof captureHoldSchema>>;

/** TAKE money from a hold: capture the remaining (or given) authorized amount with final_capture=true; the rest goes back to the buyer. Reauthorizes once if the honor period is over. */
export function capture_hold(input: CaptureHoldInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "capture_hold", input, async () => {
    const orderRef = input.orderRef;
    const rec = ctx.ledger.getRef(orderRef);
    if (!rec) throw new InputError(`No hold found for orderRef ${orderRef}. Call hold first.`);
    if (rec.kind !== "hold") throw new InputError(`orderRef ${orderRef} is a ${rec.kind}, not a hold. ${rec.kind === "charge" ? "It is already captured." : ""}`.trim());
    if (!rec.authorizationId) {
      return result(ctx, rec, {
        ok: false,
        state: rec.state,
        error: "The hold is not authorized yet (buyer has not approved).",
        human_approval_url: rec.approveUrl,
        next: "Have the buyer approve, then call hold again with the same orderRef to place the hold, then capture_hold.",
      });
    }

    const amountKey = input.amount ? normalizeAmount(input.amount) : "rest";
    const key = `capture_hold:${requestId({ salt: ctx.salt, orderRef, verb: "capture_hold", amount: `${amountKey} ${rec.currency}`, attemptKey: undefined, step: rec.authorizationId })}`;
    const prior = rec.captures.find((c) => c.key === key);
    if (prior) {
      return result(ctx, rec, { ok: true, state: rec.state, replayed: true, next: "Already captured; no money moved again. Use refund to give money back.", details: { capture_id: prior.id, captured: prior.amount } });
    }

    const remaining = heldRemainingCents(rec);
    if (remaining === 0) {
      const done = rec.captures.some((c) => c.final && c.orderId === rec.orderId);
      if (done) return result(ctx, rec, { ok: true, state: rec.state, replayed: true, next: "Nothing left to capture; the hold is fully captured. Use refund to give money back." });
      throw new InputError(`Nothing is held for ${orderRef} (authorization ${rec.authorizationStatus ?? rec.state}).`);
    }
    const amount = input.amount ? normalizeAmount(input.amount) : fromCents(remaining);
    if (toCents(amount) > remaining) throw new InputError(`Cannot capture ${amount}: only ${fromCents(remaining)} ${rec.currency} is still held.`);

    const body = { amount: money(amount, rec.currency), final_capture: true, note_to_payer: "Payment for your held order" };
    let cap: any;
    try {
      cap = (await ctx.paypal.post(`/v2/payments/authorizations/${rec.authorizationId}/capture`, body, key.slice("capture_hold:".length))).data;
    } catch (err) {
      if (!(err instanceof PayPalError) || !needsReauth(err)) throw err;
      // Honor period (3 days) is over: reauthorize the remaining amount, then capture against the new authorization.
      const { data: re } = await ctx.paypal.post(
        `/v2/payments/authorizations/${rec.authorizationId}/reauthorize`,
        { amount: money(fromCents(remaining), rec.currency) },
        requestId({ salt: ctx.salt, orderRef, verb: "capture_hold", amount: fromCents(remaining), attemptKey: undefined, step: `reauth:${rec.authorizationId}` }),
      );
      rec.authorizationId = re.id;
      rec.authorizedAmount = fromCents(remaining + rec.captures.filter((c) => c.orderId === rec.orderId).reduce((s, c) => s + toCents(c.amount), 0));
      rec.authorizationStatus = re.status;
      ctx.ledger.putRef(rec);
      cap = (await ctx.paypal.post(`/v2/payments/authorizations/${re.id}/capture`, body, requestId({ salt: ctx.salt, orderRef, verb: "capture_hold", amount, attemptKey: undefined, step: `after-reauth:${re.id}` }))).data;
    }
    rec.captures.push({ ...captureRecFrom(cap, rec.orderId, true), amount: cap.amount?.value ?? amount, key });
    rec.authorizationStatus = "CAPTURED";
    rec.state = "captured";
    ctx.ledger.putRef(rec);
    const leftOver = remaining - toCents(amount);
    return result(ctx, rec, {
      ok: cap.status === "COMPLETED" || cap.status === "PENDING",
      state: "captured",
      next: "Done. Use refund to give money back, status to check it.",
      details: { capture_id: cap.id, capture_status: cap.status, captured_now: amount, released_to_buyer: leftOver > 0 ? fromCents(leftOver) : undefined },
    });
  });
}

function needsReauth(err: PayPalError): boolean {
  const codes = [err.issue, err.paypalName, ...err.details.map((d) => d.issue)].filter(Boolean).join(" ");
  return /REAUTHORI|HONOR|AUTHORIZATION_EXPIRED_REAUTH|PREVIOUSLY_REAUTHORIZED_NOT_ALLOWED/i.test(codes) && !/VOIDED/.test(codes);
}
