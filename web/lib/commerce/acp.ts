// Agentic Commerce Protocol (ACP) checkout_sessions over REST, as a thin adapter over the same
// checkout engine as UCP (lib/commerce/ucp.ts), so both protocols share pricing, sessions, the
// Idempotency-Key store and MCPal settlement on the PayPal sandbox.
//   Spec read: github.com/agentic-commerce-protocol/agentic-commerce-protocol,
//   spec/2026-04-17/openapi/openapi.agentic_checkout.yaml (+ rfcs/rfc.agentic_checkout.md).
// Differences from UCP handled here: snake_case paths, update is POST, status names
// (not_ready_for_payment / ready_for_payment), lowercase currency, Address line_one/city/state,
// fulfillment_options + selected_fulfillment_options, payment_data on complete, idempotency
// conflicts answer 422, errors are {type, code, message, param}, cancel of a finished session is 405.
import { SITE_URL } from "@/lib/remote";
import { MERCHANT } from "./catalog";
import {
  HANDLERS,
  UCP_VERSION,
  UcpError,
  cancelCheckout,
  completeCheckout,
  createCheckout,
  loadSession,
  outstanding,
  price,
  totalsOf,
  updateCheckout,
  type Session,
} from "./ucp";

export const ACP_VERSION = "2026-04-17";

export const ACP_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, api-version, idempotency-key, request-id, signature, timestamp, accept-language",
};

export function acpJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...ACP_CORS } });
}

export function acpError(status: number, code: string, message: string, param?: string): Response {
  const type = status >= 500 ? "processing_error" : "invalid_request";
  return acpJson({ type, code, message, ...(param ? { param } : {}) }, status);
}

/** ACP needs Authorization: Bearer and API-Version. The hosted demo accepts any bearer token (sandbox only). */
export function acpHeaders(req: Request): void {
  if (!/^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "")) throw new UcpError(401, "unauthorized", "Send Authorization: Bearer <token> (the hosted demo accepts any token; it is sandbox only).");
  const v = req.headers.get("api-version");
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UcpError(400, "missing_api_version", `Send API-Version: ${ACP_VERSION}.`);
}

export async function acpHandle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UcpError) {
      // ACP: the same Idempotency-Key with a different body is 422 (UCP uses 409).
      if (err.code === "idempotency_conflict") return acpError(422, "idempotency_conflict", err.message);
      if (err.code === "checkout_completed" || err.code === "checkout_canceled") return acpError(err.status === 409 ? 405 : err.status, err.code, err.message);
      return acpError(err.status, err.code, err.message, err.path?.replace(/^\$\./, ""));
    }
    console.error("acp error", err);
    return acpError(500, "internal_error", (err as Error).message || "Server error.");
  }
}

// ---------------------------------------------------------------- request mapping (ACP -> engine)

function acpLines(raw: any): { item: { id: string }; quantity: number }[] | undefined {
  const list = Array.isArray(raw?.line_items) ? raw.line_items : Array.isArray(raw?.items) ? raw.items : undefined;
  if (!list) return undefined;
  return list.map((l: any) => ({ item: { id: String(l?.id ?? l?.item?.id ?? "") }, quantity: Number.isInteger(l?.quantity) ? l.quantity : 1 }));
}

function acpAddress(a: any) {
  if (!a || typeof a !== "object") return undefined;
  return {
    id: "acp_dest",
    street_address: a.line_one,
    extended_address: a.line_two,
    address_locality: a.city,
    address_region: a.state,
    postal_code: a.postal_code,
    address_country: a.country,
    first_name: typeof a.name === "string" ? a.name.split(" ")[0] : undefined,
    last_name: typeof a.name === "string" ? a.name.split(" ").slice(1).join(" ") || undefined : undefined,
  };
}

function acpSelectedOption(raw: any): string | undefined {
  const s = raw?.selected_fulfillment_options;
  if (Array.isArray(s)) return s.find((x: any) => x?.option_id)?.option_id;
  if (s && typeof s === "object") return s.shipping?.option_id ?? s.option_id;
  return typeof raw?.fulfillment_option_id === "string" ? raw.fulfillment_option_id : undefined;
}

