# Agentic commerce proof: a buyer agent checks out through UCP, the merchant settles on PayPal via MCPal

Recorded 2026-11-12T15:39:27.363Z against https://mcpal.vercel.app (PayPal **sandbox**; no live money). Model: gpt-4.1-mini, temperature 0, 4 tool calls, 16.7 s.

The buyer agent only knows the merchant's discovery URL (`/.well-known/ucp`). Its tools are the UCP REST checkout operations; it never sees PayPal, MCPal or any credential beyond an opaque sandbox payment token. On `complete`, the merchant calls MCPal `charge` (card_on_file, PayPal's sandbox test card), so MCPal's policy, PayPal-Request-Id idempotency and hash-chained decision log apply.

**Task given to the buyer agent:** Buy two bags of coffee for under $40 in total, shipped. Ship to Sam Sandbox, 2211 N First St, San Jose, CA 95131, US (email sam.sandbox@personal.example.com). Pay with my saved PayPal sandbox payment instrument: handler_id mcpal_paypal_sandbox, type card, credential { type: token, token: sandbox-wallet-token }. Use a discount code if the merchant advertises one. Pick the cheapest shipping. Do not complete the purchase if the total is $40.00 or more.

## Result

| | |
|---|---|
| checkout | `chk_ee71256eea53f3f20d` |
| status | completed |
| total | $31.19 |
| order | `ord_ee29f215eedac0cc99` |
| MCPal orderRef | `ucp-ee71256eea53f3f20d` |
| MCPal state | captured |
| PayPal order_id | `5H043375UE8541721` |
| PayPal capture_ids | `1EW29591SW950060R` |

## Transcript

**user**

Buy two bags of coffee for under $40 in total, shipped. Ship to Sam Sandbox, 2211 N First St, San Jose, CA 95131, US (email sam.sandbox@personal.example.com). Pay with my saved PayPal sandbox payment instrument: handler_id mcpal_paypal_sandbox, type card, credential { type: token, token: sandbox-wallet-token }. Use a discount code if the merchant advertises one. Pick the cheapest shipping. Do not complete the purchase if the total is $40.00 or more.

**agent calls discover_merchant**

```json
{}
```

**merchant answers discover_merchant**

```json
{"endpoint":"https://mcpal.vercel.app/ucp/v1","payment_handlers":{"com.paypal.sandbox.mcpal":[{"id":"mcpal_paypal_sandbox","version":"2026-04-08","config":{"environment":"sandbox","settles_with":"MCPal charge / hold on PayPal Orders v2","note":"Any credential.token (or a card credential) is settled by MCPal on the PayPal sandbox with PayPal's published sandbox test card. The token 'fail_token' simulates a decline."},"available_instruments":[{"type":"card"}]}],"dev.ucp.mock_payment_handler":[{"id":"mock_payment_handler","version":"2026-04-08","config":{"note":"The UCP conformance suite's handler id. Same settlement path as mcpal_paypal_sandbox; 'fail_token' declines before PayPal is called."},"available_instruments":[{"type":"card"}]}]},"capabilities":["dev.ucp.shopping.checkout","dev.ucp.shopping.fulfillment","dev.ucp.shopping.discount","dev.ucp.shopping.order"],"business":{"name":"Coffee Club Supply","currency":"USD","catalog":[{"id":"bag_house_blend_12oz","title":"House Blend whole bean, 12 oz bag","price":1400,"in_stock":true},{"id":"bag_ethiopia_yirgacheffe_12oz","title":"Ethiopia Yirgacheffe whole bean, 12 oz bag","price":1800,"in_stock":true},{"id":"bag_decaf_colombia_12oz","title":"Decaf Colombia ground, 12 oz bag","price":1600,"in_stock":true},{"id":"mug_ceramic_black","title":"Coffee Club ceramic mug, 12 oz","price":1200,"in_stock":true},{"id":"filters_v60_100","title":"V60 paper filters, pack of 100","price":800,"in_stock":true},{"id":"bag_panama_geisha_4oz","title":"Panama Geisha whole bean, 4 oz (sold out)","price":3800,"in_stock":false}],"discount_codes_advertised":["AGENT10"],"policy":"Totals at or above 250.00 USD need the merchant's approval (requires_escalation). Hosted demo cap: 500.00 USD per checkout.","acp":"https://mcpal.vercel.app/acp"}}
```

**agent calls create_checkout**

```json
{"line_items":[{"item_id":"bag_house_blend_12oz","quantity":2}],"buyer":{"first_name":"Sam","last_name":"Sandbox","email":"sam.sandbox@personal.example.com"},"shipping_address":{"street_address":"2211 N First St","address_locality":"San Jose","address_region":"CA","postal_code":"95131","address_country":"US"},"discount_codes":["AGENT10"]}
```

**merchant answers create_checkout**

