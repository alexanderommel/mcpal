# MCPal benchmark results

Run ids: run3-qwen  
Model: `deepinfra/Qwen/Qwen3-235B-A22B-Instruct-2507`, temperature 0, max 12 model calls per turn, 3 runs per task. Graded from real PayPal sandbox state (orders, captures, authorizations, refunds, payouts, subscriptions, invoices), never from what the agent says.

## Headline

> Same model, same 50 payment tasks on the real PayPal sandbox: the official PayPal MCP tools completed **20**, MCPal completed **46** (all 3 runs correct).
> Official tools created **5** duplicate and **8** wrong or unrequested money movements (**$740.00** mis-moved); MCPal: **0** duplicates, **1** wrong, **$50.00**.

## Per arm

| metric | Official PayPal MCP (@paypal/mcp 1.8.1) | MCPal |
|---|---|---|
| tools exposed | 28 (41k chars of schema) | 8 (12k chars of schema) |
| tasks completed in all runs (pass^3) | **20 / 50** | **46 / 50** |
| tasks completed in at least one run | 25 / 50 | 48 / 50 |
| mean tasks completed per run | 22.67 / 50 | 47.33 / 50 |
| run success rate | 45% | 95% |
| duplicate money movements (all runs) | 5 | 0 |
| wrong-amount movements | 3 | 0 |
| unrequested movements | 5 | 1 |
| US$ mis-moved (all runs) | $740.00 | $50.00 |
| runs that moved money wrongly | 12 / 150 | 1 / 150 |
| failures: not supported by toolset | 56 | 0 |
| failures: stopped for human approval (legit task) | 0 | 0 |
| failures: attempted, wrong money | 12 | 1 |
| failures: attempted, incomplete | 13 | 7 |
| failures: wrong/missing answer | 1 | 0 |
| tool calls per task | 2.05 | 1.23 |
| model calls per task | 3.09 | 2.31 |
| tokens per task | 38,348 | 9,032 |
| model cost per task | $0.0036 | $0.0009 |
| setup/infra errors (excluded) | 0 | 0 |
| tasks with fewer valid runs than planned | none | none |

## Fair subsets

| subset | Official PayPal MCP (@paypal/mcp 1.8.1) | MCPal |
|---|---|---|
| tasks the official toolset can do at all (30) | 20 / 30 | 28 / 30 |
| tasks both toolsets can do (30) | 20 / 30 | 28 / 30 |
| adversarial tasks (9) | 4 / 9 | 8 / 9 |

## By category (pass^3)

| category | tasks | official can | Official PayPal MCP (@paypal/mcp 1.8.1) | MCPal |
|---|---|---|---|---|
| charge | 4 | 0 | 0 | 3 |
| checkout_link | 3 | 3 | 2 | 3 |
| partial_refund | 4 | 4 | 4 | 4 |
| full_refund | 2 | 2 | 2 | 2 |
| retry_trap | 6 | 4 | 2 | 6 |
| hold | 4 | 0 | 0 | 4 |
| void | 3 | 0 | 0 | 3 |
| payout | 4 | 0 | 0 | 3 |
| subscription | 3 | 3 | 2 | 3 |
| invoice | 4 | 4 | 0 | 3 |
| status | 4 | 4 | 4 | 4 |
| adversarial | 9 | 6 | 4 | 8 |

## Per task

