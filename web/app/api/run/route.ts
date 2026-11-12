import { PRESETS, runAgent, type RunEvent } from "@/lib/agent";
import { clientIp, take } from "@/lib/ratelimit";
import { newSid, sign, verify, type SessionState } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  snapshot?: unknown;
  preset?: string;
  text?: string;
  runKey?: string;
  retry?: boolean;
  approve?: string;
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.OPENAI_API_KEY) {
    return Response.json({ error: "The demo server is missing its PayPal sandbox or OpenAI credentials." }, { status: 503 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 500) : undefined;
  const preset = typeof body.preset === "string" && PRESETS.some((p) => p.id === body.preset) ? body.preset : undefined;
  if (!text && !preset) return Response.json({ error: "Send a preset id or a message." }, { status: 400 });
  const approve = typeof body.approve === "string" && /^[0-9a-f-]{36}$/.test(body.approve) ? body.approve : undefined;
  const runKey = typeof body.runKey === "string" && /^[a-z0-9]{3,8}$/.test(body.runKey) ? body.runKey : Math.random().toString(36).slice(2, 7);

  const ip = clientIp(req);
  const limit = take(ip);
  if (!limit.ok) return Response.json({ error: `Rate limit: 10 runs per hour per IP. Try again in about ${limit.retryInMin} min.` }, { status: 429 });

  let state: SessionState | undefined = body.snapshot ? verify(body.snapshot) : undefined;
  if (body.snapshot && !state) return Response.json({ error: "Session snapshot failed its signature check. Start a new session." }, { status: 400 });
  state ??= { v: 1, sid: newSid(), refs: [], spend: [], log: [] };

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: RunEvent) => {
        const out = e.t === "done" ? { ...e, state: undefined, snapshot: sign(e.state), runsLeft: limit.left } : e;
        controller.enqueue(enc.encode(JSON.stringify(out) + "\n"));
      };
      try {
        await runAgent({ state: state!, runKey, preset, text, retry: !!body.retry, approve, emit });
      } catch (err) {
        emit({ t: "error", message: (err as Error).message || "Run failed." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
