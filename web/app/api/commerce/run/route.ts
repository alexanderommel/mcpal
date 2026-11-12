// "Run the buyer agent" on /commerce: one live gpt-4.1-mini buyer-agent run against this site's UCP
// endpoints (PayPal sandbox). Rate limited: 3 runs per IP per hour and 30 per hour site-wide.
import { SITE_URL, clientIp, takeIp } from "@/lib/remote";
import { runBuyerAgent } from "@/lib/commerce/buyerAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: "The buyer agent is not configured on this deployment." }, { status: 503 });
  const ip = await takeIp(clientIp(req), Date.now(), "commerce-run", 3);
  if (!ip.ok) return Response.json({ error: `You ran the buyer agent 3 times this hour. Try again in about ${ip.retryInMin} min.` }, { status: 429 });
  const all = await takeIp("all", Date.now(), "commerce-run-global", 30);
  if (!all.ok) return Response.json({ error: `The buyer agent reached its hourly limit for the whole site. Try again in about ${all.retryInMin} min.` }, { status: 429 });
  try {
    const run = await runBuyerAgent({ siteUrl: SITE_URL, openaiKey: key });
    return Response.json(run, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
