// Human approval for the hosted remote MCP. Only someone holding the demo key (the browser that
// created it) can see or decide an approval; the agent only gets the link.
import { buildRemoteContext, disposeRemote, exportRemote, loadState, nsOf, saveState, withLock } from "@/lib/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: { key?: string; id?: string; ns?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const id = typeof body.id === "string" && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : "";
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(key) || !id) return Response.json({ error: "Send your demo key and the approval id." }, { status: 400 });
  const ns = nsOf(key);
  if (body.ns && body.ns !== ns) return Response.json({ error: "This approval belongs to a different demo key. Open it in the browser where you installed MCPal, or paste that key." }, { status: 403 });
  const action = body.action === "approve" || body.action === "reject" ? body.action : "get";
  try {
    return await withLock(ns, async () => {
      const state = await loadState(ns);
      const b = buildRemoteContext(state);
      try {
        const a = b.ctx.ledger.getApproval(id);
        if (!a) return Response.json({ error: "No such approval for this key." }, { status: 404 });
        if (action === "get") return Response.json({ approval: a });
        if (a.status !== "pending") return Response.json({ approval: a, error: `Already ${a.status}.` }, { status: 409 });
        const decided = b.ctx.ledger.decideApproval(a.id, action === "approve" ? "approved" : "rejected")!;
        b.ctx.log.append({ verb: "human_approval", orderRef: a.orderRef, decision: decided.status, input: { approval_id: a.id, verb: a.verb, amount: a.amount, currency: a.currency } });
        await saveState(exportRemote(state, b));
        return Response.json({ approval: decided });
      } finally {
        disposeRemote(b);
      }
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
