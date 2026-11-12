// Read-only: the demo merchant's hash-chained MCPal decision log (agent-ready checkout), for /ledger and /commerce.
import { merchantLog } from "@/lib/commerce/merchant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const log = await merchantLog();
    return Response.json({ merchant: "Coffee Club Supply", log: log.slice(-500) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
