/**
 * Start the official PayPal MCP server (@paypal/mcp@1.8.1, --tools=all) over stdio and record its tools/list.
 * No real token is needed to list tools; a placeholder is passed. Writes docs/official-tools.json.
 *   npx tsx scripts/list-official-tools.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PKG = "@paypal/mcp@1.8.1";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", PKG, "--tools=all"],
  env: { ...(process.env as Record<string, string>), PAYPAL_ACCESS_TOKEN: process.env.PAYPAL_ACCESS_TOKEN ?? "placeholder-token", PAYPAL_ENVIRONMENT: "SANDBOX" },
  stderr: "pipe",
});
const client = new Client({ name: "mcpal-tool-counter", version: "0.1.0" });
await client.connect(transport);
const info = client.getServerVersion();
const { tools } = await client.listTools();
await client.close();

const names = tools.map((t) => t.name);
const has = (re: RegExp) => names.filter((n) => re.test(n));
const gaps = {
  holds_authorize_capture_void: {
    matching_tools: has(/authori|void|capture|reauth/i),
    note: "No tool authorizes an order, captures an authorization (partial or final), voids or reauthorizes. create_order + pay_order only covers intent CAPTURE, so holds/deposits are impossible.",
  },
  payouts: { matching_tools: has(/payout|pay_out|send_money/i), note: "No Payouts v1 tool: agents cannot send money to a person." },
  vault_saved_payment_methods: { matching_tools: has(/vault|payment_token|setup_token|save/i), note: "No vault/payment-token tool: no saved payment methods, no off-session charges." },
  webhook_verification: { matching_tools: has(/webhook/i), note: "No webhook tools: agents cannot verify that money actually moved." },
  idempotency: {
    matching_tools: tools.filter((t) => /request.?id|idempot/i.test(JSON.stringify(t.inputSchema ?? {}))).map((t) => t.name),
    note: "Tools whose input schema exposes a PayPal-Request-Id/idempotency key. Empty means retries can create duplicates.",
  },
};

const out = {
  package: PKG,
  server: info,
  listed_at: new Date().toISOString(),
  command: `npx -y ${PKG} --tools=all (PAYPAL_ACCESS_TOKEN, PAYPAL_ENVIRONMENT=SANDBOX)`,
  count: tools.length,
  tools: tools.map((t) => ({ name: t.name, description: t.description, input_properties: Object.keys((t.inputSchema as any)?.properties ?? {}) })),
  gaps,
};
mkdirSync("docs", { recursive: true });
writeFileSync("docs/official-tools.json", JSON.stringify(out, null, 2) + "\n");
console.log(`${PKG}: ${tools.length} tools`);
console.log(names.join("\n"));
console.log(JSON.stringify(Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, v.matching_tools])), null, 2));
