import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Local state for each merchant orderRef. PayPal stays the source of truth; this is the index + memory. */

export type RefKind = "charge" | "hold" | "payout" | "subscription";

export interface CaptureRec {
  id: string;
  amount: string;
  status: string;
  final?: boolean;
  /** Order the capture belongs to (differs from the main order in the split-order fallback). */
  orderId?: string;
  /** PayPal-Request-Id used; lets a retried capture_hold/hold replay instead of capturing again. */
  key?: string;
}

export interface RefundRec {
  id: string;
  captureId: string;
  amount: string;
  status: string;
  /** Idempotency key of the refund intent (one refund verb call may split over several captures). */
  key?: string;
  /** When MCPal created it (ISO). */
  at?: string;
}

export interface QuoteRec {
  quoteRef: string;
  amount: string;
  currency: string;
  description?: string;
  createdAt: string;
}

export interface RefRecord {
  orderRef: string;
  kind: RefKind;
  currency: string;
  /** Total amount the verb was asked to move (charge total, hold total, payout amount, subscription price). */
  amount: string;
  state: string;
  payWith?: string;
  orderId?: string;
  approveUrl?: string;
  authorizationId?: string;
  authorizedAmount?: string;
  authorizationStatus?: string;
  depositAmount?: string;
  /** Set when deposit was taken through the split-order fallback. */
  fallback?: string;
  depositOrderId?: string;
  captures: CaptureRec[];
  refunds: RefundRec[];
  payoutBatchId?: string;
  payoutItemId?: string;
  payoutReceiver?: string;
  productId?: string;
  planId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  recipientEmail?: string;
  /** Payment method the caller chose: payment_link | invoice | card_on_file. */
  method?: string;
  quoteRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRec {
  id: string;
  orderRef: string;
  verb: string;
  amount: string;
  currency: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "used";
  createdAt: string;
  decidedAt?: string;
}

export interface WebhookRec {
  transmissionId: string;
  eventId: string;
  eventType: string;
  resourceId: string | undefined;
  orderRef: string | undefined;
  verified: boolean;
  receivedAt: string;
  summary: string;
}

export class Ledger {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        order_ref TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        verb TEXT NOT NULL,
        order_ref TEXT NOT NULL,
        currency TEXT NOT NULL,
        cents INTEGER NOT NULL,
        request_id TEXT UNIQUE,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spend_day ON spend(day, currency);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        order_ref TEXT NOT NULL,
        verb TEXT NOT NULL,
        amount TEXT NOT NULL,
        currency TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webhooks (
        transmission_id TEXT PRIMARY KEY,
        event_id TEXT,
        event_type TEXT,
        resource_id TEXT,
        order_ref TEXT,
        verified INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        summary TEXT,
        body TEXT
      );
      CREATE INDEX IF NOT EXISTS webhooks_ref ON webhooks(order_ref, received_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotes (
        quote_ref TEXT PRIMARY KEY,
        amount TEXT NOT NULL,
        currency TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  /** Random id created with this ledger; part of the idempotency salt so a wiped/new ledger never replays old PayPal results. */
  get ledgerId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='ledger_id'").get() as { value: string } | undefined;
    if (row) return row.value;
    const id = randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('ledger_id', ?)").run(id);
    return (this.db.prepare("SELECT value FROM meta WHERE key='ledger_id'").get() as { value: string }).value;
  }

  getRef(orderRef: string): RefRecord | undefined {
    const row = this.db.prepare("SELECT data FROM refs WHERE order_ref = ?").get(orderRef) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as RefRecord) : undefined;
  }

  putRef(rec: RefRecord): RefRecord {
    rec.updatedAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO refs(order_ref, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(order_ref) DO UPDATE SET kind=excluded.kind, data=excluded.data, updated_at=excluded.updated_at")
      .run(rec.orderRef, rec.kind, JSON.stringify(rec), rec.updatedAt);
    return rec;
  }

  newRef(orderRef: string, kind: RefKind, amount: string, currency: string): RefRecord {
    const now = new Date().toISOString();
    return { orderRef, kind, amount, currency, state: "new", captures: [], refunds: [], createdAt: now, updatedAt: now };
  }

  /** Find the orderRef that owns a PayPal id (order, authorization, capture, refund, payout batch, subscription). */
  findRefByPayPalId(id: string): RefRecord | undefined {
    const row = this.db.prepare("SELECT data FROM refs WHERE instr(data, ?) > 0 LIMIT 1").get(`"${id}"`) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as RefRecord) : undefined;
  }

