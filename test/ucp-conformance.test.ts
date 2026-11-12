// Spec-derived checks: OUR re-implementation of the UCP conformance modules, NOT the official suite run.
//
// Source read (not executed): github.com/Universal-Commerce-Protocol/conformance at commit
// 1201fb78e85217c5f2df060066ccbb0a1d1dce0b (2026-11-10). Each describe() names the official module it
// mirrors; each test names the official test function and the spec section it enforces. Fixture values
// are Coffee Club Supply's own catalog, mapped the way the suite's conformance_input.json /
// test_fixtures.json would map them.
// Spec: https://ucp.dev/specification/shopping/checkout/ (checkout.md), .../checkout/rest/ (checkout-rest.md),
// JSON schemas in github.com/Universal-Commerce-Protocol/ucp source/schemas (commit 98607bc).
//
// Run:  UCP_BASE_URL=http://localhost:3101 npx vitest run test/ucp-conformance.test.ts
//       UCP_BASE_URL=https://mcpal.vercel.app npx vitest run test/ucp-conformance.test.ts
// Completing a checkout moves real PayPal SANDBOX money through MCPal (no live money).
// Per-module report: add --reporter=json --outputFile=<file> and run scripts/ucp-report.mjs on it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.UCP_BASE_URL?.replace(/\/$/, "");
const d = BASE ? describe : describe.skip;

// ---- fixtures (equivalent of conformance_input.json + test_fixtures.json for this merchant)
const FX = {
  ucp_version: "2026-04-08",
  required_capabilities: ["dev.ucp.shopping.checkout", "dev.ucp.shopping.order", "dev.ucp.shopping.discount", "dev.ucp.shopping.fulfillment"],
  currency: "USD",
  item: { id: "bag_house_blend_12oz", price: 1400 },
  out_of_stock_item: "bag_panama_geisha_4oz",
  non_existent_item: "pink_wumpus",
  code1: "AGENT10",
  pct1: 10,
  code2: "BEANS20",
  pct2: 20,
  fixed: "FIVEOFF",
  fixedReduction: 500,
  free_shipping_min_subtotal: 5000,
  domestic: { street_address: "123 Market St", address_locality: "San Francisco", address_region: "CA", postal_code: "94105", address_country: "US" },
  domesticOption: "std-ground",
  international: { street_address: "25 King St W", address_locality: "Toronto", address_region: "ON", postal_code: "M5V 2H1", address_country: "CA" },
  internationalOption: "intl-express",
  handler: "mock_payment_handler",
};

let endpoint = "";

function headers(extra: Record<string, string> = {}) {
  return {
    "UCP-Agent": 'profile="https://agent.example/profile"',
    "request-signature": "test",
    "idempotency-key": randomUUID(),
    "request-id": randomUUID(),
    "content-type": "application/json",
    ...extra,
  };
}

