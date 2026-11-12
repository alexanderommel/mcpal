import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Install, Limits } from "@/components/Install";
import { ByoSandbox } from "@/components/ByoSandbox";
import { MCP_BASE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Install MCPal — connect your AI agent to PayPal",
  description:
    "Add the hosted MCPal MCP server to Claude Code, Cursor, VS Code or claude.ai in one step, with your own demo key.",
};

export default function InstallPage() {
  return (
    <>
      <Nav current="install" />
      <main className="wrap install-page" id="main-content">
        <div className="eyebrow install-eyebrow">
          Remote MCP server · Streamable HTTP · <code>{MCP_BASE}</code>
        </div>
        <h1 className="page-h1">
          Your agent.
          <br />
          Now with <em>PayPal.</em>
        </h1>
        <p className="lede">
          Pick a client. Copy one snippet. Your demo key is already included,
          with its own isolated ledger.
        </p>
        <Install />
        <div className="install-byo-frame">
          <ByoSandbox />
        </div>
        <h2 className="h-sm">Demo limits</h2>
        <Limits />
      </main>
    </>
  );
}
