// UCP order capability: GET /orders/{id}, with the MCPal settlement (PayPal ids) as an extension field.
import { CORS, checkHeaders, getOrder, handle, json } from "@/lib/commerce/ucp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type P = { params: Promise<{ id: string }> };
export async function GET(req: Request, { params }: P): Promise<Response> {
  return handle(async () => {
    checkHeaders(req);
    const r = await getOrder((await params).id);
    return json(r.body, r.status);
  });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
