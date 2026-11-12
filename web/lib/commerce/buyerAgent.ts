// A buyer-side shopping agent (gpt-4.1-mini, temperature 0) that only knows the merchant's UCP
// discovery URL. Its tools are the UCP REST operations; it never sees PayPal or MCPal. The merchant
// side settles the order on the PayPal sandbox through MCPal.
import { randomUUID } from "node:crypto";

export const BUYER_MODEL = "gpt-4.1-mini";
export const BUYER_TASK =
  "Buy two bags of coffee for under $40 in total, shipped. Ship to Sam Sandbox, 2211 N First St, San Jose, CA 95131, US (email sam.sandbox@personal.example.com). " +
  "Pay with my saved PayPal sandbox payment instrument: handler_id mcpal_paypal_sandbox, type card, credential { type: token, token: sandbox-wallet-token }. " +
  "Use a discount code if the merchant advertises one. Pick the cheapest shipping. Do not complete the purchase if the total is $40.00 or more.";

export interface TranscriptStep {
  t: "user" | "assistant" | "tool_call" | "tool_result";
  name?: string;
  text: string;
}

export interface BuyerRun {
  model: string;
  task: string;
  steps: TranscriptStep[];
  checkout_id?: string;
  order_id?: string;
  status?: string;
  total_cents?: number;
  paypal?: Record<string, unknown>;
  final?: string;
  at: string;
  ms: number;
}

