# Official UCP conformance suite — run against https://mcpal.vercel.app (2026-11-12)

Suite: github.com/Universal-Commerce-Protocol/conformance @ 1201fb78e85217c5f2df060066ccbb0a1d1dce0b, ucp-sdk 0.4.6 (python-sdk @ 51bf73c), run with its own `runner.py --suite=all`, no simulation secret, our fixtures in this folder. Raw output: run-output.txt.

**Result: 78 tests — 55 passed, 14 failed, 9 skipped.**

All 14 failures are in the three features MCPal's demo merchant does not implement, and says so on /commerce:
- Order webhooks to the platform (webhook_test, webhook_structure_test): 7
- Platform-written order updates/adjustments, PUT /orders/{id} (order_test ×2, invalid_input_test ×2): 4
- Shipping simulation endpoint (simulation_url_security_test): 3

Skipped (9): known-customer stored-address tests (no customer address book), free-shipping item SKU (not offered), and one test the suite itself skips ("Schemas not yet published on remote ucp.dev domain").

Everything else passes: protocol/discovery, checkout lifecycle, idempotency, totals, business logic, discounts, fulfillment structure, validation, card credential handling, token binding, AP2 module tests that ran, and order retrieval.
