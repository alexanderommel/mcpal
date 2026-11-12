// Seeds buyer-less sandbox state before a task runs, so refund / void / release / status tasks start from a
// real capture or authorization. Same PayPal end state for both arms:
//  - official arm: created with plain REST calls (as if made earlier by any integration)
//  - mcpal arm:    created through MCPal's own verbs on the same server, because MCPal only manages
//                  orderRefs present in its ledger (it does not adopt foreign PayPal orders).
// Both arms get the same merchant reference ({A.ref}) and PayPal ids in the prompt.
import { randomUUID } from 'node:crypto';
import { PayPal, money, testCard } from './paypal.js';

export type FixtureSpec =
  | { kind: 'captured'; ref: string; amount: string; currency?: string; description?: string }
  | { kind: 'authorized'; ref: string; amount: string; capture_now?: string; currency?: string }
  | { kind: 'refunded'; ref: string; of: string; amount: string }
  | { kind: 'plan'; ref: string; price: string; interval?: 'MONTH' | 'YEAR' | 'WEEK'; name?: string }
  | { kind: 'checkout'; ref: string; amount: string };

export type FixtureValues = Record<string, string | undefined>;

export interface Fixtures {
  tag: string;
  via: 'rest' | 'mcpal';
  values: Record<string, FixtureValues>;
  /** PayPal ids that existed after setup (excluded from graded movements) */
  setupIds: string[];
  /** order ids the grader must always inspect */
  orderIds: string[];
}

export type McpalCall = (tool: string, args: Record<string, unknown>) => Promise<any>;

export function newTag(): string {
  return randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
}

async function orderWithCard(pp: PayPal, intent: 'CAPTURE' | 'AUTHORIZE', amount: string, currency: string, customId: string, description?: string) {
  return pp.post('/v2/checkout/orders', {
    intent,
    purchase_units: [{ amount: money(amount, currency), custom_id: customId, invoice_id: customId, description: description ?? 'Bench fixture' }],
    payment_source: testCard(),
  });
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null || v === '') throw new Error(`fixture: missing ${what}`);
  return v;
}

async function seedRest(pp: PayPal, s: FixtureSpec, ref: string, fx: Fixtures): Promise<FixtureValues> {
  const v: FixtureValues = { ref };
  if (s.kind === 'captured') {
    let order = await orderWithCard(pp, 'CAPTURE', s.amount, s.currency ?? 'USD', ref, s.description);
    if (order.status !== 'COMPLETED') order = await pp.post(`/v2/checkout/orders/${order.id}/capture`, {});
    const cap = order.purchase_units[0].payments.captures[0];
    if (cap.status !== 'COMPLETED') throw new Error(`fixture capture status ${cap.status}`);
    Object.assign(v, { order_id: order.id, capture_id: cap.id, amount: s.amount });
  } else if (s.kind === 'authorized') {
    let order = await orderWithCard(pp, 'AUTHORIZE', s.amount, s.currency ?? 'USD', ref);
    if (order.status !== 'COMPLETED') order = await pp.post(`/v2/checkout/orders/${order.id}/authorize`, {});
    const auth = order.purchase_units[0].payments.authorizations[0];
    Object.assign(v, { order_id: order.id, authorization_id: auth.id, amount: s.amount });
    if (s.capture_now) {
      const cap = await pp.post(`/v2/payments/authorizations/${auth.id}/capture`, { amount: money(s.capture_now, s.currency ?? 'USD'), final_capture: false });
      v.capture_id = cap.id;
    }
  } else if (s.kind === 'refunded') {
    const base = fx.values[s.of];
    const r = await pp.post(`/v2/payments/captures/${need(base?.capture_id, `${s.of}.capture_id`)}/refund`, { amount: money(s.amount) });
    Object.assign(v, { refund_id: r.id, amount: s.amount, ref: base?.ref });
  } else if (s.kind === 'checkout') {
    const order = await pp.post('/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ amount: money(s.amount), custom_id: ref }],
      application_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel' },
    });
    Object.assign(v, { order_id: order.id, amount: s.amount });
  }
  return v;
}

function parseResult(res: any): any {
  const text = (res?.content ?? []).map((c: any) => c.text ?? '').join('');
  try {
    return JSON.parse(text);
  } catch {
    return res?.structuredContent ?? { raw: text };
  }
}

