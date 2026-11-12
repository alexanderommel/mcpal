import type { Metadata } from "next";
import { GITHUB_URL, Nav } from "@/components/Nav";
import { PolicyPlayground } from "@/components/PolicyPlayground";

export const metadata: Metadata = {
  title: "Policy in plain English — MCPal",
  description: "Write your PayPal agent's payment rules in English or Spanish and get a checked mcpal.policy.json. The agent can't edit its own rules.",
};

export default function PolicyPage() {
  return (
    <>
      <Nav />
      <main className="wrap">
        <div style={{ padding: "28px 0 40px" }}>
          <div className="eyebrow">Policy in plain English</div>
          <p className="lede" style={{ margin: "8px 0 12px" }}>
            Write the rules your agent must follow, in English or Spanish. gpt-4.1-mini (temperature 0, strict JSON schema) proposes a <code>mcpal.policy.json</code>
            ; deterministic code validates it, refuses anything that loosens a limit unless you wrote the new amount, refuses recipients you did not write, and
            caps everything at hard maximums. You apply it yourself: <b>Apply</b> here, or <code>mcpal policy apply</code> in your install.
          </p>
          <PolicyPlayground />
          <ul className="fine">
            <li>
              <b>The agent can&apos;t edit its own rules.</b> There is no MCP tool for the policy; the agent&apos;s tools are the 8 payment verbs only.
            </li>
            <li>&quot;Try it&quot; runs the same rule code the MCP server uses (checkRules), with no PayPal call.</li>
            <li>&quot;Apply&quot; on this page changes this page&apos;s policy only, in your browser. Nothing is stored on the server.</li>
            <li>
              Eval and its caveats: <a href={`${GITHUB_URL}/blob/main/docs/policy-ai-eval.md`}>docs/policy-ai-eval.md</a>. Limits: 15 compiles per hour per IP,
              800 characters per text.
            </li>
          </ul>
        </div>
      </main>
    </>
  );
}