async function call(method: string, path: string, body?: unknown, h: Record<string, string> = {}) {
  const url = path.startsWith("http") ? path : `${endpoint}${path}`;
  const res = await fetch(url, { method, headers: headers(h), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/** Same shape the suite's create_checkout_payload() sends (shopping/base.py). */
function createPayload(o: { qty?: number; item?: string; currency?: string; fulfillment?: boolean; buyer?: unknown } = {}) {
  const p: any = {
    id: randomUUID(),
    currency: o.currency ?? FX.currency,
    line_items: [{ id: "line_item_123", item: { id: o.item ?? FX.item.id, price: FX.item.price }, quantity: o.qty ?? 1, totals: [] }],
    payment: { instruments: [], handlers: [] },
    status: "incomplete",
    ucp: { version: FX.ucp_version },
    totals: [],
    links: [],
  };
  if (o.buyer) p.buyer = o.buyer;
  if (o.fulfillment !== false)
    p.fulfillment = {
      methods: [
        {
          id: "method_1",
          type: "shipping",
          line_item_ids: ["line_item_123"],
          selected_destination_id: "dest_1",
          destinations: [{ id: "dest_1", type: "shipping_address", ...FX.domestic }],
          groups: [{ id: "group_1", line_item_ids: ["line_item_123"], selected_option_id: FX.domesticOption }],
        },
      ],
    };
  return p;
}

/** shopping/base.py update_checkout_session(): PUT is a full replacement, so carry everything over. */
function updatePayload(co: any, over: Record<string, unknown> = {}) {
  return {
    id: co.id,
    currency: co.currency,
    line_items: co.line_items.map((li: any) => ({ id: li.id, item: { id: li.item.id }, quantity: li.quantity })),
    payment: { instruments: co.payment?.instruments ?? [] },
    ...(co.buyer ? { buyer: co.buyer } : {}),
    fulfillment: co.fulfillment,
    discounts: co.discounts ? { codes: co.discounts.codes } : undefined,
    ...over,
  };
}

const validPayment = (token = "success_token") => ({
  payment: {
    instruments: [
      {
        id: "instr_1",
        handler_id: FX.handler,
        type: "card",
        display: { brand: "Visa", last_digits: "1234" },
        credential: { type: "token", token },
        billing_address: { street_address: "123 Main St", address_locality: "Springfield", address_region: "IL", address_country: "US", postal_code: "62704" },
      },
    ],
  },
  risk_signals: {},
});

async function createReady(o: Parameters<typeof createPayload>[0] = {}) {
  const r = await call("POST", "/checkout-sessions", createPayload(o));
  expect([200, 201]).toContain(r.status);
  return r.json;
}
async function complete(id: string, payment = validPayment()) {
  return call("POST", `/checkout-sessions/${id}/complete`, payment);
}
const total = (co: any, type: string) => (co.totals as any[]).filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0);
function assertTotalsConsistent(co: any, expectedSubtotal: number, expectedDiscount?: number | number[]) {
  // shopping/base.py assert_totals_consistent(): checkout.md "Verification" — sum of non-total entries == total.
  const totals = co.totals as any[];
  expect(totals.filter((t) => t.type === "total")).toHaveLength(1);
  expect(total(co, "subtotal")).toBe(expectedSubtotal);
  if (expectedDiscount !== undefined) {
    const disc = Math.abs(totals.filter((t) => t.type === "discount" || t.type === "items_discount").reduce((a, t) => a + t.amount, 0));
    if (Array.isArray(expectedDiscount)) expect(expectedDiscount).toContain(disc);
    else expect(disc).toBe(expectedDiscount);
  }
  expect(totals.filter((t) => t.type !== "total").reduce((a, t) => a + t.amount, 0)).toBe(total(co, "total"));
}

d("UCP spec-derived checks", () => {
  beforeAll(async () => {
    const r = await fetch(`${BASE}/.well-known/ucp`);
    const j = await r.json();
    endpoint = j.ucp.services["dev.ucp.shopping"][0].endpoint.replace(/\/$/, "");
    if (process.env.UCP_ENDPOINT_OVERRIDE) endpoint = process.env.UCP_ENDPOINT_OVERRIDE;
  });

  // ---------------------------------------------------------------- shopping/checkout/protocol_test.py
  describe("checkout/protocol", () => {
    it("test_discovery: version, capabilities, handlers with id+version, REST service endpoint (overview.md discovery)", async () => {
      const r = await fetch(`${BASE}/.well-known/ucp`);
      expect(r.status).toBe(200);
      const u = (await r.json()).ucp;
      expect(u.version).toBe(FX.ucp_version);
      for (const c of FX.required_capabilities) expect(Object.keys(u.capabilities)).toContain(c);
      for (const list of Object.values(u.payment_handlers) as any[][]) for (const h of list) expect(h.id && h.version).toBeTruthy();
      const svc = u.services["dev.ucp.shopping"][0];
      expect(svc.version).toBe(FX.ucp_version);
      expect(svc.transport).toBe("rest");
      expect(svc.endpoint).toBeTruthy();
    });
    it("test_discovery_urls: every advertised spec/schema URL answers 200", async () => {
      const u = (await (await fetch(`${BASE}/.well-known/ucp`)).json()).ucp;
      const urls = new Set<string>();
      for (const group of [u.services, u.capabilities, u.payment_handlers]) for (const list of Object.values(group) as any[][]) for (const x of list) for (const k of ["spec", "schema", "config_schema"]) if (x[k]) urls.add(x[k]);
      for (const url of urls) expect((await fetch(url, { redirect: "follow" })).status, url).toBe(200);
    });
    it("test_version_negotiation: advertised version accepted, 2099-01-01 refused with 422 (checkout-rest.md UCP-Agent)", async () => {
      const ok = await call("POST", "/checkout-sessions", createPayload(), { "UCP-Agent": `profile="https://agent.example/profile"; version="${FX.ucp_version}"` });
      expect([200, 201]).toContain(ok.status);
      const bad = await call("POST", "/checkout-sessions", createPayload(), { "UCP-Agent": 'profile="https://agent.example/profile"; version="2099-01-01"' });
      expect(bad.status).toBe(422);
    });
  });

  // ---------------------------------------------------------------- shopping/checkout/lifecycle_test.py
  describe("checkout/lifecycle", () => {
    it("test_create_checkout: 201 with id, status, line_items, totals, links (checkout.json required fields)", async () => {
      const r = await call("POST", "/checkout-sessions", createPayload());
      expect([200, 201]).toContain(r.status);
      for (const k of ["ucp", "id", "line_items", "status", "currency", "totals", "links"]) expect(r.json[k], k).toBeDefined();
      expect(["incomplete", "ready_for_complete"]).toContain(r.json.status);
    });
    it("test_get_checkout: GET returns the same session", async () => {
      const co = await createReady();
      const r = await call("GET", `/checkout-sessions/${co.id}`);
      expect(r.status).toBe(200);
      expect(r.json.id).toBe(co.id);
    });
    it("test_update_checkout: buyer and a second destination persist (PUT full replacement)", async () => {
      const co = await createReady();
      const fulfillment = {
        methods: [
          {
            id: co.fulfillment.methods[0].id,
            type: "shipping",
            line_item_ids: co.line_items.map((l: any) => l.id),
            selected_destination_id: "dest_2",
            destinations: [
              { id: "dest_1", type: "shipping_address", ...FX.domestic },
              { id: "dest_2", type: "shipping_address", street_address: "456 Elm St", address_locality: "Beverly Hills", address_region: "CA", postal_code: "90210", address_country: "US" },
            ],
          },
        ],
      };
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { buyer: { email: "jane.doe@example.com", first_name: "Jane", last_name: "Doe" }, fulfillment }));
      expect(r.status).toBe(200);
      expect(r.json.buyer.first_name).toBe("Jane");
      expect(r.json.buyer.last_name).toBe("Doe");
      const m = r.json.fulfillment.methods[0];
      expect(m.selected_destination_id).toBe("dest_2");
      const dest = m.destinations.find((x: any) => x.id === "dest_2");
      expect(dest.postal_code).toBe("90210");
      expect(dest.street_address).toBe("456 Elm St");
    });
    it("test_cancel_checkout: cancel answers 200 with status canceled", async () => {
      const co = await createReady();
      const r = await call("POST", `/checkout-sessions/${co.id}/cancel`, {});
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("canceled");
    });
    it("test_complete_checkout: complete answers 200, status completed, order.id + permalink_url (order_confirmation.json)", async () => {
      const co = await createReady({ buyer: { email: "buyer@example.com", first_name: "Sam", last_name: "Buyer" } });
      const r = await complete(co.id);
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("completed");
      expect(r.json.order.id).toBeTruthy();
      expect(r.json.order.permalink_url).toMatch(/^https?:\/\//);
    });
    it("test_ready_for_complete_when_nothing_is_outstanding: no errors, no actions => ready_for_complete, then completes", async () => {
      const co = await createReady();
      const before = (await call("GET", `/checkout-sessions/${co.id}`)).json;
      expect(before.fulfillment.methods[0].selected_destination_id).toBeTruthy();
      expect(before.fulfillment.methods[0].groups[0].selected_option_id).toBeTruthy();
      expect((before.messages ?? []).filter((m: any) => m.type === "error")).toHaveLength(0);
      expect(before.actions).toBeFalsy();
      expect(before.status).toBe("ready_for_complete");
      const r = await complete(co.id);
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("completed");
    });
    it("test_repeated_cancel: 200 canceled again, or a 4xx", async () => {
      const co = await createReady();
      await call("POST", `/checkout-sessions/${co.id}/cancel`, {});
      const r = await call("POST", `/checkout-sessions/${co.id}/cancel`, {});
      if (r.status === 200) expect(r.json.status).toBe("canceled");
      else expect(r.status >= 400 && r.status < 500).toBe(true);
    });
    it("test_cannot_update_canceled_checkout: 4xx", async () => {
      const co = await createReady();
      await call("POST", `/checkout-sessions/${co.id}/cancel`, {});
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { buyer: { email: "x@example.com" } }));
      expect(r.status >= 400 && r.status < 500).toBe(true);
    });
    it("test_cannot_complete_canceled_checkout: 4xx, GET still answers 200", async () => {
      const co = await createReady();
      await call("POST", `/checkout-sessions/${co.id}/cancel`, {});
      const r = await complete(co.id);
      expect(r.status >= 400 && r.status < 500).toBe(true);
      expect((await call("GET", `/checkout-sessions/${co.id}`)).status).toBe(200);
    });
    it("test_complete_is_idempotent: completing a completed checkout (new key) is refused with 4xx, never charged twice", async () => {
      const co = await createReady();
      expect((await complete(co.id)).json.status).toBe("completed");
      const r = await complete(co.id);
      expect(r.status >= 400 && r.status < 500).toBe(true);
    });
    it("test_cannot_update_completed_checkout + test_cannot_cancel_completed_checkout: 4xx", async () => {
      const co = await createReady();
      expect((await complete(co.id)).json.status).toBe("completed");
      const u = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { buyer: { email: "x@example.com" } }));
      expect(u.status >= 400 && u.status < 500).toBe(true);
      const c = await call("POST", `/checkout-sessions/${co.id}/cancel`, {});
      expect(c.status >= 400 && c.status < 500).toBe(true);
    });
  });

  // ---------------------------------------------------------------- shopping/checkout/idempotency_test.py
  describe("checkout/idempotency", () => {
    it("test_idempotency_create: same key+body => identical status and body; same key, different body => 409", async () => {
      const key = randomUUID();
      const p = createPayload();
      const r1 = await call("POST", "/checkout-sessions", p, { "idempotency-key": key });
      const r2 = await call("POST", "/checkout-sessions", p, { "idempotency-key": key });
      expect(r2.status).toBe(r1.status);
      expect(r2.json).toEqual(r1.json);
      const r3 = await call("POST", "/checkout-sessions", { ...p, currency: "EUR" }, { "idempotency-key": key });
      expect(r3.status).toBe(409);
    });
    it("test_idempotency_update: replay matches; changed body with the same key => 409", async () => {
      const co = await createReady();
      const key = randomUUID();
      const body = updatePayload(co, { line_items: co.line_items.map((l: any) => ({ id: l.id, item: { id: l.item.id, title: l.item.title }, quantity: 2 })) });
      const r1 = await call("PUT", `/checkout-sessions/${co.id}`, body, { "idempotency-key": key });
      expect(r1.status).toBe(200);
      const r2 = await call("PUT", `/checkout-sessions/${co.id}`, body, { "idempotency-key": key });
      expect(r2.status).toBe(r1.status);
      expect(r2.json).toEqual(r1.json);
      const r3 = await call("PUT", `/checkout-sessions/${co.id}`, { ...body, line_items: body.line_items.map((l: any) => ({ ...l, quantity: 3 })) }, { "idempotency-key": key });
      expect(r3.status).toBe(409);
    });
    it("test_idempotency_complete: replay returns the same completed order (one PayPal capture); changed body => 409", async () => {
      const co = await createReady();
      const key = randomUUID();
      const r1 = await call("POST", `/checkout-sessions/${co.id}/complete`, validPayment(), { "idempotency-key": key });
      expect(r1.status).toBe(200);
      const r2 = await call("POST", `/checkout-sessions/${co.id}/complete`, validPayment(), { "idempotency-key": key });
      expect(r2.status).toBe(r1.status);
      expect(r2.json).toEqual(r1.json);
      const changed = validPayment();
      changed.payment.instruments[0]!.id = "instr_2";
      const r3 = await call("POST", `/checkout-sessions/${co.id}/complete`, changed, { "idempotency-key": key });
      expect(r3.status).toBe(409);
    });
    it("test_idempotency_cancel: replay answers the same status", async () => {
      const co = await createReady();
      const key = randomUUID();
      const r1 = await call("POST", `/checkout-sessions/${co.id}/cancel`, {}, { "idempotency-key": key });
      expect(r1.status).toBe(200);
      const r2 = await call("POST", `/checkout-sessions/${co.id}/cancel`, {}, { "idempotency-key": key });
      expect(r2.status).toBe(r1.status);
    });
  });

  // ---------------------------------------------------------------- shopping/checkout/totals_test.py
  describe("checkout/totals", () => {
    let co: any;
    beforeAll(async () => {
      const c = await createReady();
      co = (await call("PUT", `/checkout-sessions/${c.id}`, updatePayload(c, { discounts: { codes: [FX.code1] } }))).json;
    });
    it("test_single_subtotal_entry (checkout.md: subtotal MUST NOT repeat)", () => expect(co.totals.filter((t: any) => t.type === "subtotal")).toHaveLength(1));
    it("test_single_total_entry (checkout.md: total MUST NOT repeat)", () => expect(co.totals.filter((t: any) => t.type === "total")).toHaveLength(1));
    it("test_entries_have_type_and_amount (total.json required: type, amount; amounts are integer minor units)", () => {
      for (const t of co.totals) {
        expect(typeof t.type).toBe("string");
        expect(Number.isInteger(t.amount)).toBe(true);
      }
    });
    it("test_additive_entries_non_negative (subtotal, fulfillment, tax, fee >= 0)", () => {
      for (const t of co.totals.filter((x: any) => ["subtotal", "fulfillment", "tax", "fee"].includes(x.type))) expect(t.amount).toBeGreaterThanOrEqual(0);
    });
    it("test_discount_entry_is_negative (total.json: discount amount exclusiveMaximum 0)", () => {
      const ds = co.totals.filter((x: any) => x.type === "discount" || x.type === "items_discount");
      expect(ds.length).toBeGreaterThan(0);
      for (const t of ds) expect(t.amount).toBeLessThan(0);
    });
    it("sum invariant: sum(non-total entries) == total (checkout.md Verification)", () => assertTotalsConsistent(co, FX.item.price));
  });

  // ---------------------------------------------------------------- shopping/checkout/business_logic_test.py
  describe("checkout/business_logic", () => {
    it("test_totals_calculation_on_create: subtotal = price x qty", async () => {
      const co = await createReady({ qty: 2 });
      assertTotalsConsistent(co, FX.item.price * 2);
      expect(co.line_items[0].item.price).toBe(FX.item.price);
    });
    it("test_totals_recalculation_on_update: quantity 1 -> 3 recomputes subtotal and total", async () => {
      const co = await createReady();
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { line_items: [{ id: co.line_items[0].id, item: { id: FX.item.id }, quantity: 3 }] }));
      expect(r.status).toBe(200);
      assertTotalsConsistent(r.json, FX.item.price * 3);
    });
    it("test_discount_flow: valid code applied, discount = round(price x pct)", async () => {
      const co = await createReady();
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { discounts: { codes: [FX.code1] } }));
      expect(r.status).toBe(200);
      assertTotalsConsistent(r.json, FX.item.price, Math.round(FX.item.price * (FX.pct1 / 100)));
      expect(r.json.discounts.applied.map((a: any) => a.code)).toContain(FX.code1);
    });
    it("test_multiple_discounts_accepted: both codes applied, sequential or cumulative", async () => {
      const co = await createReady();
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { discounts: { codes: [FX.code1, FX.code2] } }));
      const p = FX.item.price;
      const d1 = Math.round(p * (FX.pct1 / 100));
      const seq = d1 + Math.round((p - d1) * (FX.pct2 / 100));
      const cum = d1 + Math.round(p * (FX.pct2 / 100));
      assertTotalsConsistent(r.json, p, [seq, cum]);
      const codes = r.json.discounts.applied.map((a: any) => a.code);
      expect(codes).toContain(FX.code1);
      expect(codes).toContain(FX.code2);
    });
    it("test_multiple_discounts_one_rejected: only the valid one applies", async () => {
      const co = await createReady();
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { discounts: { codes: [FX.code1, "INVALID_CODE"] } }));
      assertTotalsConsistent(r.json, FX.item.price, Math.round(FX.item.price * (FX.pct1 / 100)));
      expect(r.json.discounts.applied.map((a: any) => a.code)).not.toContain("INVALID_CODE");
    });
    it("test_fixed_amount_discount: fixed reduction in minor units", async () => {
      const co = await createReady();
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { discounts: { codes: [FX.fixed] } }));
      assertTotalsConsistent(r.json, FX.item.price, FX.fixedReduction);
    });
    it("test_buyer_info_persistence: buyer survives a later update and a GET", async () => {
      const co = await createReady();
      const buyer = { email: "persist@example.com", first_name: "Per", last_name: "Sist" };
      const r1 = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { buyer }));
      expect(r1.status).toBe(200);
      const g = await call("GET", `/checkout-sessions/${co.id}`);
      expect(g.json.buyer.email).toBe(buyer.email);
      expect(g.json.buyer.first_name).toBe(buyer.first_name);
    });
  });

  // ---------------------------------------------------------------- shopping/discount/semantics_test.py
  describe("discount/semantics", () => {
    const withCodes = async (codes: string[], qty = 1, extra: Record<string, unknown> = {}) => {
      const co = await createReady({ qty });
      return (await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { discounts: { codes, ...extra } }))).json;
    };
    it("test_code_matches_case_insensitively (discount.json: codes are case-insensitive)", async () => {
      const j = await withCodes([FX.code1.toLowerCase()]);
      expect(total(j, "discount")).toBe(-Math.round(FX.item.price * (FX.pct1 / 100)));
    });
    it("test_discount_total_is_negative", async () => expect(total(await withCodes([FX.code1]), "discount")).toBeLessThan(0));
    it("test_allocations_sum_to_applied_amount (discount.json allocation)", async () => {
      const j = await withCodes([FX.code1], 3);
      for (const a of j.discounts.applied) if (a.allocations?.length) expect(a.allocations.reduce((s: number, x: any) => s + x.amount, 0)).toBe(a.amount);
    });
    it("test_client_applied_does_not_change_price (applied[] is response-only)", async () => {
      const clean = total(await withCodes([]), "total");
      const injected = total(await withCodes([], 1, { applied: [{ code: "FREE", title: "Free", amount: 100000 }] }), "total");
      expect(injected).toBe(clean);
    });
    it("test_empty_codes_removes_discount", async () => {
      const co = await createReady();
      const a = (await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { discounts: { codes: [FX.code1] } }))).json;
      const b = (await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(a, { discounts: { codes: [] } }))).json;
      expect(total(b, "discount")).toBe(0);
    });
    it("test_codes_replace_previous_set", async () => {
      const co = await createReady();
      const a = (await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { discounts: { codes: [FX.code1] } }))).json;
      const b = (await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(a, { discounts: { codes: [FX.code2] } }))).json;
      const codes = b.discounts.applied.map((x: any) => x.code);
      expect(codes).toEqual([FX.code2]);
    });
  });

  // ---------------------------------------------------------------- shopping/fulfillment/fulfillment_test.py
  describe("fulfillment/fulfillment", () => {
    it("test_fulfillment_flow: destination => options; selecting one adds a fulfillment total", async () => {
      const r = await call("POST", "/checkout-sessions", createPayload({ fulfillment: false }));
      const co = r.json;
      const u = await call(
        "PUT",
        `/checkout-sessions/${co.id}`,
        updatePayload(co, { fulfillment: { methods: [{ type: "shipping", destinations: [{ id: "dest_1", ...FX.domestic }], selected_destination_id: "dest_1" }] } }),
      );
      const m = u.json.fulfillment.methods[0];
      expect(m.groups?.length).toBeTruthy();
      const options = m.groups[0].options;
      expect(options.length).toBeGreaterThan(0);
      const chosen = options.find((o: any) => o.id === "express-2day") ?? options[0];
      const s = await call(
        "PUT",
        `/checkout-sessions/${co.id}`,
        updatePayload(u.json, { fulfillment: { methods: [{ ...m, groups: [{ id: m.groups[0].id, line_item_ids: m.groups[0].line_item_ids, selected_option_id: chosen.id }] }] } }),
      );
      expect(s.json.fulfillment.methods[0].groups[0].selected_option_id).toBe(chosen.id);
      const optCost = chosen.totals.find((t: any) => t.type === "total")?.amount ?? 0;
      expect(total(s.json, "fulfillment")).toBe(optCost);
      assertTotalsConsistent(s.json, FX.item.price);
    });
    it("test_dynamic_fulfillment: domestic and international destinations offer their own option ids", async () => {
      const co = await createReady();
      const put = async (dest: any) =>
        (await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { fulfillment: { methods: [{ type: "shipping", destinations: [{ id: "d", ...dest }], selected_destination_id: "d" }] } }))).json;
      const dom = await put(FX.domestic);
      expect(dom.fulfillment.methods[0].groups[0].options.map((o: any) => o.id)).toContain(FX.domesticOption);
      const intl = await put(FX.international);
      expect(intl.fulfillment.methods[0].groups[0].options.map((o: any) => o.id)).toContain(FX.internationalOption);
    });
    it("test_free_shipping_on_expensive_order: a zero-cost option at or above the threshold", async () => {
      const qty = Math.ceil(FX.free_shipping_min_subtotal / FX.item.price);
      const co = await createReady({ qty });
      const opts = co.fulfillment.methods[0].groups[0].options;
      expect(opts.some((o: any) => o.totals.find((t: any) => t.type === "total")?.amount === 0)).toBe(true);
    });
  });

  // ---------------------------------------------------------------- shopping/fulfillment/structure_test.py
  describe("fulfillment/structure", () => {
    it("test_option_titles_distinguish_siblings: non-empty, distinct titles", async () => {
      const co = await createReady();
      for (const m of co.fulfillment.methods)
        for (const g of m.groups ?? []) {
          const titles = g.options.map((o: any) => o.title);
          for (const t of titles) expect(typeof t === "string" && t.length > 0).toBe(true);
          expect(new Set(titles).size).toBe(titles.length);
        }
    });
    it("test_default_config_single_group_per_method: one group carrying all of the method's items", async () => {
      const co = await createReady();
      for (const m of co.fulfillment.methods) {
        expect(m.groups).toHaveLength(1);
        expect(new Set(m.groups[0].line_item_ids)).toEqual(new Set(m.line_item_ids));
      }
    });
  });

  // ---------------------------------------------------------------- shopping/validation/validation_test.py
  describe("validation/validation", () => {
    const businessError = (r: { status: number; json: any }, codes: string[], substr: string) => {
      // assert_business_error(): a structured 4xx, or 200 with a typed error message (type, code, content, severity).
      if (r.status >= 400 && r.status < 500) {
        expect(JSON.stringify(r.json).toLowerCase()).toContain(substr);
        return;
      }
      expect([200, 201]).toContain(r.status);
      const errs = (r.json.messages ?? []).filter((m: any) => m.type === "error");
      expect(errs.length).toBeGreaterThan(0);
      for (const e of errs) for (const k of ["type", "code", "content", "severity"]) expect(e[k], k).toBeTruthy();
      expect(errs.some((e: any) => codes.includes(e.code))).toBe(true);
      expect(r.json.status).not.toBe("completed");
      if (!r.json.id) expect(r.json.ucp.status).toBe("error");
    };
    it("test_out_of_stock: typed out_of_stock / item_unavailable", async () => businessError(await call("POST", "/checkout-sessions", createPayload({ item: FX.out_of_stock_item })), ["out_of_stock", "item_unavailable"], "stock"));
    it("test_update_inventory_validation: quantity beyond stock is clamped with quantity_adjusted, or refused", async () => {
      const co = await createReady();
      const r = await call("PUT", `/checkout-sessions/${co.id}`, updatePayload(co, { line_items: [{ id: co.line_items[0].id, item: { id: FX.item.id }, quantity: 10001 }] }));
      const adjusted = (r.json.messages ?? []).filter((m: any) => m.type === "warning" && m.code === "quantity_adjusted");
      if (r.status === 200 && adjusted.length) {
        for (const li of r.json.line_items) expect(li.quantity).toBeLessThan(10001);
        return;
      }
      businessError(r, ["out_of_stock", "item_unavailable"], "stock");
    });
    it("test_product_not_found: typed not_found / item_unavailable", async () => businessError(await call("POST", "/checkout-sessions", createPayload({ item: FX.non_existent_item })), ["not_found", "item_unavailable"], "not found"));
    it("complete without fulfillment: typed missing / field_required, not completed", async () => {
      const co = (await call("POST", "/checkout-sessions", createPayload({ fulfillment: false }))).json;
      businessError(await complete(co.id), ["missing", "field_required"], "fulfillment");
    });
    it("test_payment_failure: fail_token => payment_failed, checkout not completed", async () => {
      const co = await createReady();
      businessError(await complete(co.id, validPayment("fail_token")), ["payment_failed", "payment_declined"], "payment");
    });
  });

  // ---------------------------------------------------------------- common/payments/card_credential_test.py
  describe("payments/card_credential", () => {
    it("test_card_credential_payment: a raw card credential completes (sandbox: MCPal charges PayPal's test card)", async () => {
      const co = await createReady();
      const r = await complete(co.id, {
        payment: {
          instruments: [
            {
              id: "instr_card",
              handler_id: FX.handler,
              type: "card",
              display: { brand: "Visa", last_digits: "1111" },
              credential: { type: "card", card_number_type: "fpan", number: "4242424242424242", expiry_month: 12, expiry_year: 2030, cvc: "123", name: "John Doe" },
            },
          ],
        },
        risk_signals: {},
      } as any);
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("completed");
    });
  });

  // ---------------------------------------------------------------- shopping/order/order_test.py
  describe("order/order", () => {
    it("test_order_retrieval: GET /orders/{id} answers the order (order.json required fields)", async () => {
      const co = await createReady();
      const done = await complete(co.id);
      const r = await call("GET", `/orders/${done.json.order.id}`);
      expect(r.status).toBe(200);
      for (const k of ["ucp", "id", "checkout_id", "permalink_url", "line_items", "fulfillment", "currency", "totals"]) expect(r.json[k], k).toBeDefined();
      expect(r.json.id).toBe(done.json.order.id);
      expect(r.json.checkout_id).toBe(co.id);
      // test_order_fulfillment_retrieval: expectations[0].description == the selected option's title
      const opt = co.fulfillment.methods[0].groups[0].options.find((o: any) => o.id === co.fulfillment.methods[0].groups[0].selected_option_id);
      expect(r.json.fulfillment.expectations[0].description).toBe(opt.title);
    });
  });

  // ---------------------------------------------------------------- ACP (not UCP): checkout_sessions, spec-derived from
  // agentic-commerce-protocol spec/2026-04-17/openapi/openapi.agentic_checkout.yaml. There is no ACP conformance suite to mirror.
  describe("acp/checkout_sessions", () => {
    const acp = async (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
      const res = await fetch(`${BASE}/acp${path}`, {
        method,
        headers: { authorization: "Bearer demo", "api-version": "2026-04-17", "idempotency-key": randomUUID(), "content-type": "application/json", ...h },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => undefined) };
    };
    const createBody = {
      line_items: [{ id: FX.item.id, quantity: 2 }],
      fulfillment_details: { name: "Sam Sandbox", email: "sam.sandbox@personal.example.com", address: { name: "Sam Sandbox", line_one: "2211 N First St", city: "San Jose", state: "CA", country: "US", postal_code: "95131" } },
    };
    it("create: 201 with the CheckoutSession required fields; not_ready_for_payment until a shipping option is chosen", async () => {
      const r = await acp("POST", "/checkout_sessions", createBody);
      expect(r.status).toBe(201);
      for (const k of ["id", "status", "currency", "line_items", "totals", "fulfillment_options", "messages", "links", "capabilities"]) expect(r.json[k], k).toBeDefined();
      expect(r.json.currency).toBe("usd");
      expect(r.json.status).toBe("not_ready_for_payment");
      for (const t of r.json.totals) expect(t.display_text).toBeTruthy();
    });
    it("update (POST) selects a fulfillment option => ready_for_payment; complete => completed with order.checkout_session_id", async () => {
      const c = await acp("POST", "/checkout_sessions", createBody);
      const opt = c.json.fulfillment_options[0].id;
      const u = await acp("POST", `/checkout_sessions/${c.json.id}`, { selected_fulfillment_options: [{ type: "shipping", option_id: opt, item_ids: c.json.line_items.map((l: any) => l.id) }] });
      expect(u.status).toBe(200);
      expect(u.json.status).toBe("ready_for_payment");
      const done = await acp("POST", `/checkout_sessions/${c.json.id}/complete`, { payment_data: { handler_id: "mcpal_paypal_sandbox", instrument: { type: "card", credential: { type: "token", token: "sandbox-wallet-token" } } } });
      expect(done.status).toBe(200);
      expect(done.json.status).toBe("completed");
      expect(done.json.order.checkout_session_id).toBe(c.json.id);
      const cancel = await acp("POST", `/checkout_sessions/${c.json.id}/cancel`, {});
      expect(cancel.status).toBe(405);
    });
    it("idempotency: same key + same body replays; same key + different body => 422; POST without Idempotency-Key => 400", async () => {
      const key = randomUUID();
      const a = await acp("POST", "/checkout_sessions", createBody, { "idempotency-key": key });
      const b = await acp("POST", "/checkout_sessions", createBody, { "idempotency-key": key });
      expect(b.json).toEqual(a.json);
      const c = await acp("POST", "/checkout_sessions", { ...createBody, line_items: [{ id: FX.item.id, quantity: 3 }] }, { "idempotency-key": key });
      expect(c.status).toBe(422);
      const res = await fetch(`${BASE}/acp/checkout_sessions`, { method: "POST", headers: { authorization: "Bearer demo", "api-version": "2026-04-17", "content-type": "application/json" }, body: JSON.stringify(createBody) });
      expect(res.status).toBe(400);
    });
    it("errors: {type, code, message}; unknown session => 404; missing Authorization => 401", async () => {
      const r = await acp("GET", "/checkout_sessions/chk_doesnotexist000");
      expect(r.status).toBe(404);
      expect(r.json.type).toBe("invalid_request");
      expect(r.json.code && r.json.message).toBeTruthy();
      const res = await fetch(`${BASE}/acp/checkout_sessions`, { method: "POST", headers: { "api-version": "2026-04-17", "idempotency-key": randomUUID(), "content-type": "application/json" }, body: JSON.stringify(createBody) });
      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------- MCPal extension (not a UCP module): ship-later settlement
  describe("mcpal/settlement", () => {
    it("authorize at complete, capture on ship, partial refund: PayPal ids on the order", async () => {
      const co = await createReady({ qty: 2 });
      const done = await complete(co.id, { ...validPayment(), "dev.mcpal.settlement": "authorize" } as any);
      expect(done.json.status).toBe("completed");
      const oid = done.json.order.id;
      const held = (await call("GET", `/orders/${oid}`)).json["dev.mcpal.settlement"];
      expect(held.mode).toBe("authorize");
      expect(held.paypal_ids.authorization_id).toBeTruthy();
      const shipped = await call("POST", `/orders/${oid}/ship`, {});
      expect(shipped.status).toBe(200);
      expect(shipped.json["dev.mcpal.settlement"].paypal_ids.capture_ids?.length).toBeGreaterThan(0);
      expect(shipped.json.fulfillment.events[0].type).toBe("shipped");
      const refunded = await call("POST", `/orders/${oid}/refund`, { amount: 500, reason: "One bag arrived damaged" });
      expect(refunded.status).toBe(200);
      expect(refunded.json["dev.mcpal.settlement"].paypal_ids.refund_ids?.length).toBeGreaterThan(0);
    });
  });
});
