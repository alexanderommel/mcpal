// Judge session state lives in the browser as a signed snapshot, so the demo works on
// serverless instances that do not share a disk. The server rebuilds an in-memory MCPal
// ledger and decision log from it on every run and signs the new state on the way out.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ApprovalRec, RefRecord } from "mcpal";

export interface SpendRow {
  day: string;
  verb: string;
  order_ref: string;
  currency: string;
  cents: number;
  request_id: string;
  at: string;
}

export interface SessionState {
  v: 1;
  sid: string;
  refs: RefRecord[];
  spend: SpendRow[];
  /** Raw decision-log JSONL lines (hash chained). */
  log: string[];
  /** Human-approval requests raised by the policy in this session. */
  approvals?: ApprovalRec[];
}

export interface SignedSnapshot {
  state: SessionState;
  sig: string;
}

function secret(): string {
  const s = process.env.JUDGE_STATE_SECRET;
  if (s) return s;
  const base = process.env.PAYPAL_CLIENT_SECRET ?? "";
  if (!base) throw new Error("JUDGE_STATE_SECRET or PAYPAL_CLIENT_SECRET must be set");
  return createHash("sha256").update(`mcpal-judge|${base}`).digest("hex");
}

export function sign(state: SessionState): SignedSnapshot {
  const sig = createHmac("sha256", secret()).update(JSON.stringify(state)).digest("hex");
  return { state, sig };
}

export function verify(snap: unknown): SessionState | undefined {
  if (!snap || typeof snap !== "object") return undefined;
  const { state, sig } = snap as Partial<SignedSnapshot>;
  if (!state || typeof sig !== "string" || state.v !== 1) return undefined;
  const want = createHmac("sha256", secret()).update(JSON.stringify(state)).digest();
  const got = Buffer.from(sig, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  return state;
}

export function newSid(): string {
  return createHash("sha256").update(`${Date.now()}|${Math.random()}`).digest("hex").slice(0, 8);
}
