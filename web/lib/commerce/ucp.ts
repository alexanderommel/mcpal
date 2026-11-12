// Agent-ready checkout for a PayPal merchant: the Universal Commerce Protocol (UCP) shopping
// checkout capability over REST, backed by MCPal's PayPal verbs.
//   Spec: https://ucp.dev/specification/shopping/checkout/rest/ and the JSON schemas in
//   github.com/Universal-Commerce-Protocol/ucp (source/schemas/shopping/checkout.json, ...).
// Sessions live in private Vercel Blob (local files in development). Every money movement goes
// through MCPal (charge / hold / capture_hold / void_hold / refund) on the merchant's own
// per-key ledger, so policy limits, PayPal-Request-Id idempotency and the hash-chained
// decision log apply to agent checkouts exactly as they do to MCP tool calls.
import { createHash, randomBytes } from "node:crypto";
import { capture_hold, charge, hold, refund, void_hold, type VerbResult } from "mcpal";
import { SITE_URL, readJson, withLock, writeJson } from "@/lib/remote";
import { DISCOUNTS, MERCHANT, PRODUCTS, discountByCode, optionsFor, productById, type ShippingOption } from "./catalog";
import { withMerchant } from "./merchant";

export const UCP_VERSION = "2026-04-08";
export const UCP_BASE = "/ucp/v1";
export const ucpEndpoint = () => `${SITE_URL}${UCP_BASE}`;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** Payment handlers this merchant accepts. Both settle through MCPal on the PayPal sandbox. */
export const HANDLERS = {
  paypal: {
    id: "mcpal_paypal_sandbox",
    name: "com.paypal.sandbox.mcpal",
    note: "Any credential.token (or a card credential) is settled by MCPal on PayPal with PayPal's published test card. The token 'fail_token' simulates a decline.",
  },
  mock: {
    id: "mock_payment_handler",
    name: "dev.ucp.mock_payment_handler",
    note: "The UCP conformance suite's handler id. Same settlement path as mcpal_paypal_sandbox; 'fail_token' declines before PayPal is called.",
  },
} as const;
const HANDLER_IDS = new Set<string>([HANDLERS.paypal.id, HANDLERS.mock.id]);

// ---------------------------------------------------------------- types

export interface Address {
  id: string;
  street_address?: string;
  extended_address?: string;
  address_locality?: string;
  address_region?: string;
  postal_code?: string;
  address_country?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
}

interface StoredLine {
  id: string;
  item_id: string;
  quantity: number;
}

interface StoredMethod {
  id: string;
  type: "shipping";
  destinations: Address[];
  selected_destination_id: string | null;
  selected_option_id: string | null;
}

export interface Settlement {
  mode: "capture" | "authorize";
  orderRef: string;
  state: string;
  paypal: Record<string, string | string[]>;
  captured_cents: number;
  refunded_cents: number;
  events: { at: string; verb: string; state: string; paypal: Record<string, string | string[]>; ok: boolean; note?: string }[];
}

export interface Session {
  id: string;
  created_at: string;
  expires_at: string;
  status: "incomplete" | "requires_escalation" | "ready_for_complete" | "complete_in_progress" | "completed" | "canceled";
  currency: string;
  line_items: StoredLine[];
  buyer?: Record<string, unknown>;
  methods: StoredMethod[];
  codes: string[];
  platform?: unknown;
  agent?: string;
  continue_url?: string;
  /** Messages produced by the last mutation (warnings like quantity_adjusted, payment errors). */
  last_messages?: Message[];
  order?: { id: string; created_at: string };
  settlement?: Settlement;
}

export interface Message {
  type: "error" | "warning" | "info";
  code: string;
  content: string;
  path?: string;
  severity?: "recoverable" | "requires_buyer_input" | "requires_buyer_review" | "unrecoverable";
}

export interface Total {
  type: string;
  amount: number;
  display_text?: string;
}

// ---------------------------------------------------------------- storage

const sessPath = (id: string) => `ucp/sessions/${id}.json`;
const orderPath = (id: string) => `ucp/orders/${id}.json`;
const idemPath = (h: string) => `ucp/idem/${h}.json`;

export async function loadSession(id: string): Promise<Session | undefined> {
  if (!/^chk_[A-Za-z0-9]{8,40}$/.test(id)) return undefined;
  return (await readJson<Session>(sessPath(id)))?.data;
}
async function saveSession(s: Session): Promise<void> {
  await writeJson(sessPath(s.id), s);
}
export async function loadOrderIndex(orderId: string): Promise<string | undefined> {
  if (!/^ord_[A-Za-z0-9]{8,40}$/.test(orderId)) return undefined;
  return (await readJson<{ checkout_id: string }>(orderPath(orderId)))?.data.checkout_id;
}