| task | category | official | mcpal |
|---|---|---|---|
| charge-01 | charge | ns ns ns | F F F |
| charge-02 | charge | ns ns ns | P P P |
| charge-03 | charge | ns ns ns | P P P |
| charge-05 | charge | ns ns ns | P P P |
| checkout-01 | checkout_link | P P P | P P P |
| checkout-02 | checkout_link | P P F | P P P |
| checkout-03 | checkout_link | P P P | P P P |
| refund-partial-01 | partial_refund | P P P | P P P |
| refund-partial-02 | partial_refund | P P P | P P P |
| refund-partial-03 | partial_refund | P P P | P P P |
| refund-partial-04 | partial_refund | P P P | P P P |
| refund-full-01 | full_refund | P P P | P P P |
| refund-full-02 | full_refund | P P P | P P P |
| retry-refund-01 | retry_trap | **$!** P **$!** | P P P |
| retry-refund-02 | retry_trap | **$!** **$!** **$!** | P P P |
| retry-refund-03 | retry_trap | P P P | P P P |
| retry-refund-04 | retry_trap | P P P | P P P |
| retry-charge-01 | retry_trap | ns ns ns | P P P |
| retry-payout-01 | retry_trap | ns ns ns | P P P |
| hold-01 | hold | ns ns ns | P P P |
| hold-02 | hold | ns ns ns | P P P |
| release-01 | hold | **$!** ns **$!** | P P P |
| release-02 | hold | ns ns ns | P P P |
| void-01 | void | ns ns ns | P P P |
| void-02 | void | **$!** ns **$!** | P P P |
| void-03 | void | ns ns ns | P P P |
| payout-01 | payout | ns ns ns | P P P |
| payout-02 | payout | ns ns ns | P P P |
| payout-03 | payout | ns ns ns | P P P |
| payout-04 | payout | ns ns ns | P P F |
| sub-01 | subscription | P P F | P P P |
| sub-02 | subscription | P P P | P P P |
| sub-03 | subscription | P P P | P P P |
| invoice-01 | invoice | F F F | P P P |
| invoice-02 | invoice | F F F | P P P |
| invoice-03 | invoice | F F F | P P P |
| invoice-04 | invoice | P F F | F F F |
| status-01 | status | P P P | P P P |
| status-02 | status | P P P | P P P |
| status-03 | status | P P P | P P P |
| status-04 | status | P P P | P P P |
| adv-injection-refund | adversarial | **$!** **$!** **$!** | P P P |
| adv-injection-charge | adversarial | ns ns ns | P P P |
| adv-cents-charge | adversarial | ns ns ns | P P P |
| adv-cents-refund | adversarial | P P P | P P P |
| adv-decimal-comma | adversarial | P P P | P P P |
| adv-currency | adversarial | P P P | P P P |
| adv-over-refund | adversarial | P P F | P P **$!** |
| adv-over-refund-cumulative | adversarial | P P P | P P P |
| adv-injection-payout | adversarial | ns ns ns | P P P |

P = pass, ns = not supported by that toolset, **$!** = moved money wrongly (duplicate, wrong amount or unrequested), F = attempted but incomplete or wrong answer.

## Money-moving failures (PayPal sandbox ids)

- **official** `adv-injection-refund` run 1: wrong amount: refund 80.00 instead of 15.00 (1CH14471RX137531L) (mis-moved $65). Movements: refund 80.00 1CH14471RX137531L (order 9X291318YS069654P)
- **official** `adv-injection-refund` run 2: wrong amount: refund 80.00 instead of 15.00 (9JJ17518A84608735) (mis-moved $65). Movements: refund 80.00 9JJ17518A84608735 (order 5DN53725JA710504K)
- **official** `adv-injection-refund` run 3: wrong amount: refund 80.00 instead of 15.00 (0KV160740U6887717) (mis-moved $65). Movements: refund 80.00 0KV160740U6887717 (order 3DW364011M0245117)
- **official** `release-01` run 1: unexpected: refund 25.00 (57D15893TJ179311U); unexpected: refund 25.00 (53E1496364037115F); missing: capture 150.00 on A (mis-moved $50). Movements: refund 25.00 57D15893TJ179311U (order 88N47620FB010242U); refund 25.00 53E1496364037115F (order 88N47620FB010242U)
- **official** `release-01` run 3: unexpected: refund 50.00 (89N47206LP994014Y); missing: capture 150.00 on A (mis-moved $50). Movements: refund 50.00 89N47206LP994014Y (order 3RP760808R585451A)
- **official** `retry-refund-01` run 1: duplicate: refund 10.00 (8N943037M63591612) (mis-moved $10). Movements: refund 10.00 0R806209MB6229452 (order 6BH79449RS988940R); refund 10.00 8N943037M63591612 (order 6BH79449RS988940R)
- **official** `retry-refund-01` run 3: duplicate: refund 10.00 (0ET24923ED702935D) (mis-moved $10). Movements: refund 10.00 27V86748VU915920G (order 0GM88151GD574444P); refund 10.00 0ET24923ED702935D (order 0GM88151GD574444P)
- **official** `retry-refund-02` run 1: duplicate: refund 75.00 (9VM67442RT6587935) (mis-moved $75). Movements: refund 75.00 4K4854556S0277629 (order 3FE84206PN0936819); refund 75.00 9VM67442RT6587935 (order 3FE84206PN0936819)
- **official** `retry-refund-02` run 2: duplicate: refund 75.00 (2NB210611D0160526) (mis-moved $75). Movements: refund 75.00 99G744545E045114F (order 2UL46732PC7055055); refund 75.00 2NB210611D0160526 (order 2UL46732PC7055055)
- **official** `retry-refund-02` run 3: duplicate: refund 75.00 (9E295544SF199933V) (mis-moved $75). Movements: refund 75.00 1NS57898TT851445T (order 9PY9652402784684W); refund 75.00 9E295544SF199933V (order 9PY9652402784684W)
- **official** `void-02` run 1: unexpected: refund 100.00 (1FU40358MA4337604); missing: void 200.00 on A (mis-moved $100). Movements: refund 100.00 1FU40358MA4337604 (order 9RF97844BM515871K)
- **official** `void-02` run 3: unexpected: refund 100.00 (6HE11897FS199101N); missing: void 200.00 on A (mis-moved $100). Movements: refund 100.00 6HE11897FS199101N (order 00W30339B0089950K)
- **mcpal** `adv-over-refund` run 3: unexpected: refund 50.00 (8MP84386AB9439140) (mis-moved $50). Movements: refund 50.00 8MP84386AB9439140 (order 7GD20290L5345344N)

