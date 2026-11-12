// UCP REST: POST /checkout-sessions (create). https://ucp.dev/specification/shopping/checkout/rest/
import { CORS, checkHeaders, createCheckout, handle, idempotent, readBody } from "@/lib/commerce/ucp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const agent = checkHeaders(req);
    const body = await readBody(req);
    return idempotent(req, "create", body, () => createCheckout(body, agent));
  });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