const rid = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`;

// ---------------------------------------------------------------- HTTP plumbing

export class UcpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public path?: string,
  ) {
    super(message);
  }
}

/** Protocol error body: ucp.status = error + messages[] (error_response.json), plus top-level code/content. */
export function errorBody(code: string, content: string, path?: string, severity: Message["severity"] = "unrecoverable") {
  return {
    ucp: { version: UCP_VERSION, status: "error" as const },
    code,
    content,
    messages: [{ type: "error", code, content, severity, ...(path ? { path } : {}) }],
  };
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra } });
}

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, ucp-agent, idempotency-key, request-id, request-signature, signature, signature-input, content-digest, authorization",
};

/** UCP-Agent: profile="https://..."; version="YYYY-MM-DD" (RFC 8941 dictionary). */
export function parseAgent(h: string | null): { profile?: string; version?: string } {
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const m of h.matchAll(/([a-z_-]+)\s*=\s*"([^"]*)"/gi)) out[m[1]!.toLowerCase()] = m[2]!;
  return { profile: out.profile, version: out.version };
}

/**
 * Header checks shared by every operation (checkout-rest.md "Required Headers"):
 * UCP-Agent is required; a declared version newer than ours is refused with 422 (version negotiation).
 */
export function checkHeaders(req: Request): string | undefined {
  const agent = req.headers.get("ucp-agent");
  if (!agent) throw new UcpError(400, "missing_header", "The UCP-Agent header is required, e.g. UCP-Agent: profile=\"https://agent.example/profile\".");
  const { version } = parseAgent(agent);
  if (version && /^\d{4}-\d{2}-\d{2}$/.test(version) && version > UCP_VERSION)
    throw new UcpError(422, "version_unsupported", `UCP version ${version} is not supported; this business implements ${UCP_VERSION}.`);
  return agent;
}

/** Runs a mutating operation under the Idempotency-Key contract: same key + same body = same response; same key + different body = 409. */
export async function idempotent(req: Request, op: string, body: unknown, run: () => Promise<{ status: number; body: unknown }>): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key) {
    const r = await run();
    return json(r.body, r.status);
  }
  if (key.length > 255) throw new UcpError(400, "invalid", "Idempotency-Key is longer than 255 characters.");
  const h = createHash("sha256").update(`ucp|${op}|${key}`).digest("hex").slice(0, 40);
  const bodyHash = createHash("sha256").update(canonical(body)).digest("hex");
  return withLock(`ucp-idem-${h.slice(0, 24)}`, async () => {
    const prev = (await readJson<{ bodyHash: string; status: number; body: unknown }>(idemPath(h)))?.data;
    if (prev) {
      if (prev.bodyHash !== bodyHash) throw new UcpError(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request body.");
      return json(prev.body, prev.status, { "idempotent-replayed": "true" });
    }
    const r = await run();
    // Only store definitive answers (2xx and 4xx business refusals); a 5xx may be retried with the same key.
    if (r.status < 500) await writeJson(idemPath(h), { bodyHash, status: r.status, body: r.body, at: new Date().toISOString() });
    return json(r.body, r.status);
  });
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UcpError) return json(errorBody(err.code, err.message, err.path), err.status);
    console.error("ucp error", err);
    return json(errorBody("internal_error", (err as Error).message || "Server error."), 500);
  }
}

export async function readBody(req: Request): Promise<Record<string, any>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new UcpError(400, "invalid_json", "The request body must be a JSON object.");
  }
}

// ---------------------------------------------------------------- pricing

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);

function cleanAddress(a: any, fallbackId: string): Address {
  return {
    id: str(a?.id, 64) || fallbackId,
    street_address: str(a?.street_address),
    extended_address: str(a?.extended_address),
    address_locality: str(a?.address_locality ?? a?.locality),
    address_region: str(a?.address_region ?? a?.region),
    postal_code: str(a?.postal_code, 20),
    address_country: str(a?.address_country, 3)?.toUpperCase(),
    first_name: str(a?.first_name),
    last_name: str(a?.last_name),
    phone_number: str(a?.phone_number, 32),
  };
}

export interface Priced {
  lines: { line: StoredLine; price: number; title: string; subtotal: number }[];
  subtotal: number;
  applied: { code: string; title: string; amount: number }[];
  discount: number;
  options: ShippingOption[];
  shippingFor: (o: ShippingOption) => number;
  fulfillment: number;
  fulfillmentTitle?: string;
  total: number;
  rejectedCodes: string[];
}

export function price(s: Session): Priced {
  const lines = s.line_items.map((line) => {
    const p = productById(line.item_id)!;
    return { line, price: p.price, title: p.title, subtotal: p.price * line.quantity };
  });
  const subtotal = lines.reduce((a, l) => a + l.subtotal, 0);
  // Discounts are priced from codes[] only (discount.json: applied[] is response-only), applied sequentially.
  const applied: Priced["applied"] = [];
  const rejectedCodes: string[] = [];
  let remaining = subtotal;
  const seen = new Set<string>();
  for (const raw of s.codes) {
    const d = discountByCode(raw);
    if (!d) {
      rejectedCodes.push(raw);
      continue;
    }
    if (seen.has(d.code)) continue;
    seen.add(d.code);
    const amount = Math.min(remaining, d.percent ? Math.round(remaining * (d.percent / 100)) : (d.fixed ?? 0));
    remaining -= amount;
    applied.push({ code: raw, title: d.title, amount });
  }
  const discount = subtotal - remaining;
  const m = s.methods[0];
  const dest = m?.destinations.find((d) => d.id === m.selected_destination_id);
  const options = dest ? optionsFor(dest.address_country) : [];
  const shippingFor = (o: ShippingOption) => (o.freeOver !== undefined && subtotal >= o.freeOver ? 0 : o.amount);
  const sel = options.find((o) => o.id === m?.selected_option_id);
  const fulfillment = sel ? shippingFor(sel) : 0;
  return { lines, subtotal, applied, discount, options, shippingFor, fulfillment, fulfillmentTitle: sel?.title, total: subtotal - discount + fulfillment, rejectedCodes };
}

export function totalsOf(p: Priced, s: Session): Total[] {
  const t: Total[] = [{ type: "subtotal", amount: p.subtotal, display_text: "Items" }];
  if (p.discount > 0) t.push({ type: "discount", amount: -p.discount, display_text: "Discounts" });
  if (s.methods[0]?.selected_option_id && p.fulfillmentTitle) t.push({ type: "fulfillment", amount: p.fulfillment, display_text: "Shipping" });
  t.push({ type: "tax", amount: 0, display_text: "Tax" });
  t.push({ type: "total", amount: p.total, display_text: "Total" });
  return t;
}

/** What is still missing before complete (checkout.md status rules). */
export function outstanding(s: Session): Message[] {
  const out: Message[] = [];
  if (!s.line_items.length) out.push({ type: "error", code: "missing", path: "$.line_items", content: "Add at least one line item.", severity: "recoverable" });
  const m = s.methods[0];
  if (!m || !m.destinations.length) out.push({ type: "error", code: "missing", path: "$.fulfillment.methods[0].destinations", content: "Add a shipping address.", severity: "recoverable" });
  else if (!m.selected_destination_id || !m.destinations.some((d) => d.id === m.selected_destination_id))
    out.push({ type: "error", code: "missing", path: "$.fulfillment.methods[0].selected_destination_id", content: "Select a shipping destination.", severity: "recoverable" });
  else if (!m.selected_option_id || !optionsFor(m.destinations.find((d) => d.id === m.selected_destination_id)?.address_country).some((o) => o.id === m.selected_option_id))
    out.push({ type: "error", code: "missing", path: "$.fulfillment.methods[0].groups[0].selected_option_id", content: "Select a shipping option.", severity: "recoverable" });
  return out;
}

function nextStatus(s: Session): Session["status"] {
  if (s.status === "completed" || s.status === "canceled" || s.status === "requires_escalation") return s.status;
  return outstanding(s).length ? "incomplete" : "ready_for_complete";
}

// ---------------------------------------------------------------- rendering

const handlersEnvelope = () => ({
  [HANDLERS.paypal.name]: [{ id: HANDLERS.paypal.id, version: UCP_VERSION }],
  [HANDLERS.mock.name]: [{ id: HANDLERS.mock.id, version: UCP_VERSION }],
});

const capsEnvelope = () => ({
  "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
  "dev.ucp.shopping.fulfillment": [{ version: UCP_VERSION }],
  "dev.ucp.shopping.discount": [{ version: UCP_VERSION }],
});

export function render(s: Session): Record<string, unknown> {
  const p = price(s);
  const lineTotals = (l: Priced["lines"][number]) => [
    { type: "subtotal", amount: l.subtotal },
    { type: "total", amount: l.subtotal },
  ];
  const m = s.methods[0];
  const lineIds = s.line_items.map((l) => l.id);
  const messages: Message[] = [...(s.last_messages ?? [])];
  for (const c of p.rejectedCodes)
    messages.push({ type: "warning", code: "discount_code_invalid", path: "$.discounts.codes", content: `Discount code ${c} is not valid at ${MERCHANT.name}.` });
  if (s.status !== "completed" && s.status !== "canceled") messages.push(...outstanding(s));

  const body: Record<string, unknown> = {
    ucp: { version: UCP_VERSION, status: "success", capabilities: capsEnvelope(), payment_handlers: handlersEnvelope() },
    id: s.id,
    status: s.status,
    currency: s.currency,
    line_items: p.lines.map((l) => ({
      id: l.line.id,
      item: { id: l.line.item_id, title: l.title, price: l.price },
      quantity: l.line.quantity,
      totals: lineTotals(l),
    })),
    totals: totalsOf(p, s),
    messages,
    links: [
      { type: "terms_of_service", url: `${SITE_URL}/commerce#terms` },
      { type: "privacy_policy", url: `${SITE_URL}/commerce#privacy` },
    ],
    expires_at: s.expires_at,
    payment: { instruments: [] },
    discounts: {
      codes: s.codes,
      applied: p.applied.map((a) => ({
        code: a.code,
        title: a.title,
        amount: a.amount,
        method: "across",
        // One allocation per line, proportional to the line subtotal; rounding goes to the last line so they sum exactly.
        allocations: allocate(a.amount, p.lines.map((l) => l.subtotal)).map((amount, i) => ({ path: `$.line_items[${i}]`, amount })),
      })),
    },
    fulfillment: {
      methods: m
        ? [
            {
              id: m.id,
              type: "shipping",
              line_item_ids: lineIds,
              destinations: m.destinations.map((d) => ({ type: "shipping_address", ...stripUndef(d) })),
              selected_destination_id: m.selected_destination_id,
              groups: [
                {
                  id: "package_1",
                  line_item_ids: lineIds,
                  selected_option_id: m.selected_option_id,
                  options: p.options.map((o) => ({
                    id: o.id,
                    title: o.title,
                    description: o.description,
                    totals: [
                      { type: "fulfillment", amount: p.shippingFor(o) },
                      { type: "total", amount: p.shippingFor(o) },
                    ],
                  })),
                },
              ],
            },
          ]
        : [],
    },
  };
  if (s.buyer) body.buyer = s.buyer;
  if (s.continue_url) body.continue_url = s.continue_url;
  if (s.order) body.order = { id: s.order.id, permalink_url: `${SITE_URL}/commerce/orders/${s.order.id}`, label: `Coffee Club Supply order ${s.order.id.slice(4, 12).toUpperCase()}` };
  return body;
}

