import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { FixtureSpec } from './fixtures.js';

export type MovementType = 'capture' | 'refund' | 'authorization' | 'void' | 'payout';

export interface ExpectedMovement {
  type: MovementType;
  amount: string;
  currency?: string;
  on?: string; // fixture ref whose order the movement must belong to
  receiver?: string; // payouts
}

export interface Expect {
  movements?: ExpectedMovement[];
  orders?: { amount: string }[]; // unapproved orders (checkout links)
  subscriptions?: { price: string; interval: string; plan?: string }[];
  invoices?: { amount: string; status_in: string[] }[];
  allow?: { type: MovementType; on?: string }[]; // extra movements that are acceptable (e.g. voiding a released remainder)
  answer?: { all?: string[]; numbers?: string[]; words_any?: string[]; words_none?: string[] };
}

export interface Task {
  id: string;
  category: string;
  official_supported: boolean;
  mcpal_supported?: boolean;
  adversarial?: boolean;
  setup?: FixtureSpec[];
  prompt: string;
  followups?: string[];
  fault?: { tools: string[]; nth?: number };
  expect: Expect;
  /** merchant-side MCPal configuration for this task (official arm has no equivalent) */
  merchant?: { known_payees?: string[]; quotes?: { quoteRef: string; amount: string; currency?: string; description?: string }[] };
}

export const TASK_DIR = new URL('../tasks/', import.meta.url).pathname;

export function loadTasks(dir = TASK_DIR): Task[] {
  const out: Task[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml')).sort()) {
    const doc = parse(readFileSync(join(dir, f), 'utf8'));
    for (const t of doc.tasks as Task[]) {
      if (!t.id || !t.prompt || !t.expect || typeof t.official_supported !== 'boolean') throw new Error(`bad task in ${f}: ${t.id}`);
      out.push(t);
    }
  }
  const ids = new Set<string>();
  for (const t of out) {
    if (ids.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  return out;
}

export function supported(t: Task, arm: string): boolean {
  if (arm === 'official') return t.official_supported;
  return t.mcpal_supported !== false;
}
