/**
 * mcpal policy <command>
 *   compile "<rules in plain English or Spanish>"  -> writes mcpal.policy.proposed.json, prints the diff. Applies nothing.
 *   apply [proposal]  [--yes]                       -> re-validates the proposal and, after you confirm, writes mcpal.policy.json
 *   show                                            -> prints the current policy
 * Only a human runs these. There is no MCP tool for them: the agent can't edit its own rules.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadEnv } from "./config.js";
import { loadPolicy, type PolicyConfig } from "./policy.js";
import { compilePolicy, guardPolicy, validatePolicy } from "./policy-ai.js";

export const PROPOSAL_FILE = "mcpal.policy.proposed.json";

interface Proposal {
  source_text: string;
  base_hash: string;
  policy: PolicyConfig;
  diff: string[];
  warnings: string[];
  model: string;
  compiled_at: string;
}

const hash = (p: PolicyConfig) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

function policyPath(args: string[]): string {
  const i = args.indexOf("--policy");
  return resolve(i >= 0 ? args[i + 1]! : (process.env.MCPAL_POLICY_FILE ?? "mcpal.policy.json"));
}

const print = (s: string) => process.stdout.write(s + "\n");

export async function policyCli(args: string[]): Promise<number> {
  loadEnv();
  const [cmd, ...rest] = args;
  const file = policyPath(rest);
  const current = loadPolicy(file);

  if (cmd === "show") {
    print(JSON.stringify(current, null, 2));
    return 0;
  }

  if (cmd === "compile") {
    const text = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--policy" && rest[i - 1] !== "--out").join(" ").trim();
    if (!text) {
      print('Usage: mcpal policy compile "I approve refunds over $100 myself; never more than $500 a day"');
      return 2;
    }
    const r = await compilePolicy(text, current);
    const oi = rest.indexOf("--out");
    const out = resolve(oi >= 0 ? rest[oi + 1]! : PROPOSAL_FILE);
    const proposal: Proposal = { source_text: text, base_hash: hash(current), policy: r.policy, diff: r.diff, warnings: r.warnings, model: r.model, compiled_at: new Date().toISOString() };
    writeFileSync(out, JSON.stringify(proposal, null, 2) + "\n");
    print("Proposed policy (NOT applied):");
    print(JSON.stringify(r.policy, null, 2));
    print("\nChanges:");
    for (const d of r.diff.length ? r.diff : ["(none)"]) print(`  - ${d}`);
    if (r.warnings.length) {
      print("\nWarnings:");
      for (const w of r.warnings) print(`  ! ${w}`);
    }
    print(`\nSaved to ${out}. Review it, then run: mcpal policy apply`);
    return 0;
  }

  if (cmd === "apply") {
    const pf = resolve(rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--policy") ?? PROPOSAL_FILE);
    if (!existsSync(pf)) {
      print(`No proposal at ${pf}. Run: mcpal policy compile "<your rules>"`);
      return 2;
    }
    const p = JSON.parse(readFileSync(pf, "utf8")) as Proposal;
    if (p.base_hash !== hash(current)) {
      print(`${file} changed since this proposal was compiled. Compile again so the diff is accurate.`);
      return 1;
    }
    // Re-run the deterministic checks: a hand-edited proposal gets the same zod + floor guard.
    const v = validatePolicy(p.policy);
    if (!v.ok) {
      print(`Proposal is invalid:\n  ${v.errors.join("\n  ")}`);
      return 1;
    }
    const g = guardPolicy(current, p.policy, p.source_text ?? "");
    if (g.rejected.length) {
      print(`Proposal does not pass the guard:\n  ${g.rejected.join("\n  ")}`);
      return 1;
    }
    print("Changes to apply:");
    for (const d of g.diff.length ? g.diff : ["(none)"]) print(`  - ${d}`);
    for (const w of g.warnings) print(`  ! ${w}`);
    if (!g.diff.length) return 0;
    if (!rest.includes("--yes")) {
      if (!process.stdin.isTTY) {
        print("Not a terminal: pass --yes to confirm.");
        return 1;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question(`Write these rules to ${file}? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (a !== "y" && a !== "yes") {
        print("Not applied.");
        return 1;
      }
    }
    writeFileSync(file, JSON.stringify(g.policy, null, 2) + "\n");
    print(`Applied to ${file}. Restart MCPal (or the next request) to load it.`);
    return 0;
  }

  print('Usage:\n  mcpal policy compile "<rules>"   propose a policy from plain English or Spanish\n  mcpal policy apply [--yes]       apply the proposal after review\n  mcpal policy show                print the current policy');
  return cmd ? 2 : 0;
}
