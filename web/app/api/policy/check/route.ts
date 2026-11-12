import { defaultTryChecks, runTryChecks, validatePolicy } from "mcpal/policy-ai";
import { hit, ipOf } from "../limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deterministic checks (same checkRules() the MCP server uses). No model, no PayPal. */
export async function POST(req: Request): Promise<Response> {
  let body: { policies?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!hit(`check:${ipOf(req)}`, 120).ok) return Response.json({ error: "Too many checks; wait a few minutes." }, { status: 429 });
  const list = Array.isArray(body.policies) ? body.policies.slice(0, 2) : [];
  if (!list.length) return Response.json({ error: "Send policies: [current, proposed]." }, { status: 400 });
  const out = [];
  for (const p of list) {
    const v = validatePolicy(p);
    if (!v.ok || !v.policy) return Response.json({ error: `Invalid policy: ${v.errors.join(" ")}` }, { status: 400 });
    out.push(v.policy);
  }
  // Same check list for both columns, built from the last (proposed) policy.
  const proposed = out[out.length - 1]!;
  const checks = defaultTryChecks(proposed);
  return Response.json({ results: out.map((p) => runTryChecks(p, checks)) });
}
