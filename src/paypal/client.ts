/**
 * Minimal PayPal REST client.
 * - OAuth2 client-credentials with an in-memory token cache (refreshed 60 s before expiry).
 * - Every write carries a PayPal-Request-Id; retries (network, 429, 5xx) reuse the same id, so they never duplicate money.
 * - Captures `paypal-debug-id` on every response and error.
 * - Errors are typed (PayPalError) with PayPal's `name`, first `issue`, and a plain sentence an agent can act on.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  /** Base backoff in ms (doubles per retry). */
  backoffMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Raw string body (sent as-is, used for webhook verification so the event bytes are not re-serialized). */
  rawBody?: string;
  requestId?: string;
  headers?: Record<string, string>;
  /** Prefer header; default return=representation for writes. */
  prefer?: string;
}

export interface PayPalResponse<T = any> {
  status: number;
  data: T;
  debugId: string | undefined;
  requestId: string | undefined;
}

export interface PayPalIssue {
  field?: string;
  value?: string;
  location?: string;
  issue?: string;
  description?: string;
}

export class PayPalError extends Error {
  readonly status: number;
  override readonly name: string;
  readonly paypalName: string | undefined;
  readonly issue: string | undefined;
  readonly details: PayPalIssue[];
  readonly debugId: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly raw: unknown;

  constructor(args: {
    status: number;
    paypalName?: string;
    issue?: string;
    message: string;
    details?: PayPalIssue[];
    debugId?: string;
    method: string;
    path: string;
    raw?: unknown;
  }) {
    super(args.message);
    this.name = "PayPalError";
    this.status = args.status;
    this.paypalName = args.paypalName;
    this.issue = args.issue;
    this.details = args.details ?? [];
    this.debugId = args.debugId;
    this.method = args.method;
    this.path = args.path;
    this.raw = args.raw;
  }

  /** True if any issue code in the error matches one of the given codes. */
  hasIssue(...codes: string[]): boolean {
    const all = [this.issue, this.paypalName, ...this.details.map((d) => d.issue)].filter(Boolean) as string[];
    return all.some((c) => codes.includes(c));
  }

  toJSON() {
    return {
      status: this.status,
      name: this.paypalName,
      issue: this.issue,
      message: this.message,
      debug_id: this.debugId,
      details: this.details,
    };
  }
}

export class PayPalAuthError extends PayPalError {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PayPalClient {
  readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private token: { value: string; expiresAt: number } | undefined;
  private tokenPromise: Promise<string> | undefined;
  /** Last debug id seen, handy for logs. */
  lastDebugId: string | undefined;
  /** Number of API responses received (lets callers tell whether a call touched PayPal). */
  responses = 0;

  constructor(opts: PayPalClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.baseUrl = (opts.baseUrl ?? "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? 400;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      try {
        const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
        const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: "grant_type=client_credentials",
        });
        const debugId = res.headers.get("paypal-debug-id") ?? undefined;
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
          throw new PayPalAuthError({
            status: res.status,
            paypalName: data.error,
            issue: data.error,
            message: `PayPal rejected the API credentials (${data.error ?? res.status}: ${data.error_description ?? "no description"}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET and PAYPAL_ENV.`,
            debugId,
            method: "POST",
            path: "/v1/oauth2/token",
            raw: data,
          });
        }
        this.token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3000) * 1000 };
        return this.token.value;
      } finally {
        this.tokenPromise = undefined;
      }
    })();
    return this.tokenPromise;
  }

  async request<T = any>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<PayPalResponse<T>> {
    const isWrite = method !== "GET";
    let attempt = 0;
    let authRetried = false;
    for (;;) {
      const token = await this.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...opts.headers,
      };
      if (opts.body !== undefined || opts.rawBody !== undefined) headers["Content-Type"] = "application/json";
      if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
      if (isWrite) headers["Prefer"] = opts.prefer ?? "return=representation";

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        });
      } catch (err) {
        // Network failure: safe to retry because the request id is reused (or it is a GET).
        if (attempt < this.maxRetries && (!isWrite || opts.requestId)) {
          await sleep(this.backoffMs * 2 ** attempt++);
          continue;
        }
        throw new PayPalError({
          status: 0,
          paypalName: "NETWORK_ERROR",
          message: `Could not reach PayPal (${(err as Error).message}). Retry the same call; it is idempotent.`,
          method,
          path,
        });
      }

      const debugId = res.headers.get("paypal-debug-id") ?? undefined;
      this.lastDebugId = debugId;
      this.responses++;
      const text = await res.text();
      let data: any = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (res.ok) return { status: res.status, data: data as T, debugId, requestId: opts.requestId };

      if (res.status === 401 && !authRetried) {
        authRetried = true;
        this.token = undefined;
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries && (!isWrite || opts.requestId)) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.backoffMs * 2 ** attempt);
        attempt++;
        continue;
      }
      throw toPayPalError(res.status, data, debugId, method, path);
    }
  }

  get<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }
  post<T = any>(path: string, body: unknown, requestId?: string, opts: RequestOptions = {}) {
    return this.request<T>("POST", path, { ...opts, body, requestId });
  }
}

export function toPayPalError(status: number, data: any, debugId: string | undefined, method: string, path: string): PayPalError {
  const details: PayPalIssue[] = Array.isArray(data?.details) ? data.details : [];
  const name: string | undefined = data?.name ?? data?.error;
  const issue: string | undefined = details[0]?.issue ?? name;
  const desc: string = details[0]?.description ?? data?.message ?? data?.error_description ?? (typeof data === "string" ? data : "");
  const field = details[0]?.field ? ` (field ${details[0].field})` : "";
  const message = `PayPal ${status} ${issue ?? "ERROR"}${field}: ${desc || "no description"}${debugId ? ` [debug_id ${debugId}]` : ""}`;
  return new PayPalError({ status, paypalName: name, issue, message, details, debugId, method, path, raw: data });
}

/** Find a HATEOAS link by rel (e.g. "approve", "payer-action"). */
export function linkOf(obj: any, ...rels: string[]): string | undefined {
  const links: any[] = Array.isArray(obj?.links) ? obj.links : [];
  for (const rel of rels) {
    const l = links.find((x) => x?.rel === rel);
    if (l?.href) return l.href as string;
  }
  return undefined;
}