  listRefs(limit = 50): RefRecord[] {
    return (this.db.prepare("SELECT data FROM refs ORDER BY updated_at DESC LIMIT ?").all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  // ---- spend (daily cap) ----
  recordSpend(verb: string, orderRef: string, currency: string, cents: number, requestId: string, at = new Date()): void {
    this.db
      .prepare("INSERT OR IGNORE INTO spend(day, verb, order_ref, currency, cents, request_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(at.toISOString().slice(0, 10), verb, orderRef, currency, cents, requestId, at.toISOString());
  }

  spentToday(currency: string, at = new Date()): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cents),0) AS c FROM spend WHERE day = ? AND currency = ?").get(at.toISOString().slice(0, 10), currency) as { c: number };
    return row.c;
  }

  // ---- human approvals ----
  findApproval(orderRef: string, verb: string, amount: string, currency: string): ApprovalRec | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE order_ref=? AND verb=? AND amount=? AND currency=? AND status IN ('pending','approved','rejected') ORDER BY created_at DESC LIMIT 1")
      .get(orderRef, verb, amount, currency) as any;
    return row ? rowToApproval(row) : undefined;
  }

  getApproval(id: string): ApprovalRec | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as any;
    return row ? rowToApproval(row) : undefined;
  }

  createApproval(orderRef: string, verb: string, amount: string, currency: string, reason: string): ApprovalRec {
    const rec: ApprovalRec = { id: randomUUID(), orderRef, verb, amount, currency, reason, status: "pending", createdAt: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO approvals(id, order_ref, verb, amount, currency, reason, status, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(rec.id, orderRef, verb, amount, currency, reason, rec.status, rec.createdAt);
    return rec;
  }

  decideApproval(id: string, status: "approved" | "rejected" | "used"): ApprovalRec | undefined {
    this.db.prepare("UPDATE approvals SET status=?, decided_at=? WHERE id=?").run(status, new Date().toISOString(), id);
    return this.getApproval(id);
  }

  listApprovals(status?: string): ApprovalRec[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100").all();
    return (rows as any[]).map(rowToApproval);
  }

  // ---- webhooks ----
  /** Returns false if this transmission id was already stored (duplicate delivery). */
  recordWebhook(rec: WebhookRec, body: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO webhooks(transmission_id, event_id, event_type, resource_id, order_ref, verified, received_at, summary, body) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(rec.transmissionId, rec.eventId, rec.eventType, rec.resourceId ?? null, rec.orderRef ?? null, rec.verified ? 1 : 0, rec.receivedAt, rec.summary, body);
    return r.changes === 1;
  }

  hasEvent(eventId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM webhooks WHERE event_id=? AND verified=1").get(eventId);
  }

  lastWebhook(orderRef: string): WebhookRec | undefined {
    const row = this.db.prepare("SELECT * FROM webhooks WHERE order_ref=? ORDER BY received_at DESC LIMIT 1").get(orderRef) as any;
    if (!row) return undefined;
    return {
      transmissionId: row.transmission_id,
      eventId: row.event_id,
      eventType: row.event_type,
      resourceId: row.resource_id ?? undefined,
      orderRef: row.order_ref ?? undefined,
      verified: !!row.verified,
      receivedAt: row.received_at,
      summary: row.summary,
    };
  }

  // ---- merchant quotes (prices set by the merchant, never by the agent) ----
  putQuote(q: Omit<QuoteRec, "createdAt">): QuoteRec {
    const rec: QuoteRec = { ...q, createdAt: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO quotes(quote_ref, amount, currency, description, created_at) VALUES (?,?,?,?,?) ON CONFLICT(quote_ref) DO UPDATE SET amount=excluded.amount, currency=excluded.currency, description=excluded.description")
      .run(rec.quoteRef, rec.amount, rec.currency, rec.description ?? null, rec.createdAt);
    return rec;
  }

  getQuote(quoteRef: string): QuoteRec | undefined {
    const row = this.db.prepare("SELECT * FROM quotes WHERE quote_ref=?").get(quoteRef) as any;
    return row ? { quoteRef: row.quote_ref, amount: row.amount, currency: row.currency, description: row.description ?? undefined, createdAt: row.created_at } : undefined;
  }

  /** Has this recipient received a payout that PayPal reported as SUCCESS? */
  hasSuccessfulPayoutTo(receiver: string): boolean {
    const want = receiver.trim().toLowerCase();
    const rows = this.db.prepare("SELECT data FROM refs WHERE kind='payout'").all() as { data: string }[];
    return rows.some((r) => {
      const d = JSON.parse(r.data) as RefRecord;
      return d.state === "payout_success" && (d.payoutReceiver ?? "").trim().toLowerCase() === want;
    });
  }

  close(): void {
    this.db.close();
  }
}

function rowToApproval(row: any): ApprovalRec {
  return {
    id: row.id,
    orderRef: row.order_ref,
    verb: row.verb,
    amount: row.amount,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  };
}
