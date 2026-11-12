// Per-IP limit: 10 agent runs per rolling hour. In memory, so per server instance (best effort on serverless).
const WINDOW_MS = 60 * 60 * 1000;
export const RUNS_PER_HOUR = 10;
const hits = new Map<string, number[]>();

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}

export function take(ip: string, now = Date.now()): { ok: boolean; left: number; retryInMin: number } {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= RUNS_PER_HOUR) {
    hits.set(ip, list);
    return { ok: false, left: 0, retryInMin: Math.ceil((WINDOW_MS - (now - list[0]!)) / 60000) };
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return { ok: true, left: RUNS_PER_HOUR - list.length, retryInMin: 0 };
}
