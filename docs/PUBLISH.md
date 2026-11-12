# Publishing the demo site

The site in `web/` is a Next.js app deployed on Vercel. It imports the library from the repo root (`"mcpal": "file:.."`), so Vercel installs and builds the root first (see `web/vercel.json`).

## Vercel project

- Root directory: `web`
- Framework: Next.js (install and build commands come from `web/vercel.json`)
- Node 22

Environment variables (Production):

| variable | value |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | sandbox REST app |
| `PAYPAL_BUYER_EMAIL` | a sandbox personal account (`…@personal.example.com`), used as the courier in the judge presets |
| `PAYPAL_WEBHOOK_ID` | the id PayPal gives when the webhook below is registered |
| `OPENAI_API_KEY` | for the judge agent (gpt-4.1-mini) |
| `JUDGE_STATE_SECRET` | 32+ random bytes in hex; signs the judge session snapshots |
| `MCPAL_PUBLIC_URL` | the production URL, e.g. `https://mcpal.vercel.app` |

## Webhook

Register `https://<production-url>/api/webhooks/paypal` on the sandbox REST app (Dashboard → Apps & Credentials → app → Webhooks, or `POST /v1/notifications/webhooks`). Subscribe to the payment events: `PAYMENT.CAPTURE.*`, `PAYMENT.AUTHORIZATION.*`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.PAYOUTSBATCH.*`, `BILLING.SUBSCRIPTION.*`. Put the returned id in `PAYPAL_WEBHOOK_ID` and redeploy.

To check it works: run any preset on `/judge`, then open `GET /api/webhooks/paypal`. Deliveries verified by `verify-webhook-signature` show `status: "verified"`. That list is held in memory per server instance, so the Vercel function logs (`[webhook] …` lines) are the durable record.

## Limits on the public demo

- 10 agent runs per hour per IP, counted in memory on each server instance.
- Every amount is capped at 500.00 USD, only USD is accepted, payouts go only to `…example.com` sandbox accounts, and orderRefs are locked to the visitor's session. All of this is checked before the call reaches MCPal.
- A visitor's session (deals, spend, approvals, decision log) is a server-signed snapshot kept in the browser, so it does not depend on shared disk between serverless instances.

## Before making the repository public

1. `git grep -nE "(sk-[A-Za-z0-9_-]{20,}|EC[A-Za-z0-9_-]{60,}|A21AA[A-Za-z0-9_-]{20,}|client_secret\s*[:=]\s*['\"][^'\"]+)"` must return nothing.
2. No `.env*` files are tracked (`git ls-files | grep -i env` shows only `.env.example`, if any).
3. `bench/results/raw` stays out of git; the summary and chart are the published results.
