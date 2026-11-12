// UCP REST: GET /checkout-sessions/{id} and PUT /checkout-sessions/{id} (full replacement update).
import { CORS, checkHeaders, getCheckout, handle, idempotent, json, readBody, updateCheckout } from "@/lib/commerce/ucp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type P = { params: Promise<{ id: string }> };
export async function GET(req: Request, { params }: P): Promise<Response> {
  return handle(async () => {
    checkHeaders(req);
    const r = await getCheckout((await params).id);
    return json(r.body, r.status);
  });
}
export async function PUT(req: Request, { params }: P): Promise<Response> {
  return handle(async () => {
    checkHeaders(req);
    const id = (await params).id;
    const body = await readBody(req);
    return idempotent(req, `update:${id}`, body, () => updateCheckout(id, body));
  });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
