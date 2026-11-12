// ACP: POST /checkout_sessions/{id}/cancel
import { ACP_CORS, acpHandle, acpHeaders } from "@/lib/commerce/acp";
import { UcpError, idempotent, readBody } from "@/lib/commerce/ucp";
import { acpCancel } from "@/lib/commerce/acp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type P = { params: Promise<{ id: string }> };
export async function POST(req: Request, { params }: P): Promise<Response> {
  return acpHandle(async () => {
    acpHeaders(req);
    if (!req.headers.get("idempotency-key")) throw new UcpError(400, "missing_idempotency_key", "ACP requires an Idempotency-Key header on every POST.");
    const id = (await params).id;
    const body = await readBody(req);
    return idempotent(req, `acp-cancel:${id}`, body, () => acpCancel(id));
  });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: ACP_CORS });
}