const tools = [
  {
    type: "function",
    function: {
      name: "discover_merchant",
      description: "GET the merchant's UCP profile (/.well-known/ucp): REST endpoint, capabilities, payment handlers, catalog and advertised discount codes.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_checkout",
      description: "UCP create checkout session. Prices come from the merchant; send only item ids and quantities.",
      parameters: {
        type: "object",
        properties: {
          line_items: { type: "array", items: { type: "object", properties: { item_id: { type: "string" }, quantity: { type: "integer" } }, required: ["item_id", "quantity"] } },
          buyer: { type: "object", properties: { first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" } } },
          shipping_address: {
            type: "object",
            properties: { street_address: { type: "string" }, address_locality: { type: "string" }, address_region: { type: "string" }, postal_code: { type: "string" }, address_country: { type: "string" } },
          },
          discount_codes: { type: "array", items: { type: "string" } },
        },
        required: ["line_items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_checkout",
      description: "UCP update (full replacement of the fields you send). Use it to select a shipping option id from fulfillment.methods[0].groups[0].options, change quantities or discount codes.",
      parameters: {
        type: "object",
        properties: {
          checkout_id: { type: "string" },
          selected_shipping_option_id: { type: "string" },
          discount_codes: { type: "array", items: { type: "string" } },
          line_items: { type: "array", items: { type: "object", properties: { item_id: { type: "string" }, quantity: { type: "integer" } }, required: ["item_id", "quantity"] } },
        },
        required: ["checkout_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_checkout",
      description: "UCP complete: pay with a payment instrument. Only call when status is ready_for_complete and the total meets the user's limit.",
      parameters: {
        type: "object",
        properties: {
          checkout_id: { type: "string" },
          handler_id: { type: "string" },
          token: { type: "string" },
        },
        required: ["checkout_id", "handler_id", "token"],
      },
    },
  },
  {
    type: "function",
    function: { name: "get_order", description: "UCP get order by id (after complete).", parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } },
  },
];

/** Compact view of a checkout for the model (keeps tokens low, drops nothing it needs). */
function compact(co: any) {
  if (!co || typeof co !== "object" || !co.id) return co;
  const m = co.fulfillment?.methods?.[0];
  return {
    id: co.id,
    status: co.status,
    line_items: co.line_items?.map((l: any) => ({ id: l.id, item_id: l.item.id, title: l.item.title, unit_price_cents: l.item.price, quantity: l.quantity })),
    shipping: m
      ? { method_id: m.id, destinations: m.destinations, selected_destination_id: m.selected_destination_id, selected_option_id: m.groups?.[0]?.selected_option_id, options: m.groups?.[0]?.options?.map((o: any) => ({ id: o.id, title: o.title, cents: o.totals?.find((t: any) => t.type === "total")?.amount })) }
      : null,
    discounts: co.discounts,
    totals_cents: co.totals,
    messages: co.messages,
    order: co.order,
    continue_url: co.continue_url,
  };
}

export async function runBuyerAgent(opts: { siteUrl: string; openaiKey: string; fetchImpl?: typeof fetch; onStep?: (s: TranscriptStep) => void }): Promise<BuyerRun> {
  const t0 = Date.now();
  const f = opts.fetchImpl ?? fetch;
  const run: BuyerRun = { model: BUYER_MODEL, task: BUYER_TASK, steps: [], at: new Date().toISOString(), ms: 0 };
  const push = (s: TranscriptStep) => {
    run.steps.push(s);
    opts.onStep?.(s);
  };
  const agentHeader = { "UCP-Agent": `profile="${opts.siteUrl}/commerce/buyer-agent-profile"`, "content-type": "application/json" };
  let endpoint = "";
  let last: any;

  const ucp = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${endpoint}${path}`, { method, headers: { ...agentHeader, "idempotency-key": randomUUID(), "request-id": randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
  const lines = (li: { item_id: string; quantity: number }[]) => li.map((l) => ({ item: { id: l.item_id }, quantity: l.quantity }));

  const exec = async (name: string, a: any): Promise<unknown> => {
    switch (name) {
      case "discover_merchant": {
        const p = await (await f(`${opts.siteUrl}/.well-known/ucp`)).json();
        endpoint = p.ucp.services["dev.ucp.shopping"][0].endpoint;
        return { endpoint, payment_handlers: p.ucp.payment_handlers, capabilities: Object.keys(p.ucp.capabilities), business: p.business };
      }
      case "create_checkout": {
        const body: any = { line_items: lines(a.line_items ?? []) };
        if (a.buyer) body.buyer = a.buyer;
        if (a.shipping_address) body.fulfillment = { methods: [{ type: "shipping", destinations: [{ id: "dest_1", ...a.shipping_address }], selected_destination_id: "dest_1" }] };
        if (a.discount_codes) body.discounts = { codes: a.discount_codes };
        last = await ucp("POST", "/checkout-sessions", body);
        return compact(last);
      }
      case "update_checkout": {
        const cur = await ucp("GET", `/checkout-sessions/${a.checkout_id}`);
        const m = cur.fulfillment?.methods?.[0];
        const body: any = {
          line_items: a.line_items ? lines(a.line_items) : cur.line_items.map((l: any) => ({ id: l.id, item: { id: l.item.id }, quantity: l.quantity })),
          buyer: cur.buyer,
          discounts: { codes: a.discount_codes ?? cur.discounts?.codes ?? [] },
          fulfillment: m
            ? { methods: [{ id: m.id, type: "shipping", destinations: m.destinations, selected_destination_id: m.selected_destination_id, groups: [{ id: m.groups?.[0]?.id ?? "package_1", selected_option_id: a.selected_shipping_option_id ?? m.groups?.[0]?.selected_option_id ?? null }] }] }
            : undefined,
        };
        last = await ucp("PUT", `/checkout-sessions/${a.checkout_id}`, body);
        return compact(last);
      }
      case "complete_checkout": {
        last = await ucp("POST", `/checkout-sessions/${a.checkout_id}/complete`, {
          payment: { instruments: [{ id: "instr_buyer_1", handler_id: a.handler_id, type: "card", selected: true, credential: { type: "token", token: a.token } }] },
          signals: { "dev.ucp.user_agent": "mcpal-buyer-agent" },
        });
        return compact(last);
      }
      case "get_order": {
        const o = await ucp("GET", `/orders/${a.order_id}`);
        return { id: o.id, checkout_id: o.checkout_id, permalink_url: o.permalink_url, totals: o.totals, settlement: o["dev.mcpal.settlement"] ? { mode: o["dev.mcpal.settlement"].mode, state: o["dev.mcpal.settlement"].state, paypal_ids: o["dev.mcpal.settlement"].paypal_ids } : undefined };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  };

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a careful shopping agent acting for the user. You can only act through the tools, which speak the Universal Commerce Protocol (UCP) to one merchant. Start with discover_merchant. Prices and totals are integer US cents. Never pay more than the user's limit. Finish with a short summary that includes the order id and the total.",
    },
    { role: "user", content: BUYER_TASK },
  ];
  push({ t: "user", text: BUYER_TASK });

  for (let turn = 0; turn < 14; turn++) {
    const res = await f("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.openaiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: BUYER_MODEL, temperature: 0, messages, tools, parallel_tool_calls: false }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const msg = (await res.json()).choices[0].message;
    messages.push(msg);
    if (msg.content) push({ t: "assistant", text: msg.content });
    if (!msg.tool_calls?.length) {
      run.final = msg.content ?? "";
      break;
    }
    for (const tc of msg.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* model sent bad JSON */
      }
      push({ t: "tool_call", name: tc.function.name, text: JSON.stringify(args) });
      let out: unknown;
      try {
        out = await exec(tc.function.name, args);
      } catch (err) {
        out = { error: (err as Error).message };
      }
      const text = JSON.stringify(out);
      push({ t: "tool_result", name: tc.function.name, text });
      messages.push({ role: "tool", tool_call_id: tc.id, content: text });
    }
  }
  if (last?.id) {
    run.checkout_id = last.id;
    run.status = last.status;
    run.total_cents = last.totals?.find((t: any) => t.type === "total")?.amount;
    if (last.order?.id) {
      run.order_id = last.order.id;
      const o = await ucp("GET", `/orders/${last.order.id}`);
      run.paypal = o["dev.mcpal.settlement"];
    }
  }
  run.ms = Date.now() - t0;
  return run;
}
