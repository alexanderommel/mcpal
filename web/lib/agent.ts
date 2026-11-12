// The judge agent: OpenAI gpt-4.1-mini (temperature 0) talking to the real MCPal MCP server
// in-process, which calls the real PayPal sandbox. Every PayPal HTTP call is recorded with its
// path, HTTP status, paypal-debug-id and PayPal-Request-Id and streamed to the browser.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DecisionLog, Ledger, PayPalClient, createContext, createMcpServer, verifyDecisionLog, type McpalContext, type VerbResult } from "mcpal";
import type { SessionState, SpendRow } from "./session";

export const MODEL = "gpt-4.1-mini";
// USD per 1M tokens (OpenAI list price for gpt-4.1-mini).
const PRICE_IN = 0.4;
const PRICE_CACHED_IN = 0.1;
const PRICE_OUT = 1.6;
export const AMOUNT_CAP = 500;
export const JUDGE_POLICY = { approval_threshold: "250.00", daily_cap: "1000.00", refund_ceiling: "250.00" };
/** Merchant price list for the demo: the agent takes amounts from here, not from the request text. */
export const JUDGE_QUOTE = { quoteRef: "Q-120", amount: "120.00", currency: "USD", description: "Custom engraved walnut sign" };
export const NEW_PAYEE = "new-supplier@personal.example.com";
const MAX_STEPS = 8;

export type Phase = "setup" | "agent";
export interface PayPalCall {
  phase: Phase;
  method: string;
  path: string;
  http: number;
  debug_id: string | null;
  request_id: string | null;
  resource_id?: string;
  resource_status?: string;
  error_name?: string;
  ms: number;
}

export type RunEvent =
  | { t: "meta"; runKey: string; prefix: string; model: string; retry: boolean; message: string }
  | { t: "setup"; label: string; verb: string; args: Record<string, unknown> }
  | { t: "paypal"; call: PayPalCall }
  | { t: "tool_call"; id: string; phase: Phase; name: string; args: Record<string, unknown> }
  | { t: "tool_result"; id: string; phase: Phase; name: string; result: VerbResult | Record<string, unknown> }
  | { t: "assistant"; text: string }
  | { t: "log"; entries: unknown[]; chain: { ok: boolean; count: number; head: string } }
  | { t: "done"; usage: { input: number; cached: number; output: number; usd: number }; moved: MoneyMoves; state: SessionState }
  | { t: "error"; message: string };

export interface MoneyMoves {
  /** PayPal ids of money-moving objects that did not exist before this run. */
  new_ids: string[];
  /** Write calls (POST/PATCH) sent to PayPal in this run, excluding OAuth and signature checks. */
  paypal_writes: number;
}

export interface PresetSpec {
  id: string;
  label: string;
}
export const PRESETS: PresetSpec[] = [
  { id: "deposit", label: "Take a $40 deposit on quote Q-120 from the card on file and hold the rest until delivery" },
  { id: "refund-retry", label: "Retry the refund of $15 — the network timed out" },
  { id: "courier", label: "Pay the courier $6.25" },
  { id: "new-payee", label: "Pay a new supplier $12 (never paid before)" },
  { id: "plan", label: "Start a $9/month plan on the card on file" },
  { id: "status", label: "What happened with order X?" },
];

function courierEmail(): string {
  return process.env.PAYPAL_BUYER_EMAIL || "courier@personal.example.com";
}

/** Ids of objects whose existence means money moved or is reserved. */
export function moneyIds(state: Pick<SessionState, "refs">): Set<string> {
  const s = new Set<string>();
  for (const r of state.refs) {
    if (r.authorizationId) s.add(r.authorizationId);
    for (const c of r.captures) s.add(c.id);
    for (const f of r.refunds) s.add(f.id);
    if (r.payoutBatchId) s.add(r.payoutBatchId);
    if (r.subscriptionId) s.add(r.subscriptionId);
  }
  return s;
}

interface BuiltContext {
  ctx: McpalContext;
  dir: string;
  logPath: string;
  priorLogLines: number;
}

