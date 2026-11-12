/**
 * Smoke test of the built server: stdio tools/list, HTTP tools/list + /healthz, and a status call.
 *   npm run build && npx tsx scripts/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "mcpal-smoke-"));
const env = { ...(process.env as Record<string, string>), MCPAL_DATA_DIR: dataDir };

const stdio = new Client({ name: "smoke", version: "0" });
await stdio.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"], env }));
const t1 = await stdio.listTools();
console.log(`stdio: ${t1.tools.length} tools: ${t1.tools.map((t) => t.name).join(", ")}`);
const st = await stdio.callTool({ name: "status", arguments: { orderRef: "does-not-exist" } });
console.log(`stdio status call: ${(st.content as any)[0].text.slice(0, 160)}`);
await stdio.close();

const port = 18787;
const child = spawn("node", ["dist/server.js", "--http", "--port", String(port)], { env, stdio: ["ignore", "ignore", "inherit"] });
try {
  await new Promise((r) => setTimeout(r, 800));
  const http = new Client({ name: "smoke", version: "0" });
  await http.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
  const t2 = await http.listTools();
  console.log(`http: ${t2.tools.length} tools`);
  await http.close();
  const h = await fetch(`http://localhost:${port}/healthz`).then((r) => r.json());
  console.log(`healthz: ${JSON.stringify(h)}`);
  const w = await fetch(`http://localhost:${port}/webhooks/paypal`, { method: "POST", body: "{}" });
  console.log(`webhook without headers -> ${w.status}`);
} finally {
  child.kill();
}
