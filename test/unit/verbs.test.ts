import { describe, expect, it } from "vitest";
import { charge, hold, capture_hold, void_hold, refund, pay_out, subscribe, status, createQuote, refundCents } from "../../src/verbs/index.js";
import { verifyDecisionLog } from "../../src/ledger/decision-log.js";
import { handleWebhook } from "../../src/webhooks/verify.js";
import { createMcpServer, TOOL_DESCRIPTIONS } from "../../src/server.js";
import { fakeContext, FakePayPal } from "../helpers/fake-paypal.js";
import { assertOwnOrder } from "../../src/verbs/common.js";

const card = "card_on_file" as const;

describe("charge", () => {
  it("defaults to a payment link: no money moves", async () => {
    const { ctx, fake } = fakeContext();
    const r = await charge({ orderRef: "inv-link", amount: "120.00" }, ctx);
    expect(r).toMatchObject({ ok: true, state: "needs_buyer_approval" });
    expect(r.human_approval_url).toContain("sandbox.paypal.com");
    expect(fake.writes("/capture")).toHaveLength(0);
    expect(fake.calls[0]!.body.payment_source.paypal).toBeTruthy();
    expect(ctx.ledger.spentToday("USD")).toBe(0);
  });

  it("invoice: creates and sends a PayPal invoice to the recipient email, moves no money", async () => {
    const { ctx, fake } = fakeContext();
    const r = await charge({ orderRef: "inv-invoice", amount: "250.00", method: "invoice", customer_email: "buyer@example.com", description: "Logo design" }, ctx);
    expect(r).toMatchObject({ ok: true, state: "invoice_sent" });
    expect(r.paypal.ids.invoice_id).toMatch(/^INV2-/);
    const create = fake.calls.find((c) => c.path === "/v2/invoicing/invoices")!;
    expect(create.body.primary_recipients[0].billing_info.email_address).toBe("buyer@example.com");
    expect(create.body.detail.invoice_number.length).toBeLessThanOrEqual(25);
    expect(fake.writes("/send")).toHaveLength(1);
    expect(fake.writes("/capture")).toHaveLength(0);
    const again = await charge({ orderRef: "inv-invoice", amount: "250.00", method: "invoice", customer_email: "buyer@example.com" }, ctx);
    expect(again.replayed).toBe(true);
    expect(fake.writes("/send")).toHaveLength(1);
    const missing = await charge({ orderRef: "inv-noemail", amount: "5.00", method: "invoice" }, ctx);
    expect(missing.state).toBe("invalid_input");
    const v = await void_hold({ orderRef: "inv-invoice" }, ctx);
    expect(v.state).toBe("cancelled");
  });

  it("card_on_file captures only when asked, and replays on retry", async () => {
    const { ctx, fake } = fakeContext();
    const r1 = await charge({ orderRef: "inv-1", amount: "25.00", method: card }, ctx);
    expect(r1).toMatchObject({ ok: true, state: "captured" });
    const r2 = await charge({ orderRef: "inv-1", amount: "25.00", method: card }, ctx);
    expect(r2).toMatchObject({ ok: true, replayed: true });
    expect(fake.writes("/capture")).toHaveLength(1);
    const r3 = await charge({ orderRef: "inv-1", amount: "30.00", method: card }, ctx);
    expect(r3).toMatchObject({ ok: false, state: "invalid_input" });
  });

  it("payment link is captured when called again after the buyer pays", async () => {
    const { ctx, fake } = fakeContext();
    const r1 = await charge({ orderRef: "inv-2", amount: "10.00" }, ctx);
    fake.orders.get(r1.paypal.ids.order_id as string).status = "APPROVED";
    const r2 = await charge({ orderRef: "inv-2" }, ctx);
    expect(r2).toMatchObject({ ok: true, state: "captured" });
  });

  it("falls back to a payment link when the merchant cannot process cards", async () => {
    const { ctx, fake } = fakeContext();
    fake.cardProcessing = false;
    const r = await charge({ orderRef: "inv-nocard", amount: "10.00", method: card }, ctx);
    expect(r).toMatchObject({ ok: true, state: "needs_buyer_approval" });
    expect(String(r.details?.fallback)).toContain("PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING");
  });

  it("threshold is inclusive (>=)", async () => {
    const { ctx, fake } = fakeContext();
    const r = await charge({ orderRef: "big-500", amount: "500.00", method: card }, ctx);
    expect(r.state).toBe("needs_approval");
    expect(fake.calls).toHaveLength(0);
    ctx.ledger.decideApproval(r.details!.approval_id as string, "approved");
    expect((await charge({ orderRef: "big-500", amount: "500.00", method: card }, ctx)).state).toBe("captured");
    expect((await charge({ orderRef: "small", amount: "499.99", method: card }, ctx)).state).toBe("captured");
  });
});