function acpBuyer(raw: any) {
  const b = raw?.buyer;
  const fd = raw?.fulfillment_details;
  if (!b && !fd) return undefined;
  return {
    ...(b?.first_name ? { first_name: b.first_name } : {}),
    ...(b?.last_name ? { last_name: b.last_name } : {}),
    ...(b?.email || fd?.email ? { email: b?.email ?? fd?.email } : {}),
    ...(b?.phone_number || fd?.phone_number ? { phone_number: b?.phone_number ?? fd?.phone_number } : {}),
  };
}

function engineFulfillment(raw: any, cur?: Session) {
  const addr = acpAddress(raw?.fulfillment_details?.address ?? raw?.fulfillment_address);
  const opt = acpSelectedOption(raw);
  const m = cur?.methods[0];
  if (!addr && !opt) return undefined;
  const destinations = addr ? [addr] : (m?.destinations ?? []);
  return {
    methods: [
      {
        id: m?.id ?? "shipping_1",
        type: "shipping",
        destinations,
        selected_destination_id: addr ? addr.id : (m?.selected_destination_id ?? null),
        groups: [{ id: "package_1", selected_option_id: opt ?? m?.selected_option_id ?? null }],
      },
    ],
  };
}

// ---------------------------------------------------------------- rendering (engine -> ACP)

const ACP_STATUS: Record<Session["status"], string> = {
  incomplete: "not_ready_for_payment",
  ready_for_complete: "ready_for_payment",
  requires_escalation: "requires_escalation",
  complete_in_progress: "complete_in_progress",
  completed: "completed",
  canceled: "canceled",
};

const DISPLAY: Record<string, string> = { subtotal: "Subtotal", discount: "Discount", fulfillment: "Shipping", tax: "Tax", total: "Total" };

export function renderAcp(s: Session): Record<string, unknown> {
  const p = price(s);
  const m = s.methods[0];
  const dest = m?.destinations.find((d) => d.id === m.selected_destination_id);
  const itemIds = s.line_items.map((l) => l.id);
  const msgs = [...(s.last_messages ?? []), ...(s.status === "completed" || s.status === "canceled" ? [] : outstanding(s))].map((x) => ({
    type: x.type,
    ...(x.type === "info" ? {} : { code: x.code }),
    content_type: "plain",
    content: x.content,
    ...(x.path ? { param: x.path.replace(/^\$\./, "") } : {}),
    ...(x.severity ? { severity: x.severity } : {}),
  }));
  for (const c of p.rejectedCodes) msgs.push({ type: "warning", code: "discount_code_invalid", content_type: "plain", content: `Discount code ${c} is not valid.`, param: "discounts.codes" });
  const out: Record<string, unknown> = {
    id: s.id,
    status: ACP_STATUS[s.status],
    currency: s.currency.toLowerCase(),
    ...(s.buyer ? { buyer: s.buyer } : {}),
    line_items: p.lines.map((l) => ({
      id: l.line.id,
      item: { id: l.line.item_id, name: l.title, unit_amount: l.price },
      quantity: l.line.quantity,
      totals: [
        { type: "subtotal", display_text: "Subtotal", amount: l.subtotal },
        { type: "total", display_text: "Total", amount: l.subtotal },
      ],
    })),
    ...(dest
      ? {
          fulfillment_details: {
            ...(s.buyer?.email ? { email: s.buyer.email } : {}),
            address: {
              name: [dest.first_name, dest.last_name].filter(Boolean).join(" ") || undefined,
              line_one: dest.street_address,
              line_two: dest.extended_address,
              city: dest.address_locality,
              state: dest.address_region,
              country: dest.address_country,
              postal_code: dest.postal_code,
            },
          },
        }
      : {}),
    fulfillment_options: p.options.map((o) => ({
      type: "shipping",
      id: o.id,
      title: o.title,
      description: o.description,
      totals: [
        { type: "fulfillment", display_text: "Shipping", amount: p.shippingFor(o) },
        { type: "total", display_text: "Total", amount: p.shippingFor(o) },
      ],
    })),
    selected_fulfillment_options: m?.selected_option_id ? [{ type: "shipping", option_id: m.selected_option_id, item_ids: itemIds }] : [],
    totals: totalsOf(p, s).map((t) => ({ type: t.type, display_text: DISPLAY[t.type] ?? t.type, amount: t.amount })),
    discounts: { codes: s.codes, applied: p.applied },
    messages: msgs,
    links: [
      { type: "terms_of_use", url: `${SITE_URL}/commerce#terms` },
      { type: "privacy_policy", url: `${SITE_URL}/commerce#privacy` },
    ],
    capabilities: {
      payment: {
        handlers: [
          {
            id: HANDLERS.paypal.id,
            name: HANDLERS.paypal.name,
            version: UCP_VERSION,
            spec: `${SITE_URL}/commerce`,
            requires_delegate_payment: false,
            requires_pci_compliance: false,
            psp: "paypal",
            config_schema: `${SITE_URL}/commerce`,
            instrument_schemas: [`${SITE_URL}/commerce`],
            config: { environment: "sandbox", note: HANDLERS.paypal.note },
          },
        ],
      },
    },
    ...(s.continue_url ? { continue_url: s.continue_url } : {}),
  };
  if (s.order) out.order = { id: s.order.id, checkout_session_id: s.id, permalink_url: `${SITE_URL}/commerce/orders/${s.order.id}` };
  return out;
}

