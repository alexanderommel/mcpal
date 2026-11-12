import type { Metadata } from "next";
import Link from "next/link";
import { GITHUB_URL, Nav } from "@/components/Nav";
import { FlowInstrument } from "@/components/FlowInstrument";
import { modelName } from "@/components/Bench";
import { CodeBox, InstallCompact } from "@/components/Install";
import { PolicyPlayground } from "@/components/PolicyPlayground";
import {
  ArchitectureDiagram,
  BenchmarkChart,
  LineIcon,
} from "@/components/LandingVisuals";
import {
  apiFor,
  benchSummary,
  groupOfficial,
  mcpalTools,
  missingFromOfficial,
  officialTools,
  usd,
} from "@/lib/data";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "MCPal — PayPal, made for AI agents",
};

function firstSentence(s: string) {
  return /^(.+?\.)(\s|$)/.exec(s.trim())?.[1] || s;
}
const RECIPES = [
  {
    title: "Deposit now. Balance on delivery.",
    what: "Capture the deposit; hold the balance until delivery or cancellation.",
    prompt:
      "Order 1042 is $120. Take a $40 deposit from the card on file and hold the rest until delivery. When I say it was delivered, capture the rest.",
    verbs: ["hold", "capture_hold", "void_hold"],
  },
  {
    title: "Pay the courier.",
    what: "Known payees go through. New recipients wait for your approval.",
    prompt:
      "Pay our courier courier@personal.example.com $6.25 for today's delivery, order courier-0412.",
    verbs: ["pay_out"],
  },
  {
    title: "A partial refund. Just once.",
    what: "Compute the fraction in code and return it to the original payer.",
    prompt:
      "Charge $80 to the card on file for order mug-77. Then refund half of it because the handle arrived chipped. If anything times out, retry.",
    verbs: ["charge", "refund"],
  },
  {
    title: "One verb. A monthly plan.",
    what: "Create the product, plan and subscription in one call.",
    prompt:
      "Start a $9/month 'Coffee club' plan for order club-5, billed to the card on file, and tell me the subscription id.",
    verbs: ["subscribe", "void_hold"],
  },
];
const SAFETY = [
  {
    kind: "retry" as const,
    title: "Retries never pay twice",
    text: "Every write carries a PayPal-Request-Id derived from the order, verb and amount. A retry returns the first result.",
  },
  {
    kind: "shield" as const,
    title: "Rules before payment",
    text: "Approval thresholds, daily caps and refund ceilings are checked before PayPal is called. Above them, a human decides.",
  },
  {
    kind: "person" as const,
    title: "New payee? Ask a human.",
    text: "Anyone outside the allowlist who has never been paid before needs approval. At any amount.",
  },
  {
    kind: "refund" as const,
    title: "Refunds only go back",
    text: "Money returns to the original payer. Never to a different address, and never beyond the remaining balance.",
  },
  {
    kind: "lock" as const,
    title: "Nothing moves by default",
    text: "Charges and holds default to a PayPal payment link. The card on file is charged only when explicitly requested.",
  },
  {
    kind: "log" as const,
    title: "A log you can verify",
    text: "Every decision joins a SHA-256 hash chain. Inspect the PayPal IDs and re-verify the chain yourself.",
  },
];