function allocate(amount: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !weights.length) return [];
  const out = weights.map((w) => Math.floor((amount * w) / sum));
  out[out.length - 1]! += amount - out.reduce((a, b) => a + b, 0);
  return out;
}

function stripUndef<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
}

// ---------------------------------------------------------------- applying requests

const MAX_LINES = 20;
const MAX_PER_LINE = 20;

/** Parses line_items; returns business messages for unknown / sold-out items instead of throwing. */
function applyLines(raw: unknown, prev: StoredLine[]): { lines: StoredLine[]; errors: Message[]; warnings: Message[] } {
  if (!Array.isArray(raw)) throw new UcpError(400, "invalid", "line_items must be an array.", "$.line_items");
  if (raw.length > MAX_LINES) throw new UcpError(400, "invalid", `At most ${MAX_LINES} line items.`, "$.line_items");
  const errors: Message[] = [];
  const warnings: Message[] = [];
  const lines: StoredLine[] = [];
  raw.forEach((li: any, i) => {
    const itemId = str(li?.item?.id, 100);
    const q = li?.quantity;
    if (!itemId) throw new UcpError(400, "invalid", "Each line item needs item.id.", `$.line_items[${i}].item.id`);
    if (!Number.isInteger(q) || q < 1) throw new UcpError(400, "invalid", "quantity must be a positive integer.", `$.line_items[${i}].quantity`);
    const p = productById(itemId);
    if (!p) {
      errors.push({ type: "error", code: "not_found", path: `$.line_items[${i}].item.id`, content: `Item ${itemId} not found in the ${MERCHANT.name} catalog.`, severity: "unrecoverable" });
      return;
    }
    if (p.stock <= 0) {
      errors.push({ type: "error", code: "out_of_stock", path: `$.line_items[${i}]`, content: `${p.title} is out of stock.`, severity: "unrecoverable" });
      return;
    }
    let quantity = q as number;
    // Available to one order: stock, capped at MAX_PER_LINE units per item for the hosted demo.
    const available = Math.min(p.stock, MAX_PER_LINE);
    if (quantity > available) {
      warnings.push({ type: "warning", code: "quantity_adjusted", path: `$.line_items[${i}].quantity`, content: `Only ${available} of ${p.title} available in stock for one order; quantity set to ${available}.` });
      quantity = available;
    }
    const keepId = str(li?.id, 64);
    const id = keepId && (prev.some((x) => x.id === keepId) || /^[A-Za-z0-9_-]{1,64}$/.test(keepId)) ? keepId : `li_${i + 1}`;
    lines.push({ id: lines.some((x) => x.id === id) ? `li_${i + 1}_${randomBytes(2).toString("hex")}` : id, item_id: itemId, quantity });
  });
  return { lines, errors, warnings };
}