describe("merchant quotes", () => {
  it("refuses an amount that differs from the quote and uses the quote when amount is omitted", async () => {
    const { ctx, fake } = fakeContext();
    createQuote({ quoteRef: "order-42", amount: "42.50" }, ctx);
    const bad = await charge({ orderRef: "order-42", amount: "1.00", method: card }, ctx);
    expect(bad).toMatchObject({ ok: false, state: "denied" });
    expect(bad.error).toContain("42.50");
    expect(fake.calls).toHaveLength(0);
    const viaRef = await charge({ orderRef: "o-99", quote_ref: "order-42", amount: "1.00", method: card }, ctx);
    expect(viaRef.state).toBe("denied");
    const good = await charge({ orderRef: "order-42", method: card }, ctx);
    expect(good).toMatchObject({ ok: true, state: "captured", amount: "42.50" });
    const unknown = await charge({ orderRef: "o-100", quote_ref: "nope", method: card }, ctx);
    expect(unknown.state).toBe("invalid_input");
    const h = await hold({ orderRef: "h-1", quote_ref: "order-42", amount: "40.00", method: card }, ctx);
    expect(h.state).toBe("denied");
  });
});

describe("hold / capture_hold / void_hold / refund", () => {
  it("authorizes, takes a deposit, capture_hold takes the rest, refunds across both captures", async () => {
    const { ctx, fake } = fakeContext();
    const h = await hold({ orderRef: "book-1", amount: "200.00", deposit: "50.00", method: card }, ctx);
    expect(h).toMatchObject({ ok: true, state: "deposit_captured" });
    expect(h.details?.remaining_held).toBe("150.00");
    expect(h.next).toContain("void_hold");
    expect((await hold({ orderRef: "book-1", amount: "200.00", deposit: "50.00", method: card }, ctx)).replayed).toBe(true);
    expect(fake.writes("/authorizations/").filter((c) => c.path.endsWith("/capture"))).toHaveLength(1);

    expect((await capture_hold({ orderRef: "book-1", amount: "151.00" }, ctx)).state).toBe("invalid_input");
    const cap = await capture_hold({ orderRef: "book-1" }, ctx);
    expect(cap).toMatchObject({ ok: true, state: "captured" });
    expect(cap.details?.captured_now).toBe("150.00");
    expect((await capture_hold({ orderRef: "book-1" }, ctx)).replayed).toBe(true);

    expect((await refund({ orderRef: "book-1", amount: "200.01" }, ctx)).state).toBe("invalid_input");
    const r1 = await refund({ orderRef: "book-1", amount: "170.00" }, ctx);
    expect(r1).toMatchObject({ ok: true, state: "partially_refunded" });
    expect(r1.details?.refund_ids).toHaveLength(2);
    expect((await refund({ orderRef: "book-1", amount: "170.00" }, ctx)).replayed).toBe(true);
    const r2 = await refund({ orderRef: "book-1" }, ctx);
    expect(r2).toMatchObject({ ok: true, state: "refunded" });
    expect(r2.details?.refunded_now).toBe("30.00");
    expect((await refund({ orderRef: "book-1" }, ctx)).replayed).toBe(true);

    const s = await status({ orderRef: "book-1" }, ctx);
    expect(s.details?.answer).toContain("captured 200.00");
    expect(s.details?.refundable_remaining).toBe("0.00");
  });

  it("void_hold gives the held money back", async () => {
    const { ctx } = fakeContext();
    await hold({ orderRef: "book-2", amount: "80.00", deposit: "20.00", method: card }, ctx);
    const v = await void_hold({ orderRef: "book-2" }, ctx);
    expect(v).toMatchObject({ ok: true, state: "voided" });
    expect(v.details?.released_to_buyer).toBe("60.00");
    expect((await void_hold({ orderRef: "book-2" }, ctx)).replayed).toBe(true);
    expect((await capture_hold({ orderRef: "book-2" }, ctx)).ok).toBe(false);
  });

  it("hold defaults to a payment link (nothing held until approval)", async () => {
    const { ctx, fake } = fakeContext();
    const h = await hold({ orderRef: "book-link", amount: "80.00" }, ctx);
    expect(h.state).toBe("needs_buyer_approval");
    expect(fake.writes("/authorize")).toHaveLength(0);
  });

  it("falls back to split orders when partial capture is refused", async () => {
    const { ctx, fake } = fakeContext();
    fake.allowPartialCapture = false;
    const h = await hold({ orderRef: "book-3", amount: "100.00", deposit: "30.00", method: card }, ctx);
    expect(String(h.details?.fallback)).toContain("split-order fallback");
    expect(h.details?.remaining_held).toBe("70.00");
    expect((await capture_hold({ orderRef: "book-3" }, ctx)).details?.captured_now).toBe("70.00");
  });

  it("fraction / percent are computed in code against the captured amount", async () => {
    const { ctx } = fakeContext();
    expect(refundCents(8000, { fraction: 0.5 })).toBe(4000);
    expect(refundCents(8000, { percent: 25 })).toBe(2000);
    expect(refundCents(1001, { fraction: 1 / 3 })).toBe(334);
    expect(() => refundCents(8000, { fraction: 0.5, amount: "1.00" })).toThrow();
    await charge({ orderRef: "inv-80", amount: "80.00", method: card }, ctx);
    const half = await refund({ orderRef: "inv-80", fraction: 0.5 }, ctx);
    expect(half.details?.refunded_now).toBe("40.00");
    expect(half.details?.refundable_remaining).toBe("40.00");
    const pct = await refund({ orderRef: "inv-80", percent: 25 }, ctx);
    expect(pct.details?.refunded_now).toBe("20.00");
    const s = await status({ orderRef: "inv-80" }, ctx);
    expect(s.details?.refundable_remaining).toBe("20.00");
  });

  it("a second refund of the same amount needs confirm_additional and, within 10 minutes, a human", async () => {
    const { ctx, fake } = fakeContext();
    await charge({ orderRef: "inv-rep", amount: "30.00", method: card }, ctx);
    await refund({ orderRef: "inv-rep", amount: "10.00" }, ctx);
    const retry = await refund({ orderRef: "inv-rep", amount: "10.00" }, ctx);
    expect(retry.replayed).toBe(true);
    const rep = await refund({ orderRef: "inv-rep", amount: "10.00", confirm_additional: true }, ctx);
    expect(rep.state).toBe("needs_approval");
    expect(fake.writes("/refund")).toHaveLength(1);
    ctx.ledger.decideApproval(rep.details!.approval_id as string, "approved");
    const ok = await refund({ orderRef: "inv-rep", amount: "10.00", confirm_additional: true }, ctx);
    expect(ok).toMatchObject({ ok: true, state: "partially_refunded" });
    expect(fake.writes("/refund")).toHaveLength(2);
    // repeat of that approved repeat is a replay unless confirmed again
    expect((await refund({ orderRef: "inv-rep", amount: "10.00" }, ctx)).replayed).toBe(true);
  });

  it("refund ceiling (>=) asks a human", async () => {
    const { ctx } = fakeContext({ refund_ceiling: "20.00" });
    await charge({ orderRef: "inv-r", amount: "20.00", method: card }, ctx);
    expect((await refund({ orderRef: "inv-r" }, ctx)).state).toBe("needs_approval");
  });

  it("refund schema has no recipient: money only goes back to the original capture", () => {
    const { ctx } = fakeContext();
    const server = createMcpServer(ctx);
    const props = Object.keys((server as any)._registeredTools.refund.inputSchema.shape);
    expect(props.sort()).toEqual(["amount", "confirm_additional", "fraction", "orderRef", "percent", "reason"]);
  });
});

