// Minimal PayPal REST client used by the benchmark harness (fixtures + grader).
// Independent from src/ on purpose: the grader must not share code with the system under test.
import { randomUUID } from 'node:crypto';

export interface PayPalCreds {
  clientId: string;
  clientSecret: string;
  base: string; // e.g. https://api-m.sandbox.paypal.com
}

export class PayPalError extends Error {
  constructor(
    public status: number,
    public body: any,
    public debugId?: string,
  ) {
    super(`PayPal ${status}: ${body?.name ?? ''} ${body?.message ?? JSON.stringify(body).slice(0, 300)}`);
  }
}

export class PayPal {
  private token?: { value: string; exp: number };
  constructor(public creds: PayPalCreds) {}

  static fromEnv(): PayPal {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing');
    const base = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
    return new PayPal({ clientId, clientSecret, base });
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.creds.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, body);
    this.token = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 3000) * 1000 };
    return this.token.value;
  }

  async req<T = any>(method: string, path: string, body?: unknown, opts: { requestId?: string; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers ?? {}),
    };
    if (method !== 'GET') headers['PayPal-Request-Id'] = opts.requestId ?? randomUUID();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.creds.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (res.ok) return json as T;
      // retry transient errors with the same request id (idempotent)
      if ((res.status >= 500 || res.status === 429) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      throw new PayPalError(res.status, json, res.headers.get('paypal-debug-id') ?? json?.debug_id);
    }
  }

  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, b?: unknown, o?: { requestId?: string; headers?: Record<string, string> }) => this.req<T>('POST', p, b ?? {}, o);
}

export const money = (v: string | number, currency = 'USD') => ({ currency_code: currency, value: Number(v).toFixed(2) });

/** Card payment source used for buyer-less sandbox fixtures. Override with PAYPAL_TEST_CARD / PAYPAL_TEST_CARD_EXPIRY. */
export function testCard() {
  return {
    card: {
      number: process.env.PAYPAL_TEST_CARD ?? process.env.MCPAL_SANDBOX_CARD ?? '4012000077777777',
      expiry: process.env.PAYPAL_TEST_CARD_EXPIRY ?? '2029-12',
      security_code: '123',
      name: 'Bench Buyer',
      billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' },
    },
  };
}
