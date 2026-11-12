# MCPal benchmark: second model

Same 50 tasks, same system prompt, temperature 0, at most 12 model calls per turn, real PayPal sandbox, graded from PayPal state. One run id per model: `run2`, `run3-qwen`.

## Run 1 of every task (pass^1, same footing for every model)

| model | toolset | tasks correct | official-capable tasks correct | adversarial correct | duplicates | wrong-amount | unrequested | US$ mis-moved | runs moving money wrongly |
|---|---|---|---|---|---|---|---|---|---|
| gpt-4.1-mini | Official PayPal MCP (@paypal/mcp 1.8.1) | **21 / 50** | 21 / 30 | 6 / 9 | 2 | 0 | 0 | $85.00 | 2 / 50 |
| gpt-4.1-mini | MCPal | **49 / 50** | 29 / 30 | 9 / 9 | 0 | 0 | 0 | $0.00 | 0 / 50 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | Official PayPal MCP (@paypal/mcp 1.8.1) | **24 / 50** | 24 / 30 | 5 / 9 | 2 | 1 | 3 | $300.00 | 5 / 50 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | MCPal | **48 / 50** | 29 / 30 | 9 / 9 | 0 | 0 | 0 | $0.00 | 0 / 50 |

## All runs (pass^k: correct in every run)

| model | toolset | runs per task | tasks correct in all runs | adversarial | duplicates | wrong-amount | unrequested | US$ mis-moved | runs moving money wrongly |
|---|---|---|---|---|---|---|---|---|---|
| gpt-4.1-mini | Official PayPal MCP (@paypal/mcp 1.8.1) | 3 | **17 / 50** | 3 / 9 | 5 | 0 | 1 | $295.00 | 6 / 150 |
| gpt-4.1-mini | MCPal | 3 | **49 / 50** | 9 / 9 | 0 | 0 | 0 | $0.00 | 0 / 144 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | Official PayPal MCP (@paypal/mcp 1.8.1) | 3 | **20 / 50** | 4 / 9 | 5 | 3 | 5 | $740.00 | 12 / 150 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | MCPal | 3 | **46 / 50** | 8 / 9 | 0 | 0 | 1 | $50.00 | 1 / 150 |

## Cost

| model | toolset | tokens per task | model cost per task | model cost, all runs |
|---|---|---|---|---|
| gpt-4.1-mini | Official PayPal MCP (@paypal/mcp 1.8.1) | 21,837 | $0.0034 | $0.51 |
| gpt-4.1-mini | MCPal | 6,584 | $0.0012 | $0.18 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | Official PayPal MCP (@paypal/mcp 1.8.1) | 38,348 | $0.0036 | $0.54 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | MCPal | 9,032 | $0.0009 | $0.13 |

## Notes

- run2 = gpt-4.1-mini (OpenAI); run3-qwen = Qwen/Qwen3-235B-A22B-Instruct-2507 (DeepInfra). Same system prompt, tools, temperature 0, 12-step budget and task files. Per-run detail: `summary.md` (run2) and `run3-qwen/summary.md`.
- run2 payout tasks have 2 valid runs, not 3 (sandbox payout balance ran out); run3-qwen has all 300 runs valid.
- DeepInfra at temperature 0 is not fully deterministic, so repeated runs of one task can differ.
- Six task prompts are cut at an unquoted `#{tag}` (YAML comment) in both runs, identically for both models; see `run3-qwen/summary.md`.
