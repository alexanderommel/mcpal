"use client";

import { useEffect, useRef, useState } from "react";

interface PresetSpec {
  id: string;
  label: string;
}
interface PayPalCall {
  phase: string;
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
interface Step {
  id: string;
  phase: string;
  name: string;
  label?: string;
  args: Record<string, unknown>;
  result?: Record<string, any>;
  calls: PayPalCall[];
}
interface Run {
  key: string;
  runKey?: string;
  request: { preset?: string; text?: string; retry?: boolean; approve?: string };
  message?: string;
  model?: string;
  retry: boolean;
  steps: Step[];
  answer?: string;
  log?: { entries: any[]; chain: { ok: boolean; count: number; head: string } };
  usage?: { input: number; cached: number; output: number; usd: number };
  moved?: { new_ids: string[]; paypal_writes: number };
  error?: string;
  running: boolean;
}
interface Approval {
  id: string;
  orderRef: string;
  verb: string;
  amount: string;
  currency: string;
  reason: string;
  status: string;
}
interface Snapshot {
  state: { sid: string; refs: { orderRef: string; kind: string; amount: string; currency: string; state: string }[]; approvals?: Approval[] };
  sig: string;
}

const STORE = "mcpal-judge-v1";

function load(): { snapshot?: Snapshot; runs: Run[] } {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage blocked */
  }
  return { runs: [] };
}
function save(snapshot: Snapshot | undefined, runs: Run[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ snapshot, runs: runs.slice(0, 8).map((r) => ({ ...r, running: false })) }));
  } catch {
    /* storage full or blocked */
  }
}

function idsOf(result: Record<string, any> | undefined): string {
  const ids = result?.ids as Record<string, string | string[]> | undefined;
  if (!ids) return "";
  return Object.entries(ids)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join(" · ");
}

function statePill(result: Record<string, any> | undefined) {
  if (!result) return <span className="pill neutral">waiting</span>;
  const s = String(result.state ?? "");
  const cls = result.ok === false || /error|invalid|guard|refused|denied/.test(s) ? "pill bad" : /approval|pending/.test(s) ? "pill warn" : "pill";
  return <span className={cls}>{s || (result.ok ? "ok" : "failed")}</span>;
}

function args(a: Record<string, unknown>): string {
  return Object.entries(a)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
}

