// In-memory mock of the PayPal REST subset the benchmark touches. Used only to validate the harness
// (fixtures -> agent -> grader) before sandbox credentials exist. Never used for reported numbers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

const A = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const rid = (n: number) => {
  let s = '';
  const b = randomBytes(n);
  for (let i = 0; i < n; i++) s += A[b[i] % A.length];
  return s.replace(/^[A-Z]/, '1').replace(/^(\d+)$/, (m) => 'X' + m.slice(1));
};

interface State {
  orders: Map<string, any>;
  captures: Map<string, any>;
  auths: Map<string, any>;
  refunds: Map<string, any>;
  payouts: Map<string, any>;
  items: Map<string, any>;
  products: Map<string, any>;
  plans: Map<string, any>;
  subs: Map<string, any>;
  invoices: Map<string, any>;
  idem: Map<string, { status: number; body: any }>;
}

const m2 = (v: any) => Number(v).toFixed(2);

export function startMockPayPal(port = 0): Promise<{ server: Server; base: string; state: State }> {
  const st: State = {
    orders: new Map(),
    captures: new Map(),
    auths: new Map(),
    refunds: new Map(),
    payouts: new Map(),
    items: new Map(),
    products: new Map(),
    plans: new Map(),
    subs: new Map(),
    invoices: new Map(),
    idem: new Map(),
  };
  const orderView = (o: any) => o;
  const err = (status: number, name: string, message: string) => ({ status, body: { name, message, debug_id: rid(13).toLowerCase(), details: [{ issue: name }] } });
  const pu = (o: any) => o.purchase_units[0];
  const remainingAuth = (a: any) => Number(a.amount.value) - a._captured;

  function captureOrder(o: any) {
    const amt = pu(o).amount;
    const c = { id: rid(17), status: 'COMPLETED', amount: { ...amt }, final_capture: true, supplementary_data: { related_ids: { order_id: o.id } }, _refunded: 0 };
    st.captures.set(c.id, c);
    pu(o).payments = pu(o).payments ?? {};
    (pu(o).payments.captures ??= []).push(c);
    o.status = 'COMPLETED';
  }
  function authorizeOrder(o: any) {
    const a = { id: rid(17), status: 'CREATED', amount: { ...pu(o).amount }, supplementary_data: { related_ids: { order_id: o.id } }, _captured: 0 };
    st.auths.set(a.id, a);
    pu(o).payments = pu(o).payments ?? {};
    (pu(o).payments.authorizations ??= []).push(a);
    o.status = 'COMPLETED';
  }

  async function handle(method: string, path: string, body: any): Promise<{ status: number; body: any }> {
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/v1/oauth2/token') return { status: 200, body: { access_token: 'MOCK-' + rid(20), token_type: 'Bearer', expires_in: 32400 } };
    if (method === 'POST' && path === '/v2/checkout/orders') {
      const units = (body.purchase_units ?? []).map((u: any) => ({ reference_id: 'default', ...u, amount: { ...u.amount, value: m2(u.amount?.value) } }));
      if (!units.length || !(Number(units[0].amount.value) > 0)) return err(422, 'UNPROCESSABLE_ENTITY', 'invalid amount');
      const o: any = { id: rid(17), intent: body.intent ?? 'CAPTURE', status: 'CREATED', purchase_units: units, create_time: new Date().toISOString() };
      o.links = [
        { rel: 'self', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${o.id}` },
        { rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` },
      ];
      st.orders.set(o.id, o);
      if (body.payment_source?.card) {
        o.payment_source = { card: { last_digits: String(body.payment_source.card.number).slice(-4), brand: 'VISA' } };
        if (o.intent === 'CAPTURE') captureOrder(o);
        else authorizeOrder(o);
      }
      return { status: 201, body: orderView(o) };
    }
    if ((m = path.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/)) && method === 'GET') {
      const o = st.orders.get(m[1]);
      return o ? { status: 200, body: o } : err(404, 'RESOURCE_NOT_FOUND', 'order not found');
    }
    if ((m = path.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/(capture|authorize)$/)) && method === 'POST') {
      const o = st.orders.get(m[1]);
      if (!o) return err(404, 'RESOURCE_NOT_FOUND', 'order not found');
      if (o.status === 'COMPLETED') return err(422, 'ORDER_ALREADY_CAPTURED', 'Order already captured.');
      if (o.status !== 'APPROVED') return err(422, 'ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.');
      if (m[2] === 'capture') captureOrder(o);
      else authorizeOrder(o);
      return { status: 201, body: o };
    }
    if ((m = path.match(/^\/v2\/payments\/(captures|authorizations|refunds)\/([A-Z0-9]+)$/)) && method === 'GET') {
      const map = m[1] === 'captures' ? st.captures : m[1] === 'authorizations' ? st.auths : st.refunds;
      const x = map.get(m[2]);
      return x ? { status: 200, body: x } : err(404, 'RESOURCE_NOT_FOUND', 'not found');
    }
    if ((m = path.match(/^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/)) && method === 'POST') {
      const c = st.captures.get(m[1]);
      if (!c) return err(404, 'RESOURCE_NOT_FOUND', 'capture not found');
      const amt = body.amount?.value !== undefined ? Number(body.amount.value) : Number(c.amount.value) - c._refunded;
      if (body.amount?.currency_code && body.amount.currency_code !== c.amount.currency_code) return err(422, 'CURRENCY_MISMATCH', 'currency mismatch');
      if (amt <= 0 || amt > Number(c.amount.value) - c._refunded + 1e-9) return err(422, 'REFUND_AMOUNT_EXCEEDED', 'The refund amount must be less than or equal to the capture amount that has not yet been refunded.');
      c._refunded += amt;
      c.status = c._refunded >= Number(c.amount.value) - 1e-9 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      const r = { id: rid(17), status: 'COMPLETED', amount: { currency_code: c.amount.currency_code, value: m2(amt) }, links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${c.id}` }] };
      st.refunds.set(r.id, r);
      const o = st.orders.get(c.supplementary_data.related_ids.order_id);
      if (o) (pu(o).payments.refunds ??= []).push(r);
      return { status: 201, body: r };
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/([A-Z0-9]+)\/(capture|void)$/)) && method === 'POST') {
      const a = st.auths.get(m[1]);
      if (!a) return err(404, 'RESOURCE_NOT_FOUND', 'authorization not found');
      if (['VOIDED', 'CAPTURED'].includes(a.status)) return err(422, 'AUTHORIZATION_ALREADY_COMPLETED', `Authorization is ${a.status}.`);
      const o = st.orders.get(a.supplementary_data.related_ids.order_id);
      if (m[2] === 'void') {
        a.status = 'VOIDED';
        return { status: 200, body: a };
      }
      const amt = body.amount?.value !== undefined ? Number(body.amount.value) : remainingAuth(a);
      if (amt <= 0 || amt > remainingAuth(a) + 1e-9) return err(422, 'MAX_CAPTURE_AMOUNT_EXCEEDED', 'Capture amount exceeds the authorized amount.');
      a._captured += amt;
      a.status = body.final_capture === false && remainingAuth(a) > 1e-9 ? 'PARTIALLY_CAPTURED' : 'CAPTURED';
      const c = { id: rid(17), status: 'COMPLETED', amount: { currency_code: a.amount.currency_code, value: m2(amt) }, final_capture: body.final_capture !== false, supplementary_data: { related_ids: { order_id: o?.id, authorization_id: a.id } }, _refunded: 0 };
      st.captures.set(c.id, c);
      if (o) (pu(o).payments.captures ??= []).push(c);
      return { status: 201, body: c };
    }
    if (method === 'POST' && path === '/v1/payments/payouts') {
      const bid = rid(13);
      const items = (body.items ?? []).map((it: any) => {
        const item = { payout_item_id: rid(13), transaction_status: 'UNCLAIMED', payout_batch_id: bid, payout_item: { ...it, amount: { ...it.amount, value: m2(it.amount?.value) } } };
        st.items.set(item.payout_item_id, item);
        return item;
      });
      const b = { batch_header: { payout_batch_id: bid, batch_status: 'SUCCESS', sender_batch_header: body.sender_batch_header }, items };
      st.payouts.set(bid, b);
      return { status: 201, body: { batch_header: { ...b.batch_header, batch_status: 'PENDING' }, links: [] } };
    }
    if ((m = path.match(/^\/v1\/payments\/payouts\/([A-Z0-9]+)$/)) && method === 'GET') {
      const b = st.payouts.get(m[1]);
      return b ? { status: 200, body: b } : err(404, 'INVALID_RESOURCE_ID', 'not found');
    }
    if ((m = path.match(/^\/v1\/payments\/payouts-item\/([A-Z0-9]+)$/)) && method === 'GET') {
      const b = st.items.get(m[1]);
      return b ? { status: 200, body: b } : err(404, 'INVALID_RESOURCE_ID', 'not found');
    }
    if (method === 'POST' && path === '/v1/catalogs/products') {
      const p = { id: 'PROD-' + rid(17), ...body };
      st.products.set(p.id, p);
      return { status: 201, body: p };
    }
    if (method === 'GET' && path.startsWith('/v1/catalogs/products')) return { status: 200, body: { products: [...st.products.values()] } };
    if (method === 'POST' && path === '/v1/billing/plans') {
      const p = { id: 'P-' + rid(24), status: body.status ?? 'ACTIVE', ...body };
      st.plans.set(p.id, p);
      return { status: 201, body: p };
    }
    if ((m = path.match(/^\/v1\/billing\/plans\/([A-Z0-9-]+)$/)) && method === 'GET') {
      const p = st.plans.get(m[1]);
      return p ? { status: 200, body: p } : err(404, 'RESOURCE_NOT_FOUND', 'not found');
    }
    if (method === 'GET' && path.startsWith('/v1/billing/plans')) return { status: 200, body: { plans: [...st.plans.values()] } };
    if (method === 'POST' && path === '/v1/billing/subscriptions') {
      if (!st.plans.has(body.plan_id)) return err(422, 'RESOURCE_NOT_FOUND', 'plan not found');
      const s = { id: 'I-' + rid(12), status: 'APPROVAL_PENDING', plan_id: body.plan_id, links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${rid(17)}` }] };
      st.subs.set(s.id, s);
      return { status: 201, body: s };
    }
    if ((m = path.match(/^\/v1\/billing\/subscriptions\/([A-Z0-9-]+)$/)) && method === 'GET') {
      const s = st.subs.get(m[1]);
      return s ? { status: 200, body: s } : err(404, 'RESOURCE_NOT_FOUND', 'not found');
    }
    if (method === 'POST' && path === '/v2/invoicing/invoices') {
      const id = `INV2-${rid(4)}-${rid(4)}-${rid(4)}-${rid(4)}`;
      const total = (body.items ?? []).reduce((s: number, it: any) => s + Number(it.unit_amount?.value ?? 0) * Number(it.quantity ?? 1), 0);
      const inv = { id, status: 'DRAFT', ...body, amount: { currency_code: body.detail?.currency_code ?? 'USD', value: m2(total) } };
      st.invoices.set(id, inv);
      return { status: 201, body: { rel: 'self', href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${id}`, method: 'GET' } };
    }
    if ((m = path.match(/^\/v2\/invoicing\/invoices\/([A-Z0-9-]+)$/)) && method === 'GET') {
      const i = st.invoices.get(m[1]);
      return i ? { status: 200, body: i } : err(404, 'RESOURCE_NOT_FOUND', 'not found');
    }
    if ((m = path.match(/^\/v2\/invoicing\/invoices\/([A-Z0-9-]+)\/send$/)) && method === 'POST') {
      const i = st.invoices.get(m[1]);
      if (!i) return err(404, 'RESOURCE_NOT_FOUND', 'not found');
      i.status = 'SENT';
      return { status: 200, body: { href: `https://www.sandbox.paypal.com/invoice/p/#${i.id}` } };
    }
    return err(404, 'NOT_MOCKED', `${method} ${path} is not implemented in the mock`);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any = {};
    try {
      body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const path = (req.url ?? '/').split('?')[0];
    const key = req.method === 'POST' ? (req.headers['paypal-request-id'] as string | undefined) : undefined;
    let out: { status: number; body: any };
    if (key && st.idem.has(`${path}|${key}`)) out = st.idem.get(`${path}|${key}`)!;
    else {
      out = await handle(req.method ?? 'GET', path, body);
      if (key && out.status < 300) st.idem.set(`${path}|${key}`, out);
    }
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k.startsWith('_') ? undefined : v)));
    res.writeHead(out.status, { 'content-type': 'application/json', 'paypal-debug-id': rid(13).toLowerCase() });
    res.end(JSON.stringify(strip(out.body)));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as any).port}`, state: st })));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] ?? 8787);
  startMockPayPal(port).then(({ base }) => console.log(`mock PayPal on ${base}`));
}
