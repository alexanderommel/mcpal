# Bring your own sandbox: proof

Recorded 2026-11-12 at about 08:22 Ecuador time (UTC-5) against the production deployment, https://mcpal.vercel.app. Every id below is a real PayPal **sandbox** id. The demo key is redacted as `<key>`. No secret appears here or in any server response.

## What it does

- `/install#byo`, panel "Use your own sandbox": a developer pastes a PayPal **Sandbox** app's Client ID and Secret.
- `POST /api/remote/byo {action:"connect"}` (`web/app/api/remote/byo/route.ts`):
  1. checks the format;
  2. asks for an OAuth token on `api-m.sandbox.paypal.com` **and** on `api-m.paypal.com` in parallel. The pair is accepted only if the sandbox token works and the live one does not. Live credentials are refused and nothing is stored;
  3. mints a new demo key (`dk_` + 24 characters) and stores `remote/<ns>/creds.json` in private Vercel Blob. The client id is stored in clear. The secret is stored as AES-256-GCM (random 12-byte IV, with the key namespace as associated data) under `MCPAL_SECRETS_KEY`, a random 32-byte key that exists only as a Vercel production env var. The secret is never logged and never returned; the response shows only a masked client id.
- Connect attempts are limited to 10 per hour per IP.
- Remote MCP calls with that key (`web/app/mcp/route.ts`) and the PayPal return page build the key's PayPal client from those credentials, always against the sandbox host. The key's ledger, policy, limits, demo guards and idempotency salt (install id + ledger id per key) work exactly as for any other key.
- `card_on_file` still uses PayPal's sandbox test card. If the developer's sandbox business account cannot process cards, PayPal's `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` comes back with a hint to use `payment_link` or to connect an app on a US sandbox business account. If their secret stops working, the agent is told to reconnect at /install.
- "Forget my credentials" (`{action:"forget"}`) overwrites the blob with a tombstone that has no secret. From then on the key is refused with a clear message instead of silently falling back to the shared account, and the browser gets a fresh shared-sandbox key.

## Live run

Script: `web/scripts/byo-sandbox-check.mts`. It acts as an outside developer, using our own sandbox app "MCPal Hackathon US" (US sandbox business account, card processing on) as if it were theirs:

```
BYO_ENV_FILE=~/paypal-hackathon-research/.env.paypal-sandbox npx tsx scripts/byo-sandbox-check.mts
```

| step | result | ids |
|---|---|---|
| connect with a wrong secret | HTTP 400 "PayPal's sandbox rejected these credentials…" | nothing stored |
| connect with the sandbox app | HTTP 200, `mode: byo`, client id shown as `BAA5…CFo8` | new key `<key>` |
| `status` (API) | `{"mode":"byo","clientId":"BAA5…CFo8"}` | |
| remote MCP `hold` 120.00, deposit 40.00, card_on_file | `deposit_captured`, 80.00 still held | order 8TU410112K566004R, authorization 8H805614Y0852331T, capture 78T27626CE672181M |
| remote MCP `capture_hold` | `captured`, 80.00 now | capture 7XW71376FJ8448739 |
| remote MCP `status` | `captured`, authorization CAPTURED, refundable 120.00 | both captures |
| order read back **with the developer's own credentials** (`GET /v2/checkout/orders/8TU410112K566004R`) | `COMPLETED`, intent `AUTHORIZE`, payee merchant id R3DCU6RFZ24YE | |
| forget | `{"forgotten":true}` | |
| `status` after forget | `{"mode":"forgotten"}` | |
| remote MCP `tools/call` after forget | HTTP 403 "This demo key's PayPal sandbox credentials were forgotten…" | nothing sent to PayPal |

Rate limit, same IP right after the run: eight malformed connect attempts got HTTP 400 and the next ones got HTTP 429 "Too many connect attempts from this network (10 per hour). Try again in about 59 min." (the 2 connects above count toward the 10). The limit is checked before any call to PayPal.

Caveat: the shared hosted demo also runs on a "MCPal Hackathon US" app, so this run cannot show a *different* merchant id from the shared keys. That the key ran on the stored credentials is shown by the `byo` mode, the order being readable with those credentials, and the same key being refused after its credentials were forgotten (a shared key would have kept working).

## Tests

- `test/unit/byo.test.ts`: AES-256-GCM round trip; fresh IV each time; wrong key, wrong namespace and a flipped byte all fail; `MCPAL_SECRETS_KEY` must be 32 bytes; credentials that work on live (alone, or on both hosts) are refused; credentials the sandbox refuses are refused; malformed input is refused with no network call.
- `test/unit/byo-client.test.ts`: the card-country hint on `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`, the reconnect message when the token call fails, and the sandbox host as default.
- `npx vitest run test/unit`: 77 tests pass.
