// Merchant-side order actions (MCPal extension, not UCP): POST /orders/{id}/ship | release | refund.
// ship = capture_hold (ship-later orders), release = void_hold, refund = refund. Needs the merchant key
// (MCPAL_MERCHANT_KEY) except on the hosted demo merchant, where it is rate limited per IP instead.
import { clientIp, takeIp } from "@/lib/remote";
import { CORS, UcpError, handle, idempotent, orderAction, readBody } from "@/lib/commerce/ucp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type P = { params: Promise<{ id: string; action: string }> };
export async function POST(req: Request, { params }: P): Promise<Response> {
  return handle(async () => {
    const { id, action } = await params;
    if (action !== "ship" && action !== "release" && action !== "refund") throw new UcpError(404, "not_found", "Unknown order action. Use ship, release or refund.");
    const want = process.env.MCPAL_MERCHANT_KEY;
    if (want && req.headers.get("authorization") !== `Bearer ${want}`) throw new UcpError(401, "unauthorized", "Merchant actions need the merchant key.");
    if (!want) {
      const lim = await takeIp(clientIp(req), Date.now(), "ucp-merchant", 20);
      if (!lim.ok) throw new UcpError(429, "rate_limited", `Too many merchant actions from this network; try again in about ${lim.retryInMin} min.`);
    }
    const body = await readBody(req);
    return idempotent(req, `${action}:${id}`, body, () => orderAction(id, action, body));
  });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
