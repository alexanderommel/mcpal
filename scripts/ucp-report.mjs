// Turns vitest JSON results of test/ucp-conformance.test.ts into docs/ucp-conformance.json and .md.
//   node scripts/ucp-report.mjs local=<local.json> production=<prod.json>
// These are SPEC-DERIVED checks (our implementation of the UCP conformance modules), not the official suite run.
import { readFileSync, writeFileSync } from "node:fs";

const COMMIT = "1201fb78e85217c5f2df060066ccbb0a1d1dce0b";
const SPEC_COMMIT = "98607bc53f6f5e43ec15b9f96b82cba4912f0fe4";
// The 17 official modules and how we cover each one.
const MODULES = [
  ["shopping/checkout/protocol_test.py", "checkout/protocol", "covered", ""],
  ["shopping/checkout/lifecycle_test.py", "checkout/lifecycle", "covered", ""],
  ["shopping/checkout/idempotency_test.py", "checkout/idempotency", "covered", ""],
  ["shopping/checkout/totals_test.py", "checkout/totals", "covered", ""],
  ["shopping/checkout/business_logic_test.py", "checkout/business_logic", "partial", "test_buyer_consent not re-implemented: the buyer_consent capability is not advertised (consent is stored and echoed, not acted on)."],
  ["shopping/discount/semantics_test.py", "discount/semantics", "covered", ""],
  ["shopping/fulfillment/fulfillment_test.py", "fulfillment/fulfillment", "partial", "Known-customer stored-address tests (5) are unsupported: the merchant keeps no customer address book. Item-based free shipping is not offered (the official test would skip)."],
  ["shopping/fulfillment/structure_test.py", "fulfillment/structure", "covered", ""],
  ["shopping/order/order_test.py", "order/order", "partial", "GET /orders/{id} and expectations are checked. PUT /orders/{id} (platform-written fulfillment events and adjustments) is unsupported; shipping and refunds go through the merchant's own MCPal actions instead."],
  ["shopping/validation/validation_test.py", "validation/validation", "covered", ""],
  ["shopping/validation/invalid_input_test.py", "", "unsupported", "Needs PUT /orders/{id}, which is not implemented."],
  ["common/payments/card_credential_test.py", "payments/card_credential", "covered", "The card number is never forwarded: the sandbox handler charges PayPal's published sandbox test card through MCPal."],
  ["common/payments/token_binding_test.py", "", "not checked", "A token with a binding completes (binding accepted but not verified)."],
  ["common/payments/ap2_test.py", "", "unsupported", "AP2 mandates are ignored, not verified."],
  ["shopping/order/webhook_test.py", "", "unsupported", "No order webhooks are delivered to the platform."],
  ["shopping/order/webhook_structure_test.py", "", "unsupported", "No order webhooks (so no Standard Webhooks headers, retries or RFC 9421 signatures)."],
  ["shopping/order/simulation_url_security_test.py", "", "unsupported", "No /testing/simulate-shipping endpoint; shipping is the merchant's POST /orders/{id}/ship (MCPal capture_hold)."],
];

const runs = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [label, file] = a.split("=");
    const j = JSON.parse(readFileSync(file, "utf8"));
    const by = {};
    for (const f of j.testResults)
      for (const t of f.assertionResults) {
        const mod = t.ancestorTitles.at(-1);
        by[mod] ??= { pass: 0, fail: 0, tests: [] };
        const ok = t.status === "passed";
        ok ? by[mod].pass++ : by[mod].fail++;
        by[mod].tests.push({ name: t.title, ok, ...(ok ? {} : { error: (t.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 300) }) });
      }
    return [label, { at: new Date(j.startTime).toISOString(), passed: j.numPassedTests, total: j.numTotalTests, modules: by }];
  }),
);

