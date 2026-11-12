import { defaultContext, type McpalContext } from "../context.js";
import { normalizeAmount, normalizeCurrency } from "../money.js";
import type { QuoteRec } from "../ledger/store.js";

export interface QuoteInput {
  quoteRef: string;
  amount: string;
  currency?: string;
  description?: string;
}

/**
 * Merchant-side only (library, CLI, MCPAL_QUOTES_FILE or the token-protected HTTP route): never exposed as an MCP tool,
 * so text an agent reads cannot create or change a price.
 */
export function createQuote(input: QuoteInput, ctx: McpalContext = defaultContext()): QuoteRec {
  const q = ctx.ledger.putQuote({
    quoteRef: input.quoteRef,
    amount: normalizeAmount(input.amount),
    currency: normalizeCurrency(input.currency, ctx.policy.config.currency),
    description: input.description,
  });
  ctx.log.append({ verb: "quote", orderRef: q.quoteRef, decision: "allowed", input: { amount: q.amount, currency: q.currency, description: q.description } });
  return q;
}
