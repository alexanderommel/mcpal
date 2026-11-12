import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL decision log with a hash chain.
 * Each line: { seq, ts, ...entry, prev_hash, hash } where
 *   hash = sha256(prev_hash + canonicalJSON(line without hash)).
 * Editing or deleting any line breaks every later hash; verifyDecisionLog() finds the first broken line.
 */

export interface DecisionEntry {
  verb: string;
  orderRef: string;
  /** allowed | needs_approval | denied | replayed | error */
  decision: string;
  reason?: string;
  input?: unknown;
  result?: unknown;
}

export interface DecisionLine extends DecisionEntry {
  seq: number;
  ts: string;
  prev_hash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);

/** Stable JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashLine(prevHash: string, body: Omit<DecisionLine, "hash">): string {
  return createHash("sha256").update(prevHash + canonicalJson(body)).digest("hex");
}

export class DecisionLog {
  readonly path: string;
  private seq = 0;
  private prevHash = GENESIS_HASH;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        const parsed = JSON.parse(last) as DecisionLine;
        this.seq = parsed.seq;
        this.prevHash = parsed.hash;
      }
    }
  }

  append(entry: DecisionEntry, now: Date = new Date()): DecisionLine {
    const body: Omit<DecisionLine, "hash"> = {
      ...entry,
      input: redact(entry.input),
      seq: this.seq + 1,
      ts: now.toISOString(),
      prev_hash: this.prevHash,
    };
    const hash = hashLine(this.prevHash, body);
    const line: DecisionLine = { ...body, hash };
    appendFileSync(this.path, JSON.stringify(line) + "\n");
    this.seq = line.seq;
    this.prevHash = hash;
    return line;
  }

  get head() {
    return { seq: this.seq, hash: this.prevHash };
  }
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  head: string;
  brokenAt?: number;
  reason?: string;
}

export function verifyDecisionLog(path: string): VerifyResult {
  if (!existsSync(path)) return { ok: true, count: 0, head: GENESIS_HASH };
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let prev = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let parsed: DecisionLine;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "line is not valid JSON" };
    }
    const { hash, ...body } = parsed;
    if (body.prev_hash !== prev) return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "prev_hash does not match previous line" };
    if (body.seq !== i + 1) return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "sequence gap" };
    if (hashLine(prev, body) !== hash) return { ok: false, count: lines.length, head: prev, brokenAt: i + 1, reason: "hash mismatch (line edited)" };
    prev = hash;
  }
  return { ok: true, count: lines.length, head: prev };
}

const SECRET_KEYS = new Set(["number", "security_code", "card_number", "cvv", "client_secret"]);
function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) ? "[redacted]" : redact(v);
  }
  return out;
}
