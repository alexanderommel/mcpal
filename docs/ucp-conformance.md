# UCP spec-derived checks (our implementation of the UCP conformance modules), not the official suite run

Checks re-implemented in test/ucp-conformance.test.ts from the source of github.com/Universal-Commerce-Protocol/conformance at commit 1201fb78e85217c5f2df060066ccbb0a1d1dce0b and the UCP schemas at commit 98607bc53f6f5e43ec15b9f96b82cba4912f0fe4. The official Python suite was not executed: running its code (and installing ucp-sdk 0.4.6) was blocked by this environment's permission policy. To run it yourself: clone the conformance repo, then SERVER_URL=https://mcpal.vercel.app uv run pytest with a conformance_input.json naming bag_house_blend_12oz / bag_panama_geisha_4oz and test_fixtures.json with AGENT10 (10%), BEANS20 (20%), FIVEOFF (5.00).

Each check cites the official module and test function it mirrors and the spec section it enforces. Fixture values are Coffee Club Supply's own catalog (the role the suite's `conformance_input.json` / `test_fixtures.json` play). Completing a checkout moves real PayPal **sandbox** money through MCPal.

- **local**: 54/54 checks passed (2026-11-12T15:43:02.786Z).
- **production**: 54/54 checks passed (2026-11-12T15:45:53.058Z).

| official module | coverage | local | production | note |
|---|---|---|---|---|
| `shopping/checkout/protocol_test.py` | covered | 3/3 | 3/3 |  |
| `shopping/checkout/lifecycle_test.py` | covered | 11/11 | 11/11 |  |
| `shopping/checkout/idempotency_test.py` | covered | 4/4 | 4/4 |  |
| `shopping/checkout/totals_test.py` | covered | 6/6 | 6/6 |  |
| `shopping/checkout/business_logic_test.py` | partial | 7/7 | 7/7 | test_buyer_consent not re-implemented: the buyer_consent capability is not advertised (consent is stored and echoed, not acted on). |
| `shopping/discount/semantics_test.py` | covered | 6/6 | 6/6 |  |
| `shopping/fulfillment/fulfillment_test.py` | partial | 3/3 | 3/3 | Known-customer stored-address tests (5) are unsupported: the merchant keeps no customer address book. Item-based free shipping is not offered (the official test would skip). |
| `shopping/fulfillment/structure_test.py` | covered | 2/2 | 2/2 |  |
| `shopping/order/order_test.py` | partial | 1/1 | 1/1 | GET /orders/{id} and expectations are checked. PUT /orders/{id} (platform-written fulfillment events and adjustments) is unsupported; shipping and refunds go through the merchant's own MCPal actions instead. |
| `shopping/validation/validation_test.py` | covered | 5/5 | 5/5 |  |
| `shopping/validation/invalid_input_test.py` | unsupported | - | - | Needs PUT /orders/{id}, which is not implemented. |
| `common/payments/card_credential_test.py` | covered | 1/1 | 1/1 | The card number is never forwarded: the handler charges PayPal's published test card through MCPal. |
| `common/payments/token_binding_test.py` | not checked | - | - | A token with a binding completes (binding accepted but not verified). |
| `common/payments/ap2_test.py` | unsupported | - | - | AP2 mandates are ignored, not verified. |
| `shopping/order/webhook_test.py` | unsupported | - | - | No order webhooks are delivered to the platform. |
| `shopping/order/webhook_structure_test.py` | unsupported | - | - | No order webhooks (so no Standard Webhooks headers, retries or RFC 9421 signatures). |
| `shopping/order/simulation_url_security_test.py` | unsupported | - | - | No /testing/simulate-shipping endpoint; shipping is the merchant's POST /orders/{id}/ship (MCPal capture_hold). |
| MCPal extension (not UCP): ship-later settlement | extra | 1/1 | 1/1 | Authorize at complete (MCPal hold), capture on ship (capture_hold), partial refund (refund). |
| ACP checkout_sessions (not UCP) | extra | 4/4 | 4/4 | Spec-derived from the ACP 2026-04-17 OpenAPI; there is no ACP conformance suite to mirror. |

Run them yourself:

```bash
UCP_BASE_URL=https://mcpal.vercel.app npx vitest run test/ucp-conformance.test.ts
```

## Every check

### local

**checkout/protocol**

- pass: test_discovery: version, capabilities, handlers with id+version, REST service endpoint (overview.md discovery)
- pass: test_discovery_urls: every advertised spec/schema URL answers 200
- pass: test_version_negotiation: advertised version accepted, 2099-01-01 refused with 422 (checkout-rest.md UCP-Agent)

**checkout/lifecycle**