async function seedMcpal(call: McpalCall, s: FixtureSpec, ref: string, fx: Fixtures): Promise<FixtureValues> {
  const v: FixtureValues = { ref };
  const ok = (r: any, what: string) => {
    if (!r?.ok) throw new Error(`mcpal fixture ${what} failed: ${JSON.stringify(r).slice(0, 300)}`);
    return r.paypal?.ids ?? {};
  };
  if (s.kind === 'captured') {
    const ids = ok(parseResult(await call('charge', { orderRef: ref, amount: Number(s.amount).toFixed(2), currency: s.currency, description: s.description, pay_with: 'sandbox_card' })), 'charge');
    Object.assign(v, { order_id: need(ids.order_id, 'order_id'), capture_id: need(ids.capture_ids?.[0], 'capture_id'), amount: s.amount });
  } else if (s.kind === 'authorized') {
    const ids = ok(
      parseResult(await call('hold', { orderRef: ref, amount: Number(s.amount).toFixed(2), currency: s.currency, deposit: s.capture_now ? Number(s.capture_now).toFixed(2) : undefined, pay_with: 'sandbox_card' })),
      'hold',
    );
    Object.assign(v, { order_id: need(ids.order_id, 'order_id'), authorization_id: need(ids.authorization_id, 'authorization_id'), amount: s.amount });
    if (ids.capture_ids?.[0]) v.capture_id = ids.capture_ids[0];
    if (ids.deposit_order_id) v.deposit_order_id = ids.deposit_order_id;
  } else if (s.kind === 'refunded') {
    const base = fx.values[s.of];
    const ids = ok(parseResult(await call('refund', { orderRef: need(base?.ref, `${s.of}.ref`), amount: Number(s.amount).toFixed(2) })), 'refund');
    Object.assign(v, { refund_id: (ids.refund_ids ?? []).slice(-1)[0], amount: s.amount, ref: base?.ref });
  } else if (s.kind === 'checkout') {
    const r = parseResult(await call('charge', { orderRef: ref, amount: Number(s.amount).toFixed(2), pay_with: 'approval_link' }));
    const ids = ok(r, 'checkout');
    Object.assign(v, { order_id: need(ids.order_id, 'order_id'), amount: s.amount });
  }
  return v;
}

async function seedPlan(pp: PayPal, s: Extract<FixtureSpec, { kind: 'plan' }>, tag: string): Promise<FixtureValues> {
  const prod = await pp.post('/v1/catalogs/products', { name: s.name ?? `Bench product ${tag}`, type: 'SERVICE' });
  const plan = await pp.post('/v1/billing/plans', {
    product_id: prod.id,
    name: s.name ?? `Bench plan ${tag}`,
    status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: s.interval ?? 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: money(s.price) } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
  });
  return { product_id: prod.id, plan_id: plan.id, amount: s.price };
}

export async function seed(pp: PayPal, specs: FixtureSpec[], tag: string, mcpal?: McpalCall): Promise<Fixtures> {
  const fx: Fixtures = { tag, via: mcpal ? 'mcpal' : 'rest', values: {}, setupIds: [], orderIds: [] };
  for (const s of specs) {
    const ref = `${tag}-${s.ref}`;
    let v: FixtureValues;
    if (s.kind === 'plan') v = await seedPlan(pp, s, tag);
    else v = mcpal ? await seedMcpal(mcpal, s, ref, fx) : await seedRest(pp, s, ref, fx);
    fx.values[s.ref] = v;
    for (const k of ['order_id', 'deposit_order_id']) if (v[k] && !fx.orderIds.includes(v[k]!)) fx.orderIds.push(v[k]!);
    for (const val of Object.values(v)) if (val && /^[A-Z0-9-]{12,}$/.test(val)) fx.setupIds.push(val);
  }
  // Snapshot every money movement that exists after setup, so the grader only scores what the agent did.
  for (const oid of fx.orderIds) {
    const o = await pp.get(`/v2/checkout/orders/${oid}`);
    for (const pu of o.purchase_units ?? []) {
      const p = pu.payments ?? {};
      for (const x of [...(p.captures ?? []), ...(p.refunds ?? []), ...(p.authorizations ?? [])]) fx.setupIds.push(x.id);
      for (const a of p.authorizations ?? []) if (a.status === 'VOIDED') fx.setupIds.push(`void:${a.id}`);
    }
  }
  fx.setupIds = [...new Set(fx.setupIds)];
  return fx;
}

/** Replace {tag}, {A.order_id}, {env.PAYPAL_BUYER_EMAIL} in task text. */
export function render(text: string, fx: Pick<Fixtures, 'tag' | 'values'>): string {
  return text.replace(/\{([A-Za-z0-9_.]+)\}/g, (m, key: string) => {
    if (key === 'tag') return fx.tag;
    const [a, b] = key.split('.');
    if (a === 'env' && b) return process.env[b] ?? m;
    if (b && fx.values[a]?.[b] !== undefined) return String(fx.values[a][b]);
    return m;
  });
}

export function renderDeep<T>(obj: T, fx: Pick<Fixtures, 'tag' | 'values'>): T {
  if (typeof obj === 'string') return render(obj, fx) as unknown as T;
  if (Array.isArray(obj)) return obj.map((x) => renderDeep(x, fx)) as unknown as T;
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, val] of Object.entries(obj)) out[k] = renderDeep(val, fx);
    return out;
  }
  return obj;
}
