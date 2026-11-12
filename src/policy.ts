import { existsSync, readFileSync } from "node:fs";
import { fromCents, toCents } from "./money.js";
import type { ApprovalRec, Ledger } from "./ledger/store.js";

/**
 * mcpal.policy.json
 * {
 *   "currency": "USD",
 *   "approval_threshold": "500.00",  // charge/hold/pay_out/subscribe AT OR ABOVE this need a human approval first
 *   "daily_cap": "2000.00",          // money an agent may move per UTC day (charge, hold, pay_out, refund); over => denied
 *   "refund_ceiling": "250.00",      // a single refund at or above this needs a human approval
 *   "payout_allowlist": ["payroll@acme.test"], // recipients pay_out may pay without approval (plus anyone already paid successfully)
 *   "verb_thresholds": { "charge": "300.00" }  // optional: per-verb approval threshold (charge, hold, pay_out, subscribe); falls back to approval_threshold
 * }
 * Hard rules (not configurable):
 *  - refunds can never exceed captured minus already refunded, and only go back to the original capture's payer;
 *  - pay_out to a recipient not on the allowlist and never paid successfully before ALWAYS needs a human approval, any amount;
 *  - a deliberate repeat of the same refund within 10 minutes of the previous one needs a human approval.
 */
export interface PolicyConfig {
  currency: string;
  approval_threshold: string;
  daily_cap: string;
  refund_ceiling: string;
  payout_allowlist: string[];
  verb_thresholds?: Partial<Record<ThresholdVerb, string>>;
}

export const THRESHOLD_VERBS = ["charge", "hold", "pay_out", "subscribe"] as const;
export type ThresholdVerb = (typeof THRESHOLD_VERBS)[number];

/** Approval threshold that applies to a money-moving verb (per-verb override, else approval_threshold). */
export function thresholdFor(config: PolicyConfig, verb: ThresholdVerb): string {
  return config.verb_thresholds?.[verb] ?? config.approval_threshold;
}

export const DEFAULT_POLICY: PolicyConfig = {
  currency: "USD",
  approval_threshold: "500.00",
  daily_cap: "2000.00",
  refund_ceiling: "250.00",
  payout_allowlist: [],
};

export function loadPolicy(path: string): PolicyConfig {
  if (!existsSync(path)) return { ...DEFAULT_POLICY };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PolicyConfig>;
  const p = { ...DEFAULT_POLICY, ...raw };
  toCents(p.approval_threshold);
  toCents(p.daily_cap);
  toCents(p.refund_ceiling);
  if (!Array.isArray(p.payout_allowlist)) p.payout_allowlist = [];
  if (p.verb_thresholds) for (const v of Object.values(p.verb_thresholds)) if (v !== undefined) toCents(v);
  return p;
}

export type PolicyDecision =
  | { decision: "allow"; approval?: ApprovalRec }
  | { decision: "needs_approval"; reason: string; approval: ApprovalRec; approvalUrl: string }
  | { decision: "deny"; reason: string };

export interface PolicyCheck {
  verb: "charge" | "hold" | "pay_out" | "subscribe" | "refund" | "refund_repeat";
  orderRef: string;
  amount: string;
  currency: string;
  /** pay_out recipient (email / phone / payer id). */
  recipient?: string;
  /** Skip the daily cap (used for actions that move no new money, e.g. a payment link). */
  noSpend?: boolean;
}

export interface RuleOutcome {
  /** deny = over the daily cap; needs_approval = a human must approve; allow = runs without a human. */
  decision: "allow" | "needs_approval" | "deny";
  reasons: string[];
}

/**
 * The deterministic rules, without a ledger: what MCPal decides for one action given the
 * money already moved today and whether the recipient is known. Policy.evaluate uses this.
 */
export function checkRules(config: PolicyConfig, check: PolicyCheck, opts: { spentTodayCents?: number; knownRecipient?: boolean } = {}): RuleOutcome {
  const cents = toCents(check.amount);
  if (!check.noSpend) {
    const cap = toCents(config.daily_cap);
    const spent = opts.spentTodayCents ?? 0;
    if (spent + cents > cap) {
      return {
        decision: "deny",
        reasons: [
          `Daily cap reached: ${fromCents(spent)} ${check.currency} already moved today, cap is ${config.daily_cap}. This ${check.amount} would exceed it. Try again tomorrow or ask the owner to raise daily_cap in mcpal.policy.json.`,
        ],
      };
    }
  }
  const reasons: string[] = [];
  if (check.verb === "refund_repeat") {
    reasons.push(`An identical refund of ${check.amount} ${check.currency} for ${check.orderRef} completed less than 10 minutes ago; repeating it needs a human.`);
  } else {
    const limitStr = check.verb === "refund" ? config.refund_ceiling : thresholdFor(config, check.verb);
    if (cents >= toCents(limitStr)) {
      const what =
        check.verb === "refund"
          ? `refund_ceiling ${config.refund_ceiling}`
          : config.verb_thresholds?.[check.verb]
            ? `${check.verb} threshold ${limitStr}`
            : `approval_threshold ${config.approval_threshold}`;
      reasons.push(`${check.amount} ${check.currency} is at or above the ${what}.`);
    }
  }
  if (check.verb === "pay_out" && check.recipient && !opts.knownRecipient) {
    reasons.push(`${check.recipient} has never been paid before and is not on payout_allowlist; new recipients always need a human (protects against addresses injected from emails or documents).`);
  }
  return { decision: reasons.length ? "needs_approval" : "allow", reasons };
}

export function onAllowlist(config: PolicyConfig, recipient: string): boolean {
  const r = recipient.trim().toLowerCase();
  return config.payout_allowlist.some((a) => a.trim().toLowerCase() === r);
}

export class Policy {
  constructor(
    readonly config: PolicyConfig,
    private readonly ledger: Ledger,
    private readonly publicUrl: string,
  ) {}

  approvalUrl(id: string): string {
    return `${this.publicUrl}/approvals/${id}`;
  }

  isKnownRecipient(recipient: string): boolean {
    return onAllowlist(this.config, recipient) || this.ledger.hasSuccessfulPayoutTo(recipient);
  }

  evaluate(check: PolicyCheck, now = new Date()): PolicyDecision {
    const out = checkRules(this.config, check, {
      spentTodayCents: check.noSpend ? 0 : this.ledger.spentToday(check.currency, now),
      knownRecipient: check.verb === "pay_out" && check.recipient ? this.isKnownRecipient(check.recipient) : true,
    });
    if (out.decision === "deny") return { decision: "deny", reason: out.reasons[0]! };
    const reasons = out.reasons;
    if (!reasons.length) return { decision: "allow" };

    const existing = this.ledger.findApproval(check.orderRef, check.verb, check.amount, check.currency);
    if (existing?.status === "approved") return { decision: "allow", approval: existing };
    if (existing?.status === "rejected") {
      return { decision: "deny", reason: `A human rejected ${check.verb} of ${check.amount} ${check.currency} for ${check.orderRef}. Do not retry; tell the user.` };
    }
    const reason = `${reasons.join(" ")} A human must approve it first.`;
    const approval = existing ?? this.ledger.createApproval(check.orderRef, check.verb, check.amount, check.currency, reason);
    return { decision: "needs_approval", reason, approval, approvalUrl: this.approvalUrl(approval.id) };
  }
}
