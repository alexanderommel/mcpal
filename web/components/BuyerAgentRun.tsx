"use client";
// "Run the buyer agent": one live gpt-4.1-mini run against this site's UCP endpoints (PayPal sandbox).
import { useState } from "react";

interface Step {
  t: string;
  name?: string;
  text: string;
}
interface Run {
  steps: Step[];
  checkout_id?: string;
  order_id?: string;
  status?: string;
  total_cents?: number;
  paypal?: { mcpal_order_ref?: string; state?: string; paypal_ids?: Record<string, string | string[]> };
  final?: string;
  ms: number;
  error?: string;
}

export function Transcript({ run }: { run: Run }) {
  const ids = run.paypal?.paypal_ids ?? {};
  return (
    <div className="commerce-run">
      <table className="tbl" style={{ marginBottom: 14 }}>
        <tbody>
          <tr>
            <th>Status</th>
            <td>
              <span className={run.status === "completed" ? "pill" : "pill bad"}>{run.status ?? "no checkout"}</span>
            </td>
          </tr>
          <tr>
            <th>Total</th>
            <td className="mono">{run.total_cents !== undefined ? `$${(run.total_cents / 100).toFixed(2)}` : "-"}</td>
          </tr>
          <tr>
            <th>UCP checkout / order</th>
            <td className="mono" style={{ wordBreak: "break-all" }}>
              {run.checkout_id ?? "-"} / {run.order_id ? <a href={`/commerce/orders/${run.order_id}`}>{run.order_id}</a> : "-"}
            </td>
          </tr>
          <tr>
            <th>MCPal orderRef</th>
            <td className="mono">{run.paypal?.mcpal_order_ref ?? "-"}</td>
          </tr>
          {Object.entries(ids).map(([k, v]) => (
            <tr key={k}>
              <th>PayPal {k.replace(/_/g, " ")}</th>
              <td className="mono">{Array.isArray(v) ? v.join(", ") : v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ol className="commerce-steps">
        {run.steps.map((s, i) => (
          <li key={i} className={`step-${s.t}`}>
            <span className="small mono">{s.t === "tool_call" ? `agent → ${s.name}` : s.t === "tool_result" ? `merchant ← ${s.name}` : s.t}</span>
            {s.t === "tool_call" || s.t === "tool_result" ? <pre className="mono">{s.text.length > 700 ? `${s.text.slice(0, 700)} …` : s.text}</pre> : <p>{s.text}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BuyerAgentRun() {
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run | undefined>();
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    setRun(undefined);
    try {
      const r = await fetch("/api/commerce/run", { method: "POST" });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? `Error ${r.status}`);
      else setRun(j);
    } catch {
      setError("Could not reach the buyer agent.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="btns" style={{ alignItems: "center" }}>
        <button className="btn" onClick={() => void go()} disabled={busy}>
          {busy ? "Buyer agent is shopping… (about 20 s)" : "Run the buyer agent live"}
        </button>
        <span className="small">gpt-4.1-mini · PayPal · 3 runs per hour</span>
      </div>
      {error ? <p className="small" style={{ color: "var(--accent)" }}>{error}</p> : null}
      {run ? <Transcript run={run} /> : null}
    </div>
  );
}
