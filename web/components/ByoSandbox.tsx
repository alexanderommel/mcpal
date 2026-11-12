"use client";
// "Use your own sandbox": paste a PayPal SANDBOX app's Client ID + Secret; the server checks them against
// api-m.sandbox.paypal.com (and refuses anything that works on live), stores the secret encrypted, and
// returns a new demo key bound to them. Every install snippet on this page then carries that key.
import { useEffect, useState } from "react";
import { resetDemoKey, setDemoKey, useDemoKey } from "./DemoKey";
import s from "./ByoSandbox.module.css";

type Status = { mode: "shared" | "byo" | "forgotten"; clientId?: string } | undefined;

async function call(body: Record<string, string>): Promise<{ ok: boolean; data: any }> {
  try {
    const r = await fetch("/api/remote/byo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: "Network error. Try again." } };
  }
}

export function ByoSandbox() {
  const k = useDemoKey();
  const [status, setStatus] = useState<Status>(undefined);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!k) return;
    let live = true;
    call({ action: "status", key: k }).then((r) => live && r.ok && setStatus(r.data));
    return () => {
      live = false;
    };
  }, [k]);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await call({ action: "connect", clientId, clientSecret: secret });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "Could not connect.");
    setSecret("");
    setClientId("");
    setStatus({ mode: "byo", clientId: r.data.clientId });
    setDemoKey(r.data.key);
  };

  const forget = async () => {
    setBusy(true);
    setErr("");
    const r = await call({ action: "forget", key: k });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "Could not forget the credentials.");
    setStatus({ mode: "shared" });
    resetDemoKey(); // back to a fresh key on MCPal's shared sandbox
  };

  return (
    <div className={s.panel} id="byo">
      <h2>Use your own sandbox</h2>
      {status?.mode === "byo" ? (
        <>
          <p className={s.ok}>
            This key runs on <b>your</b> PayPal sandbox app (<code>{status.clientId}</code>). Orders, holds and payouts show up in your own sandbox
            business account. The secret is stored encrypted and never shown again.
          </p>
          <div className={s.row}>
            <button type="button" className="btn ghost small" onClick={forget} disabled={busy}>
              {busy ? "Forgetting…" : "Forget my credentials"}
            </button>
            <span className={s.fine}>Deletes the stored secret; this key stops working and you get a new shared-sandbox key.</span>
          </div>
        </>
      ) : (
        <>
          <p>
            By default your key uses MCPal&apos;s shared sandbox account. To see the money move in <b>your</b> PayPal sandbox, paste a <b>Sandbox</b> app&apos;s
            credentials from <a href="https://developer.paypal.com/dashboard/applications/sandbox">developer.paypal.com → Apps &amp; Credentials → Sandbox</a>.
            You get a new demo key bound to them; every install snippet above updates.
          </p>
          <form className={s.form} onSubmit={connect} autoComplete="off">
            <label>
              Sandbox Client ID
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoCapitalize="off" required />
            </label>
            <label>
              Sandbox Secret
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="new-password" required />
            </label>
            <div className={s.row}>
              <button type="submit" className="btn small" disabled={busy || !clientId || !secret}>
                {busy ? "Checking with PayPal…" : "Connect my sandbox"}
              </button>
            </div>
          </form>
          <p className={s.fine} style={{ marginTop: 10 }}>
            Sandbox only: the server checks the pair against api-m.sandbox.paypal.com and refuses credentials that work on live PayPal. The secret is
            encrypted at rest (AES-256-GCM), never logged and never returned. <code>card_on_file</code> needs a sandbox business account in a
            card-enabled country (a US one works).
          </p>
          {status?.mode === "forgotten" && <p className={s.err}>This key&apos;s credentials were forgotten. Connect again or press &ldquo;New key&rdquo;.</p>}
        </>
      )}
      {err && <p className={s.err}>{err}</p>}
    </div>
  );
}