export default async function Home() {
  const official = officialTools(),
    officialNames = official.tools.map((t) => t.name),
    groups = groupOfficial(officialNames),
    verbs = await mcpalTools();
  const bench = benchSummary(),
    o = bench?.arms.official,
    m = bench?.arms.mcpal,
    sup = bench?.subsets?.officialSupported,
    adv = bench?.subsets?.adversarial;
  return (
    <>
      <Nav />
      <main className="wrap landing" id="main-content">
        <div className="product-hero technical-hero">
          <div className="hero-copy">
            <div className="eyebrow">
              Remote MCP server · PayPal REST APIs
            </div>
            <h1>
              PayPal,
              <br />
              <em>made for AI agents.</em>
            </h1>
            <p className="hero-lede">
              {verbs.length} verbs and a buyer checkout on top of PayPal&apos;s
              APIs. Holds, payouts and subscriptions in one call each. Simple
              to integrate, safe to retry.
            </p>
            <InstallCompact />
          </div>
          <FlowInstrument />
        </div>
        {bench &&
        o &&
        m &&
        sup?.mcpal &&
        sup.official &&
        adv?.mcpal &&
        adv.official ? (
          <section
            className="proof-strip"
            aria-label="Measured benchmark results"
          >
            <div className="proof-metrics">
              <div>
                <strong>
                  {sup.mcpal.passAll}
                  <span>/{sup.mcpal.n}</span>
                </strong>
                <p>
                  tasks the official toolkit can attempt
                  <span>
                    vs {sup.official.passAll}/{sup.official.n}
                  </span>
                </p>
              </div>
              <div>
                <strong>{m.duplicates}</strong>
                <p>
                  duplicate payments<span>vs {o.duplicates}</span>
                </p>
              </div>
              <div>
                <strong>{usd(m.misMovedUsd)}</strong>
                <p>
                  moved wrongly<span>vs {usd(o.misMovedUsd)}</span>
                </p>
              </div>
              <div>
                <strong>
                  {adv.mcpal.passAll}
                  <span>/{adv.mcpal.n}</span>
                </strong>
                <p>
                  prompt-injection tasks resisted
                  <span>
                    vs {adv.official.passAll}/{adv.official.n}
                  </span>
                </p>
              </div>
            </div>
            <Link href="/benchmark" className="proof-method">
              Same model ({modelName(bench)}), same {bench.tasks} tasks, graded
              from PayPal&apos;s own records{" "}
              <span aria-hidden="true">↗</span>
            </Link>
          </section>
        ) : (
          <div className="pending">
            Benchmark results are not published yet.
          </div>
        )}

        <section
          className="landing-section architecture-section"
          aria-labelledby="architecture-h"
        >
          <div className="section-heading">
            <div>
              <span className="section-index">01 / ARCHITECTURE</span>
              <h2 id="architecture-h">Where MCPal sits.</h2>
            </div>
            <p>
              One clear interface between what a business asks for and what
              PayPal needs to do.
            </p>
          </div>
          <ArchitectureDiagram verbs={verbs.map((v) => v.name)} />
          <p className="diagram-caption">
            Built on PayPal&apos;s REST APIs — the layer after PayPal&apos;s
            Agent Toolkit.
          </p>
        </section>

        <section
          className="landing-section benchmark-section"
          aria-labelledby="bench-h"
        >
          <div className="section-heading">
            <div>
              <span className="section-index">02 / EVIDENCE, NOT PROMISES</span>
              <h2 id="bench-h">The evidence is in the payments.</h2>
            </div>
            <p>
              Same model. PayPal&apos;s own records. Both the comparable task set and
              the full suite, side by side.
            </p>
          </div>
          {bench && o && m ? (
            <>
              <BenchmarkChart summary={bench} />
              <p className="benchmark-caveat">
                {m.reps} runs per task · {modelName(bench)} · Temperature 0 ·
                Correct in every run. A bounded benchmark, not a guarantee for
                every payment.
              </p>
            </>
          ) : (
            <div className="pending">
              Benchmark results are not published yet.
            </div>
          )}
          <Link href="/benchmark" className="text-link">
            Method, caveats and every PayPal id{" "}
            <span aria-hidden="true">↗</span>
          </Link>
        </section>

        <section className="landing-section" aria-labelledby="recipes-h">
          <div className="section-heading">
            <div>
              <span className="section-index">03 / RECIPES</span>
              <h2 id="recipes-h">Payment flows your agent can finish.</h2>
            </div>
            <p>
              Connect MCPal, copy a prompt, and let your agent work through the
              payment flow.
            </p>
          </div>
          <div className="landing-recipes">
            {RECIPES.map((r, i) => (
              <article className="landing-recipe" key={r.title}>
                <div className="recipe-top">
                  <span className="recipe-number">0{i + 1}</span>
                  <div className="verb-chips">
                    {r.verbs.map((v) => (
                      <code key={v}>{v}</code>
                    ))}
                  </div>
                </div>
                <h3>{r.title}</h3>
                <p>{r.what}</p>
                <CodeBox code={r.prompt} />
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-labelledby="versus-h">
          <div className="section-heading">
            <div>
              <span className="section-index">04 / LESS TO ORCHESTRATE</span>
              <h2 id="versus-h">
                {official.count} tools. {verbs.length} verbs.
                <br />
                One shared foundation.
              </h2>
            </div>
            <p>
              PayPal&apos;s Agent Toolkit exposes API calls as tools. MCPal
              complements it with complete business intents.
            </p>
          </div>
          <div className="tool-comparison">
            <div className="official-panel">
              <span className="eyebrow-s">PAYPAL AGENT TOOLKIT</span>
              <div className="tool-count">
                {official.count}
                <span>API-level tools</span>
              </div>
              <p>
                Direct access to PayPal&apos;s APIs, grouped by area. This is the
                local npm server we benchmarked; PayPal&apos;s hosted server
                (mcp.sandbox.paypal.com) lists 46 tools, and neither has holds,
                payouts or retry-safe keys.
              </p>
              <div className="official-counts">
                {groups.map((g) => (
                  <div key={g.area}>
                    <span>{g.area}</span>
                    <b>{g.tools.length}</b>
                  </div>
                ))}
              </div>
              <details className="official-disclosure">
                <summary>
                  Show all {official.count} tools{" "}
                  <span aria-hidden="true">+</span>
                </summary>
                {groups.map((g) => (
                  <div className="group" key={g.area}>
                    <div className="gname">{g.area}</div>
                    <div className="chips">
                      {g.tools.map((t) => (
                        <code className="official-chip" key={t}>
                          {t}
                        </code>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="small">
                  <code>{official.package}</code> · <code>--tools=all</code> ·
                  Listed {official.listed_at.slice(0, 10)}
                </p>
              </details>
            </div>
            <div className="intent-panel">
              <div className="intent-panel-title">
                <div>
                  <span className="eyebrow-s">MCPAL</span>
                  <div className="tool-count">
                    {verbs.length}
                    <span>intent-level verbs</span>
                  </div>
                </div>
                <span className="intent-mark" aria-hidden="true">
                  →
                </span>
              </div>
              <div className="intent-verbs">
                {verbs.map((v) => (
                  <div key={v.name}>
                    <div className="intent-verb-name">
                      <code>{v.name}</code>
                      {missingFromOfficial(v.name, officialNames) && (
                        <span className="new-capability">new</span>
                      )}
                    </div>
                    <p>{firstSentence(v.description)}</p>
                    <span className="verb-api">{apiFor(v.name)}</span>
                  </div>
                ))}
              </div>
              <p className="small intent-note">
                “New” marks an intent unavailable in the listed official
                toolkit. All payments still run on PayPal.
              </p>
            </div>
          </div>
        </section>

        <section className="landing-section" aria-labelledby="safety-h">
          <div className="section-heading">
            <div>
              <span className="section-index">05 / GUARDRAILS</span>
              <h2 id="safety-h">Safety, enforced in code.</h2>
            </div>
            <p>
              The model chooses an intent. Deterministic checks decide whether
              money can move.
            </p>
          </div>
          <div className="safety-grid">
            {SAFETY.map((s) => (
              <article key={s.title}>
                <LineIcon kind={s.kind} />
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          className="landing-section policy-section"
          id="policy"
          aria-labelledby="policy-h"
        >
          <div className="section-heading">
            <div>
              <span className="section-index">06 / YOUR RULES</span>
              <h2 id="policy-h">Policy in plain English.</h2>
            </div>
            <p>
              Write the rules in English or Spanish. A model proposes the file;
              code checks the changes. You decide when to apply.
            </p>
          </div>
          <div className="policy-frame">
            <div className="policy-frame-title">
              <LineIcon kind="shield" />
              <span>Your rules. Your approval.</span>
              <span className="small">
                The agent can&apos;t edit its own policy.
              </span>
            </div>
            <PolicyPlayground />
          </div>
          <div className="section-links">
            <Link href="/policy" className="text-link">
              Open the full playground ↗
            </Link>
            <a
              href={`${GITHUB_URL}/blob/main/docs/policy-ai-eval.md`}
              className="text-link"
            >
              Read the eval · 15 cases, 6 adversarial ↗
            </a>
          </div>
        </section>

        <section
          className="landing-section log-section"
          aria-labelledby="log-h"
        >
          <div>
            <span className="section-index">07 / NO BLACK BOX</span>
            <h2 id="log-h">Trace every decision to its receipt.</h2>
            <p>
              Every decision, filterable, with PayPal ids — powered by AG Grid.
            </p>
            <Link href="/ledger" className="text-link">
              Open the decision log ↗
            </Link>
          </div>
          <Link
            href="/ledger"
            className="log-preview"
            aria-label="Explore the real decision log"
          >
            <div className="log-preview-top">
              <span>
                <LineIcon kind="log" /> Decision log
              </span>
              <span className="small">AG Grid</span>
            </div>
            <div className="log-example-label">
              Example view
            </div>
            <div className="log-preview-table">
              <div className="log-table-head">
                <span>VERB</span>
                <span>DECISION</span>
                <span>PAYPAL ID</span>
              </div>
              <div>
                <code>hold</code>
                <span>allowed</span>
                <code>0VF52814…</code>
              </div>
              <div>
                <code>capture_hold</code>
                <span>allowed</span>
                <code>2GH41827…</code>
              </div>
              <div>
                <code>pay_out</code>
                <span className="log-needs">needs approval</span>
                <code>—</code>
              </div>
            </div>
            <div className="log-preview-bottom">
              <LineIcon kind="lock" /> SHA-256 hash chain{" "}
              <span>Inspect the evidence ↗</span>
            </div>
          </Link>
        </section>

        <section className="landing-section" aria-labelledby="commerce-h">
          <div className="section-heading">
            <div>
              <span className="section-index">08 / AGENTIC COMMERCE</span>
              <h2 id="commerce-h">Agent-ready checkout for any PayPal merchant.</h2>
            </div>
          </div>
          <p>
            Buyer agents check out through the open Universal Commerce Protocol
            (UCP): discovery, checkout sessions, fulfillment, discounts and
            orders. The merchant settles every order on PayPal with MCPal&apos;s
            verbs, under the same policy, retry-safe ids and decision log.
          </p>
          <Link href="/commerce" className="text-link">
            Watch a buyer agent buy coffee ↗
          </Link>
        </section>

      </main>
      <footer className="wrap product-footer">
        <Link href="/" className="brand">
          MC<b>Pal</b>
        </Link>
        <span>Built for the PayPal AI Hackathon</span>
        <div>
          <a href={GITHUB_URL}>GitHub ↗</a>
          <a href={`${GITHUB_URL}/blob/main/LICENSE`}>MIT license</a>
          <Link href="/install">Add to your agent →</Link>
        </div>
      </footer>
    </>
  );
}
