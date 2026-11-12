// The sandbox buyer comes back from PayPal: finish the charge or hold for that key's ledger right away
// (same as MCPal's /paypal/return on a self-hosted server).
import { charge, hold, status } from "mcpal";
import { FORGOTTEN_MSG, buildRemoteContext, disposeRemote, exportRemote, loadCreds, loadState, saveState, withLock } from "@/lib/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const page = (msg: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCPal</title><style>body{font:17px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1b1a17;background:#f6f1e7}a{color:#c8401f}</style></head><body><h1>MCPal</h1><p>${msg.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)}</p><p><a href="/">mcpal.app</a></p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

export async function GET(req: Request, { params }: { params: Promise<{ ns: string }> }): Promise<Response> {
  const { ns } = await params;
  if (!/^[0-9a-f]{24}$/.test(ns)) return page("Unknown link.");
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? url.searchParams.get("subscription_id") ?? "";
  if (!token) return page("Thanks. You can close this page.");
  try {
    const kc = await loadCreds(ns);
    if (kc.kind === "forgotten") return page(FORGOTTEN_MSG);
    const msg = await withLock(ns, async () => {
      const state = await loadState(ns);
      const b = buildRemoteContext(state, kc.kind === "byo" ? kc.creds : undefined);
      try {
        const rec = b.ctx.ledger.findRefByPayPalId(token);
        let m = "Thanks. You can close this page and ask your agent for the status.";
        if (rec?.kind === "charge") {
          const r = await charge({ orderRef: rec.orderRef, amount: rec.amount, currency: rec.currency }, b.ctx);
          m = r.ok ? `Payment ${r.state} for ${rec.orderRef}. Your agent can confirm with status.` : `Could not finish the payment: ${r.error}`;
        } else if (rec?.kind === "hold") {
          const r = await hold({ orderRef: rec.orderRef, amount: rec.amount, currency: rec.currency }, b.ctx);
          m = r.ok ? `Hold ${r.state} for ${rec.orderRef}. Your agent can capture or void it now.` : `Could not place the hold: ${r.error}`;
        } else if (rec?.kind === "subscription") {
          const r = await status({ orderRef: rec.orderRef }, b.ctx);
          m = `Subscription ${r.state.replace("subscription_", "")} for ${rec.orderRef}.`;
        }
        await saveState(exportRemote(state, b));
        return m;
      } finally {
        disposeRemote(b);
      }
    });
    return page(msg);
  } catch (err) {
    return page(`Something went wrong: ${(err as Error).message}`);
  }
}
