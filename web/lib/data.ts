// Build-time readers for files in the repo (docs/, bench/results/). Server components only.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DecisionLog, Ledger, createContext, createMcpServer } from "mcpal";

const ROOT = join(process.cwd(), "..");

function readJson<T>(rel: string): T | undefined {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export interface OfficialTools {
  package: string;
  count: number;
  listed_at: string;
  command: string;
  tools: { name: string }[];
}

export function officialTools(): OfficialTools {
  const t = readJson<OfficialTools>("docs/official-tools.json");
  if (!t) throw new Error("docs/official-tools.json is missing");
  return t;
}

export interface ProofStep {
  ok: boolean;
  state: string;
  ids: Record<string, string | string[]>;
  debug_id?: string;
  details?: Record<string, unknown>;
}
export interface SandboxProof {
  run: string;
  at: string;
  proof: Record<string, ProofStep | Record<string, unknown>>;
}

export function sandboxProof(): SandboxProof {
  const p = readJson<SandboxProof>("docs/sandbox-proof.json");
  if (!p) throw new Error("docs/sandbox-proof.json is missing");
  return p;
}

export interface BenchArm {
  arm: string;
  tasks: number;
  runs: number;
  reps: number;
  passAll: number;
  successRate: number;
  supportedTasks?: number;
  duplicates: number;
  wrongAmount: number;
  unexpected: number;
  misMovedUsd: number;
  tokensPerTask: number;
  costPerTaskUsd: number;
  toolCount: number;
  toolSchemaChars: number;
  passAny: number;
  runSuccess: number;
  meanTasksPerRun: number;
  runsWithBadMoney: number;
  failureKinds: Record<string, number>;
  toolCallsPerTask: number;
  modelCallsPerTask: number;
  totalCostUsd: number;
  passAllIds: string[];
}
export interface TaskRun {
  rep: number;
  success: boolean;
  kind?: string;
  reason: string;
}
export interface Notable {
  arm: string;
  task: string;
  rep: number;
  reason: string;
  misMovedUsd: number;
  movements: string[];
}
export interface BenchSummary {
  runIds: string[];
  model: string;
  tasks: number;
  headline?: Record<string, number>;
  arms: Record<string, BenchArm>;
  subsets?: Record<string, Record<string, { n: number; passAll: number }>>;
  perTask: Record<string, Record<string, TaskRun[]>>;
  notable: Notable[];
}

/**
 * Flip to true only when the benchmark owner says bench/results/summary.json is the final run.
 * Until then the site shows "benchmark running" and never the numbers in that file.
 */
export const BENCH_FINAL = true;

/** bench/results/summary.json written by the benchmark; undefined while it is not final. */
export function benchSummary(): BenchSummary | undefined {
  if (!BENCH_FINAL) return undefined;
  const s = readJson<BenchSummary>("bench/results/summary.json");
  if (!s || !s.arms?.official || !s.arms?.mcpal) return undefined;
  return s;
}

/** Group the official tool names by PayPal area, for the side-by-side picture. */
export function groupOfficial(names: string[]): { area: string; tools: string[] }[] {
  const areas: [string, RegExp][] = [
    ["Invoices", /invoice/],
    ["Orders", /order/],
    ["Catalog products", /product/],
    ["Subscriptions", /subscription/],
    ["Shipment tracking", /shipment/],
    ["Disputes", /dispute/],
    ["Reporting", /transaction/],
    ["Refunds", /refund/],
  ];
  const out = areas.map(([area]) => ({ area, tools: [] as string[] }));
  const other: string[] = [];
  for (const n of names) {
    const i = areas.findIndex(([, re]) => re.test(n));
    if (i >= 0) out[i]!.tools.push(n);
    else other.push(n);
  }
  if (other.length) out.push({ area: "Other", tools: other });
  return out.filter((g) => g.tools.length);
}

export interface McpalTool {
  name: string;
  description: string;
  params: string[];
  required: string[];
}

/** The verbs exactly as the MCPal MCP server lists them (read from the built library, never hardcoded). */
export async function mcpalTools(): Promise<McpalTool[]> {
  const dir = mkdtempSync(join(tmpdir(), "mcpal-tools-"));
  try {
    const ctx = createContext({ config: { dataDir: dir }, ledger: new Ledger(":memory:"), log: new DecisionLog(join(dir, "d.jsonl")) });
    const server = createMcpServer(ctx);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "mcpal-web-build", version: "0" });
    await client.connect(c);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools.map((t) => {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      return { name: t.name, description: t.description ?? "", params: Object.keys(schema.properties ?? {}), required: schema.required ?? [] };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Which PayPal REST API a verb lands on, matched by name so renamed verbs still map. */
export function apiFor(name: string): string {
  const rules: [RegExp, string][] = [
    [/^charge$/, "Orders v2: create + capture (or a buyer approval link)"],
    [/^hold$/, "Orders v2 authorize; Payments v2 capture for the deposit"],
    [/release|capture/, "Payments v2: capture authorization, then void the rest"],
    [/cancel|void/, "Payments v2 void; Subscriptions cancel; Payouts cancel item"],
    [/refund/, "Payments v2: refund a capture"],
    [/pay_?out/, "Payouts v1: create batch"],
    [/subscribe/, "Catalog Products + Billing Plans + Subscriptions v1"],
    [/status/, "GET on orders, authorizations, captures, refunds, payouts, subscriptions"],
  ];
  return rules.find(([re]) => re.test(name))?.[1] ?? "";
}

/** True when the verb covers a PayPal area that the official toolkit has no tool for. */
export function missingFromOfficial(name: string, official: string[]): boolean {
  if (/hold|release|capture|void/.test(name)) return !official.some((n) => /authoriz|capture/.test(n));
  if (/pay_?out/.test(name)) return !official.some((n) => /payout/.test(n));
  return false;
}

/** MCPal's first version, kept by the benchmark as run1-pre-fix (same tasks, same model). */
export function benchPreFix(): BenchSummary | undefined {
  if (!BENCH_FINAL) return undefined;
  const s = readJson<BenchSummary>("bench/results/run1-pre-fix/summary.json");
  return s?.arms?.mcpal ? s : undefined;
}

/** The chart the benchmark report draws (our own SVG file). */
export function benchChartSvg(): string | undefined {
  const p = join(ROOT, "bench/results/chart.svg");
  return BENCH_FINAL && existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

export interface BenchTask {
  id: string;
  category: string;
  officialSupported: boolean;
  /** The merchant request the agent gets ({tag} is a per-run prefix). */
  prompt: string;
}

function promptOf(block: string): string {
  const lines = block.split("\n");
  const i = lines.findIndex((l) => /^\s*prompt:/.test(l));
  if (i < 0) return "";
  const first = lines[i]!.replace(/^\s*prompt:\s*/, "");
  if (!/^[|>]/.test(first)) return first.replace(/^["']|["']$/g, "");
  const indent = lines[i]!.search(/\S/);
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    out.push(l.trim());
  }
  return out.join(" ").trim();
}

/** Task id, category and official_supported from bench/tasks/*.yaml (flat keys, read with a regex). */
export function benchTasks(): BenchTask[] {
  const dir = join(ROOT, "bench/tasks");
  if (!existsSync(dir)) return [];
  const out: BenchTask[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const block of text.split(/\n\s*- id:\s*/).slice(1)) {
      const id = block.split("\n")[0]!.trim();
      const category = /\n\s*category:\s*(\S+)/.exec(block)?.[1] ?? "other";
      const officialSupported = !/\n\s*official_supported:\s*false/.test(block);
      out.push({ id, category, officialSupported, prompt: promptOf(block).replace(/\{tag\}-?/g, "") });
    }
  }
  return out;
}

/** Tasks where an arm has fewer valid runs than planned (e.g. sandbox payout balance ran out). */
export function shortTasks(s: BenchSummary, arm: string): { task: string; runs: number }[] {
  const reps = s.arms[arm]?.reps ?? 0;
  return Object.entries(s.perTask)
    .map(([task, arms]) => ({ task, runs: arms[arm]?.length ?? 0 }))
    .filter((t) => t.runs < reps);
}

export function failedTasks(s: BenchSummary, arm: string): { task: string; reason: string }[] {
  const pass = new Set(s.arms[arm]?.passAllIds ?? []);
  return Object.entries(s.perTask)
    .filter(([task]) => !pass.has(task))
    .map(([task, arms]) => ({ task, reason: arms[arm]?.find((r) => !r.success)?.reason ?? "" }));
}

export const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