const out = {
  title: "UCP spec-derived checks (our implementation of the UCP conformance modules), not the official suite run",
  note: `Checks re-implemented in test/ucp-conformance.test.ts from the source of github.com/Universal-Commerce-Protocol/conformance at commit ${COMMIT} and the UCP schemas at commit ${SPEC_COMMIT}. The official Python suite was not executed: running its code (and installing ucp-sdk 0.4.6) was blocked by this environment's permission policy. To run it yourself: clone the conformance repo, then SERVER_URL=https://mcpal.vercel.app uv run pytest with a conformance_input.json naming bag_house_blend_12oz / bag_panama_geisha_4oz and test_fixtures.json with AGENT10 (10%), BEANS20 (20%), FIVEOFF (5.00).`,
  ucp_version: "2026-04-08",
  modules: MODULES.map(([official, ours, coverage, note]) => ({
    official_module: official,
    our_module: ours || null,
    coverage,
    note: note || undefined,
    results: Object.fromEntries(Object.entries(runs).map(([label, r]) => [label, ours && r.modules[ours] ? { pass: r.modules[ours].pass, fail: r.modules[ours].fail } : null])),
  })),
  extensions: [
    ["mcpal/settlement", "MCPal extension (not UCP): ship-later settlement", "Authorize at complete (MCPal hold), capture on ship (capture_hold), partial refund (refund)."],
    ["acp/checkout_sessions", "ACP checkout_sessions (not UCP)", "Spec-derived from the ACP 2026-04-17 OpenAPI; there is no ACP conformance suite to mirror."],
  ].map(([mod, title, note]) => ({ module: mod, title, note, results: Object.fromEntries(Object.entries(runs).map(([l, r]) => [l, r.modules[mod] ? { pass: r.modules[mod].pass, fail: r.modules[mod].fail } : null])) })),
  runs,
};
writeFileSync("docs/ucp-conformance.json", JSON.stringify(out, null, 2) + "\n");

const labels = Object.keys(runs);
const cell = (r) => (r ? `${r.pass}/${r.pass + r.fail}${r.fail ? " FAIL" : ""}` : "-");
const md = [
  "# UCP spec-derived checks (our implementation of the UCP conformance modules), not the official suite run",
  "",
  out.note,
  "",
  "Each check cites the official module and test function it mirrors and the spec section it enforces. Fixture values are Coffee Club Supply's own catalog (the role the suite's `conformance_input.json` / `test_fixtures.json` play). Completing a checkout moves real PayPal **sandbox** money through MCPal.",
  "",
  ...labels.map((l) => `- **${l}**: ${runs[l].passed}/${runs[l].total} checks passed (${runs[l].at}).`),
  "",
  `| official module | coverage | ${labels.join(" | ")} | note |`,
  `|---|---|${labels.map(() => "---|").join("")}---|`,
  ...out.modules.map((m) => `| \`${m.official_module}\` | ${m.coverage} | ${labels.map((l) => cell(m.results[l])).join(" | ")} | ${m.note ?? ""} |`),
  ...out.extensions.map((e) => `| ${e.title} | extra | ${labels.map((l) => cell(e.results[l])).join(" | ")} | ${e.note} |`),
  "",
  "Run them yourself:",
  "",
  "```bash",
  "UCP_BASE_URL=https://mcpal.vercel.app npx vitest run test/ucp-conformance.test.ts",
  "```",
  "",
  "## Every check",
  "",
  ...labels.flatMap((l) => [
    `### ${l}`,
    "",
    ...Object.entries(runs[l].modules).flatMap(([mod, r]) => [`**${mod}**`, "", ...r.tests.map((t) => `- ${t.ok ? "pass" : "FAIL"}: ${t.name}${t.error ? ` — ${t.error}` : ""}`), ""]),
  ]),
].join("\n");
writeFileSync("docs/ucp-conformance.md", md + "\n");
console.log(labels.map((l) => `${l}: ${runs[l].passed}/${runs[l].total}`).join(", "));
