import { DEFAULT_POLICY, MAX_POLICY_TEXT, compilePolicy, validatePolicy } from "mcpal/policy-ai";
import { COMPILES_PER_HOUR, dailyBudget, hit, ipOf } from "../limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Compile merchant text into a PROPOSED policy. Applies nothing; there is no write path here. */
export async function POST(req: Request): Promise<Response> {
  let body: { text?: unknown; current?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "Write at least one rule." }, { status: 400 });
  if (text.length > MAX_POLICY_TEXT) return Response.json({ error: `Keep it under ${MAX_POLICY_TEXT} characters.` }, { status: 400 });
  const cur = body.current === undefined ? { ok: true, policy: { ...DEFAULT_POLICY }, errors: [] } : validatePolicy(body.current);
  if (!cur.ok || !cur.policy) return Response.json({ error: `Current policy is invalid: ${cur.errors.join(" ")}` }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "The demo server has no OpenAI key." }, { status: 503 });

  const lim = hit(`compile:${ipOf(req)}`, COMPILES_PER_HOUR);
  if (!lim.ok) return Response.json({ error: `Rate limit: ${COMPILES_PER_HOUR} compiles per hour. Try again in about ${lim.retryInMin} min.` }, { status: 429 });
  if (!dailyBudget()) return Response.json({ error: "The demo's daily model budget is used up. Try again tomorrow." }, { status: 429 });

  try {
    const r = await compilePolicy(text, cur.policy, { signal: AbortSignal.timeout(25_000) });
    return Response.json({ policy: r.policy, diff: r.diff, warnings: r.warnings, rejected: r.rejected, ignored: r.ignored, model: r.model });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
