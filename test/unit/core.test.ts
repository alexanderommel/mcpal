import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestId, shortId } from "../../src/idempotency.js";
import { fromCents, normalizeAmount, toCents } from "../../src/money.js";
import { Ledger } from "../../src/ledger/store.js";
import { DecisionLog, verifyDecisionLog, canonicalJson } from "../../src/ledger/decision-log.js";
import { Policy, DEFAULT_POLICY } from "../../src/policy.js";
import { buildVerifyBody } from "../../src/webhooks/verify.js";

const tmp = () => mkdtempSync(join(tmpdir(), "mcpal-unit-"));

describe("idempotency keys", () => {
  it("is deterministic and 64 hex chars", () => {
    const a = requestId({ orderRef: "inv-1", verb: "charge", amount: "10.00 USD" });
    const b = requestId({ orderRef: "inv-1", verb: "charge", amount: "10.00 USD" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes with every component", () => {
    const base = { orderRef: "inv-1", verb: "refund", amount: "5.00 USD", attemptKey: "", step: "CAP1" };
    const k = requestId(base);
    expect(requestId({ ...base, orderRef: "inv-2" })).not.toBe(k);
    expect(requestId({ ...base, verb: "charge" })).not.toBe(k);
    expect(requestId({ ...base, amount: "5.01 USD" })).not.toBe(k);
    expect(requestId({ ...base, attemptKey: "second" })).not.toBe(k);
    expect(requestId({ ...base, step: "CAP2" })).not.toBe(k);
    expect(requestId({ ...base, salt: "install-a" })).not.toBe(k);
    expect(requestId({ ...base, salt: "install-a" })).not.toBe(requestId({ ...base, salt: "install-b" }));
    expect(requestId({ ...base, salt: "install-a" })).toBe(requestId({ ...base, salt: "install-a" }));
  });
  it("fits PayPal limits", () => {
    expect(requestId({ orderRef: "x".repeat(127), verb: "hold" }).length).toBeLessThanOrEqual(108);
    expect(shortId("mcpal", "a", "b")).toMatch(/^mcpal-[0-9a-f]{24}$/);
  });
});

describe("money", () => {
  it("parses and formats", () => {
    expect(toCents("12.5")).toBe(1250);
    expect(toCents("0.07")).toBe(7);
    expect(fromCents(1250)).toBe("12.50");
    expect(normalizeAmount("3")).toBe("3.00");
    expect(() => normalizeAmount("-1")).toThrow();
    expect(() => normalizeAmount("1.234")).toThrow();
    expect(() => normalizeAmount("0")).toThrow();
  });
});

describe("policy", () => {
  const mk = () => {
    const ledger = new Ledger(":memory:");
    return { ledger, policy: new Policy({ ...DEFAULT_POLICY, approval_threshold: "100.00", daily_cap: "300.00", refund_ceiling: "50.00" }, ledger, "http://x") };
  };
  it("allows under the threshold", () => {
    const { policy } = mk();
    expect(policy.evaluate({ verb: "charge", orderRef: "a", amount: "99.99", currency: "USD" }).decision).toBe("allow");
    expect(policy.evaluate({ verb: "charge", orderRef: "a2", amount: "100.00", currency: "USD" }).decision).toBe("needs_approval");
  });
  it("asks for approval above the threshold, then allows once approved, denies if rejected", () => {
    const { policy, ledger } = mk();
    const d = policy.evaluate({ verb: "pay_out", orderRef: "a", amount: "150.00", currency: "USD" });
    expect(d.decision).toBe("needs_approval");
    if (d.decision !== "needs_approval") throw new Error();
    expect(d.approvalUrl).toBe(`http://x/approvals/${d.approval.id}`);
    // asking again reuses the same pending approval
    const d2 = policy.evaluate({ verb: "pay_out", orderRef: "a", amount: "150.00", currency: "USD" });
    expect(d2.decision === "needs_approval" && d2.approval.id).toBe(d.approval.id);
    ledger.decideApproval(d.approval.id, "approved");
    expect(policy.evaluate({ verb: "pay_out", orderRef: "a", amount: "150.00", currency: "USD" }).decision).toBe("allow");
    const d3 = policy.evaluate({ verb: "pay_out", orderRef: "b", amount: "150.00", currency: "USD" });
    if (d3.decision !== "needs_approval") throw new Error();
    ledger.decideApproval(d3.approval.id, "rejected");
    expect(policy.evaluate({ verb: "pay_out", orderRef: "b", amount: "150.00", currency: "USD" }).decision).toBe("deny");
  });
  it("enforces the daily cap", () => {
    const { policy, ledger } = mk();
    ledger.recordSpend("charge", "a", "USD", 25000, "r1");
    ledger.recordSpend("charge", "a", "USD", 25000, "r1"); // same request id counted once
    expect(ledger.spentToday("USD")).toBe(25000);
    expect(policy.evaluate({ verb: "charge", orderRef: "b", amount: "50.00", currency: "USD" }).decision).toBe("allow");
    const d = policy.evaluate({ verb: "charge", orderRef: "b", amount: "50.01", currency: "USD" });
    expect(policy.evaluate({ verb: "charge", orderRef: "b", amount: "60.00", currency: "USD", noSpend: true }).decision).toBe("allow");
    expect(d.decision).toBe("deny");
    expect(policy.evaluate({ verb: "charge", orderRef: "b", amount: "60.00", currency: "EUR" }).decision).toBe("allow");
  });
  it("uses refund_ceiling for refunds", () => {
    const { policy } = mk();
    expect(policy.evaluate({ verb: "refund", orderRef: "a", amount: "49.99", currency: "USD" }).decision).toBe("allow");
    expect(policy.evaluate({ verb: "refund", orderRef: "a", amount: "50.00", currency: "USD" }).decision).toBe("needs_approval");
  });
  it("new payout recipients always need approval; allowlist and past successful payouts do not", () => {
    const ledger = new Ledger(":memory:");
    const policy = new Policy({ ...DEFAULT_POLICY, payout_allowlist: ["Payroll@Acme.test"] }, ledger, "http://x");
    expect(policy.evaluate({ verb: "pay_out", orderRef: "p1", amount: "0.01", currency: "USD", recipient: "new@x.test" }).decision).toBe("needs_approval");
    expect(policy.evaluate({ verb: "pay_out", orderRef: "p2", amount: "5.00", currency: "USD", recipient: "payroll@acme.test" }).decision).toBe("allow");
    const r = ledger.newRef("old", "payout", "1.00", "USD");
    r.payoutReceiver = "old@x.test";
    r.state = "payout_success";
    ledger.putRef(r);
    expect(policy.evaluate({ verb: "pay_out", orderRef: "p3", amount: "5.00", currency: "USD", recipient: "old@x.test" }).decision).toBe("allow");
    r.state = "payout_unclaimed";
    ledger.putRef(r);
    expect(policy.evaluate({ verb: "pay_out", orderRef: "p4", amount: "5.00", currency: "USD", recipient: "old@x.test" }).decision).toBe("needs_approval");
  });
});

describe("decision log", () => {
  it("chains hashes and survives reopen", () => {
    const p = join(tmp(), "d.jsonl");
    const log = new DecisionLog(p);
    log.append({ verb: "charge", orderRef: "a", decision: "allowed", input: { amount: "1.00" } });
    log.append({ verb: "refund", orderRef: "a", decision: "allowed" });
    const again = new DecisionLog(p);
    const l3 = again.append({ verb: "status", orderRef: "a", decision: "allowed" });
    expect(l3.seq).toBe(3);
    const v = verifyDecisionLog(p);
    expect(v).toMatchObject({ ok: true, count: 3, head: l3.hash });
  });
  it("detects an edited line", () => {
    const p = join(tmp(), "d.jsonl");
    const log = new DecisionLog(p);
    log.append({ verb: "charge", orderRef: "a", decision: "allowed", input: { amount: "1.00" } });
    log.append({ verb: "refund", orderRef: "a", decision: "allowed", input: { amount: "1.00" } });
    log.append({ verb: "status", orderRef: "a", decision: "allowed" });
    const lines = readFileSync(p, "utf8").split("\n");
    lines[1] = lines[1]!.replace('"amount":"1.00"', '"amount":"9.00"');
    writeFileSync(p, lines.join("\n"));
    expect(verifyDecisionLog(p)).toMatchObject({ ok: false, brokenAt: 2 });
  });
  it("detects a deleted line", () => {
    const p = join(tmp(), "d.jsonl");
    const log = new DecisionLog(p);
    for (let i = 0; i < 3; i++) log.append({ verb: "charge", orderRef: `a${i}`, decision: "allowed" });
    const lines = readFileSync(p, "utf8").split("\n");
    lines.splice(1, 1);
    writeFileSync(p, lines.join("\n"));
    expect(verifyDecisionLog(p).ok).toBe(false);
  });
  it("redacts card data", () => {
    const p = join(tmp(), "d.jsonl");
    new DecisionLog(p).append({ verb: "charge", orderRef: "a", decision: "allowed", input: { card: { number: "4111", security_code: "123" } } });
    expect(readFileSync(p, "utf8")).not.toContain("4111");
  });
  it("canonical JSON sorts keys", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });
});

describe("ledger", () => {
  it("stores refs, finds by PayPal id, dedupes webhooks", () => {
    const l = new Ledger(":memory:");
    const r = l.newRef("inv-9", "charge", "10.00", "USD");
    r.orderId = "ORD123";
    r.captures.push({ id: "CAP456", amount: "10.00", status: "COMPLETED" });
    l.putRef(r);
    expect(l.getRef("inv-9")?.orderId).toBe("ORD123");
    expect(l.findRefByPayPalId("CAP456")?.orderRef).toBe("inv-9");
    expect(l.findRefByPayPalId("CAP45")).toBeUndefined();
    const w = { transmissionId: "t1", eventId: "e1", eventType: "PAYMENT.CAPTURE.COMPLETED", resourceId: "CAP456", orderRef: "inv-9", verified: true, receivedAt: new Date().toISOString(), summary: "s" };
    expect(l.recordWebhook(w, "{}")).toBe(true);
    expect(l.recordWebhook(w, "{}")).toBe(false);
    expect(l.lastWebhook("inv-9")?.eventType).toBe("PAYMENT.CAPTURE.COMPLETED");
  });
});

describe("webhook verify body", () => {
  it("embeds the raw event bytes untouched", () => {
    const raw = '{"id":"WH-1","event_type":"X","resource":{"amount":{"value":"10.10"}},"z":1.0}';
    const body = buildVerifyBody(raw, { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://c", "paypal-transmission-id": "t", "paypal-transmission-sig": "s", "paypal-transmission-time": "now" }, "WH");
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body).webhook_id).toBe("WH");
    expect(body).toContain('"z":1.0'); // JSON.stringify would have turned 1.0 into 1
  });
});
