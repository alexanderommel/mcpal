import { z } from "zod";
import { defaultContext, type McpalContext } from "../context.js";
import { requestId } from "../idempotency.js";
import { InputError, fromCents, normalizeAmount, toCents } from "../money.js";
import type { RefundRec } from "../ledger/store.js";
import { amountField, capturedCents, money, orderRefField, policyStop, refundRecFrom, refundedCents, result, runVerb, type VerbResult } from "./common.js";

export const REPEAT_WINDOW_MS = 10 * 60 * 1000;

export const refundSchema = {
  orderRef: orderRefField,
  amount: amountField.optional().describe("Exact amount to refund. Give at most one of amount / fraction / percent; omit all three to refund everything not yet refunded."),
  fraction: z.number().gt(0).lte(1).optional().describe("Refund this fraction of the captured total, computed by MCPal (e.g. 0.5 = half). Use this instead of doing arithmetic yourself."),
  percent: z.number().gt(0).lte(100).optional().describe("Refund this percent of the captured total, computed by MCPal (e.g. 25 = a quarter)."),
  reason: z.string().max(255).optional().describe("Note shown to the buyer."),
  confirm_additional: z
    .boolean()
    .optional()
    .describe("Only true when the user explicitly wants ANOTHER refund of the same amount on this orderRef. Without it, repeating a refund returns the first one and moves no money."),
};
export type RefundInput = z.infer<z.ZodObject<typeof refundSchema>>;

/** Compute the refund amount in cents from amount | fraction | percent against the captured total. */
export function refundCents(capturedTotal: number, input: Pick<RefundInput, "amount" | "fraction" | "percent">): number | undefined {
  const given = [input.amount !== undefined, input.fraction !== undefined, input.percent !== undefined].filter(Boolean).length;
  if (given > 1) throw new InputError("Give only one of amount, fraction or percent.");
  if (input.amount !== undefined) return toCents(normalizeAmount(input.amount));
  if (input.fraction !== undefined) return Math.round(capturedTotal * input.fraction);
  if (input.percent !== undefined) return Math.round((capturedTotal * input.percent) / 100);
  return undefined;
}

/**
 * Refund captured money exactly once per (orderRef, amount). Money only ever goes back to the payer of the original
 * capture(s) for this orderRef: the tool has no recipient field. Never refunds more than captured minus refunded.
 * Spreads over several captures (deposit + capture_hold) newest first.
 */