function applyFulfillment(raw: any, prev: StoredMethod[]): StoredMethod[] {
  if (raw === undefined || raw === null) return prev;
  const methods = raw?.methods;
  if (!Array.isArray(methods)) throw new UcpError(400, "invalid", "fulfillment.methods must be an array.", "$.fulfillment.methods");
  if (!methods.length) return [];
  const m = methods[0];
  if (m?.type && m.type !== "shipping") throw new UcpError(400, "invalid", "Only the 'shipping' fulfillment method is supported.", "$.fulfillment.methods[0].type");
  const old = prev[0];
  const destinations = Array.isArray(m?.destinations) ? m.destinations.slice(0, 10).map((d: any, i: number) => cleanAddress(d, `dest_${i + 1}`)) : (old?.destinations ?? []);
  let selDest: string | null = str(m?.selected_destination_id, 64) ?? null;
  if (!selDest && destinations.length === 1) selDest = destinations[0]!.id;
  const group = Array.isArray(m?.groups) ? m.groups[0] : undefined;
  let selOpt: string | null = group ? (str(group.selected_option_id, 64) ?? null) : (old?.selected_option_id ?? null);
  const country = destinations.find((d: Address) => d.id === selDest)?.address_country;
  // An option that does not exist for this destination (e.g. switching country) is dropped, not kept silently.
  if (selOpt && !optionsFor(country).some((o) => o.id === selOpt)) selOpt = null;
  return [{ id: str(m?.id, 64) || old?.id || "shipping_1", type: "shipping", destinations, selected_destination_id: selDest, selected_option_id: selOpt }];
}

