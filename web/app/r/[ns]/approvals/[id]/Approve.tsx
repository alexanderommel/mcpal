"use client";
import { useEffect, useState } from "react";

interface Approval {
  id: string;
  orderRef: string;
  verb: string;
  amount: string;
  currency: string;
  reason: string;
  status: string;
}

const STORAGE = "mcpal_demo_key";

export default function Approve({ ns, id }: { ns: string; id: string }) {
  const [key, setKey] = useState("");
  const [approval, setApproval] = useState<Approval>();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function call(action: "get" | "approve" | "reject", k = key) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/remote/approval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: k, id, ns, action }) });
      const j = await r.json();
      if (j.approval) setApproval(j.approval);
      if (j.error) setErr(j.error);
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let k = "";
    try {
      k = localStorage.getItem(STORAGE) ?? "";
    } catch {
      /* storage blocked */
    }
    if (k) {
      setKey(k);
      void call("get", k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!approval)
    return (
      <div style={{ padding: 16, background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--radius)" }}>
        <p>Approvals open only for the demo key that made the request. Open this link in the browser where you installed MCPal, or paste that key:</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void call("get");
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <input className="mono" value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="dk_…" style={{ flex: "1 1 220px", padding: 8 }} />
          <button className="btn" disabled={busy || !key}>
            Open
          </button>
        </form>
        {err && <p style={{ color: "var(--accent)" }}>{err}</p>}
      </div>
    );

  return (
    <div style={{ padding: 16, background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--radius)" }}>
      <p style={{ fontSize: 22, margin: "0 0 8px" }}>
        <b>{approval.verb}</b> {approval.amount} {approval.currency}
      </p>
      <p className="mono" style={{ margin: "0 0 8px" }}>
        orderRef {approval.orderRef}
      </p>
      <p>{approval.reason}</p>
      <p>
        Status: <b>{approval.status}</b>
      </p>
      {approval.status === "pending" ? (
        <div className="btns">
          <button className="btn" disabled={busy} onClick={() => void call("approve")}>
            Approve
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void call("reject")}>
            Reject
          </button>
        </div>
      ) : (
        <p>Now ask your agent to call {approval.verb} again with the same orderRef.</p>
      )}
      {err && <p style={{ color: "var(--accent)" }}>{err}</p>}
    </div>
  );
}
