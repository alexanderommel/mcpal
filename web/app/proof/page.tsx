import type { Metadata } from "next";
import { GITHUB_URL, Nav } from "@/components/Nav";
import { sandboxProof, type ProofStep } from "@/lib/data";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Proof — MCPal",
  description: "Every MCPal verb run against PayPal, with PayPal's own ids and debug ids.",
};

function isStep(v: unknown): v is ProofStep {
  return !!v && typeof v === "object" && "state" in v && "ids" in v;
}

function fmtIds(ids: Record<string, string | string[]>): [string, string][] {
  return Object.entries(ids).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]);
}

export default function ProofPage() {
  const proof = sandboxProof();
  const rows = Object.entries(proof.proof);
  const steps = rows.filter(([, v]) => isStep(v)) as [string, ProofStep][];
  // Guard steps are supposed to stop money: a block there is the expected result.
  const BLOCKED = new Set(["needs_approval", "denied", "invalid_input"]);
  const outcome = (name: string, v: ProofStep): "ok" | "blocked" | "sandbox" | "fail" => {
    if (v.ok) return "ok";
    if (BLOCKED.has(String(v.state))) return "blocked";
    if (/INSUFFICIENT_FUNDS/.test(String((v as { error?: string }).error ?? ""))) return "sandbox";
    return "fail";
  };
  const counts = { ok: 0, blocked: 0, sandbox: 0, fail: 0 };
  for (const [n, v] of steps) counts[outcome(n, v)]++;

  return (
    <>
      <Nav current="proof" />
      <main className="wrap">
        <div style={{ padding: "28px 0 8px" }}>
          <div className="eyebrow">Proof · run {proof.run}</div>
          <h1 style={{ fontFamily: "var(--font-display), Georgia, serif", fontWeight: 400, fontSize: "clamp(32px, 5vw, 52px)", margin: "8px 0 10px", lineHeight: 1.05 }}>
            {counts.ok + counts.blocked} of {steps.length} steps behaved as designed on PayPal
          </h1>
          <p className="lede">
            {counts.ok} moved money as asked · {counts.blocked} were safety checks that correctly refused to move money (approval limit, injected price, repeated refund, new payee, reused reference)
            {counts.sandbox ? ` · ${counts.sandbox} payout could not run because the shared business account ran out of payout balance` : ""}
            {counts.fail ? ` · ${counts.fail} failed` : ""}.
          </p>
          <p className="lede">
            Recorded {new Date(proof.at).toUTCString()} by the repository&apos;s proof script. Each row is one MCPal call; the ids are PayPal&apos;s own, and the
            debug id is what PayPal support can look up. The file is <code>docs/sandbox-proof.json</code> in the <a href={GITHUB_URL}>repository</a>.
          </p>
        </div>
        <section style={{ borderTop: 0, paddingTop: 20 }}>
          <div className="scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Result</th>
                  <th>PayPal ids</th>
                  <th>Debug id</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([name, v]) =>
                  isStep(v) ? (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td>
                        <span className={outcome(name, v) === "ok" || outcome(name, v) === "blocked" ? "pill" : "pill bad"}>
                          {outcome(name, v) === "blocked" ? `blocked as designed · ${v.state}` : outcome(name, v) === "sandbox" ? "payout balance empty" : v.state}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {fmtIds(v.ids).map(([k, id]) => (
                          <div key={k}>
                            <span style={{ color: "var(--muted)" }}>{k}</span> {id}
                          </div>
                        ))}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {v.debug_id ?? "—"}
                      </td>
                    </tr>
                  ) : (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td colSpan={3} className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                        {JSON.stringify(v)}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p className="small">
            &ldquo;replay&rdquo; rows call the same verb again with the same orderRef: PayPal returns the same order and capture ids, so no money moves twice.
          </p>
        </section>
      </main>
    </>
  );
}
