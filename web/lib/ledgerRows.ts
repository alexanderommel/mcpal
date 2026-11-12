// Turns MCPal decision-log lines (hash-chained JSONL) into rows for the ledger grid.
// Runs in the browser: the hash chain is re-verified here with Web Crypto, using the same
// canonical JSON and sha256(prev_hash + canonical(line without hash)) rule as src/ledger/decision-log.ts.

export type LedgerSource = "demo key" | "judge session" | "merchant checkout (UCP)" | "sample (sandbox proof)";

export interface LedgerRow {
  id: string;
  source: LedgerSource;
  seq: number | null;
  ts: string;
  verb: string;
  orderRef: string;
  amount: number | null;
  currency: string;
  /** moved | allowed | replayed | needs_approval | denied | error | approved | rejected */
  decision: string;
  state: string;
  rule: string;
  reason: string;
  captured: number;
  paidOut: number;
  refunded: number;
  held: number;
  stopped: number;
  orderId: string;
  authorizationId: string;
  captureIds: string;
  refundIds: string;
  payoutId: string;
  otherIds: string;
  debugId: string;
  hash: string;
  chain: "verified" | "broken" | "sample";
  raw: unknown;
}

const GENESIS = "0".repeat(64);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  head: string;
  brokenAt?: number;
  reason?: string;
}

/** Same checks as verifyDecisionLog(): prev_hash link, sequence, and the line's own hash. */
export async function verifyChain(lines: string[]): Promise<ChainCheck & { okUpTo: number }> {
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "line is not valid JSON", okUpTo: i };
    }
    const { hash, ...body } = parsed;
    if (body.prev_hash !== prev) return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "prev_hash does not match previous line", okUpTo: i };
    if (body.seq !== i + 1) return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "sequence gap", okUpTo: i };
    if ((await sha256Hex(prev + canonicalJson(body))) !== hash) return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "hash mismatch (line edited)", okUpTo: i };
    prev = String(hash);
  }
  return { ok: true, count: lines.length, head: prev, okUpTo: lines.length };
}

/** Which policy rule (or demo guard) produced a stop, read from MCPal's own reason sentences (src/policy.ts). */
export function ruleOf(reason: string | undefined, decision: string): string {
  const r = reason ?? "";
  if (!r) return decision === "approved" || decision === "rejected" ? "human approval" : "";
  if (/Daily cap/i.test(r)) return "daily_cap";
  if (/identical refund/i.test(r)) return "repeat refund < 10 min";
  if (/refund_ceiling/.test(r)) return "refund_ceiling";
  if (/payout_allowlist|never been paid/.test(r)) return "payout_allowlist";
  if (/threshold/.test(r)) return "approval_threshold";
  if (/quote|price list|Amounts must come from the merchant/i.test(r)) return "amount from merchant";
  if (/human rejected/i.test(r)) return "human rejected";
  if (/hosted demo/i.test(r)) return "demo guard";
  if (decision === "error") return "PayPal / input error";
  return "";
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const join = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : v ? String(v) : "");

function idCols(ids: Record<string, unknown> | undefined) {
  const i = ids ?? {};
  const known = new Set(["order_id", "authorization_id", "capture_ids", "refund_ids", "payout_batch_id", "payout_item_id"]);
  return {
    orderId: join(i.order_id),
    authorizationId: join(i.authorization_id),
    captureIds: join(i.capture_ids),
    refundIds: join(i.refund_ids),
    payoutId: [join(i.payout_batch_id), join(i.payout_item_id)].filter(Boolean).join(" / "),
    otherIds: Object.entries(i)
      .filter(([k, v]) => !known.has(k) && v)
      .map(([k, v]) => `${k}: ${join(v)}`)
      .join(" · "),
  };
}

const OPEN_HOLD = /authoriz|^held|deposit_captured|partially_captured/;

/**
 * Money columns for one call. Only calls that went through (decision "allowed") move money;
 * stops (needs_approval / denied) count the amount that policy kept from moving.
 */
function money(verb: string, decision: string, state: string, amount: number | null, input: Record<string, unknown>, details: Record<string, unknown>) {
  const out = { captured: 0, paidOut: 0, refunded: 0, held: 0, stopped: 0 };
  if (decision === "needs_approval" || decision === "denied") {
    out.stopped = amount ?? 0;
    return out;
  }
  if (decision !== "allowed") return out;
  const a = amount ?? 0;
  if (verb === "charge" && /captured|completed/i.test(state)) out.captured = a;
  else if (verb === "hold") {
    const dep = num(details.deposit_captured) ?? num(input.deposit) ?? 0;
    out.captured = dep;
    out.held = Math.max(0, (num(input.amount) ?? a) - dep);
  } else if (verb === "capture_hold") out.captured = num(details.captured_now) ?? num(input.amount) ?? 0;
  else if (verb === "refund") out.refunded = num(details.refunded_now) ?? num(input.amount) ?? 0;
  else if (verb === "pay_out" && !/pending_approval|needs/.test(state)) out.paidOut = num(input.amount) ?? a;
  return out;
}

