# Remote MCP proof (https://mcpal.vercel.app/mcp)

Recorded 2026-11-12 between 08:03 and 08:09 Ecuador time (UTC-5), against the production deployment. Every id below is a real PayPal **sandbox** id. Demo keys are redacted as `<key>`.

## What the endpoint is

- Streamable HTTP MCP, stateless: JSON responses, no session id, POST only. It runs as a Next.js route on Vercel (`web/app/mcp/route.ts`).
- Auth is a demo key, passed as `?key=<key>` or `Authorization: Bearer <key>`. The site generates a random key per visitor (`dk_` + 24 characters) at `/install`. A request without a key gets HTTP 401 with instructions.
- Each key has its own MCPal ledger: refs, spend, approvals, the hash-chained decision log, and its own install id and ledger id. Idempotency keys (`PayPal-Request-Id`) are therefore stable for one key and never shared between keys.
- **Storage:** a private Vercel Blob store (`mcpal-state`), with one JSON document per key, read with the CDN cache bypassed. Tool calls for one key are serialized with a lock blob; a stale lock is taken over with an ETag-conditional write.
  - Why not Neon: the Vercel marketplace install of Neon (and of Upstash) needs a human to accept the integration terms in a browser, and `neonctl` had no non-browser credentials on this machine. Blob is first-party Vercel storage and could be created from the CLI (`vercel blob create-store mcpal-state --access private`).
- **Limits checked before MCPal's own policy and PayPal** (`web/lib/remote.ts`):
  - 30 tool calls per hour per key, and 60 per hour per IP (the IP count is stored in Blob too).
  - Every amount up to $500.00, USD only.
  - Payouts only to PayPal sandbox addresses (`…example.com`).
  - Invoices only to sandbox addresses.
  - `card_on_file` uses PayPal's sandbox test card 4012000077777777.
- **Policy per key:**
  - Approval threshold $250.00, daily cap $1,000.00, refund ceiling $250.00.
  - The sandbox courier is on the payout allowlist; anyone else needs a human.
  - Approval links point to `https://mcpal.vercel.app/r/<namespace>/approvals/<id>`. They only open for the browser that holds the same key, or for someone who pastes it. The namespace is a hash of the key and does not reveal it.

## 1. TypeScript MCP SDK client

Script: `web/scripts/remote-mcp-check.mts` (`@modelcontextprotocol/sdk` 1.32.2 `StreamableHTTPClientTransport`), run with a fresh key:

```
MCP_URL="https://mcpal.vercel.app/mcp?key=<key>" npx tsx scripts/remote-mcp-check.mts
tools: charge, hold, capture_hold, void_hold, refund, pay_out, subscribe, status
```

| call | result | PayPal sandbox ids |
|---|---|---|
| `hold` 120.00, deposit 40.00, card_on_file | `deposit_captured` | order 5G925966BD9115622, authorization 7PB62467S0474645L, capture 0EU39183NF6251600 |
| the same `hold` again (agent retry) | `deposit_captured`, `replayed: true` | the same ids; nothing new at PayPal |
| `capture_hold` | `captured` (80.00) | capture 89R32682AG5402053 |
| `status` | `captured`, refundable 120.00 | both captures |
| `pay_out` to someone@gmail.com | `demo_guard`: payouts only to sandbox addresses | none (never sent) |
| `charge` 900.00 | `demo_guard`: cap $500 | none (never sent) |

The retry was a separate HTTP request, and so a separate serverless invocation. It was answered from the ledger stored in Blob.

Isolation: a different key, sent as `Authorization: Bearer <key2>`, asked `status` for `booking-88603` (an order created with the first key) and got `No record of orderRef booking-88603 on this MCPal server.`

## 2. Claude Code, non-interactive

```
claude mcp add --transport http mcpal "https://mcpal.vercel.app/mcp?key=<key>"
claude mcp list   →  mcpal: https://mcpal.vercel.app/mcp?key=<key> (HTTP) - ✔ Connected
```

Then `claude -p "<prompt>" --allowedTools "mcp__mcpal__…" --output-format stream-json --verbose`. Model: claude-opus-5-5. Tool calls and results are copied from the stream-json output. The final answers are shortened, and a personal footer that comes from the operator's global CLAUDE.md is removed.

### Run 1: take a deposit and hold the rest