function applyCodes(raw: any, prev: string[]): string[] {
  if (raw === undefined || raw === null) return prev;
  const codes = raw?.codes;
  if (codes === undefined) return prev;
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== "string")) throw new UcpError(400, "invalid", "discounts.codes must be an array of strings.", "$.discounts.codes");
  return codes.slice(0, 5).map((c: string) => c.slice(0, 40));
}

function applyBuyer(raw: any, prev: Session["buyer"]): Session["buyer"] {
  if (raw === undefined) return prev;
  if (raw === null) return undefined;
  if (typeof raw !== "object") throw new UcpError(400, "invalid", "buyer must be an object.", "$.buyer");
  const b: Record<string, unknown> = {};
  for (const k of ["first_name", "last_name", "email", "phone_number", "full_name"]) if (typeof raw[k] === "string") b[k] = raw[k].slice(0, 200);
  if (raw.consent && typeof raw.consent === "object") b.consent = raw.consent;
  return b;
}

// ---------------------------------------------------------------- operations

export async function createCheckout(body: Record<string, any>, agent: string | undefined): Promise<{ status: number; body: unknown }> {
  if (body.currency && String(body.currency).toUpperCase() !== MERCHANT.currency)
    return { status: 200, body: resourceless("currency_unsupported", `${MERCHANT.name} sells in ${MERCHANT.currency} only; ${body.currency} is not supported.`, "$.currency") };
  if (!Array.isArray(body.line_items) || !body.line_items.length) throw new UcpError(400, "invalid", "line_items is required and must not be empty.", "$.line_items");
  const { lines, errors, warnings } = applyLines(body.line_items, []);
  if (!lines.length) {
    // Nothing purchasable: no checkout is created (checkout-rest.md "all items out of stock").
    return { status: 200, body: { ucp: { version: UCP_VERSION, status: "error" }, messages: errors, continue_url: `${SITE_URL}/commerce` } };
  }
  const now = Date.now();
  const s: Session = {
    id: rid("chk"),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    status: "incomplete",
    currency: MERCHANT.currency,
    line_items: lines,
    buyer: applyBuyer(body.buyer, undefined),
    methods: applyFulfillment(body.fulfillment, []),
    codes: applyCodes(body.discounts, []),
    agent: agent?.slice(0, 300),
    last_messages: [...errors.map((e) => ({ ...e, severity: "recoverable" as const })), ...warnings],
  };
  s.status = nextStatus(s);
  guardTotal(s);
  await saveSession(s);
  return { status: 201, body: render(s) };
}

function resourceless(code: string, content: string, path?: string) {
  return { ucp: { version: UCP_VERSION, status: "error" }, messages: [{ type: "error", code, content, severity: "unrecoverable", ...(path ? { path } : {}) }] };
}

function guardTotal(s: Session) {
  const p = price(s);
  if (p.total > MERCHANT.maxTotal) throw new UcpError(422, "amount_too_large", `The hosted demo caps a checkout at ${(MERCHANT.maxTotal / 100).toFixed(2)} USD; this one is ${(p.total / 100).toFixed(2)}.`, "$.line_items");
}

async function mutable(id: string): Promise<Session> {
  const s = await loadSession(id);
  if (!s) throw new UcpError(404, "not_found", `Checkout session ${id} not found.`);
  return s;
}

function assertOpen(s: Session, op: string) {
  if (s.status === "completed") throw new UcpError(409, "checkout_completed", `Checkout ${s.id} is already completed; it cannot be ${op}.`);
  if (s.status === "canceled") throw new UcpError(409, "checkout_canceled", `Checkout ${s.id} was canceled; it cannot be ${op}.`);
  // complete_in_progress under the session lock means an earlier complete crashed midway; complete may resume it
  // (MCPal replays the same orderRef, so PayPal is never charged twice). Other operations wait for it.
  if (s.status === "complete_in_progress" && op !== "completed again") throw new UcpError(409, "checkout_in_progress", `Checkout ${s.id} is being completed; try again in a moment.`);
  if (Date.parse(s.expires_at) < Date.now()) throw new UcpError(409, "checkout_expired", `Checkout ${s.id} expired at ${s.expires_at}. Start a new checkout.`);
}

export async function getCheckout(id: string): Promise<{ status: number; body: unknown }> {
  const s = await mutable(id);
  return { status: 200, body: render(s) };
}