```json
{"id":"chk_ee71256eea53f3f20d","status":"incomplete","line_items":[{"id":"li_1","item_id":"bag_house_blend_12oz","title":"House Blend whole bean, 12 oz bag","unit_price_cents":1400,"quantity":2}],"shipping":{"method_id":"shipping_1","destinations":[{"type":"shipping_address","id":"dest_1","street_address":"2211 N First St","address_locality":"San Jose","address_region":"CA","postal_code":"95131","address_country":"US"}],"selected_destination_id":"dest_1","selected_option_id":null,"options":[{"id":"std-ground","title":"Standard ground (5-7 business days)","cents":599},{"id":"express-2day","title":"Express (2 business days)","cents":1499}]},"discounts":{"codes":["AGENT10"],"applied":[{"code":"AGENT10","title":"10% off for agent checkouts","amount":280,"method":"across","allocations":[{"path":"$.line_items[0]","amount":280}]}]},"totals_cents":[{"type":"subtotal","amount":2800,"display_text":"Items"},{"type":"discount","amount":-280,"display_text":"Discounts"},{"type":"tax","amount":0,"display_text":"Tax"},{"type":"total","amount":2520,"display_text":"Total"}],"messages":[{"type":"error","code":"missing","path":"$.fulfillment.methods[0].groups[0].selected_option_id","content":"Select a shipping option.","severity":"recoverable"}]}
```

**agent calls update_checkout**

```json
{"checkout_id":"chk_ee71256eea53f3f20d","selected_shipping_option_id":"std-ground"}
```

**merchant answers update_checkout**

```json
{"id":"chk_ee71256eea53f3f20d","status":"ready_for_complete","line_items":[{"id":"li_1","item_id":"bag_house_blend_12oz","title":"House Blend whole bean, 12 oz bag","unit_price_cents":1400,"quantity":2}],"shipping":{"method_id":"shipping_1","destinations":[{"type":"shipping_address","id":"dest_1","street_address":"2211 N First St","address_locality":"San Jose","address_region":"CA","postal_code":"95131","address_country":"US"}],"selected_destination_id":"dest_1","selected_option_id":"std-ground","options":[{"id":"std-ground","title":"Standard ground (5-7 business days)","cents":599},{"id":"express-2day","title":"Express (2 business days)","cents":1499}]},"discounts":{"codes":["AGENT10"],"applied":[{"code":"AGENT10","title":"10% off for agent checkouts","amount":280,"method":"across","allocations":[{"path":"$.line_items[0]","amount":280}]}]},"totals_cents":[{"type":"subtotal","amount":2800,"display_text":"Items"},{"type":"discount","amount":-280,"display_text":"Discounts"},{"type":"fulfillment","amount":599,"display_text":"Shipping"},{"type":"tax","amount":0,"display_text":"Tax"},{"type":"total","amount":3119,"display_text":"Total"}],"messages":[]}
```

**assistant**

The total for two bags of House Blend whole bean coffee with the 10% agent discount and standard ground shipping is $31.19, which is under your $40 limit. I will now complete the purchase using your saved PayPal sandbox payment instrument.

**agent calls complete_checkout**

```json
{"checkout_id":"chk_ee71256eea53f3f20d","handler_id":"mcpal_paypal_sandbox","token":"sandbox-wallet-token"}
```

**merchant answers complete_checkout**

```json
{"id":"chk_ee71256eea53f3f20d","status":"completed","line_items":[{"id":"li_1","item_id":"bag_house_blend_12oz","title":"House Blend whole bean, 12 oz bag","unit_price_cents":1400,"quantity":2}],"shipping":{"method_id":"shipping_1","destinations":[{"type":"shipping_address","id":"dest_1","street_address":"2211 N First St","address_locality":"San Jose","address_region":"CA","postal_code":"95131","address_country":"US"}],"selected_destination_id":"dest_1","selected_option_id":"std-ground","options":[{"id":"std-ground","title":"Standard ground (5-7 business days)","cents":599},{"id":"express-2day","title":"Express (2 business days)","cents":1499}]},"discounts":{"codes":["AGENT10"],"applied":[{"code":"AGENT10","title":"10% off for agent checkouts","amount":280,"method":"across","allocations":[{"path":"$.line_items[0]","amount":280}]}]},"totals_cents":[{"type":"subtotal","amount":2800,"display_text":"Items"},{"type":"discount","amount":-280,"display_text":"Discounts"},{"type":"fulfillment","amount":599,"display_text":"Shipping"},{"type":"tax","amount":0,"display_text":"Tax"},{"type":"total","amount":3119,"display_text":"Total"}],"messages":[],"order":{"id":"ord_ee29f215eedac0cc99","permalink_url":"https://mcpal.vercel.app/commerce/orders/ord_ee29f215eedac0cc99","label":"Coffee Club Supply order EE29F215"}}
```

**assistant**

The order for two bags of House Blend whole bean coffee with standard ground shipping and a 10% discount has been completed successfully. The total was $31.19, under your $40 limit. Your order ID is ord_ee29f215eedac0cc99.


Merchant decision log: https://mcpal.vercel.app/ledger?source=merchant (source "merchant checkout (UCP)").