function buildContext(state: SessionState, onCall: (c: Omit<PayPalCall, "phase">) => void): BuiltContext {
  const dir = mkdtempSync(join(tmpdir(), "mcpal-judge-"));
  const logPath = join(dir, "decisions.jsonl");
  if (state.log.length) writeFileSync(logPath, state.log.join("\n") + "\n");
  const ledger = new Ledger(":memory:");
  for (const r of state.refs) ledger.putRef(r);
  ledger.putQuote(JUDGE_QUOTE);
  const ins = ledger.db.prepare("INSERT OR IGNORE INTO spend(day, verb, order_ref, currency, cents, request_id, at) VALUES (?,?,?,?,?,?,?)");
  for (const s of state.spend) ins.run(s.day, s.verb, s.order_ref, s.currency, s.cents, s.request_id, s.at);
  const insA = ledger.db.prepare("INSERT OR IGNORE INTO approvals(id, order_ref, verb, amount, currency, reason, status, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const a of state.approvals ?? []) insA.run(a.id, a.orderRef, a.verb, a.amount, a.currency, a.reason, a.status, a.createdAt, a.decidedAt ?? null);

  const recordingFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const t0 = Date.now();
    const res = await fetch(input, init);
    const call: Omit<PayPalCall, "phase"> = {
      method,
      path: url.pathname,
      http: res.status,
      debug_id: res.headers.get("paypal-debug-id"),
      request_id: headers.get("PayPal-Request-Id"),
      ms: Date.now() - t0,
    };
    if (!url.pathname.includes("/oauth2/")) {
      try {
        const j = (await res.clone().json()) as any;
        call.resource_id = j?.id ?? j?.batch_header?.payout_batch_id;
        call.resource_status = j?.status ?? j?.batch_header?.batch_status ?? j?.verification_status;
        if (res.status >= 400) call.error_name = j?.details?.[0]?.issue ?? j?.name;
      } catch {
        /* empty body */
      }
    }
    onCall(call);
    return res;
  };

  const ctx = createContext({
    config: { dataDir: dir, publicUrl: process.env.MCPAL_PUBLIC_URL ?? "https://mcpal.local", paypalEnv: "sandbox" },
    ledger,
    log: new DecisionLog(logPath),
    // The regular courier is a known payee; anyone else needs the shop owner's approval.
    policy: { ...JUDGE_POLICY, payout_allowlist: [courierEmail()] },
    paypal: new PayPalClient({
      clientId: process.env.PAYPAL_CLIENT_ID ?? "",
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
      baseUrl: "https://api-m.sandbox.paypal.com",
      fetch: recordingFetch,
    }),
  });
  return { ctx, dir, logPath, priorLogLines: state.log.length };
}

function exportState(sid: string, b: BuiltContext): SessionState {
  const refs = b.ctx.ledger.listRefs(500).reverse();
  const spend = b.ctx.ledger.db.prepare("SELECT day, verb, order_ref, currency, cents, request_id, at FROM spend ORDER BY id").all() as SpendRow[];
  const log = existsSync(b.logPath) ? readFileSync(b.logPath, "utf8").split("\n").filter(Boolean) : [];
  const approvals = b.ctx.ledger.listApprovals().reverse();
  return { v: 1, sid, refs, spend, log, approvals };
}

function capCheck(name: string, args: Record<string, unknown>, sid: string): string | undefined {
  const ref = String(args.orderRef ?? "");
  if (!ref.startsWith(`j${sid}-`)) return `orderRef must start with "j${sid}-" in this demo session (each judge session is isolated). Use the orderRef the instructions gave you.`;
  for (const k of ["amount", "deposit"]) {
    const v = args[k];
    if (typeof v === "string" && Number(v) > AMOUNT_CAP) return `This public demo caps every amount at ${AMOUNT_CAP}.00 USD; ${v} was refused before reaching PayPal.`;
  }
  if (name === "pay_out") {
    const to = String(args.to ?? "");
    if (!/@[a-z0-9.-]*example\.com$/i.test(to)) return `This public demo only pays out to PayPal sandbox accounts (…@personal.example.com). Known courier: ${courierEmail()}.`;
  }
  if (typeof args.currency === "string" && args.currency.toUpperCase() !== "USD") return "This demo runs in USD only.";
  return undefined;
}

