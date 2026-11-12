import type { Metadata } from "next";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { GITHUB_URL, Nav, TRUTH_SENTENCE } from "@/components/Nav";
import { BuyerAgentRun, Transcript } from "@/components/BuyerAgentRun";
import { DISCOUNTS, PRODUCTS, SHIPPING_OPTIONS, INTL_OPTIONS } from "@/lib/commerce/catalog";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Agent-ready checkout for any PayPal merchant — MCPal",
  description:
    "MCPal makes a PayPal merchant agent-ready: buyer agents check out through the open Universal Commerce Protocol (UCP), and the merchant settles on PayPal through MCPal's verbs, policy and decision log.",
};

const ROOT = join(process.cwd(), "..");
function readDoc<T>(rel: string): T | undefined {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface Conf {
  title: string;
  note: string;
  modules: { official_module: string; coverage: string; note?: string; results: Record<string, { pass: number; fail: number } | null> }[];
  extensions: { title: string; note: string; results: Record<string, { pass: number; fail: number } | null> }[];
  runs: Record<string, { at: string; passed: number; total: number }>;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function CommercePage() {
  const conf = readDoc<Conf>("docs/ucp-conformance.json");
  const proof = readDoc<any>("docs/agentic-commerce-proof.json");
  const ep = `${SITE_URL}/ucp/v1`;
  const labels = conf ? Object.keys(conf.runs) : [];
  const curl = `curl -s ${SITE_URL}/.well-known/ucp

curl -s -X POST ${ep}/checkout-sessions \\
  -H 'UCP-Agent: profile="https://agent.example/profile"' \\
  -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \\
  -d '{"line_items":[{"item":{"id":"bag_house_blend_12oz"},"quantity":2}],
       "discounts":{"codes":["AGENT10"]},
       "fulfillment":{"methods":[{"type":"shipping","destinations":[{"id":"d1",
         "street_address":"2211 N First St","address_locality":"San Jose",
         "address_region":"CA","postal_code":"95131","address_country":"US"}],
         "groups":[{"selected_option_id":"std-ground"}]}]}}'

# then, with the returned id (PayPal sandbox; nothing real moves):
curl -s -X POST ${ep}/checkout-sessions/<id>/complete \\
  -H 'UCP-Agent: profile="https://agent.example/profile"' \\
  -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \\
  -d '{"payment":{"instruments":[{"id":"i1","handler_id":"mcpal_paypal_sandbox",
       "type":"card","credential":{"type":"token","token":"sandbox-wallet-token"}}]}}'`;

  return (
    <>
      <Nav current="commerce" />
      <main className="wrap" id="main-content">
        <div style={{ padding: "28px 0 4px" }}>
          <div className="eyebrow">Agentic commerce · UCP {"2026-04-08"} · PayPal sandbox</div>
          <h1 className="page-h1">Agent-ready checkout for any PayPal merchant</h1>
          <p className="lede">
            Shopping agents are starting to buy on people&apos;s behalf through the open <a href="https://ucp.dev">Universal Commerce Protocol</a>. MCPal gives a PayPal
            merchant the UCP checkout endpoints those agents speak, and settles every order on PayPal with MCPal&apos;s own verbs: <code>charge</code>, or{" "}
            <code>hold</code> then <code>capture_hold</code> when the order ships, <code>void_hold</code> to release it, and <code>refund</code>. The merchant&apos;s policy
            limits, retry-safe PayPal request ids and the hash-chained decision log apply to agent orders exactly as they do to MCP tool calls. The same checkout also
            answers the Agentic Commerce Protocol (ACP) <code>checkout_sessions</code> API.
          </p>
        </div>

        <section className="commerce-section" aria-labelledby="how-h">
          <h2 id="how-h" className="h-sm">How an agent order flows</h2>
          <ol className="commerce-flow">
            <li>
              <b>Discover.</b> The buyer agent reads <a href="/.well-known/ucp"><code>/.well-known/ucp</code></a>: REST endpoint, capabilities (checkout, fulfillment, discount,
              order) and payment handlers.
            </li>
            <li>
              <b>Build the cart.</b> <code>POST /checkout-sessions</code> and <code>PUT</code> updates. The agent sends item ids, an address and discount codes; the merchant
              prices everything (integer cents) and answers <code>ready_for_complete</code> when nothing is missing.
            </li>
            <li>
              <b>Pay.</b> <code>POST /checkout-sessions/&#123;id&#125;/complete</code> with a payment instrument. The merchant calls MCPal <code>charge</code> (or{" "}
              <code>hold</code> with <code>&quot;dev.mcpal.settlement&quot;: &quot;authorize&quot;</code>). The MCPal orderRef is derived from the checkout id, so a retried complete
              can never charge twice.
            </li>
            <li>
              <b>Policy.</b> Totals at or above $250.00 stop at the merchant&apos;s approval rule: the checkout answers <code>requires_escalation</code> with a{" "}
              <code>continue_url</code>, and nothing is charged.
            </li>
            <li>
              <b>After the sale.</b> <code>GET /orders/&#123;id&#125;</code> shows the order with PayPal&apos;s ids. The merchant ships (<code>capture_hold</code>), releases (
              <code>void_hold</code>) or refunds (<code>refund</code>) through <code>/orders/&#123;id&#125;/ship|release|refund</code>.
            </li>
          </ol>
        </section>

        <section className="commerce-section" aria-labelledby="run-h">
          <h2 id="run-h" className="h-sm">A buyer agent buys coffee</h2>
          <p className="small" style={{ maxWidth: "70ch" }}>
            The demo merchant is <b>Coffee Club Supply</b>. A gpt-4.1-mini agent (temperature 0) is told: &ldquo;{proof?.task ?? "Buy two bags of coffee for under $40, shipped."}&rdquo;
            Its only tools are the UCP operations above; it never sees PayPal or MCPal.
          </p>
          {proof ? (
            <>
              <p className="small">
                Recorded run, {new Date(proof.at).toUTCString()} ({proof.steps.filter((s: any) => s.t === "tool_call").length} tool calls). Full transcript:{" "}
                <a href={`${GITHUB_URL}/blob/main/docs/agentic-commerce-proof.md`}>docs/agentic-commerce-proof.md</a>.
              </p>
              <Transcript run={proof} />
            </>
          ) : null}
          <div style={{ marginTop: 18 }}>
            <BuyerAgentRun />
          </div>
        </section>

        <section className="commerce-section" aria-labelledby="official-h">
          <h2 id="official-h" className="h-sm">Official UCP conformance suite: 55 passed, 14 failed, 9 skipped (78 tests)</h2>
          <p className="small" style={{ maxWidth: "75ch" }}>
            Run on 2026-11-12 against this site with the suite&apos;s own runner (conformance @ 1201fb7, ucp-sdk 0.4.6). Every one of the 14 failures is in a
            feature this demo merchant does not implement and lists below as unsupported: order webhooks to the platform (7), platform-written order
            updates via PUT /orders (4) and the shipping-simulation endpoint (3). Checkout lifecycle, idempotency, totals, discounts, validation,
            fulfillment structure and card credentials all pass. Raw output and fixtures:{" "}
            <a href={`${GITHUB_URL}/tree/main/docs/ucp-official`}>docs/ucp-official</a>.
          </p>
        </section>

        <section className="commerce-section" aria-labelledby="checks-h">
          <h2 id="checks-h" className="h-sm">Spec-derived checks</h2>
          <p className="small" style={{ maxWidth: "75ch" }}>
            {conf ? conf.title : "Not run yet"}. {conf?.note} {labels.map((l) => `${l}: ${conf!.runs[l]!.passed}/${conf!.runs[l]!.total} passed`).join(" · ")}. Unsupported modules
            are listed as unsupported, not counted as passes. Details: <a href={`${GITHUB_URL}/blob/main/docs/ucp-conformance.md`}>docs/ucp-conformance.md</a>.
          </p>
          {conf ? (
            <div className="scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Official module</th>
                    <th>Coverage</th>
                    {labels.map((l) => (
                      <th key={l}>{l}</th>
                    ))}
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {conf.modules.map((m) => (
                    <tr key={m.official_module}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {m.official_module}
                      </td>
                      <td>
                        <span className={m.coverage === "covered" ? "pill" : m.coverage === "partial" ? "pill warn" : "pill neutral"}>{m.coverage}</span>
                      </td>
                      {labels.map((l) => {
                        const r = m.results[l];
                        return (
                          <td key={l} className="mono">
                            {r ? <span className={r.fail ? "pill bad" : "pill"}>{`${r.pass}/${r.pass + r.fail}`}</span> : "-"}
                          </td>
                        );
                      })}
                      <td className="small">{m.note ?? ""}</td>
                    </tr>
                  ))}
                  {(conf.extensions ?? []).map((e) => (
                    <tr key={e.title}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {e.title}
                      </td>
                      <td>
                        <span className="pill neutral">extra</span>
                      </td>
                      {labels.map((l) => {
                        const r = e.results[l];
                        return (
                          <td key={l} className="mono">
                            {r ? <span className={r.fail ? "pill bad" : "pill"}>{`${r.pass}/${r.pass + r.fail}`}</span> : "-"}
                          </td>
                        );
                      })}
                      <td className="small">{e.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="commerce-section" aria-labelledby="ep-h">
          <h2 id="ep-h" className="h-sm">Endpoints</h2>
          <div className="scroll">
            <table className="tbl">
              <tbody>
                {[
                  ["GET", `${SITE_URL}/.well-known/ucp`, "UCP business profile (discovery)"],
                  ["POST", `${ep}/checkout-sessions`, "create checkout"],
                  ["GET / PUT", `${ep}/checkout-sessions/{id}`, "get / update (full replacement)"],
                  ["POST", `${ep}/checkout-sessions/{id}/complete`, "pay: MCPal charge, or hold"],
                  ["POST", `${ep}/checkout-sessions/{id}/cancel`, "cancel (void_hold if anything was held)"],
                  ["GET", `${ep}/orders/{id}`, "order, with PayPal ids under dev.mcpal.settlement"],
                  ["POST", `${ep}/orders/{id}/ship | release | refund`, "merchant actions (MCPal extension): capture_hold, void_hold, refund"],
                  ["POST", `${SITE_URL}/acp/checkout_sessions`, "ACP create (same engine; Authorization: Bearer <any>, API-Version: 2026-04-17)"],
                  ["GET / POST", `${SITE_URL}/acp/checkout_sessions/{id}`, "ACP get / update"],
                  ["POST", `${SITE_URL}/acp/checkout_sessions/{id}/complete | cancel`, "ACP complete (payment_data) / cancel"],
                ].map(([m, u, d]) => (
                  <tr key={u}>
                    <td className="mono">{m}</td>
                    <td className="mono" style={{ wordBreak: "break-all" }}>
                      {u}
                    </td>
                    <td className="small">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">
            Headers: <code>UCP-Agent</code> (required; a <code>version</code> newer than 2026-04-08 gets 422), <code>Idempotency-Key</code> (same key + same body replays
            the first answer; a different body gets 409), <code>Request-Id</code>. Payment handlers: <code>mcpal_paypal_sandbox</code> and the conformance suite&apos;s{" "}
            <code>mock_payment_handler</code>; the token <code>fail_token</code> simulates a decline.
          </p>
          <div className="codebox">
            <pre className="mono">{curl}</pre>
          </div>
        </section>

        <section className="commerce-section" aria-labelledby="cat-h">
          <h2 id="cat-h" className="h-sm">The demo merchant</h2>
          <div className="scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Item id</th>
                  <th>Product</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {PRODUCTS.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.title}</td>
                    <td className="mono">{p.stock > 0 ? money(p.price) : "sold out"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">
            Shipping: {[...SHIPPING_OPTIONS, ...INTL_OPTIONS].map((o) => `${o.title} ${money(o.amount)}${o.freeOver ? ` (free from ${money(o.freeOver)})` : ""}`).join(" · ")}.
            Discount codes: {DISCOUNTS.map((d) => d.code).join(", ")} (AGENT10 is the one the profile advertises). Hosted-demo cap: $500.00 per checkout.
          </p>
          <p className="small" id="terms">
            Terms: this is a demo merchant on the PayPal sandbox. Nothing ships and no real money moves.
          </p>
          <p className="small" id="privacy">
            Privacy: buyer names, emails and addresses sent to the demo are stored with the checkout session in private storage and used only to render it.
          </p>
        </section>

        <section className="commerce-section" aria-labelledby="unsup-h">
          <h2 id="unsup-h" className="h-sm">Not supported (yet)</h2>
          <ul className="small" style={{ maxWidth: "75ch" }}>
            <li>Order webhooks to the platform, request/response signatures (RFC 9421) and the conformance suite&apos;s simulate-shipping hook.</li>
            <li>Platform-written order updates (<code>PUT /orders/&#123;id&#125;</code>), stored customer address books, AP2 mandates, verified token binding.</li>
            <li>Real card or wallet credentials: on the sandbox, every accepted instrument settles with PayPal&apos;s published sandbox test card. Card numbers are never forwarded.</li>
            <li>MCP and A2A transports for UCP; the REST binding only.</li>
            <li>ACP: delegated payment (the PSP vault-token flow), order webhooks to the agent platform and signed requests. The ACP endpoints share the UCP engine, so the same sandbox handler settles them.</li>
          </ul>
          <p className="small">
            Every merchant decision is in the <Link href="/ledger?source=merchant">decision log</Link> (source &ldquo;merchant checkout (UCP)&rdquo;).
          </p>
        </section>

        <div className="truth">
          <p>{TRUTH_SENTENCE}</p>
        </div>
      </main>
    </>
  );
}