describe("pay_out / subscribe", () => {
  it("pays an allowlisted recipient once per orderRef", async () => {
    const { ctx, fake } = fakeContext();
    const p = await pay_out({ orderRef: "po-1", to: "seller@example.com", amount: "12.00" }, ctx);
    expect(p).toMatchObject({ ok: true, state: "payout_success" });
    expect(fake.calls[0]!.body.items[0].amount).toEqual({ value: "12.00", currency: "USD" });
    expect((await pay_out({ orderRef: "po-1", to: "seller@example.com", amount: "12.00" }, ctx)).replayed).toBe(true);
    expect(fake.writes("/v1/payments/payouts")).toHaveLength(1);
  });

  it("a never-paid recipient always needs a human, any amount", async () => {
    const { ctx, fake } = fakeContext();
    const p = await pay_out({ orderRef: "po-x", to: "attacker@evil.example", amount: "1.00" }, ctx);
    expect(p.state).toBe("needs_approval");
    expect(p.error).toContain("never been paid");
    expect(fake.calls).toHaveLength(0);
    ctx.ledger.decideApproval(p.details!.approval_id as string, "approved");
    const ok = await pay_out({ orderRef: "po-x", to: "attacker@evil.example", amount: "1.00" }, ctx);
    expect(ok.state).toBe("payout_success");
    // now a known recipient (previous successful payout)
    const next = await pay_out({ orderRef: "po-y", to: "attacker@evil.example", amount: "2.00" }, ctx);
    expect(next.state).toBe("payout_success");
  });

  it("daily cap blocks", async () => {
    const { ctx } = fakeContext({ daily_cap: "15.00" });
    await pay_out({ orderRef: "po-2", to: "a@example.com", amount: "10.00" }, ctx);
    expect((await pay_out({ orderRef: "po-3", to: "a@example.com", amount: "10.00" }, ctx)).state).toBe("denied");
  });

  it("subscribes (new plan, card) and cancels with void_hold", async () => {
    const { ctx } = fakeContext();
    const s = await subscribe({ orderRef: "sub-1", name: "Pro", amount: "9.99", interval: "MONTH", method: card }, ctx);
    expect(s).toMatchObject({ ok: true, state: "subscription_active" });
    expect((await void_hold({ orderRef: "sub-1" }, ctx)).state).toBe("cancelled");
  });

  it("subscribes to an existing plan_id and checks its price", async () => {
    const { ctx, fake } = fakeContext();
    const first = await subscribe({ orderRef: "sub-a", name: "Pro", amount: "9.99", method: card }, ctx);
    const planId = first.paypal.ids.plan_id as string;
    const before = fake.writes("/v1/billing/plans").length;
    const s = await subscribe({ orderRef: "sub-b", plan_id: planId }, ctx);
    expect(s).toMatchObject({ ok: true, state: "subscription_approval_pending", amount: "9.99" });
    expect(s.paypal.ids.plan_id).toBe(planId);
    expect(fake.writes("/v1/billing/plans")).toHaveLength(before);
    expect(fake.writes("/v1/catalogs/products")).toHaveLength(1);
    const bad = await subscribe({ orderRef: "sub-c", plan_id: planId, amount: "1.00" }, ctx);
    expect(bad.state).toBe("denied");
  });
});