export function JudgeConsole({ presets, runsPerHour, amountCap }: { presets: PresetSpec[]; runsPerHour: number; amountCap: number }) {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [runsLeft, setRunsLeft] = useState<number | undefined>();
  const loaded = useRef(false);

  useEffect(() => {
    const s = load();
    setSnapshot(s.snapshot);
    setRuns(s.runs ?? []);
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (loaded.current) save(snapshot, runs);
  }, [snapshot, runs]);

  function patch(key: string, f: (r: Run) => Run) {
    setRuns((rs) => rs.map((r) => (r.key === key ? f(r) : r)));
  }

  async function start(request: Run["request"] & { runKey?: string }) {
    if (busy) return;
    setBusy(true);
    const key = Math.random().toString(36).slice(2);
    const run: Run = { key, request, retry: !!request.retry, steps: [], running: true, runKey: request.runKey };
    setRuns((rs) => [run, ...rs]);
    let snapOut: Snapshot | undefined;
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshot, ...request }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line);
          if (e.t === "done") snapOut = e.snapshot;
          if (e.t === "done" && typeof e.runsLeft === "number") setRunsLeft(e.runsLeft);
          patch(key, (r) => apply(r, e));
        }
      }
    } catch (err) {
      patch(key, (r) => ({ ...r, error: (err as Error).message }));
    } finally {
      if (snapOut) setSnapshot(snapOut);
      patch(key, (r) => ({ ...r, running: false }));
      setBusy(false);
    }
  }

  function apply(r: Run, e: any): Run {
    switch (e.t) {
      case "meta":
        return { ...r, runKey: e.runKey, message: e.message, model: e.model, retry: e.retry };
      case "setup":
        if (e.verb === "human_approval") return { ...r, steps: [...r.steps, { id: `appr-${r.steps.length}`, phase: "setup", name: "human_approval", label: e.label, args: e.args, result: { ok: true, state: "approved" }, calls: [] }] };
        return { ...r, steps: [...r.steps, { id: `pending-label`, phase: "label", name: "", label: e.label, args: {}, calls: [] }] };
      case "tool_call": {
        const steps = [...r.steps];
        const last = steps.at(-1);
        const label = last?.phase === "label" ? last.label : undefined;
        if (last?.phase === "label") steps.pop();
        steps.push({ id: e.id, phase: e.phase, name: e.name, args: e.args, label, calls: [] });
        return { ...r, steps };
      }
      case "paypal": {
        const open = [...r.steps].reverse().find((s) => s.phase !== "label" && !s.result);
        if (!open) return r;
        return { ...r, steps: r.steps.map((s) => (s === open ? { ...s, calls: [...s.calls, e.call] } : s)) };
      }
      case "tool_result":
        return { ...r, steps: r.steps.map((s) => (s.id === e.id ? { ...s, result: e.result } : s)) };
      case "assistant":
        return { ...r, answer: e.text };
      case "log":
        return { ...r, log: { entries: e.entries, chain: e.chain } };
      case "done":
        return { ...r, usage: e.usage, moved: e.moved };
      case "error":
        return { ...r, error: e.message };
      default:
        return r;
    }
  }

  function approve(a: Approval) {
    const runKey = a.orderRef.split("-")[1];
    const origin = runs.find((r) => r.runKey === runKey && r.message && !r.request.approve);
    const text = origin?.message ?? `The shop owner approved ${a.verb} of ${a.amount} ${a.currency} for order ${a.orderRef}. Call ${a.verb} again with the same arguments.`;
    void start({ text, runKey, retry: true, approve: a.id });
  }

  const pending = (snapshot?.state.approvals ?? []).filter((a) => a.status === "pending");
  const refs = snapshot?.state.refs ?? [];

  return (
    <div className="judge">
      <aside className="side">
        <div className="box">
          <h2>Try a request</h2>
          {presets.map((p) => (
            <button key={p.id} className="preset" disabled={busy} onClick={() => start({ preset: p.id })}>
              {p.label}
            </button>
          ))}
          <form
            className="compose"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (text.trim()) void start({ text: text.trim() });
              setText("");
            }}
          >
            <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Or type your own request" maxLength={500} disabled={busy} aria-label="Your request" />
            <button className="btn small" disabled={busy || !text.trim()}>
              Run
            </button>
          </form>
          <p className="small">
            {runsPerHour} runs per hour per visitor{typeof runsLeft === "number" ? ` · ${runsLeft} left` : ""}. Amounts above ${amountCap}, non-USD and payouts to
            non-sandbox addresses are refused before PayPal is called.
          </p>
        </div>

        {pending.length > 0 && (
          <div className="box">
            <h2>Waiting for the shop owner</h2>
            {pending.map((a) => (
              <div key={a.id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 14 }}>
                  <b>
                    {a.verb} {a.amount} {a.currency}
                  </b>{" "}
                  <span className="mono">{a.orderRef}</span>
                </div>
                <div className="small">{a.reason}</div>
                <button className="btn small" style={{ marginTop: 6 }} disabled={busy} onClick={() => approve(a)}>
                  Approve and let the agent retry
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="box">
          <h2>This session</h2>
          {snapshot ? (
            <>
              <p className="small" style={{ marginTop: 0 }}>
                Session <span className="mono">{snapshot.state.sid}</span>. Its deals live only in your browser (signed by the server).
              </p>
              {refs.length ? (
                refs.slice(-8).map((r) => (
                  <div key={r.orderRef} className="log-row">
                    {r.orderRef} · {r.kind} {r.amount} · {r.state}
                  </div>
                ))
              ) : (
                <p className="small">No deals yet.</p>
              )}
              <a className="btn ghost small" style={{ marginTop: 10 }} href="/ledger?source=judge">
                Open this session in the ledger
              </a>
            </>
          ) : (
            <p className="small" style={{ margin: 0 }}>
              A session starts with your first run.
            </p>
          )}
          <button
            className="btn ghost small"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={() => {
              setSnapshot(undefined);
              setRuns([]);
            }}
          >
            New session
          </button>
        </div>
      </aside>

      <div className="feed" aria-live="polite">
        {runs.length === 0 && <div className="empty">Pick a request on the left. The agent&apos;s tool calls and every PayPal sandbox HTTP call appear here as they happen.</div>}
        {runs.map((r) => (
          <RunCard key={r.key} run={r} busy={busy} onRetry={() => r.message && start({ text: r.message, runKey: r.runKey, retry: true })} />
        ))}
      </div>
    </div>
  );
}

function RunCard({ run, busy, onRetry }: { run: Run; busy: boolean; onRetry: () => void }) {
  return (
    <article className="run">
      <div className="run-head">
        <div>
          <div className="msg">{run.message ?? (run.request.preset ? "Preparing…" : run.request.text)}</div>
          <div className="small">
            {run.model ?? "gpt-4.1-mini"} · temperature 0{run.runKey ? ` · run ${run.runKey}` : ""}
          </div>
        </div>
        <div className="tags">
          {run.retry && <span className="pill warn">{run.request.approve ? "after approval" : "retry, same request"}</span>}
          {run.running && (
            <span className="pill neutral">
              <span className="spin" /> running
            </span>
          )}
        </div>
      </div>

      {run.steps.map((s) => (
        <div className="step" key={s.id}>
          <div className="label">{s.phase === "setup" ? (s.label ?? "Setup") : "Agent tool call"}</div>
          {s.name !== "human_approval" && (
            <div className="call">
              <span className="fn">{s.name}</span>({args(s.args)})
            </div>
          )}
          {s.calls.length > 0 && (
            <div className="pp">
              {s.calls.map((c, i) => (
                <div className="pp-row" key={i}>
                  <span className="m">{c.method}</span>
                  <span className="rest">
                    {c.path} → <b>{c.http}</b>
                    {c.resource_status ? ` ${c.resource_status}` : ""}
                    {c.error_name ? ` ${c.error_name}` : ""}
                    {c.resource_id ? ` · id ${c.resource_id}` : ""}
                    <span className="dim">
                      {c.debug_id ? ` · debug_id ${c.debug_id}` : ""}
                      {c.request_id ? ` · PayPal-Request-Id ${c.request_id}` : ""} · {c.ms} ms
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {s.result && (
            <div className="res">
              {statePill(s.result)} {s.result.error ? <span className="err">{String(s.result.error)}</span> : null}
              {idsOf(s.result) && <div className="ids">{idsOf(s.result)}</div>}
            </div>
          )}
        </div>
      ))}

      {run.answer !== undefined && (
        <div className="step">
          <div className="label">Agent</div>
          <div className="answer">{run.answer}</div>
        </div>
      )}

      {run.moved && (
        <div className="step">
          <div className="label">Money the agent moved in this run{run.steps.some((s) => s.phase === "setup") ? " (setup steps not counted)" : ""}</div>
          <div className="moved">
            <span className={run.moved.new_ids.length ? "pill" : "pill neutral"}>
              {run.moved.new_ids.length} new money move{run.moved.new_ids.length === 1 ? "" : "s"}
            </span>
            <span className="small">
              {run.moved.paypal_writes} write call{run.moved.paypal_writes === 1 ? "" : "s"} sent to PayPal
              {run.moved.new_ids.length ? ` · ${run.moved.new_ids.join(", ")}` : ""}
            </span>
          </div>
          {run.retry && !run.request.approve && run.moved.new_ids.length === 0 && (
            <p className="small" style={{ marginBottom: 0 }}>
              Same request again, no new capture, refund or payout: MCPal reused the PayPal-Request-Id of the first attempt.
            </p>
          )}
        </div>
      )}

      {run.log && (
        <div className="step">
          <details>
            <summary>
              Decision log: {run.log.entries.length} new entr{run.log.entries.length === 1 ? "y" : "ies"} · hash chain {run.log.chain.ok ? "verified" : "BROKEN"} ({run.log.chain.count} total)
            </summary>
            <div style={{ marginTop: 8 }}>
              {run.log.entries.map((e, i) => (
                <div className="log-row" key={i}>
                  {JSON.stringify(e)}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {(run.usage || run.error || (!run.running && run.message)) && (
        <div className="step" style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span className="small">
            {run.error ? <span className="err">{run.error}</span> : null}
            {run.usage ? `${run.usage.input.toLocaleString("en-US")} input + ${run.usage.output.toLocaleString("en-US")} output tokens · US$${run.usage.usd.toFixed(4)}` : ""}
          </span>
          {!run.running && run.message && !run.request.approve && (
            <button className="btn ghost small" disabled={busy} onClick={onRetry}>
              Send the same request again
            </button>
          )}
        </div>
      )}
    </article>
  );
}
