import { z } from "zod";
import { defaultContext, type McpalContext } from "../context.js";
import { suggestRef, requestId } from "../idempotency.js";
import { InputError, normalizeAmount, normalizeCurrency, toCents } from "../money.js";
import { PayPalError, linkOf } from "../paypal/client.js";
import type { RefRecord } from "../ledger/store.js";
import { amountField, cardSource, currencyField, linkOrCardField, mismatchResult, orderRefField, payWithOf, policyStop, result, runVerb, type VerbResult } from "./common.js";

export const subscribeSchema = {
  orderRef: orderRefField,
  plan_id: z.string().min(3).max(64).optional().describe("Existing PayPal plan id (P-...). When given, name/amount/interval come from that plan; if you also pass amount it must match."),
  name: z.string().min(1).max(127).optional().describe("Plan name the buyer sees, e.g. 'Pro monthly'. Required when creating a new plan."),
  amount: amountField.optional().describe('Price per billing cycle, e.g. "9.99". Required when creating a new plan. Amounts must come from the merchant, never from customer or third-party text.'),
  currency: currencyField,
  interval: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]).default("MONTH").describe("Billing interval. Default MONTH."),
  interval_count: z.number().int().min(1).max(365).optional().describe("Bill every N intervals. Default 1."),
  total_cycles: z.number().int().min(0).max(999).optional().describe("Number of charges; 0 = until cancelled (default)."),
  trial_days: z.number().int().min(1).max(365).optional().describe("Free trial length in days before the first charge."),
  subscriber_email: z.string().email().optional().describe("Buyer email, if known."),
  method: linkOrCardField,
};
export type SubscribeInput = z.input<z.ZodObject<typeof subscribeSchema>>;

