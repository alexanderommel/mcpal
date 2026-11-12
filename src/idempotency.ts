import { createHash, randomBytes } from "node:crypto";

/**
 * Deterministic PayPal-Request-Id:
 *   sha256(salt | orderRef | verb | amount | attemptKey [| step])
 * salt = sha256(install id | ledger id | PayPal client id), so idempotency is per MCPal install + ledger + merchant:
 * the same orderRef in another install never replays this install's PayPal results.
 * Same intent => same id => PayPal replays the original response instead of moving money twice.
 * `step` distinguishes the several PayPal writes one verb may make (create, authorize, capture ...).
 * PayPal accepts up to 108 chars; a hex sha256 is 64.
 */
export function requestId(parts: {
  /** Per-install/ledger secret (McpalContext.salt). Keeps keys from colliding across installs, ledgers and merchants. */
  salt?: string;
  orderRef: string;
  verb: string;
  amount?: string;
  attemptKey?: string;
  step?: string;
}): string {
  const fields = [parts.orderRef, parts.verb, parts.amount ?? "", parts.attemptKey ?? ""];
  if (parts.salt) fields.unshift(parts.salt);
  if (parts.step) fields.push(parts.step);
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/** Short deterministic id usable where PayPal wants a merchant id (sender_batch_id, product id). */
export function shortId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

/** A fresh, unique merchant reference to suggest when an orderRef cannot be reused. */
export function suggestRef(orderRef: string): string {
  return `${orderRef.slice(0, 100)}-${randomBytes(3).toString("hex")}`;
}
