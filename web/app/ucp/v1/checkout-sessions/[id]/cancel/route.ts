// UCP REST: POST /checkout-sessions/{id}/cancel
import { CORS, cancelCheckout, checkHeaders, handle, idempotent, readBody } from "@/lib/commerce/ucp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type P = { params: Promise<{ id: string }> };
export async function POST(req: Request, { params }: P): Promise<Response> {
  return handle(async () => {
    checkHeaders(req);
    const id = (await params).id;
    const body = await readBody(req);
    return idempotent(req, `cancel:${id}`, body, () => cancelCheckout(id));
  });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
