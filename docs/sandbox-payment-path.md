# Paying without a browser in the sandbox

PayPal wallet payments need a buyer to click an approval link. Agents and tests cannot do that, so MCPal has an explicit card path. Every money-taking verb takes `method`; the default is `payment_link`, so nothing moves unless the caller asks for the card:

| `method` | What happens | Where it works |
|---|---|---|
| `invoice` (charge only) | Invoicing v2 creates an invoice with `primary_recipients[0].billing_info.email_address = customer_email` and sends it. Returns `invoice_sent` and the payer link. No money moves until the buyer pays. | Sandbox and live. |
| `card_on_file` (only when explicitly asked) | Order is created with `payment_source.card` holding a PayPal sandbox test card. PayPal approves it immediately, then MCPal captures (`charge`) or authorizes (`hold`) in the same call. No redirect, no browser. | Sandbox only. MCPal refuses it when `PAYPAL_ENV=live`. |
| `payment_link` (default) | Order is created with `payment_source.paypal.experience_context` (return/cancel URLs). The verb returns `state: needs_buyer_approval` and `human_approval_url`. After the buyer approves, call the same verb again with the same `orderRef`, or let the HTTP server's `/paypal/return` route finish it automatically. | Sandbox and live. |

## Why the card path

PayPal's sandbox card-testing guide documents this exact flow: create an `AUTHORIZE` order with a `payment_source` holding a test card, authorize it, then capture it ([developer.paypal.com/tools/sandbox/card-testing](https://developer.paypal.com/tools/sandbox/card-testing/)). It needs no buyer session, so `charge`, `hold`, `capture_hold`, `void_hold` and `refund` can run end to end from an agent.

Other options we rejected:
- Vaulted payment tokens (Vault v3) need a setup token that a buyer approves once. That still means a browser, and the official tools have no vault support either.
- Billing agreements and reference transactions are legacy, and new sandbox apps do not have them turned on.

## Details

- Test card: `MCPAL_SANDBOX_CARD` (default Visa `4012000077777777` from PayPal's list; others: `4012888888881881`, `4005519200000004`, Mastercard `2223000048400011`). The expiry is set 3 years ahead and the CVV is `123`. To test a decline, PayPal's guide uses a name on card such as `CCREJECT-REFUSED`.
- The sandbox app needs Advanced Credit and Debit Card payments. Default US sandbox business accounts have it. Without it, PayPal returns an error, and MCPal falls back to `payment_link` and says why in `details.fallback`.
- `subscribe` with `card_on_file` sends `subscriber.payment_source.card`. If PayPal refuses it, MCPal falls back to an approval link and puts the reason in `details.fallback`.
- The decision log redacts card numbers and CVVs.

## Partial captures (deposits)

`hold` with `deposit` captures part of the authorization with `final_capture: false`, and `capture_hold` captures the rest with `final_capture: true`. PayPal documents multiple partial captures on one authorization. If an account refuses the partial capture (422), MCPal uses a fallback that the unit tests cover with a simulated refusal:

1. Void the single authorization.
2. Charge the deposit as its own `CAPTURE` order.
3. Hold the remainder as a new `AUTHORIZE` order.

The response notes this in `details.fallback`. The fallback runs automatically only with `card_on_file`, because an approval-link buyer would have to approve twice.

Verified on the real sandbox (US business account, 2026-11-12): a 90.00 authorization took 3 captures (10.00 deposit, a second 20.00 partial capture, 60.00 final), all COMPLETED, so the fallback is not needed there. Captures above 115% of the order amount fail with MAX_CAPTURE_AMOUNT_EXCEEDED. Proof: `docs/sandbox-proof.json` (`multiple_partial_captures`).

Card processing is per merchant country: an EC sandbox business account returns PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING on orders and MERCHANT_COUNTRY_NOT_ENABLED_FOR_CARD_PAYMENT on card-funded subscriptions. MCPal then falls back to payment_link and says why in `details.fallback`.

## Authorization timing

The authorization is guaranteed for 3 days (the honor period) and is valid for 29 days. If PayPal rejects a `capture_hold` capture with a reauthorization issue, `capture_hold` reauthorizes the remaining amount once and captures against the new authorization.