> I run a small shop. Order booking-88603 is $120.00 (USD). Take a $40 deposit now from the card on file and hold the remaining $80 until delivery. Use orderRef booking-88603. Reply with what happened and the PayPal ids.

```
tool  mcp__mcpal__hold {"orderRef":"booking-88603","amount":"120.00","deposit":"40.00","currency":"USD","method":"card_on_file","description":"Order booking-88603: $40 deposit, $80 held until delivery"}
→ {"ok":true,"state":"deposit_captured","details":{"authorized":"120.00","deposit_captured":"40.00","remaining_held":"80.00","authorization_status":"CREATED"},
   "paypal":{"ids":{"order_id":"8AW86436FW9513607","authorization_id":"39X71873HD645721C","capture_ids":["2VW477746J656691V"]},"debug_id":"f6791308fdb9d"}}
```

Claude: "The $40 deposit was charged to the card on file, and the other $80 is on hold until delivery. Order ID 8AW86436FW9513607, Authorization ID 39X71873HD645721C, deposit capture ID 2VW477746J656691V."

### Run 2: delivered, so capture the rest; then a $300 charge that needs a human

> Order booking-88603 was delivered: capture the rest of the hold. Then charge order sofa-booking-88603 $300.00 (USD) on the card on file.

Claude called `status` twice, then `capture_hold` and `charge` in parallel. The per-key lock ran them one after the other.

```
tool  mcp__mcpal__status {"orderRef":"booking-88603"}
→ state deposit_captured: "authorization PARTIALLY_CAPTURED, captured 40.00, still held 80.00"
tool  mcp__mcpal__capture_hold {"orderRef":"booking-88603"}
→ {"ok":true,"state":"captured","details":{"capture_id":"9VC45377E68073330","captured_now":"80.00"},
   "paypal":{"ids":{"order_id":"8AW86436FW9513607","authorization_id":"39X71873HD645721C","capture_ids":["2VW477746J656691V","9VC45377E68073330"]},"debug_id":"f365346b2dcd3"}}
tool  mcp__mcpal__charge {"orderRef":"sofa-booking-88603","amount":"300.00","currency":"USD","method":"card_on_file"}
→ {"ok":false,"state":"needs_approval","human_approval_url":"https://mcpal.vercel.app/r/1a6277e5e1b34761baeabcb6/approvals/24e6bf57-23c3-486c-a84a-b47e21fe3bbe",
   "error":"300.00 USD is at or above the approval_threshold 250.00. A human must approve it first.","paypal":{"ids":{}}}
```

Claude: "booking-88603: done; I took the remaining $80.00 (capture 9VC45377E68073330). sofa-booking-88603: needs you. No money has moved… Approve it here: https://mcpal.vercel.app/r/1a6277e5e1b34761baeabcb6/approvals/24e6bf57-23c3-486c-a84a-b47e21fe3bbe"

### Human approval

The approval page returned HTTP 200. Approving with a different key was refused: "This approval belongs to a different demo key." Approving with the right key returned `"status":"approved","decidedAt":"2026-11-12T13:05:07.533Z"`.

### Run 3: a fresh session finishes the approved charge

> I approved the $300.00 charge for sofa-booking-88603. Finish it, then tell me the PayPal ids briefly.

```
tool  mcp__mcpal__status {"orderRef":"sofa-booking-88603"}
→ {"ok":true,"state":"approval_approved","next":"Approved by a human. Call charge again with exactly the original arguments (details.original_call) to finish it.",
   "details":{"original_call":{"orderRef":"sofa-booking-88603","amount":"300.00","currency":"USD","method":"card_on_file"}}}
tool  mcp__mcpal__charge {"orderRef":"sofa-booking-88603","amount":"300.00","currency":"USD","method":"card_on_file"}
→ {"ok":true,"state":"captured","paypal":{"ids":{"order_id":"7Y135494X7369824A","capture_ids":["3E9919003H254154T"]},"debug_id":"f22867653062b"}}
```

Claude: "The $300.00 USD charge to the card on file for sofa-booking-88603 went through. Order ID 7Y135494X7369824A, Capture ID 3E9919003H254154T."

The first attempt at run 3, before a fix, showed a gap. `status` answered "No record" for an orderRef that had only reached a human approval, so a fresh session could not finish the charge. `status` now reports the approval and the original call (commit dd15739). The transcript above is from the run after that fix.
