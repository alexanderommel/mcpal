import { existsSync, readFileSync } from "node:fs";
import { defaultContext, type McpalContext } from "../context.js";
import { InputError, fromCents } from "../money.js";
import { linkOf } from "../paypal/client.js";
import type { RefRecord } from "../ledger/store.js";
import { capturedCents, captureRecFrom, firstUnit, heldRemainingCents, orderRefField, refundedCents, result, runVerb, type VerbResult } from "./common.js";
import { refreshPayout } from "./pay_out.js";
import { refreshInvoice } from "./charge.js";

export const statusSchema = {
  orderRef: orderRefField,
};
export type StatusInput = { orderRef: string };

/** One plain answer about an orderRef, refreshed from PayPal (order, authorization, captures, refunds, payout, subscription) + last webhook. */
export function status(input: StatusInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "status", input, async () => {
    const rec = ctx.ledger.getRef(input.orderRef);
    if (!rec) {
      const pending = approvalOnly(ctx, input.orderRef);
      if (pending) return pending;
      throw new InputError(`No record of orderRef ${input.orderRef} on this MCPal server. It was never charged, held, paid out or subscribed here.`);
    }
    const warnings: string[] = [];
    await refresh(ctx, rec, warnings);
    ctx.ledger.putRef(rec);
    const hook = ctx.ledger.lastWebhook(rec.orderRef);
    const { answer, next } = explain(rec);
    return result(ctx, rec, {
      ok: true,
      state: rec.state,
      next,
      human_approval_url: rec.state === "needs_buyer_approval" || rec.state === "subscription_approval_pending" ? rec.approveUrl : undefined,
      details: {
        answer,
        kind: rec.kind,
        captured: rec.captures.length ? fromCents(capturedCents(rec)) : undefined,
        refunded: rec.refunds.length ? fromCents(refundedCents(rec)) : undefined,
        refundable_remaining: rec.kind === "charge" || rec.kind === "hold" ? fromCents(Math.max(0, capturedCents(rec) - refundedCents(rec))) : undefined,
        method: rec.method,
        still_held: rec.kind === "hold" && rec.authorizationId ? fromCents(heldRemainingCents(rec)) : undefined,
        authorization_status: rec.authorizationStatus,
        captures: rec.captures.map(({ key: _k, ...c }) => c),
        refunds: rec.refunds.map(({ key: _k, ...r }) => r),
        last_webhook: hook ? { type: hook.eventType, at: hook.receivedAt, verified: hook.verified, summary: hook.summary } : null,
        warnings: warnings.length ? warnings : undefined,
      },
    });
  });
}

async function refresh(ctx: McpalContext, rec: RefRecord, warnings: string[]) {
  const pp = ctx.paypal;
  const safe = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      warnings.push(`${what}: ${(e as Error).message}`);
    }
  };
  if (rec.invoiceId) {
    await safe("invoice", async () => void (await refreshInvoice(ctx, rec)));
  }
  if (rec.kind === "charge" || rec.kind === "hold") {
    if (rec.orderId) {
      await safe("order", async () => {
        const { data: o } = await pp.get(`/v2/checkout/orders/${rec.orderId}`);
        const pay = firstUnit(o).payments ?? {};
        const auth = (pay.authorizations ?? [])[0];
        if (auth && !rec.authorizationId) {
          rec.authorizationId = auth.id;
          rec.authorizedAmount = auth.amount?.value;
        }
        for (const c of pay.captures ?? []) {
          const known = rec.captures.find((x) => x.id === c.id);
          if (known) known.status = c.status;
          else rec.captures.push(captureRecFrom(c, rec.orderId, c.final_capture));
        }
        if (o.status === "APPROVED" && rec.state === "needs_buyer_approval") rec.state = "buyer_approved";
        rec.approveUrl = linkOf(o, "payer-action", "approve") ?? rec.approveUrl;
      });
    }
    if (rec.authorizationId) {
      await safe("authorization", async () => {
        const { data: a } = await pp.get(`/v2/payments/authorizations/${rec.authorizationId}`);
        rec.authorizationStatus = a.status;
        if (a.status === "VOIDED" && rec.state !== "voided") rec.state = "voided";
        if (a.expiration_time) (rec as any).authorizationExpires = a.expiration_time;
      });
    }
    for (const c of rec.captures) {
      await safe(`capture ${c.id}`, async () => {
        const { data } = await pp.get(`/v2/payments/captures/${c.id}`);
        c.status = data.status;
      });
    }
    for (const r of rec.refunds) {
      await safe(`refund ${r.id}`, async () => {
        const { data } = await pp.get(`/v2/payments/refunds/${r.id}`);
        r.status = data.status;
      });
    }
  } else if (rec.kind === "payout") {
    await safe("payout", async () => void (await refreshPayout(ctx, rec)));
  } else if (rec.kind === "subscription" && rec.subscriptionId) {
    await safe("subscription", async () => {
      const { data: s } = await pp.get(`/v1/billing/subscriptions/${rec.subscriptionId}`);
      rec.state = `subscription_${String(s.status).toLowerCase()}`;
      (rec as any).nextBillingTime = s.billing_info?.next_billing_time;
      (rec as any).lastPayment = s.billing_info?.last_payment;
    });
  }
}

