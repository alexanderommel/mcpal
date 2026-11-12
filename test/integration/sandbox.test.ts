/**
 * Real PayPal sandbox integration tests. Run only when ~/paypal-hackathon-research/.env.paypal-sandbox exists
 * (or MCPAL_PAYPAL_ENV_FILE points to a file with PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).
 *   npm run test:sandbox
 * Prints the PayPal ids each verb produced and writes docs/sandbox-proof.json.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX_ENV_FILE, loadEnvFile } from "../../src/config.js";
import { createContext, type McpalContext } from "../../src/context.js";
import { charge, hold, capture_hold, void_hold, refund, pay_out, subscribe, status, createQuote, type VerbResult } from "../../src/verbs/index.js";
import { requestId } from "../../src/idempotency.js";
import { verifyDecisionLog } from "../../src/ledger/decision-log.js";

const envFile = process.env.MCPAL_PAYPAL_ENV_FILE ?? DEFAULT_SANDBOX_ENV_FILE;
const enabled = existsSync(envFile);
if (enabled) loadEnvFile(envFile);
const run = `it${Date.now().toString(36)}`;
const proof: Record<string, unknown> = {};
const card = "card_on_file" as const;

function skipIfNoCard(c: { skip: (note?: string) => void }, r: VerbResult) {
  if (String(r.details?.fallback ?? "").includes("cannot process cards")) {
    proof.card_processing = "unavailable on this sandbox merchant (fell back to payment_link)";
    c.skip("merchant cannot process cards");
  }
}

function show(label: string, r: VerbResult) {
  proof[label] = { ok: r.ok, state: r.state, ids: r.paypal.ids, debug_id: r.paypal.debug_id, error: r.error, details: r.details, human_approval_url: r.human_approval_url };
  console.log(`[sandbox] ${label}: ok=${r.ok} state=${r.state} ids=${JSON.stringify(r.paypal.ids)} debug_id=${r.paypal.debug_id ?? "-"}${r.error ? ` error=${r.error}` : ""}`);
}

function approve(ctx: McpalContext, r: VerbResult) {
  ctx.ledger.decideApproval(r.details!.approval_id as string, "approved");
}

describe.skipIf(!enabled)("PayPal sandbox", () => {
  let ctx: McpalContext;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "mcpal-sandbox-"));
    ctx = createContext({
      config: { dataDir: dir, policyFile: join(dir, "none.json"), paypalEnv: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com" },
      policy: { approval_threshold: "5000.00", daily_cap: "100000.00", refund_ceiling: "5000.00", payout_allowlist: [] },
    });
  });

  it("charge: default is a payment link (no money moves)", async () => {
    const r = await charge({ orderRef: `${run}-link`, amount: "120.00" }, ctx);
    show("fix4 charge default payment_link", r);
    expect(r.state).toBe("needs_buyer_approval");
    expect(r.human_approval_url).toMatch(/paypal\.com/);
    expect(r.paypal.ids.capture_ids).toBeUndefined();
  });

  it("charge: invoice is created and sent (Invoicing v2)", async () => {
    const email = process.env.PAYPAL_BUYER_EMAIL ?? "buyer@example.com";
    const r = await charge({ orderRef: `${run}-invoice`, amount: "250.00", method: "invoice", customer_email: email, description: "MCPal sandbox invoice" }, ctx);
    show("fix4 charge invoice", r);
    expect(r.ok, r.error).toBe(true);
    expect(r.state).toBe("invoice_sent");
    expect(r.paypal.ids.invoice_id).toBeTruthy();
    expect(r.paypal.ids.capture_ids).toBeUndefined();
    const v = await void_hold({ orderRef: `${run}-invoice` }, ctx);
    show("fix4 invoice cancelled via void_hold", v);
  });

  it("charge: card_on_file when explicitly asked, then replay", async (c) => {
    const r = await charge({ orderRef: `${run}-charge`, amount: "12.34", method: card, description: "MCPal sandbox charge" }, ctx);
    show("charge card_on_file", r);
    skipIfNoCard(c, r);
    expect(r.state).toBe("captured");
    const again = await charge({ orderRef: `${run}-charge`, amount: "12.34", method: card }, ctx);
    show("charge replay", again);
    expect(again.replayed).toBe(true);
    expect(again.paypal.ids.capture_ids).toEqual(r.paypal.ids.capture_ids);
  });

  it("threshold is inclusive: exactly the threshold needs approval", async () => {
    const strict = createContext({
      config: { ...ctx.config },
      ledger: ctx.ledger,
      log: ctx.log,
      policy: { approval_threshold: "500.00", daily_cap: "100000.00", refund_ceiling: "5000.00", payout_allowlist: [] },
    });
    const r = await charge({ orderRef: `${run}-500`, amount: "500.00", method: card }, strict);
    show("fix2 charge 500.00 at threshold", r);
    expect(r.state).toBe("needs_approval");
  });

  it("quote check: injected price is refused, quoted price is charged", async (c) => {
    createQuote({ quoteRef: `${run}-q42`, amount: "42.50", description: "Widget" }, ctx);
    const bad = await charge({ orderRef: `${run}-q42`, amount: "1.00", method: card }, ctx);
    show("fix3 charge injected 1.00 vs quote 42.50", bad);
    expect(bad.state).toBe("denied");
    const good = await charge({ orderRef: `${run}-q42`, method: card }, ctx);
    show("fix3 charge from quote", good);
    skipIfNoCard(c, good);
    expect(good.amount).toBe("42.50");
    expect(good.state).toBe("captured");
  });

  it("same PayPal-Request-Id returns the same order (PayPal idempotency)", async () => {
    const rid = requestId({ orderRef: `${run}-raw`, verb: "probe" });
    const body = { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] };
    const a = await ctx.paypal.post("/v2/checkout/orders", body, rid);
    const b = await ctx.paypal.post("/v2/checkout/orders", body, rid);
    console.log(`[sandbox] request-id replay: ${a.data.id} vs ${b.data.id}`);
    expect(b.data.id).toBe(a.data.id);
  });

  it("hold with deposit, capture_hold, refund across captures", async (c) => {
    const ref = `${run}-hold`;
    const h = await hold({ orderRef: ref, amount: "100.00", deposit: "25.00", method: card, description: "MCPal sandbox hold" }, ctx);
    show("hold", h);
    skipIfNoCard(c, h);
    expect(h.details?.remaining_held).toBe("75.00");
    const cap = await capture_hold({ orderRef: ref }, ctx);
    show("fix1 capture_hold", cap);
    expect(cap.ok, cap.error).toBe(true);
    const rf = await refund({ orderRef: ref, amount: "80.00", reason: "MCPal test" }, ctx);
    show("refund partial", rf);
    expect(rf.ok, rf.error).toBe(true);
    expect((await refund({ orderRef: ref, amount: "80.00" }, ctx)).replayed).toBe(true);
    expect((await refund({ orderRef: ref, amount: "20.01" }, ctx)).state).toBe("invalid_input");
    const rest = await refund({ orderRef: ref }, ctx);
    show("refund rest", rest);
    expect(rest.state).toBe("refunded");
    const s = await status({ orderRef: ref }, ctx);
    show("status hold", s);
  });

  it("multiple partial captures on one authorization (probe)", async (c) => {
    const ref = `${run}-multi`;
    const h = await hold({ orderRef: ref, amount: "90.00", deposit: "10.00", method: card }, ctx);
    show("multi hold", h);
    skipIfNoCard(c, h);
    const authId = h.paypal.ids.authorization_id as string;
    let second: any;
    let err: any;
    try {
      second = (await ctx.paypal.post(`/v2/payments/authorizations/${authId}/capture`, { amount: { currency_code: "USD", value: "20.00" }, final_capture: false }, requestId({ orderRef: ref, verb: "probe", step: "2nd" }))).data;
    } catch (e) {
      err = e;
    }
    if (second) {
      const rec = ctx.ledger.getRef(ref)!;
      rec.captures.push({ id: second.id, amount: "20.00", status: second.status, final: false, orderId: rec.orderId });
      ctx.ledger.putRef(rec);
    }
    proof["multiple_partial_captures"] = { fallback_used_for_first_partial: h.details?.fallback ?? null, second_partial_capture: second ? { id: second.id, status: second.status } : { error: err?.message, issue: err?.issue } };
    const cap = await capture_hold({ orderRef: ref }, ctx);
    show("multi capture_hold", cap);
    expect(cap.ok, cap.error).toBe(true);
    expect(cap.details?.captured_now).toBe(second ? "60.00" : "80.00");
  });

  it("void_hold gives the hold back", async (c) => {
    const ref = `${run}-void`;
    const h = await hold({ orderRef: ref, amount: "40.00", method: card }, ctx);
    show("hold for void", h);
    skipIfNoCard(c, h);
    const v = await void_hold({ orderRef: ref, reason: "test" }, ctx);
    show("fix1 void_hold", v);
    expect(v.state).toBe("voided");
    expect(v.details?.authorization_status).toBe("VOIDED");
  });

  it("refund fraction (half of 80.00) and refundable_remaining", async (c) => {
    const ref = `${run}-80`;
    const ch = await charge({ orderRef: ref, amount: "80.00", method: card }, ctx);
    show("charge 80", ch);
    skipIfNoCard(c, ch);
    const half = await refund({ orderRef: ref, fraction: 0.5 }, ctx);
    show("fix5 refund fraction 0.5", half);
    expect(half.details?.refunded_now).toBe("40.00");
    const s = await status({ orderRef: ref }, ctx);
    show("fix5 status refundable_remaining", s);
    expect(s.details?.refundable_remaining).toBe("40.00");
  });

  it("repeat refund needs confirm_additional and a human within 10 minutes", async (c) => {
    const ref = `${run}-rep`;
    const ch = await charge({ orderRef: ref, amount: "30.00", method: card }, ctx);
    skipIfNoCard(c, ch);
    const r1 = await refund({ orderRef: ref, amount: "10.00" }, ctx);
    show("fix6 refund 10.00", r1);
    const retry = await refund({ orderRef: ref, amount: "10.00" }, ctx);
    show("fix6 refund retry (replay)", retry);
    expect(retry.replayed).toBe(true);
    const rep = await refund({ orderRef: ref, amount: "10.00", confirm_additional: true }, ctx);
    show("fix6 refund confirm_additional within 10 min", rep);
    expect(rep.state).toBe("needs_approval");
    approve(ctx, rep);
    const r2 = await refund({ orderRef: ref, amount: "10.00", confirm_additional: true }, ctx);
    show("fix6 second refund after human approval", r2);
    expect(r2.ok, r2.error).toBe(true);
    expect((r2.details?.refund_ids as string[])[0]).not.toBe((r1.details?.refund_ids as string[])[0]);
  });

  it("pay_out: a new recipient needs a human; after approval it pays once", async (c) => {
    const to = process.env.PAYPAL_BUYER_EMAIL ?? "mcpal-recipient@example.com";
    const ref = `${run}-payout`;
    const p0 = await pay_out({ orderRef: ref, to, amount: "3.21", note: "MCPal sandbox payout" }, ctx);
    show("fix2 pay_out new recipient", p0);
    expect(p0.state).toBe("needs_approval");
    approve(ctx, p0);
    const r = await pay_out({ orderRef: ref, to, amount: "3.21", note: "MCPal sandbox payout" }, ctx);
    show("pay_out after approval", r);
    if (r.error?.includes("INSUFFICIENT_FUNDS")) {
      proof.payout_balance = "sandbox business account has no balance left for payouts (INSUFFICIENT_FUNDS); add funds in the sandbox dashboard";
      c.skip("sandbox business account out of payout balance");
    }
    expect(r.ok, r.error).toBe(true);
    const again = await pay_out({ orderRef: ref, to, amount: "3.21" }, ctx);
    expect(again.replayed).toBe(true);
    expect(again.paypal.ids.payout_batch_id).toBe(r.paypal.ids.payout_batch_id);
  });

  it("subscribe: new plan, then an existing plan_id, then void_hold", async () => {
    const r = await subscribe({ orderRef: `${run}-sub`, name: "MCPal Pro", amount: "9.99", interval: "MONTH", method: card }, ctx);
    show("subscribe new plan", r);
    expect(r.ok, r.error).toBe(true);
    const planId = r.paypal.ids.plan_id as string;
    const r2 = await subscribe({ orderRef: `${run}-sub2`, plan_id: planId }, ctx);
    show("fix7 subscribe existing plan_id", r2);
    expect(r2.ok, r2.error).toBe(true);
    expect(r2.paypal.ids.plan_id).toBe(planId);
    expect(r2.amount).toBe("9.99");
    const c1 = await void_hold({ orderRef: `${run}-sub` }, ctx);
    show("void_hold subscription", c1);
    expect(c1.ok, c1.error).toBe(true);
    const c2 = await void_hold({ orderRef: `${run}-sub2` }, ctx);
    expect(c2.ok, c2.error).toBe(true);
  });

  it("generic orderRef in two installs: two real payments, no cross-install replay", async (c) => {
    const mk = () => {
      const dir = mkdtempSync(join(tmpdir(), "mcpal-sandbox-install-"));
      return createContext({ config: { ...ctx.config, dataDir: dir }, ledger: undefined, log: undefined, policy: { approval_threshold: "5000.00", daily_cap: "100000.00", refund_ceiling: "5000.00", payout_allowlist: [] } });
    };
    const a = mk();
    const b = mk();
    const ra = await charge({ orderRef: "order", amount: "7.77", method: card }, a);
    show("idempotency install A orderRef=order", ra);
    skipIfNoCard(c, ra);
    const rb = await charge({ orderRef: "order", amount: "7.77", method: card }, b);
    show("idempotency install B orderRef=order", rb);
    expect(ra.state).toBe("captured");
    expect(rb.state).toBe("captured");
    expect(rb.paypal.ids.order_id).not.toBe(ra.paypal.ids.order_id);
    const again = await charge({ orderRef: "order", amount: "7.77", method: card }, a);
    show("idempotency install A retry (replay)", again);
    expect(again.replayed).toBe(true);
    const diff = await charge({ orderRef: "order", amount: "9.99", method: card }, a);
    show("idempotency install A same ref, different amount", diff);
    expect(diff.state).toBe("invalid_input");
  });

  it("decision log chain is intact", () => {
    const v = verifyDecisionLog(ctx.log.path);
    console.log(`[sandbox] decision log: ${JSON.stringify(v)}`);
    expect(v.ok).toBe(true);
    mkdirSync("docs", { recursive: true });
    writeFileSync(join("docs", "sandbox-proof.json"), JSON.stringify({ run, at: new Date().toISOString(), proof }, null, 2) + "\n");
  });
});
