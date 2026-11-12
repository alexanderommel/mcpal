// Checks the remote MCP endpoint with the official TypeScript MCP client.
//   MCP_URL="https://mcpal.vercel.app/mcp?key=dk_..." npx tsx scripts/remote-mcp-check.ts
// Without MCP_URL it calls the route handler in-process (needs PayPal sandbox creds; Blob token optional).
// Flow: list tools, hold $120 with a $40 deposit on the sandbox card, retry the same hold (must replay),
// capture the rest, status. Prints PayPal ids.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnv } from "mcpal";

loadEnv();
const url = process.env.MCP_URL ?? `http://local.test/mcp?key=dk_localcheck${Date.now().toString(36)}`;
let fetchImpl: typeof fetch | undefined;
if (!process.env.MCP_URL) {
  const route = await import("../app/mcp/route");
  fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return (route as any)[req.method](req);
  }) as typeof fetch;
}

const client = new Client({ name: "mcpal-remote-check", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), fetchImpl ? { fetch: fetchImpl } : {}));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const ref = process.env.ORDER_REF ?? `chk-${Date.now().toString(36)}`;
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  const out = JSON.parse(r.content[0].text);
  console.log(`\n${name} ${JSON.stringify(args)}\n→ ${JSON.stringify(out)}`);
  return out;
};
await call("hold", { orderRef: ref, amount: "120.00", deposit: "40.00", method: "card_on_file", description: "Remote MCP check" });
await call("hold", { orderRef: ref, amount: "120.00", deposit: "40.00", method: "card_on_file", description: "Remote MCP check" });
if (!process.env.SKIP_CAPTURE) await call("capture_hold", { orderRef: ref });
await call("status", { orderRef: ref });
await call("pay_out", { orderRef: `${ref}-x`, to: "someone@gmail.com", amount: "5.00" });
await call("charge", { orderRef: `${ref}-big`, amount: "900.00" });
await client.close();