// ---------------------------------------------------------------- operations

async function view(id: string, status = 200): Promise<{ status: number; body: unknown }> {
  const s = await loadSession(id);
  if (!s) throw new UcpError(404, "not_found", `Checkout session ${id} not found.`);
  return { status, body: renderAcp(s) };
}

export async function acpCreate(body: Record<string, any>): Promise<{ status: number; body: unknown }> {
  const lines = acpLines(body);
  if (!lines?.length) throw new UcpError(400, "invalid", "line_items is required (each { id, quantity }).", "$.line_items");
  if (body.currency && String(body.currency).toUpperCase() !== MERCHANT.currency) throw new UcpError(400, "currency_unsupported", `Only ${MERCHANT.currency.toLowerCase()} is supported.`, "$.currency");
  const r = await createCheckout(
    { line_items: lines, buyer: acpBuyer(body), fulfillment: engineFulfillment(body), discounts: body.discounts?.codes ? { codes: body.discounts.codes } : undefined },
    "acp",
  );
  const created = r.body as { id?: string; messages?: { code: string; content: string }[] };
  if (!created.id) {
    const m = created.messages?.[0];
    throw new UcpError(400, m?.code ?? "invalid", m?.content ?? "Nothing in this request can be sold.", "$.line_items");
  }
  return view(created.id, 201);
}

export async function acpUpdate(id: string, body: Record<string, any>): Promise<{ status: number; body: unknown }> {
  const cur = await loadSession(id);
  if (!cur) throw new UcpError(404, "not_found", `Checkout session ${id} not found.`);
  const lines = acpLines(body);
  const upd: Record<string, unknown> = {
    line_items: lines ?? cur.line_items.map((l) => ({ id: l.id, item: { id: l.item_id }, quantity: l.quantity })),
  };
  const b = acpBuyer(body);
  if (b) upd.buyer = { ...(cur.buyer ?? {}), ...b };
  const f = engineFulfillment(body, cur);
  if (f) upd.fulfillment = f;
  if (body.discounts?.codes) upd.discounts = { codes: body.discounts.codes };
  await updateCheckout(id, upd);
  return view(id);
}

export async function acpComplete(id: string, body: Record<string, any>): Promise<{ status: number; body: unknown }> {
  const pd = body.payment_data ?? {};
  const token = pd.instrument?.credential?.token ?? pd.token;
  if (typeof token !== "string") throw new UcpError(400, "invalid", "payment_data.instrument.credential.token is required.", "$.payment_data");
  if (body.buyer) await acpUpdate(id, { buyer: body.buyer });
  await completeCheckout(id, {
    payment: { instruments: [{ id: "acp_instr", handler_id: pd.handler_id ?? HANDLERS.paypal.id, type: pd.instrument?.type ?? "card", credential: { type: "token", token } }] },
    ...(body["dev.mcpal.settlement"] ? { "dev.mcpal.settlement": body["dev.mcpal.settlement"] } : {}),
  });
  return view(id);
}

export async function acpCancel(id: string): Promise<{ status: number; body: unknown }> {
  const cur = await loadSession(id);
  if (!cur) throw new UcpError(404, "not_found", `Checkout session ${id} not found.`);
  if (cur.status === "completed" || cur.status === "canceled") throw new UcpError(405, "not_cancelable", `Checkout session ${id} is already ${cur.status}.`);
  await cancelCheckout(id);
  return view(id);
}

export async function acpGet(id: string) {
  return view(id);
}
