// The demo merchant's MCPal: one isolated per-key ledger (same machinery as the hosted remote MCP),
// so every money movement of the agent-ready checkout goes through MCPal's verbs, policy,
// PayPal-Request-Id idempotency and the hash-chained decision log.
import { createHash } from "node:crypto";
import type { McpalContext } from "mcpal";
import { buildRemoteContext, disposeRemote, exportRemote, loadState, saveState, withLock } from "@/lib/remote";

/** Fixed namespace for the demo merchant (not a demo key: nobody can call its MCP with it). */
export const MERCHANT_NS = createHash("sha256").update("mcpal-commerce|coffee-club-supply").digest("hex").slice(0, 24);

/** Merchant policy: totals at or above 250.00 need a human; 5,000.00 a day; refunds over 100.00 need a human. */
export const MERCHANT_POLICY = { approval_threshold: "250.00", daily_cap: "5000.00", refund_ceiling: "100.00" };

/** Run fn with the merchant's MCPal context while holding the merchant lock; state is saved afterwards. */
export async function withMerchant<T>(fn: (ctx: McpalContext) => Promise<T>): Promise<T> {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error("The merchant is missing its PayPal sandbox credentials.");
  return withLock(MERCHANT_NS, async () => {
    const state = await loadState(MERCHANT_NS);
    const b = buildRemoteContext(state, undefined, MERCHANT_POLICY);
    try {
      const out = await fn(b.ctx);
      await saveState({ ...exportRemote(state, b), calls: [] });
      return out;
    } finally {
      disposeRemote(b);
    }
  });
}

export async function merchantLog(): Promise<string[]> {
  return (await loadState(MERCHANT_NS)).log;
}
