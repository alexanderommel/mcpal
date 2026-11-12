# MCPal — Devpost submission (final)

**Links:** demo https://mcpal.vercel.app · install https://mcpal.vercel.app/install · judge console https://mcpal.vercel.app/judge · benchmark https://mcpal.vercel.app/benchmark · policy https://mcpal.vercel.app/policy · repo github.com/alexanderommel/mcpal (MIT)

**Name:** MCPal

**Tagline (≤200 chars):** Give your AI agent PayPal, safely. One MCP line adds 8 verbs on top of PayPal's APIs. Same model, same 50 tasks: 29/30 vs 17/30 with the official tools, and no payment made twice.

---

## Inspiration
AI agents are starting to handle small businesses' money: deposits, refunds, courier payouts. We gave the same model the same 50 merchant payment requests twice, once with PayPal's official MCP server (the npm package @paypal/mcp 1.8.1, 28 tools; PayPal's hosted server lists 46, and neither has holds, payouts or retry-safe keys) and once with MCPal, and graded every run by reading PayPal's own sandbox records, not by trusting what the agent said. With the official tools the agent refunded a customer twice after a network timeout ($75, refunds 9N023148D9313614L and 5K9682505J188951K). That is the problem MCPal solves.

## What it does
MCPal is an MCP server for AI agents, built on PayPal's REST APIs as the layer after PayPal's Agent Toolkit. It gives an agent 8 verbs that match what a business asks for: charge, hold, capture_hold, void_hold, refund, pay_out, subscribe, status. Each verb runs the whole PayPal flow underneath with:
- an idempotency key the agent can't change (a retry returns the first result; no money moves twice),
- an approval policy (thresholds, daily cap, refund ceiling, payout allowlist; new payees always need a human),
- merchant quotes the agent can't edit (an injected "$1.00" price is refused),
- verified PayPal webhooks and a hash-chained decision log.

**Add it to your own agent in one line** (like Stripe's remote MCP): `claude mcp add --transport http mcpal "https://mcpal.vercel.app/mcp?key=<your demo key>"`, or one-click Add to Cursor / Install in VS Code / claude.ai connector at /install. Each visitor gets an isolated sandbox ledger.

**Bring your own sandbox.** Paste your own PayPal sandbox app's Client ID and Secret on /install and MCPal gives you a demo key that runs on your sandbox account, so you watch the holds and captures land in your own PayPal dashboard. Credentials are checked against the sandbox and refused if they work on live; the secret is encrypted at rest and one click forgets it.

**Policy in plain English (AI inside the product):** a merchant writes "I approve refunds over $100 myself; only pay my couriers juan@x.com and ana@y.com; never more than $500 a day". gpt-4.1-mini proposes the policy; code validates it (limits only loosen when the amount is written, recipients only when written, hard maximums), and nothing applies until a human clicks Apply. The agent has no tool to edit its own rules. 15/15 on our labelled cases, 6/6 adversarial.

## Agentic commerce (UCP/ACP)
MCPal also makes a PayPal merchant agent-ready. A demo merchant, Coffee Club Supply, serves the open Universal Commerce Protocol checkout (UCP 2026-04-08, REST) at https://mcpal.vercel.app/ucp/v1, with discovery at /.well-known/ucp. The same engine also answers ACP `checkout_sessions` at /acp/checkout_sessions.

Buyer agents send item ids, an address, discount codes and a payment instrument. The merchant prices the order. Then:
- `complete` runs MCPal `charge` on PayPal (or `hold`, then `capture_hold` when the order ships);
- `cancel` runs `void_hold`;
- refunds run `refund`.

MCPal's guarantees carry over to these agent orders. The policy limits apply: a total of $250 or more answers `requires_escalation` and nothing is charged. Retry-safe PayPal request ids mean a repeated complete never charges twice. Every decision lands in the hash-chained log.

In a recorded run, a gpt-4.1-mini buyer agent knew only the discovery URL. It bought two bags of coffee with the AGENT10 discount and standard shipping for $31.19. That is PayPal sandbox order 5H043375UE8541721, capture 1EW29591SW950060R. The transcript is in docs/agentic-commerce-proof.md, and the /commerce page can run the agent again live.

We re-implemented the checks of the official UCP conformance modules from their source. These are spec-derived checks, not a run of the official suite. Results are in docs/ucp-conformance.md, including the unsupported modules: webhooks, PUT /orders, simulate-shipping, AP2 and token binding.

**Official UCP conformance suite** (Google's, run against our live endpoints): 78 tests — 55 passed, 14 failed, 9 skipped. All 14 failures are the three features the demo merchant doesn't implement (order webhooks, platform-written order updates, shipping simulation); checkout, idempotency, totals, discounts, validation and card credentials all pass.

## How we measured it
Same model (gpt-4.1-mini, temperature 0), same 50 merchant payment tasks, 3 runs each, graded from PayPal's own records.

| | Official PayPal MCP (28 tools) | MCPal (8 verbs) |
|---|---|---|
| On the 30 tasks the official toolkit can attempt | 17 / 30 | 29 / 30 |
| All 50 tasks, correct in every run | 17 / 50 | 49 / 50 |
| Duplicate money movements | 5 | 0 |
| US$ moved wrongly | $295 | $0 |
| Adversarial / prompt-injection tasks | 3 / 9 | 9 / 9 |
| Tokens per task | 21.8k | 6.6k |

Our own first version failed too: a fake email signature got a $500 payout, and "release the hold" captured instead of voiding (38/50, $1,667 moved wrongly). We fixed each issue and reran: 49/50, $0. Every wrong movement, with sandbox IDs: /benchmark.

**Second model (robustness check):** the same 50 tasks with Qwen3-235B (a different model family, via DeepInfra): official tools 20/50 vs MCPal 46/50 correct in every run; money moved wrongly $740 vs $50 (the one MCPal case: the model refunded the remaining $50 after MCPal refused an $80 over-refund — within policy, but not what the merchant asked; documented on /benchmark).


## How we built it
TypeScript MCP server (stdio + Streamable HTTP) and library; Next.js on Vercel; remote MCP with per-key isolated state. PayPal: Orders v2 (create, AUTHORIZE, capture), Payments v2 (authorization capture/void/reauthorize, capture refunds, multiple partial captures), Payouts v1, Invoicing v2, Catalog Products + Billing Plans + Subscriptions v1, Notifications (verify-webhook-signature). 65 unit tests + sandbox integration tests.
AG Grid Community powers the decision log explorer (/ledger: every payment decision with PayPal ids, policy rule, verified hash chain, filters, per-order totals, CSV export) and the 50-task × 2-toolset benchmark grid on /benchmark.

## AI tools used (and how)
- **OpenAI gpt-4.1-mini**: the agent in the judge console and the benchmark (temperature 0); the plain-English policy compiler (structured outputs). Money decisions are always deterministic code.
- **Claude Code and OpenAI Codex**: coding assistants used to build the project.

## What's real vs simulated
Every PayPal call is real, on the PayPal sandbox; card payments use PayPal's published sandbox test card; the "network timeout" in the retry tasks is injected by our harness, equally for both toolsets; nothing is live.

## Challenges
A sandbox merchant account registered in Ecuador can't process cards (we moved to a US sandbox account); captures are capped at 115% of an order; transaction search lags new sandbox payments; our first version's own mistakes, found by our benchmark.

## What's next
MCPal Cloud: a merchant connects their PayPal account once (PayPal's partner onboarding) and any agent gets the 8 verbs under that merchant's plain-English policy. Publish to the MCP registry and npm.