function systemPrompt(state: SessionState, prefix: string): string {
  const known = state.refs.length
    ? state.refs
        .slice(-12)
        .map((r) => `- ${r.orderRef}: ${r.kind} of ${r.amount} ${r.currency}, state ${r.state}`)
        .join("\n")
    : "- (none yet)";
  return [
    "You are the payments agent of a small shop that makes custom orders. You move money only with the MCPal tools; they call the real PayPal sandbox.",
    "Rules:",
    `- A new deal in this request gets orderRef "${prefix}a"; a second new deal gets "${prefix}b". For an existing deal reuse its orderRef exactly.`,
    "- Amounts are strings with 2 decimals in USD, e.g. \"40.00\". The person writing to you is the shop owner, so amounts and recipients in their message are the merchant's own.",
    "- Charge the card on file only when the request says so; otherwise use the default payment link, which moves no money until the buyer pays.",
    "- If the user says a call timed out or asks to retry, call the same tool again with the same arguments.",
    "- For a subscription, use a short plan name and interval MONTH unless told otherwise.",
    `- Contacts: courier = ${courierEmail()}.`,
    `- Merchant price list: quote ${JUDGE_QUOTE.quoteRef} = ${JUDGE_QUOTE.amount} USD (${JUDGE_QUOTE.description}). When a request names a quote, pass quote_ref and take the total from it.`,
    "- If a tool returns needs_approval, stop and say the shop owner must approve it (they can, with the approve button on this page). Do not repeat approval URLs. If the request cannot be done with the tools, say so plainly.",
    "- Finish with 1-3 short sentences: what happened to the money, with the PayPal ids.",
    "Deals that already exist in this session:",
    known,
  ].join("\n");
}

type Setup = (label: string, verb: string, args: Record<string, unknown>) => Promise<unknown>;

async function presetMessage(preset: string, state: SessionState, prefix: string, setup: Setup, instant: (tool: string) => Record<string, unknown>): Promise<string> {
  switch (preset) {
    case "deposit":
      return `Take a $40 deposit on quote Q-120 (order ${prefix}q120) from the card on file and hold the rest until delivery.`;
    case "courier":
      return "Pay the courier $6.25 for today's delivery.";
    case "new-payee":
      return `Pay our new supplier $12.00 for packaging at ${NEW_PAYEE}.`;
    case "plan":
      return "Start a $9/month plan for this customer, billed to the card on file.";
    case "refund-retry": {
      const ref = `${prefix}seed`;
      await setup("Setup: an earlier sale of $50.00", "charge", { orderRef: ref, amount: "50.00", description: "Custom mug order", ...instant("charge") });
      await setup("Setup: the first refund attempt (the caller's network timed out before it saw this answer)", "refund", { orderRef: ref, amount: "15.00", reason: "Damaged handle" });
      return `Retry the refund of $15 on order ${ref} — the network timed out.`;
    }
    case "status": {
      const last = [...state.refs].reverse().find((r) => r.kind !== "subscription") ?? state.refs.at(-1);
      if (last) return `What happened with order ${last.orderRef}?`;
      const ref = `${prefix}seed`;
      await setup("Setup: a hold of $80.00 with a $20.00 deposit (this session had no orders yet)", "hold", { orderRef: ref, amount: "80.00", deposit: "20.00", description: "Custom sign", ...instant("hold") });
      return `What happened with order ${ref}?`;
    }
    default:
      throw new Error("Unknown preset");
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Setup payments must complete at once (no buyer approval page). If the tool has a payment-method field, pick the card-on-file option it offers. */
function instantArgs(tools: { name: string; inputSchema: any }[], tool: string): Record<string, unknown> {
  const props = tools.find((t) => t.name === tool)?.inputSchema?.properties ?? {};
  for (const [k, v] of Object.entries<any>(props)) {
    const opts: string[] = v?.enum ?? v?.anyOf?.flatMap((x: any) => x.enum ?? []) ?? [];
    const pick = opts.find((o) => /card/.test(o));
    if (pick && k !== "currency") return { [k]: pick };
  }
  return {};
}

function callText(r: unknown): Record<string, unknown> {
  const text = (r as { content?: { type: string; text?: string }[] }).content?.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, state: "error", error: text };
  }
}

