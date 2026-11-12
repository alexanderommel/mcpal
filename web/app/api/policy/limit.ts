// Rate limits for the policy playground. In memory, per server instance (best effort on serverless).
const HOUR = 60 * 60 * 1000;
const buckets = new Map<string, number[]>();
let dayStart = Date.now();
let compilesToday = 0;
export const COMPILES_PER_HOUR = 15;
export const COMPILES_PER_DAY_PER_INSTANCE = 400; // keeps model spend bounded (~US$0.0005 per compile)

export function ipOf(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}

export function hit(key: string, perHour: number, now = Date.now()): { ok: boolean; retryInMin: number } {
  const list = (buckets.get(key) ?? []).filter((t) => now - t < HOUR);
  if (list.length >= perHour) {
    buckets.set(key, list);
    return { ok: false, retryInMin: Math.ceil((HOUR - (now - list[0]!)) / 60000) };
  }
  list.push(now);
  buckets.set(key, list);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.some((t) => now - t < HOUR)) buckets.delete(k);
  return { ok: true, retryInMin: 0 };
}

export function dailyBudget(now = Date.now()): boolean {
  if (now - dayStart > 24 * HOUR) {
    dayStart = now;
    compilesToday = 0;
  }
  compilesToday++;
  return compilesToday <= COMPILES_PER_DAY_PER_INSTANCE;
}