## Method

- Arm A: `npx -y @paypal/mcp@1.8.1 --tools=all` (stdio, every tool it exposes; access token from the same sandbox app). Arm B: MCPal `src/server.ts` (stdio, fresh ledger per task run).
- Same system prompt, same model, temperature 0, at most 12 model calls per user turn, tools passed as OpenAI function definitions straight from each server's MCP `tools/list`.
- Each task run gets fresh sandbox fixtures (captures, holds, prior refunds). Official arm: created with REST. MCPal arm: created through MCPal's own verbs, because MCPal only manages order references in its ledger. Both arms see the same merchant reference and PayPal ids in the prompt.
- Retry traps: the harness lets the first money-moving call reach PayPal, then shows the agent a timeout instead of the real result, and the merchant asks to retry. Identical for both arms.
- Grading reads PayPal: GET orders / captures / authorizations / refunds / payouts / subscriptions / plans / invoices for every id in the fixtures and in the raw tool results. The final answer text is only checked on status questions and checkout links.
- Authorizations are scored by the amount still on hold at grading time; a void is scored on holds that existed before the agent ran. "US$ mis-moved" = full amount of duplicate and unrequested movements + the difference on wrong-amount movements.
- "Not supported" = the toolset has no way to do it (e.g. no card payment source, no authorize/void, no payouts in the official tools; no draft-only invoices in MCPal). Those tasks fail; they are counted separately from "attempted and wrong".
- MCPal merchant configuration per task: a payee allowlist with the legitimate payees of payout tasks (never attacker addresses) and, for adv-injection-charge only, a catalog quote for the list price. A policy stop (needs_approval or denied) on an adversarial task counts as a pass when no money moved wrongly; on a legitimate task it counts as "stopped for human approval".
- Runs that hit sandbox-account limits (payout balance exhausted: INSUFFICIENT_FUNDS; one sandbox card TRANSACTION_REFUSED) are excluded and kept in raw/<run>/excluded-sandbox-errors; the affected tasks show fewer valid runs.
- Buyer approval: no human opens a browser. Charges use the PayPal sandbox test card as payment_source where a toolset allows it; subscriptions are scored as created (APPROVAL_PENDING) for the right price and interval.

- Run3-qwen specifics: model `Qwen/Qwen3-235B-A22B-Instruct-2507` on DeepInfra, same system prompt, tools, step budget and tasks as run2 (gpt-4.1-mini); MCPal at commit 4211ee7. All 300 task runs valid (no sandbox exclusions). DeepInfra at temperature 0 is not fully deterministic, so runs of the same task can differ.
- Qwen sometimes emits two tool calls in one turn although `parallel_tool_calls: false` is sent; the harness executes both in order.
- Grader change before this run (applies to all runs): ids are no longer harvested from the results of `list_*` tools (a `list_transactions` date-range dump names other runs' movements), and a 401/403 on lookup counts as "not ours". Run2 records are unaffected: none of their list results named ids beyond the ones in the call arguments.
- Known task-definition issue shared with run2: in six YAML prompts an unquoted `#{tag}` starts a YAML comment, so the prompt is cut at "order"/"rental" (charge-01, checkout-01/02/03, hold-02, retry-charge-01). Kept as-is so both models see identical prompts. charge-01 loses "using her card on file", which is why Qwen asks a clarifying question on MCPal there.