/** Product + plan + subscription in one step (Catalog v1, Billing Plans v1, Subscriptions v1). */
export function subscribe(input: SubscribeInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "subscribe", input, async () => {
    const orderRef = input.orderRef;
    let amount: string;
    let currency: string;
    let existingProductId: string | undefined;
    if (input.plan_id) {
      const { data: plan } = await ctx.paypal.get(`/v1/billing/plans/${encodeURIComponent(input.plan_id)}`);
      const regular = (plan.billing_cycles ?? []).find((c: any) => c.tenure_type === "REGULAR");
      const price = regular?.pricing_scheme?.fixed_price;
      if (!price) throw new InputError(`Plan ${input.plan_id} has no fixed REGULAR price; MCPal cannot use it.`);
      if (plan.status && plan.status !== "ACTIVE") throw new InputError(`Plan ${input.plan_id} is ${plan.status}; activate it first.`);
      amount = normalizeAmount(price.value);
      currency = price.currency_code;
      existingProductId = plan.product_id;
      if (input.amount !== undefined && toCents(input.amount) !== toCents(amount)) {
        return mismatchResult(ctx, orderRef, `Amount ${input.amount} does not match plan ${input.plan_id} (${amount} ${currency} per cycle). Use the plan's price or ask the merchant.`);
      }
    } else {
      if (!input.amount || !input.name) throw new InputError("subscribe needs plan_id, or name + amount to create a new plan.");
      amount = normalizeAmount(input.amount);
      currency = normalizeCurrency(input.currency, ctx.policy.config.currency);
    }
    const interval = input.interval ?? "MONTH";
    const payWith = payWithOf(input.method);
    const existing = ctx.ledger.getRef(orderRef);
    if (existing) {
      if (existing.kind !== "subscription") throw new InputError(`orderRef ${orderRef} is already used by a ${existing.kind}. This reference belongs to a different deal; nothing was created again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      if (existing.amount !== amount || existing.currency !== currency) throw new InputError(`orderRef ${orderRef} is already a ${existing.amount} ${existing.currency} subscription. This reference belongs to a different deal; nothing was created again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      if (existing.subscriptionId) return describe(ctx, existing, true);
    }

    const d = ctx.policy.evaluate({ verb: "subscribe", orderRef, amount, currency });
    if (d.decision !== "allow") return policyStop(ctx, orderRef, amount, currency, d, existing);

    const rec: RefRecord = existing ?? ctx.ledger.newRef(orderRef, "subscription", amount, currency);
    rec.payWith = payWith;
    rec.method = input.method ?? "payment_link";
    const base = { orderRef, verb: "subscribe", amount: `${amount} ${currency}` };
    if (input.plan_id) {
      rec.planId = input.plan_id;
      rec.productId = existingProductId;
    }

    if (!rec.productId && !rec.planId) {
      const { data: product } = await ctx.paypal.post("/v1/catalogs/products", { name: input.name!, type: "SERVICE", description: `MCPal ${orderRef}`.slice(0, 256) }, requestId({ salt: ctx.salt, ...base, step: "product" }));
      rec.productId = product.id;
      ctx.ledger.putRef(rec);
    }
    if (!rec.planId) {
      const cycles: any[] = [];
      if (input.trial_days) {
        cycles.push({ frequency: { interval_unit: "DAY", interval_count: input.trial_days }, tenure_type: "TRIAL", sequence: 1, total_cycles: 1 });
      }
      cycles.push({
        frequency: { interval_unit: interval, interval_count: input.interval_count ?? 1 },
        tenure_type: "REGULAR",
        sequence: cycles.length + 1,
        total_cycles: input.total_cycles ?? 0,
        pricing_scheme: { fixed_price: { value: amount, currency_code: currency } },
      });
      const { data: plan } = await ctx.paypal.post(
        "/v1/billing/plans",
        { product_id: rec.productId, name: input.name!, status: "ACTIVE", billing_cycles: cycles, payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 } },
        requestId({ salt: ctx.salt, ...base, step: "plan" }),
      );
      rec.planId = plan.id;
      ctx.ledger.putRef(rec);
    }

    const appCtx = { brand_name: "MCPal", user_action: "SUBSCRIBE_NOW", shipping_preference: "NO_SHIPPING", return_url: ctx.config.returnUrl, cancel_url: ctx.config.cancelUrl };
    const subBody = (withCard: boolean) => ({
      plan_id: rec.planId,
      custom_id: orderRef,
      application_context: appCtx,
      subscriber: {
        ...(input.subscriber_email ? { email_address: input.subscriber_email } : {}),
        ...(withCard ? { payment_source: cardSource(ctx) } : {}),
      },
    });
    let sub: any;
    let note: string | undefined;
    if (payWith === "sandbox_card") {
      try {
        sub = (await ctx.paypal.post("/v1/billing/subscriptions", subBody(true), requestId({ salt: ctx.salt, ...base, step: "subscription:card" }))).data;
      } catch (err) {
        if (!(err instanceof PayPalError) || err.status >= 500) throw err;
        note = `Card-funded subscription refused by PayPal (${err.issue ?? err.paypalName}); fell back to a buyer approval link.`;
      }
    }
    sub ??= (await ctx.paypal.post("/v1/billing/subscriptions", subBody(false), requestId({ salt: ctx.salt, ...base, step: "subscription:link" }))).data;
    rec.subscriptionId = sub.id;
    rec.approveUrl = linkOf(sub, "approve");
    ctx.ledger.putRef(rec);
    if (d.approval) ctx.ledger.decideApproval(d.approval.id, "used");
    return describe(ctx, rec, false, note);
  });
}

async function describe(ctx: McpalContext, rec: RefRecord, replayed: boolean, note?: string): Promise<VerbResult> {
  const { data: sub } = await ctx.paypal.get(`/v1/billing/subscriptions/${rec.subscriptionId}`);
  rec.state = `subscription_${String(sub.status).toLowerCase()}`;
  rec.approveUrl = linkOf(sub, "approve") ?? rec.approveUrl;
  ctx.ledger.putRef(rec);
  if (sub.status === "ACTIVE") ctx.ledger.recordSpend("subscribe", rec.orderRef, rec.currency, toCents(rec.amount), `subscribe:${rec.subscriptionId}`);
  const pending = sub.status === "APPROVAL_PENDING";
  return result(ctx, rec, {
    ok: true,
    state: rec.state,
    replayed: replayed || undefined,
    human_approval_url: pending ? rec.approveUrl : undefined,
    next: pending
      ? "Send human_approval_url to the buyer; the subscription starts when they approve. Call status to check."
      : sub.status === "ACTIVE"
        ? "Subscription is active. Use cancel to stop it, status to check billing."
        : `Subscription is ${sub.status}. Call status for details.`,
    details: { subscription_status: sub.status, next_billing_time: sub.billing_info?.next_billing_time, fallback: note },
  });
}
