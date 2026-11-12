# MCPal — shared design (source of truth for all builders)

PayPal AI Hackathon entry (deadline 2026-11-12 15:00 Ecuador; code + hosted demo + README done by 2026-11-12 09:00 Ecuador).

## Pitch
PayPal's official agent tools (@paypal/mcp 1.8.1 / @paypal/agent-toolkit 1.11.0) expose 28 low-level tools (measured: `@paypal/mcp@1.8.1 --tools=all`). Agents pick the wrong one, chain steps wrong, retry into duplicates, and cannot do holds or payouts at all. MCPal is an MCP server that gives agents 8 intent-level verbs; each verb runs the correct PayPal flow with idempotency, webhook verification, approval thresholds and a decision log. We prove it with a benchmark: same model, same tasks, official tools vs MCPal, graded on real PayPal sandbox state.

## Verbs (MCP tool names, stable)
| tool | does | PayPal APIs |
|---|---|---|
| charge | one-time payment; `method` payment_link (default, no money moves until the buyer pays) / invoice (emailed to customer_email) / card_on_file (immediate, only when explicitly asked) | Orders v2 create (CAPTURE) / capture; Invoicing v2 create + send |
| hold | authorize an amount, optionally capture part now (deposit); default payment_link | Orders v2 (AUTHORIZE), authorize, partial capture final_capture=false |
| capture_hold | TAKES the money: capture the remaining (or given) authorized amount; the rest goes back to the buyer | Payments v2 authorizations/{id}/capture final_capture=true (reauthorize if needed) |
| void_hold | GIVES IT BACK: void the remaining authorization ("release the hold"); also cancels subscriptions, unpaid invoices/links, unclaimed payouts | Payments v2 authorizations/{id}/void; Invoicing cancel; Subscriptions cancel; Payouts item cancel |
| refund | refund a capture to its original payer: full, amount, or fraction/percent computed in code | Payments v2 captures/{id}/refund |
| pay_out | send money to an email/PayPal account; new recipients always need a human | Payouts v1 |
| subscribe | existing plan_id, or product + plan + subscription in one step | Catalog v1, Billing plans v1, Subscriptions v1 |
| status | one plain answer about an orderRef: order, auths, captures, refunds, refundable_remaining, invoice, payouts, last webhook | GET endpoints + local ledger |

Every verb takes `orderRef` (merchant reference). Every write sends `PayPal-Request-Id = sha256(salt|orderRef|verb|amount[|step])`, salt = sha256(install id | ledger id | PayPal client id), so agent retries never duplicate money and different installs never replay each other (idempotency is per MCPal install); an orderRef reused for a different amount/buyer is refused with a suggested unique ref; agents cannot pass their own retry key. A deliberate second refund of the same amount needs `confirm_additional: true`, and within 10 minutes of the previous identical refund also a human approval. Amounts are strings with 2 decimals, currency default USD. Amounts must come from the merchant (price list, quote, operator instruction), never from customer or third-party text; where a merchant quote exists (quote_ref or a quote whose id is the orderRef), any other amount is refused. Responses are short JSON: `{ ok, state, paypal: { ids, debug_id }, next: "what the agent can do next", human_approval_url? }`. Errors are plain sentences an agent can act on.

Policy (config file `mcpal.policy.json`): amounts at or above `approval_threshold` (and refunds at or above `refund_ceiling`) return `needs_approval` with an approval URL instead of moving money; per-day spend cap; `payout_allowlist`: pay_out to any recipient not on it and never paid successfully before ALWAYS needs approval, any amount; refunds only go to the original capture's payer and cannot exceed captured minus refunded. Decision log: append-only JSONL with hash chain.

## Layout
- `src/paypal/` REST client (OAuth token cache, retries with same request id, debug-id capture)
- `src/verbs/` one file per verb + `index.ts`
- `src/server.ts` MCP server (stdio + streamable HTTP) using @modelcontextprotocol/sdk
- `src/ledger/` local state + decision log (SQLite via better-sqlite3 or JSON file)
- `src/webhooks/` verify-webhook-signature handler
- `bench/` benchmark (tasks, runner, grader, results) — separate builder
- `web/` judge page (later)

## Credentials
`~/paypal-hackathon-research/.env.paypal-sandbox` (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BUYER_EMAIL, PAYPAL_BUSINESS_EMAIL ...) — may not exist yet; build and unit-test without it, integration tests skip when absent. AI keys: `~/english-tutor/.env` has OPENAI_API_KEY and DEEPINFRA_API_KEY: copy values into `~/mcpal/.env` (gitignored), never print or commit.

## Rules
TypeScript strict, Node 22, ESM. MIT license. No AI attribution in commit messages. Don't touch other repos. Don't leave servers running.