- pass: test_create_checkout: 201 with id, status, line_items, totals, links (checkout.json required fields)
- pass: test_get_checkout: GET returns the same session
- pass: test_update_checkout: buyer and a second destination persist (PUT full replacement)
- pass: test_cancel_checkout: cancel answers 200 with status canceled
- pass: test_complete_checkout: complete answers 200, status completed, order.id + permalink_url (order_confirmation.json)
- pass: test_ready_for_complete_when_nothing_is_outstanding: no errors, no actions => ready_for_complete, then completes
- pass: test_repeated_cancel: 200 canceled again, or a 4xx
- pass: test_cannot_update_canceled_checkout: 4xx
- pass: test_cannot_complete_canceled_checkout: 4xx, GET still answers 200
- pass: test_complete_is_idempotent: completing a completed checkout (new key) is refused with 4xx, never charged twice
- pass: test_cannot_update_completed_checkout + test_cannot_cancel_completed_checkout: 4xx

**checkout/idempotency**

- pass: test_idempotency_create: same key+body => identical status and body; same key, different body => 409
- pass: test_idempotency_update: replay matches; changed body with the same key => 409
- pass: test_idempotency_complete: replay returns the same completed order (one PayPal capture); changed body => 409
- pass: test_idempotency_cancel: replay answers the same status

**checkout/totals**

- pass: test_single_subtotal_entry (checkout.md: subtotal MUST NOT repeat)
- pass: test_single_total_entry (checkout.md: total MUST NOT repeat)
- pass: test_entries_have_type_and_amount (total.json required: type, amount; amounts are integer minor units)
- pass: test_additive_entries_non_negative (subtotal, fulfillment, tax, fee >= 0)
- pass: test_discount_entry_is_negative (total.json: discount amount exclusiveMaximum 0)
- pass: sum invariant: sum(non-total entries) == total (checkout.md Verification)

**checkout/business_logic**

- pass: test_totals_calculation_on_create: subtotal = price x qty
- pass: test_totals_recalculation_on_update: quantity 1 -> 3 recomputes subtotal and total
- pass: test_discount_flow: valid code applied, discount = round(price x pct)
- pass: test_multiple_discounts_accepted: both codes applied, sequential or cumulative
- pass: test_multiple_discounts_one_rejected: only the valid one applies
- pass: test_fixed_amount_discount: fixed reduction in minor units
- pass: test_buyer_info_persistence: buyer survives a later update and a GET

**discount/semantics**

- pass: test_code_matches_case_insensitively (discount.json: codes are case-insensitive)
- pass: test_discount_total_is_negative
- pass: test_allocations_sum_to_applied_amount (discount.json allocation)
- pass: test_client_applied_does_not_change_price (applied[] is response-only)
- pass: test_empty_codes_removes_discount
- pass: test_codes_replace_previous_set

**fulfillment/fulfillment**

- pass: test_fulfillment_flow: destination => options; selecting one adds a fulfillment total
- pass: test_dynamic_fulfillment: domestic and international destinations offer their own option ids
- pass: test_free_shipping_on_expensive_order: a zero-cost option at or above the threshold

**fulfillment/structure**

- pass: test_option_titles_distinguish_siblings: non-empty, distinct titles
- pass: test_default_config_single_group_per_method: one group carrying all of the method's items

**validation/validation**

- pass: test_out_of_stock: typed out_of_stock / item_unavailable
- pass: test_update_inventory_validation: quantity beyond stock is clamped with quantity_adjusted, or refused
- pass: test_product_not_found: typed not_found / item_unavailable
- pass: complete without fulfillment: typed missing / field_required, not completed
- pass: test_payment_failure: fail_token => payment_failed, checkout not completed

**payments/card_credential**

