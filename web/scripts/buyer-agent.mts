// Buyer-agent demo: a gpt-4.1-mini shopping agent (temperature 0) buys coffee from Coffee Club Supply
// through the merchant's UCP endpoints only; the merchant settles on the PayPal sandbox via MCPal.
//   BUYER_SITE=https://mcpal.vercel.app npx tsx scripts/buyer-agent.mts      (default: production)
// Writes docs/agentic-commerce-proof.json and docs/agentic-commerce-proof.md (set BUYER_OUT=0 to skip).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "mcpal";
import { runBuyerAgent } from "../lib/commerce/buyerAgent";

loadEnv();
const site = (process.env.BUYER_SITE ?? "https://mcpal.vercel.app").replace(/\/$/, "");
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY is not set");
const run = await runBuyerAgent({ siteUrl: site, openaiKey: key, onStep: (s) => console.log(`[${s.t}${s.name ? ` ${s.name}` : ""}] ${s.text.slice(0, 300)}`) });
const st: any = run.paypal ?? {};
const ids: Record<string, unknown> = st.paypal_ids ?? {};
console.log(`\nstatus=${run.status} order=${run.order_id} total=${run.total_cents} paypal=${JSON.stringify(ids)}`);
if (process.env.BUYER_OUT === "0") process.exit(0);

const docs = join(process.cwd(), "..", "docs");
writeFileSync(join(docs, "agentic-commerce-proof.json"), JSON.stringify({ site, ...run }, null, 2) + "\n");
const fence = "```";
const md = [
  "# Agentic commerce proof: a buyer agent checks out through UCP, the merchant settles on PayPal via MCPal",
  "",
  `Recorded ${run.at} against ${site} (PayPal **sandbox**; no live money). Model: ${run.model}, temperature 0, ${run.steps.filter((s) => s.t === "tool_call").length} tool calls, ${(run.ms / 1000).toFixed(1)} s.`,
  "",
  "The buyer agent only knows the merchant's discovery URL (`/.well-known/ucp`). Its tools are the UCP REST checkout operations; it never sees PayPal, MCPal or any credential beyond an opaque sandbox payment token. On `complete`, the merchant calls MCPal `charge` (card_on_file, PayPal's sandbox test card), so MCPal's policy, PayPal-Request-Id idempotency and hash-chained decision log apply.",
  "",
  `**Task given to the buyer agent:** ${run.task}`,
  "",
  "## Result",
  "",
  "| | |",
  "|---|---|",
  `| checkout | \`${run.checkout_id ?? "-"}\` |`,
  `| status | ${run.status ?? "-"} |`,
  `| total | ${run.total_cents !== undefined ? `$${(run.total_cents / 100).toFixed(2)}` : "-"} |`,
  `| order | \`${run.order_id ?? "-"}\` |`,
  `| MCPal orderRef | \`${st.mcpal_order_ref ?? "-"}\` |`,
  `| MCPal state | ${st.state ?? "-"} |`,
  ...Object.entries(ids).map(([k, v]) => `| PayPal ${k} | \`${Array.isArray(v) ? v.join(", ") : String(v)}\` |`),
  "",
  "## Transcript",
  "",
  ...run.steps.map((s) => {
    const head = s.t === "tool_call" ? `**agent calls ${s.name}**` : s.t === "tool_result" ? `**merchant answers ${s.name}**` : `**${s.t}**`;
    const body = s.t === "tool_result" || s.t === "tool_call" ? `${fence}json\n${s.text.length > 1800 ? s.text.slice(0, 1800) + " …(truncated)" : s.text}\n${fence}` : s.text;
    return `${head}\n\n${body}\n`;
  }),
  "",
  "Merchant decision log: https://mcpal.vercel.app/ledger?source=merchant (source \"merchant checkout (UCP)\").",
  "",
].join("\n");
writeFileSync(join(docs, "agentic-commerce-proof.md"), md);