describe("decision log + webhooks + server", () => {
  it("logs every call in a valid chain", async () => {
    const { ctx } = fakeContext();
    await charge({ orderRef: "inv-l", amount: "1.00", method: card }, ctx);
    await charge({ orderRef: "inv-l", amount: "1.00", method: card }, ctx);
    await status({ orderRef: "nope" }, ctx);
    expect(verifyDecisionLog(ctx.log.path)).toMatchObject({ ok: true, count: 3 });
  });

  it("verifies and dedupes webhooks by transmission id", async () => {
    const { ctx } = fakeContext();
    const c = await charge({ orderRef: "inv-w", amount: "3.00", method: card }, ctx);
    const capId = (c.paypal.ids.capture_ids as string[])[0];
    const raw = JSON.stringify({ id: "WH-EV1", event_type: "PAYMENT.CAPTURE.COMPLETED", summary: "done", resource: { id: capId, status: "COMPLETED", custom_id: "inv-w" } });
    const headers = { "paypal-transmission-id": "tx-1", "paypal-transmission-time": "t", "paypal-transmission-sig": "s", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA" };
    expect(await handleWebhook(ctx, raw, headers)).toMatchObject({ status: "verified", orderRef: "inv-w" });
    expect((await handleWebhook(ctx, raw, headers)).status).toBe("duplicate");
    const s = await status({ orderRef: "inv-w" }, ctx);
    expect((s.details?.last_webhook as any).type).toBe("PAYMENT.CAPTURE.COMPLETED");
  });

  it("registers exactly the 8 verbs, with no attempt_key and the take/give-back wording", async () => {
    const { ctx } = fakeContext();
    const server = createMcpServer(ctx);
    const tools = (server as any)._registeredTools;
    const names = Object.keys(tools).sort();
    expect(names).toEqual(["capture_hold", "charge", "hold", "pay_out", "refund", "status", "subscribe", "void_hold"]);
    expect(names).toEqual(Object.keys(TOOL_DESCRIPTIONS).sort());
    for (const n of names) expect(Object.keys(tools[n].inputSchema.shape)).not.toContain("attempt_key");
    expect(TOOL_DESCRIPTIONS.capture_hold).toContain("TAKE");
    expect(TOOL_DESCRIPTIONS.void_hold).toContain("GIVE IT BACK");
    expect(TOOL_DESCRIPTIONS.hold).toContain("capture_hold TAKES the money; void_hold GIVES IT BACK to the buyer");
  });
});

describe("idempotency scope (per install + ledger + merchant)", () => {
  it("the same generic orderRef in two installs creates two real payments, not a replay", async () => {
    const paypal = new FakePayPal(); // one PayPal account remembering request ids across both installs
    const a = fakeContext({}, paypal);
    const b = fakeContext({}, paypal);
    expect(a.ctx.salt).not.toBe(b.ctx.salt);
    const ra = await charge({ orderRef: "order", amount: "42.00", method: card }, a.ctx);
    const rb = await charge({ orderRef: "order", amount: "42.00", method: card }, b.ctx);
    expect(ra.state).toBe("captured");
    expect(rb.state).toBe("captured");
    expect(rb.paypal.ids.order_id).not.toBe(ra.paypal.ids.order_id);
    expect(paypal.writes("/capture")).toHaveLength(2);
  });

  it("same-ledger retries still replay", async () => {
    const { ctx, fake } = fakeContext();
    await charge({ orderRef: "order", amount: "42.00", method: card }, ctx);
    const again = await charge({ orderRef: "order", amount: "42.00", method: card }, ctx);
    expect(again.replayed).toBe(true);
    expect(fake.writes("/capture")).toHaveLength(1);
  });

  it("install id is persisted in the data dir and reused", async () => {
    const { ctx, dir } = fakeContext();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(`${dir}/install-id`, "utf8").trim()).toBe(ctx.installId);
    const { loadInstallId } = await import("../../src/context.js");
    expect(loadInstallId(dir)).toBe(ctx.installId);
  });

  it("an orderRef reused for a different amount or buyer is refused with a unique suggestion", async () => {
    const { ctx, fake } = fakeContext();
    await charge({ orderRef: "order-DanaRuiz-001", amount: "42.00", method: card }, ctx);
    const other = await charge({ orderRef: "order-DanaRuiz-001", amount: "55.00", method: card }, ctx);
    expect(other.state).toBe("invalid_input");
    expect(other.error).toMatch(/unique orderRef such as "order-DanaRuiz-001-[0-9a-f]{6}"/);
    await charge({ orderRef: "inv-buyer", amount: "10.00", method: "invoice", customer_email: "a@example.com" }, ctx);
    const otherBuyer = await charge({ orderRef: "inv-buyer", amount: "10.00", method: "invoice", customer_email: "b@example.com" }, ctx);
    expect(otherBuyer.state).toBe("invalid_input");
    expect(otherBuyer.error).toContain("different buyer");
    expect(fake.writes("/capture")).toHaveLength(1);
  });

  it("refuses an order PayPal replayed from outside this ledger", () => {
    const rec = { orderRef: "order", createdAt: new Date().toISOString() } as any;
    const old = { id: "OLD1", create_time: new Date(Date.now() - 3600_000).toISOString(), purchase_units: [{ custom_id: "order" }] };
    expect(() => assertOwnOrder(rec, old)).toThrow(/already used outside this MCPal ledger/);
    const otherRef = { id: "OLD2", create_time: new Date().toISOString(), purchase_units: [{ custom_id: "someone-else" }] };
    expect(() => assertOwnOrder(rec, otherRef)).toThrow(/unique orderRef/);
    expect(() => assertOwnOrder(rec, { id: "NEW", create_time: new Date().toISOString(), purchase_units: [{ custom_id: "order" }] })).not.toThrow();
  });
});
