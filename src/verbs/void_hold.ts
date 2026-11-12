import { z } from "zod";
import { defaultContext, type McpalContext } from "../context.js";
import { requestId } from "../idempotency.js";
import { InputError, fromCents } from "../money.js";
import { PayPalError } from "../paypal/client.js";
import { heldRemainingCents, orderRefField, result, runVerb, type VerbResult } from "./common.js";

export const voidHoldSchema = {
  orderRef: orderRefField,
  reason: z.string().max(127).optional().describe("Why it is cancelled (kept in the log; sent to PayPal for subscriptions)."),
};
export type VoidHoldInput = z.infer<z.ZodObject<typeof voidHoldSchema>>;

/**
 * GIVE BACK money that has not moved yet:
 *  hold -> void the remaining authorization (Payments v2 void)
 *  subscription -> cancel the subscription
 *  unclaimed payout -> cancel the payout item
 *  unapproved charge/hold -> mark cancelled (PayPal lets the order expire)
 */
export function void_hold(input: VoidHoldInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "void_hold", input, async () => {
    const orderRef = input.orderRef;
    const rec = ctx.ledger.getRef(orderRef);
    if (!rec) throw new InputError(`No record of orderRef ${orderRef}; nothing to cancel.`);
    if (rec.state === "cancelled" || rec.state === "voided") return result(ctx, rec, { ok: true, state: rec.state, replayed: true, next: "Already voided/cancelled; nothing else to do." });

    if (rec.kind === "subscription") {
      if (!rec.subscriptionId) throw new InputError(`Subscription for ${orderRef} was never created.`);
      const { data: before } = await ctx.paypal.get(`/v1/billing/subscriptions/${rec.subscriptionId}`);
      if (before.status === "APPROVAL_PENDING") {
        // PayPal cannot cancel a subscription the buyer never approved (404); nothing will ever bill, so cancel locally.
        rec.state = "cancelled";
        ctx.ledger.putRef(rec);
        return result(ctx, rec, { ok: true, state: "cancelled", next: "Buyer never approved; no billing will happen. The approval link simply expires.", details: { subscription_status: before.status } });
      }
      try {
        await ctx.paypal.post(`/v1/billing/subscriptions/${rec.subscriptionId}/cancel`, { reason: input.reason ?? "Cancelled by merchant agent" }, requestId({ salt: ctx.salt, orderRef, verb: "void_hold", step: rec.subscriptionId }));
      } catch (err) {
        if (!(err instanceof PayPalError && err.hasIssue("SUBSCRIPTION_STATUS_INVALID"))) throw err;
      }
      const { data: sub } = await ctx.paypal.get(`/v1/billing/subscriptions/${rec.subscriptionId}`);
      rec.state = sub.status === "CANCELLED" ? "cancelled" : String(sub.status).toLowerCase();
      ctx.ledger.putRef(rec);
      return result(ctx, rec, { ok: rec.state === "cancelled" || sub.status === "APPROVAL_PENDING", state: rec.state, next: "No further billing. Use status to confirm.", details: { subscription_status: sub.status } });
    }

    if (rec.kind === "payout") {
      if (!rec.payoutItemId) throw new InputError(`Payout ${orderRef} has no item id yet; call status and try again.`);
      await ctx.paypal.post(`/v1/payments/payouts-item/${rec.payoutItemId}/cancel`, {}, requestId({ salt: ctx.salt, orderRef, verb: "void_hold", step: rec.payoutItemId }));
      rec.state = "cancelled";
      ctx.ledger.putRef(rec);
      return result(ctx, rec, { ok: true, state: "cancelled", next: "Unclaimed payout returned to your balance." });
    }

    if (rec.kind === "charge") {
      if (rec.captures.length > 0) {
        throw new InputError(`Charge ${orderRef} is already captured; void_hold cannot undo it. Use refund.`);
      }
      if (rec.invoiceId) {
        try {
          await ctx.paypal.post(`/v2/invoicing/invoices/${rec.invoiceId}/cancel`, { send_to_recipient: true, send_to_invoicer: false, subject: "Invoice cancelled" }, requestId({ salt: ctx.salt, orderRef, verb: "void_hold", step: rec.invoiceId }));
        } catch (err) {
          if (!(err instanceof PayPalError && err.status === 422)) throw err;
        }
      }
      rec.state = "cancelled";
      ctx.ledger.putRef(rec);
      return result(ctx, rec, { ok: true, state: "cancelled", next: rec.invoiceId ? "Invoice cancelled; no money moved." : "No money moved. The unpaid payment link will expire on its own." });
    }

    // hold
    if (!rec.authorizationId) {
      rec.state = "cancelled";
      ctx.ledger.putRef(rec);
      return result(ctx, rec, { ok: true, state: "cancelled", next: "Buyer never approved; nothing was held. The PayPal order will expire." });
    }
    const remaining = heldRemainingCents(rec);
    if (remaining === 0) {
      if (rec.authorizationStatus === "VOIDED") return result(ctx, rec, { ok: true, state: "voided", replayed: true, next: "Already voided." });
      throw new InputError(`The hold for ${orderRef} is fully captured; nothing to void. Use refund to give money back.`);
    }
    try {
      await ctx.paypal.post(`/v2/payments/authorizations/${rec.authorizationId}/void`, {}, requestId({ salt: ctx.salt, orderRef, verb: "void_hold", step: rec.authorizationId }));
    } catch (err) {
      if (!(err instanceof PayPalError && err.hasIssue("PREVIOUSLY_VOIDED", "AUTHORIZATION_VOIDED", "AUTHORIZATION_ALREADY_VOIDED"))) throw err;
    }
    const { data: auth } = await ctx.paypal.get(`/v2/payments/authorizations/${rec.authorizationId}`);
    rec.authorizationStatus = auth.status;
    rec.state = "voided";
    ctx.ledger.putRef(rec);
    const deposit = rec.captures.length ? " The deposit already taken is kept; use refund to return it." : "";
    return result(ctx, rec, {
      ok: auth.status === "VOIDED" || auth.status === "PARTIALLY_CAPTURED" || auth.status === "CAPTURED",
      state: "voided",
      next: `Hold voided; ${fromCents(remaining)} ${rec.currency} given back to the buyer (never taken).${deposit}`,
      details: { authorization_status: auth.status, released_to_buyer: fromCents(remaining) },
    });
  });
}