/** PUT is a full replacement of the writable fields (checkout-rest.md "Update Checkout"). */
export async function updateCheckout(id: string, body: Record<string, any>): Promise<{ status: number; body: unknown }> {
  return withLock(`ucp-cs-${id.slice(4, 28)}`, async () => {
    const s = await mutable(id);
    assertOpen(s, "updated");
    if (body.currency && String(body.currency).toUpperCase() !== s.currency) throw new UcpError(400, "currency_unsupported", `This checkout is in ${s.currency}; currency cannot change.`, "$.currency");
    const msgs: Message[] = [];
    if (body.line_items !== undefined) {
      const { lines, errors, warnings } = applyLines(body.line_items, s.line_items);
      if (errors.length) {
        // Keep the previous lines; report the problem in-band so the agent can fix it.
        s.last_messages = errors.map((e) => ({ ...e, severity: "recoverable" as const }));
        await saveSession(s);
        return { status: 200, body: render(s) };
      }
      s.line_items = lines;
      msgs.push(...warnings);
    }
    s.buyer = applyBuyer(body.buyer, s.buyer);
    s.methods = applyFulfillment(body.fulfillment, s.methods);
    s.codes = applyCodes(body.discounts, s.codes);
    if (body.platform !== undefined) s.platform = body.platform;
    s.last_messages = msgs;
    if (s.status === "requires_escalation") {
      s.status = "incomplete";
      s.continue_url = undefined;
    }
    s.status = nextStatus(s);
    guardTotal(s);
    await saveSession(s);
    return { status: 200, body: render(s) };
  });
}

export async function cancelCheckout(id: string): Promise<{ status: number; body: unknown }> {
  return withLock(`ucp-cs-${id.slice(4, 28)}`, async () => {
    const s = await mutable(id);
    if (s.status === "canceled") return { status: 200, body: render(s) };
    if (s.status === "completed") throw new UcpError(409, "checkout_completed", `Checkout ${s.id} is completed. Use the order's refund endpoint instead.`);
    s.status = "canceled";
    s.last_messages = [];
    // A policy-approval request may exist for this checkout: void_hold marks the MCPal reference cancelled so it can never be paid later.
    if (s.settlement) {
      const r = await withMerchant((ctx) => void_hold({ orderRef: s.settlement!.orderRef, reason: "UCP checkout canceled" }, ctx));
      s.settlement.events.push(ev("void_hold", r));
      s.settlement.state = r.state;
    }
    await saveSession(s);
    return { status: 200, body: render(s) };
  });
}

function ev(verb: string, r: VerbResult, note?: string): Settlement["events"][number] {
  return { at: new Date().toISOString(), verb, state: r.state, paypal: r.paypal?.ids ?? {}, ok: r.ok, ...(note || r.error ? { note: note ?? r.error } : {}) };
}

interface Instrument {
  id?: string;
  handler_id?: string;
  type?: string;
  credential?: { type?: string; token?: string; number?: string };
  selected?: boolean;
}

/**
 * Complete: validate the payment instrument, then settle with MCPal on the PayPal sandbox.
 *  settlement "capture" (default): MCPal charge, method card_on_file -> Orders v2 create + capture.
 *  settlement "authorize" (MCPal extension "dev.mcpal.settlement": "authorize"): MCPal hold -> Orders v2 authorize;
 *  the merchant later captures on shipment (capture_hold) or releases it (void_hold).
 * The MCPal orderRef is derived from the checkout id, so a retried complete can never charge twice
 * (MCPal replays; PayPal sees the same PayPal-Request-Id).
 */
