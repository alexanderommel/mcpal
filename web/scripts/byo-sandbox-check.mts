// End-to-end check of "Use your own sandbox" against a deployed site, acting as an outside developer.
//   BYO_ENV_FILE=~/path/.env.paypal-sandbox SITE=https://mcpal.vercel.app npx tsx scripts/byo-sandbox-check.mts
// Flow: bad creds are refused → connect real sandbox creds (new key) → status → remote MCP hold (card_on_file)
// → capture_hold → status → the order is read back with the developer's own credentials → forget → the key
// is refused. Prints ids only; the secret is never printed.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const site = (process.env.SITE ?? "https://mcpal.vercel.app").replace(/\/$/, "");
const env = Object.fromEntries(
  readFileSync(process.env.BYO_ENV_FILE!, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
);
const clientId = env.PAYPAL_CLIENT_ID!;
const clientSecret = env.PAYPAL_CLIENT_SECRET!;

const byo = async (body: Record<string, string>) => {
  const r = await fetch(`${site}/api/remote/byo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json()) as any };
};
const show = (label: string, v: unknown) => console.log(`\n## ${label}\n${JSON.stringify(v)}`);

show("connect with a wrong secret", await byo({ action: "connect", clientId, clientSecret: "WrongSecret_" + "x".repeat(40) }));
const c = await byo({ action: "connect", clientId, clientSecret });
show("connect with the developer's sandbox app", { status: c.status, clientId: c.data.clientId, mode: c.data.mode, key: c.data.key ? "<key>" : c.data });
const key: string = c.data.key;
if (!key) process.exit(1);
show("status", (await byo({ action: "status", key })).data);

const client = new Client({ name: "mcpal-byo-check", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${site}/mcp?key=${key}`)));
const ref = `byo-${Date.now().toString(36)}`;
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  const out = JSON.parse(r.content[0].text);
  show(`${name} ${JSON.stringify(args)}`, out);
  return out;
};
const h = await call("hold", { orderRef: ref, amount: "120.00", deposit: "40.00", method: "card_on_file", description: "BYO sandbox check" });
await call("capture_hold", { orderRef: ref });
await call("status", { orderRef: ref });
await client.close();

// Read the order back with the developer's own credentials: it lives on their sandbox account.
const orderId = h?.paypal?.ids?.orderId ?? h?.paypal?.ids?.order_id;
if (orderId) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tok = (await (await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json()) as any;
  const o = (await (await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()) as any;
  show("order read back with the developer's credentials", { id: o.id, status: o.status, intent: o.intent, payee: o.purchase_units?.[0]?.payee?.merchant_id });
}

show("forget", (await byo({ action: "forget", key })).data);
show("status after forget", (await byo({ action: "status", key })).data);
const after = await fetch(`${site}/mcp?key=${key}`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: { orderRef: ref } } }),
});
show("remote MCP call after forget", { http: after.status, body: await after.json() });
