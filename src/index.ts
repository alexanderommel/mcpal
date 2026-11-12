/**
 * MCPal as a library:
 *   import { hold, capture_hold, createContext } from "mcpal";
 *   const r = await hold({ orderRef: "booking-7", amount: "200.00", deposit: "50.00", method: "card_on_file" });
 * Each verb takes an optional McpalContext as its second argument; without one it uses
 * a process-wide default built from env, mcpal.policy.json and ./.mcpal.
 */
export * from "./verbs/index.js";
export { createContext, defaultContext, setDefaultContext, MissingCredentialsError, type McpalContext, type ContextOverrides } from "./context.js";
export { readConfig, loadEnv, loadEnvFile, type McpalConfig } from "./config.js";
export { PayPalClient, PayPalError, PayPalAuthError, linkOf, type PayPalClientOptions } from "./paypal/client.js";
export { requestId, shortId } from "./idempotency.js";
export { Policy, loadPolicy, checkRules, thresholdFor, DEFAULT_POLICY, THRESHOLD_VERBS, type PolicyConfig, type PolicyDecision, type ThresholdVerb } from "./policy.js";
export {
  compilePolicy,
  finishCompile,
  guardPolicy,
  validatePolicy,
  runTryChecks,
  defaultTryChecks,
  amountsInText,
  HARD_LIMITS,
  MAX_POLICY_TEXT,
  POLICY_AI_MODEL,
  type CompileResult,
  type TryCheck,
} from "./policy-ai.js";
export { Ledger, type RefRecord, type ApprovalRec } from "./ledger/store.js";
export { DecisionLog, verifyDecisionLog, canonicalJson } from "./ledger/decision-log.js";
export { handleWebhook, buildVerifyBody } from "./webhooks/verify.js";
export { toCents, fromCents, normalizeAmount, InputError } from "./money.js";
export { TOOL_DESCRIPTIONS, createMcpServer, createHttpServer, startHttp, startStdio } from "./server.js";
