import type { Metadata } from "next";
import { LedgerExplorer } from "@/components/LedgerExplorer";
import { Nav } from "@/components/Nav";
import { sandboxProof } from "@/lib/data";

export const metadata: Metadata = {
  title: "Decision log explorer — MCPal",
  description: "Every MCPal payment decision for your demo key and judge session: what moved, what policy stopped, PayPal ids, and the verified hash chain.",
  robots: { index: false },
};

export default function LedgerPage() {
  const proof = sandboxProof();
  return (
    <>
      <Nav current="ledger" />
      <main className="wrap">
        <div style={{ padding: "28px 0 4px" }}>
          <div className="eyebrow">Decision log explorer</div>
          <h1 className="page-h1">Every decision your agent made</h1>
          <p className="lede" style={{ marginBottom: 18 }}>
            MCPal writes every verb call to an append-only, hash-chained log: what the agent asked, what policy decided, and what PayPal returned. This is that log for
            your demo key (the hosted remote MCP) and your judge-console session, from this browser only. Filter it, group it by order, total it, export it for your
            books, and check that no line was edited.
          </p>
        </div>
        <LedgerExplorer proof={proof} />
      </main>
    </>
  );
}
