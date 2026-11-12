// The PayPal client used for bring-your-own-sandbox keys: card-country and stale-credential messages.
import { describe, expect, it } from "vitest";
import { ByoPayPalClient } from "../../web/lib/remote.js";

function fake(orderStatus: number, orderBody: unknown, tokenOk = true): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/v1/oauth2/token"))
      return new Response(JSON.stringify(tokenOk ? { access_token: "t", expires_in: 3000 } : { error: "invalid_client" }), { status: tokenOk ? 200 : 401 });
    return new Response(JSON.stringify(orderBody), { status: orderStatus, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("ByoPayPalClient", () => {
  it("adds the US sandbox business account hint on PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING", async () => {
    const c = new ByoPayPalClient({ clientId: "id", clientSecret: "s", maxRetries: 0, fetch: fake(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING", description: "The payee is not enabled for card processing." }] }) });
    await expect(c.request("POST", "/v2/checkout/orders", { body: {} })).rejects.toThrow(/US sandbox business account/);
  });

  it("tells the developer to reconnect when their credentials stop working", async () => {
    const c = new ByoPayPalClient({ clientId: "id", clientSecret: "s", maxRetries: 0, fetch: fake(200, {}, false) });
    await expect(c.request("GET", "/v2/checkout/orders/X")).rejects.toThrow(/Connect them again/);
  });

  it("only ever talks to the sandbox host by default", () => {
    expect(new ByoPayPalClient({ clientId: "id", clientSecret: "s" }).baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });
});