export function explain(rec: RefRecord): { answer: string; next: string } {
  const cur = rec.currency;
  const cap = fromCents(capturedCents(rec));
  const ref = fromCents(refundedCents(rec));
  switch (rec.kind) {
    case "charge": {
      if (rec.invoiceId && !rec.captures.length) return { answer: `Invoice ${rec.invoiceNumber ?? rec.invoiceId} for ${rec.amount} ${cur} to ${rec.recipientEmail}: ${rec.state.replace(/^invoice_/, "").toUpperCase()}. No money has moved yet.`, next: "Wait for the buyer to pay; call status again later." };
      if (rec.state === "needs_buyer_approval") return { answer: `Payment link for ${rec.amount} ${cur} sent; the buyer has not paid yet. No money has moved.`, next: "Send the link; call charge again after they pay." };
      if (rec.state === "buyer_approved") return { answer: `Buyer approved the ${rec.amount} ${cur} charge; it is not captured yet.`, next: "Call charge again with the same orderRef to capture." };
      if (rec.state === "cancelled") return { answer: `Charge ${rec.orderRef} was cancelled before payment.`, next: "Nothing to do." };
      return {
        answer: `Charged ${cap} ${cur}${ref !== "0.00" ? `, refunded ${ref} ${cur}` : ""}; refundable remaining ${fromCents(Math.max(0, capturedCents(rec) - refundedCents(rec)))} ${cur}. Capture status: ${rec.captures.map((c) => c.status).join(", ") || "none"}.`,
        next: ref === cap && cap !== "0.00" ? "Fully refunded; nothing else to do." : "Use refund to give money back.",
      };
    }
    case "hold": {
      if (!rec.authorizationId) return { answer: `Hold of ${rec.amount} ${cur} is waiting for the buyer to approve on PayPal.`, next: "Send the approval link; call hold again after they approve." };
      const held = fromCents(heldRemainingCents(rec));
      const parts = [`Hold of ${rec.amount} ${cur}: authorization ${rec.authorizationStatus ?? "?"}`, `captured ${cap}`, `still held ${held}`];
      if (ref !== "0.00") parts.push(`refunded ${ref}`);
      if (cap !== "0.00") parts.push(`refundable remaining ${fromCents(Math.max(0, capturedCents(rec) - refundedCents(rec)))}`);
      const exp = (rec as any).authorizationExpires;
      if (exp && held !== "0.00") parts.push(`authorization expires ${exp}`);
      return { answer: parts.join(", ") + ".", next: held !== "0.00" ? "Call capture_hold to TAKE what is held, or void_hold to GIVE IT BACK." : cap !== "0.00" ? "Use refund to give captured money back." : "Nothing left to do." };
    }
    case "payout":
      return { answer: `Payout of ${rec.amount} ${cur} to ${rec.payoutReceiver}: ${rec.state.replace(/^payout_|^batch_/, "").toUpperCase()}.`, next: rec.state === "payout_unclaimed" ? "Recipient has no PayPal account yet; they have 30 days to claim. Use void_hold to recall it." : "Call status again later if it is still pending." };
    case "subscription":
      return {
        answer: `Subscription ${rec.subscriptionId ?? "(not created)"} at ${rec.amount} ${cur}: ${rec.state.replace(/^subscription_/, "").toUpperCase()}${(rec as any).nextBillingTime ? `, next billing ${(rec as any).nextBillingTime}` : ""}.`,
        next: rec.state === "subscription_approval_pending" ? "Send the approval link to the buyer." : rec.state === "subscription_active" ? "Use void_hold to stop it." : "Nothing to do.",
      };
  }
}

/** An orderRef that only reached the policy (needs_approval): report the approval and the exact call to repeat. */
function approvalOnly(ctx: McpalContext, orderRef: string): VerbResult | undefined {
  const a = ctx.ledger.listApprovals().find((x) => x.orderRef === orderRef);
  if (!a) return undefined;
  let original: unknown;
  try {
    const lines = existsSync(ctx.log.path) ? readFileSync(ctx.log.path, "utf8").split("\n").filter(Boolean) : [];
    for (let i = lines.length - 1; i >= 0 && original === undefined; i--) {
      const l = JSON.parse(lines[i]!) as { verb?: string; orderRef?: string; decision?: string; input?: unknown };
      if (l.orderRef === orderRef && l.verb === a.verb && l.decision === "needs_approval") original = l.input;
    }
  } catch {
    /* the log is optional here */
  }
  const next =
    a.status === "approved"
      ? `Approved by a human. Call ${a.verb} again with exactly the original arguments (details.original_call) to finish it.`
      : a.status === "pending"
        ? `Waiting for a human to approve ${a.verb} of ${a.amount} ${a.currency}. Do not retry until they do.`
        : `A human rejected ${a.verb} of ${a.amount} ${a.currency}. Do not retry; tell the user.`;
  return {
    ok: true,
    state: `approval_${a.status}`,
    orderRef,
    amount: a.amount,
    currency: a.currency,
    paypal: { ids: {} },
    next,
    details: {
      answer: `Nothing sent to PayPal yet: ${a.verb} of ${a.amount} ${a.currency} needed a human approval, which is ${a.status}.`,
      approval_id: a.id,
      approval_status: a.status,
      verb: a.verb,
      ...(original !== undefined ? { original_call: original } : {}),
    },
  };
}