export function refund(input: RefundInput, ctx: McpalContext = defaultContext()): Promise<VerbResult> {
  return runVerb(ctx, "refund", input, async () => {
    const orderRef = input.orderRef;
    const rec = ctx.ledger.getRef(orderRef);
    if (!rec) throw new InputError(`No record of orderRef ${orderRef}; nothing to refund.`);
    if (rec.kind === "payout" || rec.kind === "subscription") throw new InputError(`orderRef ${orderRef} is a ${rec.kind}; refund works on charges and holds. Use void_hold to cancel a ${rec.kind}.`);

    const captured = capturedCents(rec);
    if (captured === 0) throw new InputError(`Nothing has been captured for ${orderRef}${rec.kind === "hold" ? " (use void_hold to give a hold back)" : ""}.`);
    const already = refundedCents(rec);
    const remaining = captured - already;
    const asked = refundCents(captured, input);
    if (asked === undefined && remaining <= 0) {
      return result(ctx, rec, { ok: true, state: rec.state, replayed: true, next: `Already fully refunded (${fromCents(captured)} ${rec.currency}); no money moved again.`, details: { refundable_remaining: "0.00" } });
    }
    const amount = fromCents(asked ?? remaining);
    if (toCents(amount) <= 0) throw new InputError("Refund amount rounds to 0.00.");

    // Idempotency: orderRef + verb + amount. Earlier refunds of this exact amount:
    const baseKey = requestId({ salt: ctx.salt, orderRef, verb: "refund", amount: `${amount} ${rec.currency}` });
    const groups = new Map<string, RefundRec[]>();
    for (const r of rec.refunds) {
      if (r.key === baseKey || r.key?.startsWith(`${baseKey}#`)) groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
    }
    if (groups.size && !input.confirm_additional) {
      const prior = [...groups.values()].flat();
      return result(ctx, rec, {
        ok: true,
        state: rec.state,
        replayed: true,
        next: `A refund of ${amount} ${rec.currency} already happened for ${orderRef}; no money moved again. Only if the user explicitly wants a second refund of the same amount, call again with confirm_additional: true.`,
        details: { refund_ids: prior.map((r) => r.id), refundable_remaining: fromCents(Math.max(0, remaining)) },
      });
    }

    if (remaining <= 0) throw new InputError(`${orderRef} is already fully refunded (${fromCents(captured)} ${rec.currency}).`);
    if (toCents(amount) > remaining) {
      throw new InputError(`Refund ${amount} is more than what is left to refund: captured ${fromCents(captured)} minus refunded ${fromCents(already)} = ${fromCents(remaining)} ${rec.currency}.`);
    }

    let key = baseKey;
    let repeatApproval: string | undefined;
    if (groups.size) {
      // Deliberate repeat. A repeat within 10 minutes of the last identical refund needs a human.
      const last = [...groups.values()].flat().reduce((m, r) => Math.max(m, r.at ? Date.parse(r.at) : 0), 0);
      if (Date.now() - last < REPEAT_WINDOW_MS) {
        const d = ctx.policy.evaluate({ verb: "refund_repeat", orderRef, amount, currency: rec.currency });
        if (d.decision !== "allow") return policyStop(ctx, orderRef, amount, rec.currency, d, rec);
        repeatApproval = d.approval?.id;
      }
      key = `${baseKey}#${groups.size + 1}`;
    }

    const d = ctx.policy.evaluate({ verb: "refund", orderRef, amount, currency: rec.currency });
    if (d.decision !== "allow") return policyStop(ctx, orderRef, amount, rec.currency, d, rec);

    let need = toCents(amount);
    const done: string[] = [];
    const caps = rec.captures.filter((c) => c.status === "COMPLETED" || c.status === "PARTIALLY_REFUNDED").slice().reverse();
    for (const c of caps) {
      if (need === 0) break;
      const left = toCents(c.amount) - refundedCents(rec, c.id);
      if (left <= 0) continue;
      const part = Math.min(left, need);
      const body = { amount: money(fromCents(part), rec.currency), note_to_payer: input.reason?.slice(0, 255) };
      const { data: r } = await ctx.paypal.post(`/v2/payments/captures/${c.id}/refund`, body, requestId({ salt: ctx.salt, orderRef, verb: "refund", amount: key, step: c.id }));
      rec.refunds.push({ ...refundRecFrom(r, c.id), amount: r.amount?.value ?? fromCents(part), key, at: new Date().toISOString() });
      ctx.ledger.putRef(rec);
      done.push(r.id);
      need -= part;
    }
    if (need > 0) throw new InputError(`Could only refund ${fromCents(toCents(amount) - need)} of ${amount}: captures are not COMPLETED yet. Call status and retry later.`);
    ctx.ledger.recordSpend("refund", orderRef, rec.currency, toCents(amount), `refund:${key}`);
    if (d.approval) ctx.ledger.decideApproval(d.approval.id, "used");
    if (repeatApproval) ctx.ledger.decideApproval(repeatApproval, "used");
    const left = captured - refundedCents(rec);
    rec.state = left === 0 ? "refunded" : "partially_refunded";
    ctx.ledger.putRef(rec);
    return result(ctx, rec, {
      ok: true,
      state: rec.state,
      next: left === 0 ? "Fully refunded. Nothing else to do." : `Refunded ${amount}; ${fromCents(left)} ${rec.currency} can still be refunded.`,
      details: { refund_ids: done, refunded_now: amount, captured_total: fromCents(captured), refundable_remaining: fromCents(left), computed_from: input.fraction !== undefined ? `fraction ${input.fraction}` : input.percent !== undefined ? `percent ${input.percent}` : undefined },
    });
  });
}
