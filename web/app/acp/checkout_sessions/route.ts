// ACP: POST /checkout_sessions (create). Same engine and MCPal settlement as /ucp/v1.
import { ACP_CORS, acpHandle, acpHeaders } from "@/lib/commerce/acp";
import { UcpError, idempotent, readBody } from "@/lib/commerce/ucp";
import { acpCreate } from "@/lib/commerce/acp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  return acpHandle(async () => {
    acpHeaders(req);
    if (!req.headers.get("idempotency-key")) throw new UcpError(400, "missing_idempotency_key", "ACP requires an Idempotency-Key header on every POST.");
    const body = await readBody(req);
    return idempotent(req, "acp-create", body, () => acpCreate(body));
  });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: ACP_CORS });
}
