/** Money helpers. Amounts travel as strings with 2 decimals ("12.50"); math is done in integer cents. */

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

/** Parse "12.5" / "12.50" / 12.5 into integer cents. Throws an InputError with a plain sentence on bad input. */
export function toCents(amount: string | number): number {
  const s = typeof amount === "number" ? amount.toFixed(2) : String(amount).trim();
  if (!AMOUNT_RE.test(s)) throw new InputError(`Amount "${amount}" is not valid. Use a positive number with up to 2 decimals, like "25.00".`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/** Integer cents to "12.50". */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new InputError(`Invalid cents value ${cents}.`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Normalize an amount to the canonical 2-decimal string. */
export function normalizeAmount(amount: string | number): string {
  const c = toCents(amount);
  if (c <= 0) throw new InputError(`Amount must be greater than 0.00 (got "${amount}").`);
  return fromCents(c);
}

export function normalizeCurrency(currency: string | undefined, fallback = "USD"): string {
  const c = (currency ?? fallback).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new InputError(`Currency "${currency}" is not a 3-letter ISO code like "USD".`);
  return c;
}

export function money(value: string, currency: string) {
  return { currency_code: currency, value };
}
