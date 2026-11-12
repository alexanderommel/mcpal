import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { normalizeAmount } from "./money.js";
import { readConfig, type McpalConfig } from "./config.js";
import { PayPalClient } from "./paypal/client.js";
import { Ledger } from "./ledger/store.js";
import { DecisionLog } from "./ledger/decision-log.js";
import { Policy, loadPolicy, type PolicyConfig } from "./policy.js";

export interface McpalContext {
  config: McpalConfig;
  /** Throws a plain error if PayPal credentials are missing. */
  readonly paypal: PayPalClient;
  ledger: Ledger;
  policy: Policy;
  log: DecisionLog;
  /** Per-install idempotency salt: sha256(install id | ledger id | PayPal client id). */
  salt: string;
  installId: string;
}

export interface ContextOverrides {
  config?: Partial<McpalConfig>;
  paypal?: PayPalClient;
  ledger?: Ledger;
  policy?: Partial<PolicyConfig>;
  log?: DecisionLog;
}

export class MissingCredentialsError extends Error {
  constructor() {
    super("PayPal credentials are missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app) in .env or ~/paypal-hackathon-research/.env.paypal-sandbox.");
    this.name = "MissingCredentialsError";
  }
}

export function createContext(overrides: ContextOverrides = {}): McpalContext {
  const config: McpalConfig = { ...readConfig(), ...overrides.config };
  const ledger = overrides.ledger ?? new Ledger(join(config.dataDir, "mcpal.sqlite"));
  const log = overrides.log ?? new DecisionLog(join(config.dataDir, "decisions.jsonl"));
  const policyConfig = { ...loadPolicy(config.policyFile), ...overrides.policy };
  const policy = new Policy(policyConfig, ledger, config.publicUrl);
  const quotesFile = process.env.MCPAL_QUOTES_FILE;
  if (quotesFile && existsSync(quotesFile)) {
    // Merchant price list: [{ "quoteRef": "order-42", "amount": "42.50", "currency": "USD", "description": "..." }]
    const quotes = JSON.parse(readFileSync(quotesFile, "utf8")) as { quoteRef: string; amount: string; currency?: string; description?: string }[];
    for (const q of quotes) ledger.putQuote({ quoteRef: q.quoteRef, amount: normalizeAmount(q.amount), currency: (q.currency ?? policyConfig.currency).toUpperCase(), description: q.description });
  }
  const installId = loadInstallId(config.dataDir);
  const salt = createHash("sha256").update(`${installId}|${ledger.ledgerId}|${config.clientId ?? ""}`).digest("hex");
  let client = overrides.paypal;
  return {
    config,
    ledger,
    log,
    policy,
    salt,
    installId,
    get paypal(): PayPalClient {
      if (!client) {
        if (!config.clientId || !config.clientSecret) throw new MissingCredentialsError();
        client = new PayPalClient({ clientId: config.clientId, clientSecret: config.clientSecret, baseUrl: config.baseUrl });
      }
      return client;
    },
  };
}

let defaultCtx: McpalContext | undefined;
/** Lazily-created process-wide context (env + mcpal.policy.json + ./.mcpal). */
export function defaultContext(): McpalContext {
  defaultCtx ??= createContext();
  return defaultCtx;
}

/** Replace the process-wide default context (library users, tests). */
export function setDefaultContext(ctx: McpalContext | undefined): void {
  defaultCtx = ctx;
}

/** MCPAL_INSTALL_ID, or a random id generated on first run and persisted in <dataDir>/install-id. */
export function loadInstallId(dataDir: string): string {
  if (process.env.MCPAL_INSTALL_ID) return process.env.MCPAL_INSTALL_ID;
  const file = join(dataDir, "install-id");
  if (existsSync(file)) {
    const v = readFileSync(file, "utf8").trim();
    if (v) return v;
  }
  mkdirSync(dataDir, { recursive: true });
  const id = randomBytes(16).toString("hex");
  writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}