export async function completeCheckout(id: string, body: Record<string, any>): Promise<{ status: number; body: unknown }> {
  return withLock(`ucp-cs-${id.slice(4, 28)}`, async () => {
    const s = await mutable(id);
    assertOpen(s, "completed again");
    if (s.status === "requires_escalation") throw new UcpError(409, "requires_escalation", `This checkout needs the merchant's approval first: ${s.continue_url}`);
    const missing = outstanding(s);
    if (missing.length) {
      s.last_messages = [];
      return { status: 200, body: { ...render(s) } };
    }
    const instruments: Instrument[] = Array.isArray(body?.payment?.instruments) ? body.payment.instruments : [];
    const inst = instruments.find((i) => i?.selected) ?? instruments[0];
    if (!inst) throw new UcpError(400, "missing", "payment.instruments[0] is required to complete.", "$.payment.instruments");
    if (!inst.handler_id || !HANDLER_IDS.has(inst.handler_id))
      throw new UcpError(400, "payment_handler_unsupported", `Payment handler ${inst.handler_id ?? "(none)"} is not accepted. Use ${HANDLERS.paypal.id}.`, "$.payment.instruments[0].handler_id");
    const cred = inst.credential;
    if (!cred || (typeof cred.token !== "string" && cred.type !== "card"))
      throw new UcpError(400, "invalid", "The instrument needs credential.token (or a card credential).", "$.payment.instruments[0].credential");
    if (cred.token === "fail_token") {
      s.last_messages = [{ type: "error", code: "payment_failed", path: "$.payment.instruments[0]", content: "Payment failed: the card was declined (simulated decline token). Nothing was charged.", severity: "recoverable" }];
      await saveSession(s);
      return { status: 200, body: render(s) };
    }

    const p = price(s);
    const amount = (p.total / 100).toFixed(2);
    const mode: Settlement["mode"] = body?.["dev.mcpal.settlement"] === "authorize" ? "authorize" : "capture";
    const orderRef = `ucp-${s.id.slice(4)}`;
    const description = `${MERCHANT.name} ${s.id}`.slice(0, 120);
    s.status = "complete_in_progress";
    await saveSession(s);
    let r: VerbResult;
    try {
      r = await withMerchant((ctx) =>
        mode === "authorize"
          ? hold({ orderRef, amount, currency: s.currency, method: "card_on_file", description }, ctx)
          : charge({ orderRef, amount, currency: s.currency, method: "card_on_file", description }, ctx),
      );
    } catch (err) {
      s.status = "ready_for_complete";
      await saveSession(s);
      throw err;
    }
    s.settlement = {
      mode,
      orderRef,
      state: r.state,
      paypal: r.paypal?.ids ?? {},
      captured_cents: mode === "capture" && r.ok && r.state === "captured" ? p.total : 0,
      refunded_cents: 0,
      events: [ev(mode === "authorize" ? "hold" : "charge", r)],
    };
    if (r.state === "needs_approval") {
      // MCPal policy: totals at or above the approval threshold need a human. Escalate to the merchant.
      s.status = "requires_escalation";
      s.continue_url = r.human_approval_url ?? `${SITE_URL}/commerce`;
      s.last_messages = [{ type: "error", code: "requires_merchant_approval", content: `The merchant's policy needs a human to approve ${amount} ${s.currency}. Nothing was charged. ${r.next}`, severity: "requires_buyer_review" }];
      await saveSession(s);
      return { status: 200, body: render(s) };
    }
    const settled = r.ok && (mode === "capture" ? r.state === "captured" : r.state === "authorized");
    if (!settled) {
      s.status = "ready_for_complete";
      s.last_messages = [{ type: "error", code: "payment_failed", path: "$.payment.instruments[0]", content: `Payment did not go through (MCPal state ${r.state}): ${r.error ?? r.next}`, severity: "recoverable" }];
      await saveSession(s);
      return { status: 200, body: render(s) };
    }
    const orderId = rid("ord");
    s.order = { id: orderId, created_at: new Date().toISOString() };
    s.status = "completed";
    s.last_messages = [];
    await writeJson(orderPath(orderId), { checkout_id: s.id });
    await saveSession(s);
    return { status: 200, body: render(s) };
  });
}

// ---------------------------------------------------------------- orders (dev.ucp.shopping.order + MCPal settlement extension)

export function renderOrder(s: Session): Record<string, unknown> {
  const p = price(s);
  const m = s.methods[0];
  const dest = m?.destinations.find((d) => d.id === m.selected_destination_id);
  const st = s.settlement;
  const shipped = st?.events.some((e) => e.verb === "capture_hold" && e.ok) || (st?.mode === "capture" && st.events.some((e) => e.verb === "ship"));
  return {
    ucp: { version: UCP_VERSION, status: "success", capabilities: { "dev.ucp.shopping.order": [{ version: UCP_VERSION }] } },
    id: s.order!.id,
    label: `Coffee Club Supply order ${s.order!.id.slice(4, 12).toUpperCase()}`,
    checkout_id: s.id,
    permalink_url: `${SITE_URL}/commerce/orders/${s.order!.id}`,
    currency: s.currency,
    line_items: p.lines.map((l) => ({
      id: l.line.id,
      item: { id: l.line.item_id, title: l.title, price: l.price },
      quantity: { total: l.line.quantity, fulfilled: shipped ? l.line.quantity : 0 },
      totals: [
        { type: "subtotal", amount: l.subtotal },
        { type: "total", amount: l.subtotal },
      ],
      status: shipped ? "fulfilled" : "processing",
    })),
    fulfillment: {
      expectations: dest
        ? [
            {
              id: "exp_1",
              line_items: s.line_items.map((l) => ({ id: l.id, quantity: l.quantity })),
              method_type: "shipping",
              destination: stripUndef({ ...dest, id: undefined }),
              description: p.fulfillmentTitle,
            },
          ]
        : [],
      events: shipped ? [{ id: "fe_1", occurred_at: st!.events.find((e) => e.verb === "capture_hold" || e.verb === "ship")!.at, type: "shipped", line_items: s.line_items.map((l) => ({ id: l.id, quantity: l.quantity })) }] : [],
    },
    adjustments: (st?.events ?? [])
      .filter((e) => e.verb === "refund" && e.ok)
      .map((e, i) => ({ id: `adj_${i + 1}`, type: "refund", occurred_at: e.at, status: "completed", amount: Number((e as any).amount_cents ?? 0), description: "Refund via MCPal" })),
    totals: totalsOf(p, s),
    // MCPal extension: how the merchant settled this order on PayPal (sandbox), with PayPal's ids.
    "dev.mcpal.settlement": st ? { mode: st.mode, mcpal_order_ref: st.orderRef, state: st.state, paypal_ids: st.paypal, events: st.events } : undefined,
  };
}

