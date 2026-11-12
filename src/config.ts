import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_SANDBOX_ENV_FILE = join(homedir(), "paypal-hackathon-research", ".env.paypal-sandbox");

/** Parse a dotenv-style file. Does not override variables already set. Returns true if the file was loaded. */
export function loadEnvFile(path: string, override = false): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2] ?? "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(" #");
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (override || process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

let envLoaded = false;
/** Load ./.env and the PayPal sandbox credentials file (if present). Idempotent. */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  loadEnvFile(resolve(process.cwd(), ".env"));
  loadEnvFile(process.env.MCPAL_PAYPAL_ENV_FILE ?? DEFAULT_SANDBOX_ENV_FILE);
}

export type PayPalEnv = "sandbox" | "live";
export type PayWith = "sandbox_card" | "approval_link";

export interface McpalConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  paypalEnv: PayPalEnv;
  baseUrl: string;
  webhookId: string | undefined;
  dataDir: string;
  policyFile: string;
  publicUrl: string;
  httpPort: number;
  /** @deprecated verbs now take an explicit method (default payment_link); kept for config compatibility. */
  defaultPayWith: PayWith;
  sandboxCard: string;
  returnUrl: string;
  cancelUrl: string;
}

export function readConfig(): McpalConfig {
  loadEnv();
  const e = process.env;
  const paypalEnv: PayPalEnv = e.PAYPAL_ENV === "live" ? "live" : "sandbox";
  const port = Number(e.MCPAL_HTTP_PORT ?? e.PORT ?? 8787);
  const publicUrl = (e.MCPAL_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const defaultPayWith: PayWith =
    paypalEnv === "live" ? "approval_link" : e.MCPAL_DEFAULT_PAY_WITH === "approval_link" ? "approval_link" : "sandbox_card";
  return {
    clientId: e.PAYPAL_CLIENT_ID,
    clientSecret: e.PAYPAL_CLIENT_SECRET,
    paypalEnv,
    baseUrl: e.PAYPAL_BASE_URL ?? (paypalEnv === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com"),
    webhookId: e.PAYPAL_WEBHOOK_ID,
    dataDir: resolve(e.MCPAL_DATA_DIR ?? ".mcpal"),
    policyFile: resolve(e.MCPAL_POLICY_FILE ?? "mcpal.policy.json"),
    publicUrl,
    httpPort: port,
    defaultPayWith,
    sandboxCard: e.MCPAL_SANDBOX_CARD ?? "4012000077777777",
    returnUrl: e.MCPAL_RETURN_URL ?? `${publicUrl}/paypal/return`,
    cancelUrl: e.MCPAL_CANCEL_URL ?? `${publicUrl}/paypal/cancel`,
  };
}
