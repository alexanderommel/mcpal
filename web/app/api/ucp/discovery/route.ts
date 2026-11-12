// UCP business profile, served at /.well-known/ucp (rewrite in next.config.ts).
import { CORS, discoveryProfile, json } from "@/lib/commerce/ucp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  return json(discoveryProfile(), 200, { "cache-control": "public, max-age=60" });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