- pass: test_card_credential_payment: a raw card credential completes (sandbox: MCPal charges PayPal's test card)

**order/order**

- pass: test_order_retrieval: GET /orders/{id} answers the order (order.json required fields)

**acp/checkout_sessions**

- pass: create: 201 with the CheckoutSession required fields; not_ready_for_payment until a shipping option is chosen
- pass: update (POST) selects a fulfillment option => ready_for_payment; complete => completed with order.checkout_session_id
- pass: idempotency: same key + same body replays; same key + different body => 422; POST without Idempotency-Key => 400
- pass: errors: {type, code, message}; unknown session => 404; missing Authorization => 401

**mcpal/settlement**

- pass: authorize at complete, capture on ship, partial refund: PayPal ids on the order

### production

**checkout/protocol**

- pass: test_discovery: version, capabilities, handlers with id+version, REST service endpoint (overview.md discovery)
- pass: test_discovery_urls: every advertised spec/schema URL answers 200
- pass: test_version_negotiation: advertised version accepted, 2099-01-01 refused with 422 (checkout-rest.md UCP-Agent)

**checkout/lifecycle**

- pass: test_create_checkout: 201 with id, status, line_items, totals, links (checkout.json required fields)
- pass: test_get_checkout: GET returns the same session
- pass: test_update_checkout: buyer and a second destination persist (PUT full replacement)
- pass: test_cancel_checkout: cancel answers 200 with status canceled
- pass: test_complete_checkout: complete answers 200, status completed, order.id + permalink_url (order_confirmation.json)
- pass: test_ready_for_complete_when_nothing_is_outstanding: no errors, no actions => ready_for_complete, then completes
- pass: test_repeated_cancel: 200 canceled again, or a 4xx
- pass: test_cannot_update_canceled_checkout: 4xx
- pass: test_cannot_complete_canceled_checkout: 4xx, GET still answers 200
- pass: test_complete_is_idempotent: completing a completed checkout (new key) is refused with 4xx, never charged twice
- pass: test_cannot_update_completed_checkout + test_cannot_cancel_completed_checkout: 4xx

**checkout/idempotency**

- pass: test_idempotency_create: same key+body => identical status and body; same key, different body => 409
- pass: test_idempotency_update: replay matches; changed body with the same key => 409
- pass: test_idempotency_complete: replay returns the same completed order (one PayPal capture); changed body => 409
- pass: test_idempotency_cancel: replay answers the same status

**checkout/totals**

- pass: test_single_subtotal_entry (checkout.md: subtotal MUST NOT repeat)
- pass: test_single_total_entry (checkout.md: total MUST NOT repeat)
- pass: test_entries_have_type_and_amount (total.json required: type, amount; amounts are integer minor units)
- pass: test_additive_entries_non_negative (subtotal, fulfillment, tax, fee >= 0)
- pass: test_discount_entry_is_negative (total.json: discount amount exclusiveMaximum 0)
- pass: sum invariant: sum(non-total entries) == total (checkout.md Verification)

**checkout/business_logic**

- pass: test_totals_calculation_on_create: subtotal = price x qty
- pass: test_totals_recalculation_on_update: quantity 1 -> 3 recomputes subtotal and total
- pass: test_discount_flow: valid code applied, discount = round(price x pct)
- pass: test_multiple_discounts_accepted: both codes applied, sequential or cumulative
- pass: test_multiple_discounts_one_rejected: only the valid one applies
- pass: test_fixed_amount_discount: fixed reduction in minor units
- pass: test_buyer_info_persistence: buyer survives a later update and a GET

**discount/semantics**

- pass: test_code_matches_case_insensitively (discount.json: codes are case-insensitive)
- pass: test_discount_total_is_negative
- pass: test_allocations_sum_to_applied_amount (discount.json allocation)
- pass: test_client_applied_does_not_change_price (applied[] is response-only)
- pass: test_empty_codes_removes_discount
- pass: test_codes_replace_previous_set

**fulfillment/fulfillment**

- pass: test_fulfillment_flow: destination => options; selecting one adds a fulfillment total
- pass: test_dynamic_fulfillment: domestic and international destinations offer their own option ids
- pass: test_free_shipping_on_expensive_order: a zero-cost option at or above the threshold

**fulfillment/structure**

- pass: test_option_titles_distinguish_siblings: non-empty, distinct titles
- pass: test_default_config_single_group_per_method: one group carrying all of the method's items

**validation/validation**

- pass: test_out_of_stock: typed out_of_stock / item_unavailable
- pass: test_update_inventory_validation: quantity beyond stock is clamped with quantity_adjusted, or refused
- pass: test_product_not_found: typed not_found / item_unavailable
- pass: complete without fulfillment: typed missing / field_required, not completed
- pass: test_payment_failure: fail_token => payment_failed, checkout not completed

**payments/card_credential**

- pass: test_card_credential_payment: a raw card credential completes (sandbox: MCPal charges PayPal's test card)

**order/order**

- pass: test_order_retrieval: GET /orders/{id} answers the order (order.json required fields)

**acp/checkout_sessions**

- pass: create: 201 with the CheckoutSession required fields; not_ready_for_payment until a shipping option is chosen
- pass: update (POST) selects a fulfillment option => ready_for_payment; complete => completed with order.checkout_session_id
- pass: idempotency: same key + same body replays; same key + different body => 422; POST without Idempotency-Key => 400
- pass: errors: {type, code, message}; unknown session => 404; missing Authorization => 401

**mcpal/settlement**

- pass: authorize at complete, capture on ship, partial refund: PayPal ids on the order

