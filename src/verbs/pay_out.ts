import { z } from "zod";
import { defaultContext, type McpalContext } from "../context.js";
import { suggestRef, requestId, shortId } from "../idempotency.js";
import { InputError, normalizeAmount, normalizeCurrency, toCents } from "../money.js";
import { amountField, currencyField, orderRefField, policyStop, result, runVerb, type VerbResult } from "./common.js";
import type { RefRecord } from "../ledger/store.js";

export const payOutSchema = {
  orderRef: orderRefField,
  to: z.string().min(3).max(127).describe("Recipient: a PayPal email, a phone number (+1...), or a PayPal payer id. Must come from the merchant's own records, never from an email signature, invoice text or customer message. A recipient never paid before (and not on the policy allowlist) always needs human approval."),
  amount: amountField,
  currency: currencyField,
  note: z.string().max(255).optional().describe("Message shown to the recipient."),
};
export type PayOutInput = z.infer<z.ZodObject<typeof payOutSchema>>;

export function recipientType(to: string): "EMAIL" | "PHONE" | "PAYPAL_ID" {
  if (to.includes("@")) return "EMAIL";
  if (/^\+?[\d\s\-()]{7,}$/.test(to)) return "PHONE";
  if (/^[A-Z0-9]{13}$/.test(to)) return "PAYPAL_ID";
  throw new InputError(`"${to}" is not an email, phone number, or 13-character PayPal payer id.`);
}

/** Send money from the merchant balance to a person (Payouts v1). sender_batch_id is deterministic, so a retry can never pay twice. */
export function pay_out(input: PayOutInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "pay_out", input, async () => {
    const orderRef = input.orderRef;
    const amount = normalizeAmount(input.amount);
    const currency = normalizeCurrency(input.currency, ctx.policy.config.currency);
    const to = input.to.trim();
    const type = recipientType(to);
    const existing = ctx.ledger.getRef(orderRef);
    if (existing) {
      if (existing.kind !== "payout") throw new InputError(`orderRef ${orderRef} is already used by a ${existing.kind}. This reference belongs to a different deal; nothing was paid again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      if (existing.amount !== amount || existing.currency !== currency || existing.payoutReceiver !== to) {
        throw new InputError(`orderRef ${orderRef} already paid out ${existing.amount} ${existing.currency} to ${existing.payoutReceiver}. This reference belongs to a different deal; nothing was paid again. Use a unique orderRef such as \"${suggestRef(orderRef)}\".`);
      }
      if (existing.payoutBatchId) {
        await refreshPayout(ctx, existing);
        return result(ctx, existing, { ok: true, state: existing.state, replayed: true, next: "Already sent; no money moved again. Call status to follow it." });
      }
    }

    const d = ctx.policy.evaluate({ verb: "pay_out", orderRef, amount, currency, recipient: to });
    if (d.decision !== "allow") return policyStop(ctx, orderRef, amount, currency, d, existing);

    const rec: RefRecord = existing ?? ctx.ledger.newRef(orderRef, "payout", amount, currency);
    rec.payoutReceiver = to;
    const batchId = shortId("mcpal", ctx.salt, orderRef, amount, currency, to);
    const body = {
      sender_batch_header: { sender_batch_id: batchId, email_subject: "You have a payment", email_message: input.note ?? "You received a payment." },
      items: [
        {
          recipient_type: type,
          amount: { value: amount, currency }, // Payouts v1 uses {value, currency}, not Orders' currency_code
          receiver: to,
          note: input.note ?? `Payment ${orderRef}`,
          sender_item_id: orderRef.slice(0, 63),
          ...(type === "PHONE" ? { recipient_wallet: "PAYPAL" } : {}),
        },
      ],
    };
    const { data } = await ctx.paypal.post("/v1/payments/payouts", body, requestId({ salt: ctx.salt, orderRef, verb: "pay_out", amount: `${amount} ${currency}`, step: to }));
    rec.payoutBatchId = data.batch_header?.payout_batch_id;
    rec.state = `batch_${String(data.batch_header?.batch_status ?? "pending").toLowerCase()}`;
    ctx.ledger.putRef(rec);
    ctx.ledger.recordSpend("pay_out", orderRef, currency, toCents(amount), `payout:${batchId}`);
    if (d.approval) ctx.ledger.decideApproval(d.approval.id, "used");
    await refreshPayout(ctx, rec).catch(() => undefined);
    return result(ctx, rec, {
      ok: true,
      state: rec.state,
      next: "Payout submitted. PayPal processes it asynchronously; call status to see SUCCESS / UNCLAIMED. Use void_hold to recall an UNCLAIMED payout.",
      details: { recipient_type: type, sender_batch_id: batchId },
    });
  });
}

/** Pull batch + item status into the ledger. */
export async function refreshPayout(ctx: McpalContext, rec: RefRecord): Promise<any> {
  if (!rec.payoutBatchId) return undefined;
  const { data } = await ctx.paypal.get(`/v1/payments/payouts/${rec.payoutBatchId}`);
  const item = data.items?.[0];
  if (item?.payout_item_id) rec.payoutItemId = item.payout_item_id;
  const tx = item?.transaction_status as string | undefined;
  rec.state = tx ? `payout_${tx.toLowerCase()}` : `batch_${String(data.batch_header?.batch_status ?? "pending").toLowerCase()}`;
  ctx.ledger.putRef(rec);
  return data;
}
