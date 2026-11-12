// Read-only: the hash-chained decision log of one demo key's remote MCP ledger, for /ledger.
// Only the holder of the key can read it; the browser re-verifies the hash chain itself.
import { clientIp, keyFrom, loadState, nsOf } from "@/lib/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const READS_PER_HOUR = 120;
const hits = new Map<string, number[]>();

export async function GET(req: Request): Promise<Response> {
  const key = keyFrom(req);
  if (!key) return Response.json({ error: "Send your demo key as ?key= or Authorization: Bearer." }, { status: 400 });
  const ip = clientIp(req);
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < HOUR);
  if (list.length >= READS_PER_HOUR) return Response.json({ error: "Too many reads from this address; try again later." }, { status: 429 });
  list.push(now);
  hits.set(ip, list);
  try {
    const state = await loadState(nsOf(key));
    return Response.json(
      { ns: state.ns, log: state.log, refs: state.refs.length, approvals: state.approvals.filter((a) => a.status === "pending").length },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