function decisionLabel(decision: string, m: ReturnType<typeof money>): string {
  if (decision === "allowed") return m.captured || m.paidOut || m.refunded || m.held ? "moved" : "allowed";
  return decision;
}

/** Once a hold is captured or voided, its remaining amount is no longer "held". */
function settleHolds(rows: LedgerRow[]) {
  const last = new Map<string, string>();
  for (const r of rows) if (r.decision !== "needs_approval" && r.decision !== "denied" && r.state && r.verb !== "status") last.set(`${r.source}|${r.orderRef}`, r.state);
  for (const r of rows) if (r.held && !OPEN_HOLD.test(last.get(`${r.source}|${r.orderRef}`) ?? "")) r.held = 0;
}

/** Rows from raw decision-log lines, with the hash chain verified in the browser. */
export async function rowsFromLog(lines: string[], source: LedgerSource): Promise<{ rows: LedgerRow[]; chain: ChainCheck }> {
  const chain = await verifyChain(lines);
  const rows: LedgerRow[] = [];
  lines.forEach((line, i) => {
    let p: Record<string, any>;
    try {
      p = JSON.parse(line);
    } catch {
      return;
    }
    const input = (p.input ?? {}) as Record<string, unknown>;
    const res = (p.result ?? {}) as Record<string, any>;
    const amount = num(res.amount) ?? num(input.amount);
    const state = String(res.state ?? (p.decision === "approved" || p.decision === "rejected" ? `approval ${p.decision}` : ""));
    const m = money(p.verb, p.decision, state, amount, input, (res.details ?? {}) as Record<string, unknown>);
    rows.push({
      id: `${source}|${p.seq ?? i}`,
      source,
      seq: p.seq ?? null,
      ts: String(p.ts ?? ""),
      verb: String(p.verb ?? ""),
      orderRef: String(p.orderRef ?? ""),
      amount,
      currency: String(res.currency ?? input.currency ?? "USD"),
      decision: decisionLabel(String(p.decision ?? ""), m),
      state,
      rule: ruleOf(p.reason, p.decision),
      reason: String(p.reason ?? ""),
      ...m,
      ...idCols(res.ids),
      debugId: String(res.debug_id ?? ""),
      hash: String(p.hash ?? ""),
      chain: i < chain.okUpTo ? "verified" : "broken",
      raw: p,
    });
  });
  settleHolds(rows);
  return { rows, chain };
}

const VERBS = ["capture_hold", "void_hold", "pay_out", "subscribe", "charge", "refund", "hold", "status"];

/** Rows from docs/sandbox-proof.json: real sandbox results from the proof script (not a hash-chained log). */
export function rowsFromProof(proof: { run: string; at: string; proof: Record<string, any> }): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let seq = 0;
  for (const [label, r] of Object.entries(proof.proof)) {
    if (!r || typeof r !== "object" || !("state" in r)) continue;
    seq++;
    const words = label.replace(/^fix\d+\s+/, "");
    const verb =
      VERBS.find((v) => new RegExp(`(^|\\s)${v}(\\s|$)`).test(words)) ??
      (/payout/.test(words) ? (/balance/.test(words) ? "status" : "pay_out") : /capture/.test(words) ? "capture_hold" : /idempotency/.test(words) ? "charge" : "status");
    const ids = (r.ids ?? {}) as Record<string, unknown>;
    const details = (r.details ?? {}) as Record<string, unknown>;
    const orderRef = String(ids.order_id ?? ids.invoice_id ?? ids.subscription_id ?? ids.payout_batch_id ?? `proof-${seq}`);
    const amountFromLabel = /\s(\d+(?:\.\d\d)?)(?:\s|$)/.exec(words)?.[1];
    const amount = num(details.refunded_now) ?? num(details.captured_now) ?? num(details.authorized) ?? num(amountFromLabel);
    const decision = r.replayed || /replay/.test(label) ? "replayed" : r.state === "needs_approval" ? "needs_approval" : r.state === "denied" ? "denied" : r.ok ? "allowed" : "error";
    const m = money(verb, decision, String(r.state), amount, { amount: amountFromLabel, deposit: details.deposit_captured }, details);
    rows.push({
      id: `proof|${seq}`,
      source: "sample (sandbox proof)",
      seq,
      ts: proof.at,
      verb,
      orderRef,
      amount,
      currency: "USD",
      decision: decisionLabel(decision, m),
      state: String(r.state),
      rule: ruleOf(r.error, decision),
      reason: String(r.error ?? label),
      ...m,
      ...idCols(ids),
      debugId: String(r.debug_id ?? ""),
      hash: "",
      chain: "sample",
      raw: { proof_step: label, run: proof.run, ...r },
    });
  }
  settleHolds(rows);
  return rows;
}