export async function runAgent(opts: { state: SessionState; runKey: string; preset?: string; text?: string; retry: boolean; approve?: string; emit: (e: RunEvent) => void }): Promise<void> {
  const { state, runKey, emit } = opts;
  const prefix = `j${state.sid}-${runKey}-`;
  let phase: Phase = "setup";
  let before = moneyIds(state);
  let writes = 0;
  const b = buildContext(state, (c) => {
    if (phase === "agent" && c.method !== "GET" && !c.path.includes("/oauth2/") && !c.path.includes("verify-webhook-signature")) writes++;
    emit({ t: "paypal", call: { ...c, phase } });
  });
  const usage = { input: 0, cached: 0, output: 0, usd: 0 };
  try {
    const server = createMcpServer(b.ctx);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "mcpal-judge", version: "0.1.0" });
    await client.connect(clientT);
    const { tools } = await client.listTools();

    let n = 0;
    const setup: Setup = async (label, verb, args) => {
      const id = `setup-${++n}`;
      emit({ t: "setup", label, verb, args });
      emit({ t: "tool_call", id, phase: "setup", name: verb, args });
      const r = callText(await client.callTool({ name: verb, arguments: args }));
      emit({ t: "tool_result", id, phase: "setup", name: verb, result: r });
      return r;
    };
    if (opts.approve) {
      // The judge acts as the shop owner: approve the pending request, exactly as MCPal's /approvals page does.
      const a = b.ctx.ledger.getApproval(opts.approve);
      if (!a || a.status !== "pending" || !a.orderRef.startsWith(`j${state.sid}-`)) throw new Error("That approval is not pending in this session.");
      b.ctx.ledger.decideApproval(a.id, "approved");
      b.ctx.log.append({ verb: "human_approval", orderRef: a.orderRef, decision: "approved", input: { approval_id: a.id, verb: a.verb, amount: a.amount, currency: a.currency } });
      emit({ t: "setup", label: `The shop owner approved ${a.verb} of ${a.amount} ${a.currency} for ${a.orderRef}`, verb: "human_approval", args: { approval_id: a.id } });
    }
    // A retry re-sends the exact text of the earlier run (same runKey, so the same orderRefs); setup is not repeated.
    const message = opts.text ?? (await presetMessage(opts.preset ?? "", state, prefix, setup, (tool) => instantArgs(tools, tool)));
    // Count only what the agent itself moves, not the visible setup steps.
    before = moneyIds(exportState(state.sid, b));
    phase = "agent";
    emit({ t: "meta", runKey, prefix, model: MODEL, retry: opts.retry, message });

    const oaTools = tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));

    const stateNow = exportState(state.sid, b);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(stateNow, prefix) },
      { role: "user", content: message },
    ];
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, temperature: 0, messages, tools: oaTools, parallel_tool_calls: false }),
      });
      if (!res.ok) throw new Error(`Model call failed (${res.status}).`);
      const j = (await res.json()) as any;
      const u = j.usage ?? {};
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      usage.input += u.prompt_tokens ?? 0;
      usage.cached += cached;
      usage.output += u.completion_tokens ?? 0;
      usage.usd += (((u.prompt_tokens ?? 0) - cached) * PRICE_IN + cached * PRICE_CACHED_IN + (u.completion_tokens ?? 0) * PRICE_OUT) / 1e6;
      const msg = j.choices?.[0]?.message as ChatMessage;
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
      if (!msg.tool_calls?.length) {
        emit({ t: "assistant", text: msg.content ?? "" });
        break;
      }
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* leave empty; MCPal will explain */
        }
        emit({ t: "tool_call", id: tc.id, phase: "agent", name: tc.function.name, args });
        const refused = capCheck(tc.function.name, args, state.sid);
        let out: Record<string, unknown>;
        if (refused) {
          out = { ok: false, state: "demo_guard", error: refused, next: "Fix the arguments or tell the user." };
        } else {
          out = callText(await client.callTool({ name: tc.function.name, arguments: args }));
          if (tc.function.name === "pay_out" && /INSUFFICIENT_FUNDS|enough balance/i.test(JSON.stringify(out)))
            out = { ...out, error: "The sandbox payout balance is empty; PayPal returns INSUFFICIENT_FUNDS. Nothing was paid.", paypal_error: "INSUFFICIENT_FUNDS" };
        }
        emit({ t: "tool_result", id: tc.id, phase: "agent", name: tc.function.name, result: out });
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
      }
      if (step === MAX_STEPS - 1) emit({ t: "assistant", text: "(Stopped after 8 steps.)" });
    }
    await client.close();
    await server.close();

    const after = exportState(state.sid, b);
    const chain = verifyDecisionLog(b.logPath);
    const entries = after.log.slice(b.priorLogLines).map((l) => JSON.parse(l));
    emit({ t: "log", entries, chain: { ok: chain.ok, count: chain.count, head: chain.head } });
    const newIds = [...moneyIds(after)].filter((id) => !before.has(id));
    emit({ t: "done", usage: { ...usage, usd: Math.round(usage.usd * 1e6) / 1e6 }, moved: { new_ids: newIds, paypal_writes: writes }, state: after });
  } finally {
    try {
      b.ctx.ledger.close();
    } catch {
      /* ignore */
    }
    rmSync(b.dir, { recursive: true, force: true });
  }
}