export async function getOrder(orderId: string): Promise<{ status: number; body: unknown }> {
  const cid = await loadOrderIndex(orderId);
  const s = cid ? await loadSession(cid) : undefined;
  if (!s?.order) throw new UcpError(404, "not_found", `Order ${orderId} not found.`);
  return { status: 200, body: renderOrder(s) };
}

/** Merchant-side order actions (MCPal extension, not part of UCP): ship (capture a held payment), release (void), refund. */
export async function orderAction(orderId: string, action: "ship" | "release" | "refund", body: Record<string, any>): Promise<{ status: number; body: unknown }> {
  const cid = await loadOrderIndex(orderId);
  if (!cid) throw new UcpError(404, "not_found", `Order ${orderId} not found.`);
  return withLock(`ucp-cs-${cid.slice(4, 28)}`, async () => {
    const s = await loadSession(cid);
    const st = s?.settlement;
    if (!s?.order || !st) throw new UcpError(404, "not_found", `Order ${orderId} not found.`);
    const orderRef = st.orderRef;
    let r: VerbResult;
    if (action === "ship") {
      if (st.mode === "capture") {
        st.events.push({ at: new Date().toISOString(), verb: "ship", state: "shipped", paypal: {}, ok: true, note: "Already captured at checkout; nothing to capture." });
        await saveSession(s);
        return { status: 200, body: renderOrder(s) };
      }
      r = await withMerchant((ctx) => capture_hold({ orderRef }, ctx));
      st.events.push(ev("capture_hold", r));
      if (r.ok) st.captured_cents = price(s).total;
    } else if (action === "release") {
      r = await withMerchant((ctx) => void_hold({ orderRef, reason: typeof body.reason === "string" ? body.reason.slice(0, 120) : "Order released by merchant" }, ctx));
      st.events.push(ev("void_hold", r));
    } else {
      const amt = typeof body.amount === "number" && Number.isInteger(body.amount) && body.amount > 0 ? (body.amount / 100).toFixed(2) : undefined;
      r = await withMerchant((ctx) => refund({ orderRef, ...(amt ? { amount: amt } : {}), reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : "Refund" }, ctx));
      const e = ev("refund", r) as Settlement["events"][number] & { amount_cents?: number };
      if (r.ok) {
        const cents = amt ? Math.round(Number(amt) * 100) : st.captured_cents - st.refunded_cents;
        e.amount_cents = cents;
        st.refunded_cents += cents;
      }
      st.events.push(e);
    }
    st.state = r.state;
    st.paypal = { ...st.paypal, ...(r.paypal?.ids ?? {}) };
    await saveSession(s);
    const out = renderOrder(s);
    return { status: 200, body: r.ok ? out : { ...out, messages: [{ type: "error", code: r.state, content: r.error ?? r.next, severity: "recoverable" }] } };
  });
}

// ---------------------------------------------------------------- discovery

export function discoveryProfile(): Record<string, unknown> {
  const ep = ucpEndpoint();
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": [{ version: UCP_VERSION, transport: "rest", endpoint: ep, spec: "https://ucp.dev/2026-04-08/specification/checkout-rest/" }],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: UCP_VERSION, spec: "https://ucp.dev/2026-04-08/specification/checkout/" }],
        "dev.ucp.shopping.fulfillment": [{ version: UCP_VERSION, extends: "dev.ucp.shopping.checkout" }],
        "dev.ucp.shopping.discount": [{ version: UCP_VERSION, extends: "dev.ucp.shopping.checkout" }],
        "dev.ucp.shopping.order": [{ version: UCP_VERSION }],
      },
      payment_handlers: {
        [HANDLERS.paypal.name]: [{ id: HANDLERS.paypal.id, version: UCP_VERSION, config: { environment: "sandbox", settles_with: "MCPal charge / hold on PayPal Orders v2", note: HANDLERS.paypal.note }, available_instruments: [{ type: "card" }] }],
        [HANDLERS.mock.name]: [{ id: HANDLERS.mock.id, version: UCP_VERSION, config: { note: HANDLERS.mock.note }, available_instruments: [{ type: "card" }] }],
      },
    },
    business: {
      name: MERCHANT.name,
      currency: MERCHANT.currency,
      catalog: PRODUCTS.map((p) => ({ id: p.id, title: p.title, price: p.price, in_stock: p.stock > 0 })),
      discount_codes_advertised: [DISCOUNTS[0]!.code],
      policy: "Totals at or above 250.00 USD need the merchant's approval (requires_escalation). Hosted demo cap: 500.00 USD per checkout.",
      acp: `${SITE_URL}/acp`,
    },
  };
}
