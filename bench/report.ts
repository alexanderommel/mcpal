// Report: tsx report.ts <runId> [more runIds...]  ->  results/summary.md, summary.json, chart.svg (+ chart.png if a converter exists)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTasks, supported, type Task } from './lib/tasks.js';

const BENCH = new URL('.', import.meta.url).pathname;
const RESULTS = join(BENCH, 'results');
const ARMS = ['official', 'mcpal'] as const;
const LABEL: Record<string, string> = { official: 'Official PayPal MCP (@paypal/mcp 1.8.1)', mcpal: 'MCPal' };

interface Rec {
  arm: string;
  taskId: string;
  rep: number;
  model: string;
  provider: string;
  setupError?: string;
  agentError?: string;
  calls: { name: string; args: any; faulted: boolean }[];
  steps: number;
  usage: { prompt: number; cached: number; completion: number };
  costUsd: number;
  toolCount?: number;
  toolSchemaChars?: number;
  finalAnswer: string;
  fixtures?: any;
  grade?: any;
}

function load(runIds: string[]): Rec[] {
  const out: Rec[] = [];
  for (const runId of runIds)
    for (const arm of ARMS) {
      const dir = join(RESULTS, 'raw', runId, arm);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');

function armStats(recs: Rec[], tasks: Task[], arm: string) {
  const mine = recs.filter((r) => r.arm === arm);
  const valid = mine.filter((r) => !r.setupError && r.grade && !r.grade.error);
  const byTask = new Map<string, Rec[]>();
  for (const r of valid) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const taskIds = tasks.map((t) => t.id).filter((id) => byTask.has(id));
  const reps = Math.max(0, ...[...byTask.values()].map((v) => v.length));
  const passAll = taskIds.filter((id) => byTask.get(id)!.every((r) => r.grade.success));
  const passAny = taskIds.filter((id) => byTask.get(id)!.some((r) => r.grade.success));
  const runSuccess = valid.filter((r) => r.grade.success).length;
  const kinds: Record<string, number> = {};
  for (const r of valid) if (!r.grade.success) kinds[r.grade.failureKind ?? 'other'] = (kinds[r.grade.failureKind ?? 'other'] ?? 0) + 1;
  const sum = (f: (r: Rec) => number) => valid.reduce((s, r) => s + f(r), 0);
  const supportedIds = taskIds.filter((id) => supported(tasks.find((t) => t.id === id)!, arm));
  return {
    arm,
    tasks: taskIds.length,
    runs: valid.length,
    reps,
    setupErrors: mine.length - valid.length,
    passAll: passAll.length,
    passAny: passAny.length,
    runSuccess,
    meanTasksPerRun: reps ? r2(runSuccess / reps) : 0,
    successRate: valid.length ? r2(runSuccess / valid.length) : 0,
    supportedTasks: supportedIds.length,
    duplicates: sum((r) => r.grade.duplicates ?? 0),
    wrongAmount: sum((r) => r.grade.wrongAmount ?? 0),
    unexpected: sum((r) => r.grade.unexpected ?? 0),
    misMovedUsd: r2(sum((r) => r.grade.misMovedUsd ?? 0)),
    runsWithBadMoney: valid.filter((r) => (r.grade.duplicates ?? 0) + (r.grade.wrongAmount ?? 0) + (r.grade.unexpected ?? 0) > 0).length,
    failureKinds: kinds,
    toolCallsPerTask: r2(sum((r) => r.calls.length) / (valid.length || 1)),
    modelCallsPerTask: r2(sum((r) => r.steps) / (valid.length || 1)),
    tokensPerTask: Math.round(sum((r) => r.usage.prompt + r.usage.completion) / (valid.length || 1)),
    costPerTaskUsd: Math.round((sum((r) => r.costUsd) / (valid.length || 1)) * 10000) / 10000,
    totalCostUsd: r2(sum((r) => r.costUsd)),
    toolCount: valid[0]?.toolCount,
    toolSchemaChars: valid[0]?.toolSchemaChars,
    passAllIds: passAll,
    byTask,
  };
}

function subsetPass(st: ReturnType<typeof armStats>, ids: string[]) {
  const rel = ids.filter((id) => st.byTask.has(id));
  return { n: rel.length, passAll: rel.filter((id) => st.byTask.get(id)!.every((r) => r.grade.success)).length };
}

function chartSvg(stats: ReturnType<typeof armStats>[], n: number): string {
  // 2x2 grid on a square canvas (square so macOS qlmanage thumbnails are not cropped)
  const W = 1000,
    H = 1000;
  const reps = stats[0]?.reps ?? 1;
  const colors: Record<string, string> = { official: '#8a8f98', mcpal: '#1f6feb' };
  const panels = [
    { title: `Tasks completed in all ${reps} runs (of ${n})`, get: (s: any) => s.passAll, max: n, fmt: (v: number) => String(v) },
    { title: `Duplicate money movements (${reps} runs)`, get: (s: any) => s.duplicates, max: 0, fmt: (v: number) => String(v) },
    { title: 'Wrong-amount or unrequested movements', get: (s: any) => s.wrongAmount + s.unexpected, max: 0, fmt: (v: number) => String(v) },
    { title: 'US$ that would have been mis-moved', get: (s: any) => s.misMovedUsd, max: 0, fmt: (v: number) => `$${v.toFixed(2)}` },
  ];
  const pw = W / 2;
  const ph = 440;
  let g = `<text x="${W / 2}" y="50" text-anchor="middle" font-size="28" font-weight="700" fill="#111">Official PayPal MCP vs MCPal</text>`;
  panels.forEach((p, i) => {
    const ox = (i % 2) * pw;
    const oy = 80 + Math.floor(i / 2) * ph;
    const vals = stats.map((s) => p.get(s) as number);
    const max = Math.max(p.max, ...vals, 1);
    const barW = 140;
    const gap = 40;
    const x0 = ox + (pw - (2 * barW + gap)) / 2;
    const base = oy + 360;
    const area = 260;
    g += `<text x="${ox + pw / 2}" y="${oy + 30}" text-anchor="middle" font-size="20" font-weight="600" fill="#111">${p.title}</text>`;
    stats.forEach((s, k) => {
      const v = vals[k];
      const h = (v / max) * area;
      const x = x0 + k * (barW + gap);
      const y = base - h;
      g += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h, 2)}" fill="${colors[s.arm]}" rx="4"/>`;
      g += `<text x="${x + barW / 2}" y="${y - 12}" text-anchor="middle" font-size="26" font-weight="700" fill="#111">${p.fmt(v)}</text>`;
      g += `<text x="${x + barW / 2}" y="${base + 30}" text-anchor="middle" font-size="18" fill="#333">${s.arm === 'mcpal' ? 'MCPal' : 'Official'}</text>`;
    });
    g += `<line x1="${x0 - 10}" y1="${base}" x2="${x0 + 2 * barW + gap + 10}" y2="${base}" stroke="#999"/>`;
  });
  const m = stats[0]?.byTask.values().next().value?.[0];
  const foot = `Same model (${m?.provider}/${m?.model}), same ${n} payment tasks, ${reps} runs each, graded on real PayPal sandbox state.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif"><rect width="100%" height="100%" fill="#fff"/>${g}<text x="${W / 2}" y="${H - 30}" text-anchor="middle" font-size="16" fill="#555">${foot}</text></svg>`;
}

/**
 * Cross-model table: tsx report.ts --models run2 run3-qwen  ->  results/models.md + models.json.
 * One run id per model. "pass^1" uses run 1 of every task only, so a model with 3 runs and a model with 1 run
 * are compared on the same footing; the all-runs columns are added when a model has more than one run.
 */
function modelsReport(runIds: string[]) {
  const tasks = loadTasks();
  const adversarial = tasks.filter((t) => t.adversarial).map((t) => t.id);
  const officialSupported = tasks.filter((t) => t.official_supported).map((t) => t.id);
  const pick = (s: ReturnType<typeof armStats>) => ({
    tasks: s.tasks,
    runs: s.runs,
    reps: s.reps,
    tasksCorrect: s.passAll,
    tasksCorrectAnyRun: s.passAny,
    runSuccessRate: s.successRate,
    duplicates: s.duplicates,
    wrongAmount: s.wrongAmount,
    unexpected: s.unexpected,
    misMovedUsd: s.misMovedUsd,
    runsWithBadMoney: s.runsWithBadMoney,
    adversarial: subsetPass(s, adversarial),
    officialSupported: subsetPass(s, officialSupported),
    failureKinds: s.failureKinds,
    tokensPerTask: s.tokensPerTask,
    costPerTaskUsd: s.costPerTaskUsd,
    totalCostUsd: s.totalCostUsd,
    excludedRuns: s.setupErrors,
  });
  const models = runIds.map((runId) => {
    const recs = load([runId]);
    if (!recs.length) throw new Error(`no records for ${runId}`);
    const first = recs.filter((r) => r.rep === 1);
    const arms: Record<string, any> = {};
    for (const arm of ARMS) {
      const p1 = armStats(first, tasks, arm);
      const all = armStats(recs, tasks, arm);
      arms[arm] = { pass1: pick(p1), allRuns: all.reps > 1 ? pick(all) : undefined };
    }
    return { runId, model: recs[0].model, provider: recs[0].provider, reps: Math.max(...ARMS.map((a) => arms[a].allRuns?.reps ?? 1)), arms };
  });
  const json = {
    generatedAt: new Date().toISOString(),
    tasks: tasks.length,
    note: 'pass1 = run 1 of every task only (same footing for every model). allRuns = every run, pass^k, when a model has more than one run.',
    models,
  };
  writeFileSync(join(RESULTS, 'models.json'), JSON.stringify(json, null, 1));

  const L: string[] = [];
  L.push('# MCPal benchmark: second model', '');
  L.push(`Same ${tasks.length} tasks, same system prompt, temperature 0, at most 12 model calls per turn, real PayPal sandbox, graded from PayPal state. One run id per model: ${runIds.map((r) => `\`${r}\``).join(', ')}.`, '');
  L.push('## Run 1 of every task (pass^1, same footing for every model)', '');
  L.push('| model | toolset | tasks correct | official-capable tasks correct | adversarial correct | duplicates | wrong-amount | unrequested | US$ mis-moved | runs moving money wrongly |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const m of models)
    for (const arm of ARMS) {
      const s = m.arms[arm].pass1;
      L.push(`| ${m.model} | ${LABEL[arm]} | **${s.tasksCorrect} / ${s.tasks}** | ${s.officialSupported.passAll} / ${s.officialSupported.n} | ${s.adversarial.passAll} / ${s.adversarial.n} | ${s.duplicates} | ${s.wrongAmount} | ${s.unexpected} | $${s.misMovedUsd.toFixed(2)} | ${s.runsWithBadMoney} / ${s.runs} |`);
    }
  const multi = models.filter((m) => ARMS.some((a) => m.arms[a].allRuns));
  if (multi.length) {
    L.push('', '## All runs (pass^k: correct in every run)', '');
    L.push('| model | toolset | runs per task | tasks correct in all runs | adversarial | duplicates | wrong-amount | unrequested | US$ mis-moved | runs moving money wrongly |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const m of multi)
      for (const arm of ARMS) {
        const s = m.arms[arm].allRuns;
        if (!s) continue;
        L.push(`| ${m.model} | ${LABEL[arm]} | ${s.reps} | **${s.tasksCorrect} / ${s.tasks}** | ${s.adversarial.passAll} / ${s.adversarial.n} | ${s.duplicates} | ${s.wrongAmount} | ${s.unexpected} | $${s.misMovedUsd.toFixed(2)} | ${s.runsWithBadMoney} / ${s.runs} |`);
      }
  }
  L.push('', '## Cost', '');
  L.push('| model | toolset | tokens per task | model cost per task | model cost, all runs |');
  L.push('|---|---|---|---|---|');
  for (const m of models)
    for (const arm of ARMS) {
      const s = m.arms[arm].allRuns ?? m.arms[arm].pass1;
      L.push(`| ${m.model} | ${LABEL[arm]} | ${s.tokensPerTask.toLocaleString('en-US')} | $${s.costPerTaskUsd.toFixed(4)} | $${s.totalCostUsd.toFixed(2)} |`);
    }
  L.push('', '## Notes', '');
  L.push(
    [
      '- run2 = gpt-4.1-mini (OpenAI); run3-qwen = Qwen/Qwen3-235B-A22B-Instruct-2507 (DeepInfra). Same system prompt, tools, temperature 0, 12-step budget and task files. Per-run detail: `summary.md` (run2) and `run3-qwen/summary.md`.',
      '- run2 payout tasks have 2 valid runs, not 3 (sandbox payout balance ran out); run3-qwen has all 300 runs valid.',
      '- DeepInfra at temperature 0 is not fully deterministic, so repeated runs of one task can differ.',
      '- Six task prompts are cut at an unquoted `#{tag}` (YAML comment) in both runs, identically for both models; see `run3-qwen/summary.md`.',
    ].join('\n'),
  );
  writeFileSync(join(RESULTS, 'models.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

function main() {
  // usage: tsx report.ts [--out subdir] runId...   |   tsx report.ts --models runId...
  const argv = process.argv.slice(2);
  if (argv[0] === '--models') return modelsReport(argv.slice(1));
  const oi = argv.indexOf("--out");
  const OUT = oi >= 0 ? join(RESULTS, argv[oi + 1]) : RESULTS;
  if (oi >= 0) argv.splice(oi, 2);
  mkdirSync(OUT, { recursive: true });
  const runIds = argv;
  if (!runIds.length) throw new Error('usage: tsx report.ts <runId> [...]');
  const tasks = loadTasks();
  const recs = load(runIds);
  const stats = ARMS.map((a) => armStats(recs, tasks, a)).filter((s) => s.runs > 0);
  const n = Math.max(...stats.map((s) => s.tasks));
  const officialSupported = tasks.filter((t) => t.official_supported).map((t) => t.id);
  const bothSupported = tasks.filter((t) => t.official_supported && t.mcpal_supported !== false).map((t) => t.id);
  const adversarial = tasks.filter((t) => t.adversarial).map((t) => t.id);
  const categories = [...new Set(tasks.map((t) => t.category))];
  const model = recs[0] ? `${recs[0].provider}/${recs[0].model}` : '?';
  const get = (a: string) => stats.find((s) => s.arm === a);
  const off = get('official');
  const mp = get('mcpal');

  // notable failures for the video: wrong money first, with PayPal ids
  const notable = recs
    .filter((r) => r.grade && ((r.grade.duplicates ?? 0) + (r.grade.wrongAmount ?? 0) + (r.grade.unexpected ?? 0) > 0))
    .map((r) => ({ arm: r.arm, task: r.taskId, rep: r.rep, reason: r.grade.reason, misMovedUsd: r.grade.misMovedUsd, movements: r.grade.movements?.map((m: any) => `${m.type} ${m.amount.toFixed(2)} ${m.id}${m.orderId ? ' (order ' + m.orderId + ')' : ''}`) }));

  const L: string[] = [];
  L.push(`# MCPal benchmark results`, '');
  L.push(`Run ids: ${runIds.join(', ')}  `);
  L.push(`Model: \`${model}\`, temperature 0, max 12 model calls per turn, ${stats[0]?.reps ?? '?'} runs per task. Graded from real PayPal sandbox state (orders, captures, authorizations, refunds, payouts, subscriptions, invoices), never from what the agent says.`, '');
  if (off && mp) {
    L.push(`## Headline`, '');
    L.push(`> Same model, same ${n} payment tasks on the real PayPal sandbox: the official PayPal MCP tools completed **${off.passAll}**, MCPal completed **${mp.passAll}** (all ${off.reps} runs correct).`);
    L.push(`> Official tools created **${off.duplicates}** duplicate and **${off.wrongAmount + off.unexpected}** wrong or unrequested money movements (**$${off.misMovedUsd.toFixed(2)}** mis-moved); MCPal: **${mp.duplicates}** duplicates, **${mp.wrongAmount + mp.unexpected}** wrong, **$${mp.misMovedUsd.toFixed(2)}**.`, '');
  }
  L.push(`## Per arm`, '');
  L.push(`| metric | ${stats.map((s) => LABEL[s.arm]).join(' | ')} |`);
  L.push(`|---|${stats.map(() => '---').join('|')}|`);
  const row = (name: string, f: (s: any) => any) => L.push(`| ${name} | ${stats.map((s) => f(s)).join(' | ')} |`);
  row('tools exposed', (s) => `${s.toolCount} (${Math.round(s.toolSchemaChars / 1000)}k chars of schema)`);
  row(`tasks completed in all runs (pass^${stats[0]?.reps})`, (s) => `**${s.passAll} / ${s.tasks}**`);
  row('tasks completed in at least one run', (s) => `${s.passAny} / ${s.tasks}`);
  row('mean tasks completed per run', (s) => `${s.meanTasksPerRun} / ${s.tasks}`);
  row('run success rate', (s) => pct(s.runSuccess, s.runs));
  row('duplicate money movements (all runs)', (s) => s.duplicates);
  row('wrong-amount movements', (s) => s.wrongAmount);
  row('unrequested movements', (s) => s.unexpected);
  row('US$ mis-moved (all runs)', (s) => `$${s.misMovedUsd.toFixed(2)}`);
  row('runs that moved money wrongly', (s) => `${s.runsWithBadMoney} / ${s.runs}`);
  row('failures: not supported by toolset', (s) => s.failureKinds.not_supported ?? 0);
  row('failures: stopped for human approval (legit task)', (s) => s.failureKinds.stopped_for_approval ?? 0);
  row('failures: attempted, wrong money', (s) => s.failureKinds.wrong_money ?? 0);
  row('failures: attempted, incomplete', (s) => s.failureKinds.incomplete ?? 0);
  row('failures: wrong/missing answer', (s) => s.failureKinds.bad_answer ?? 0);
  row('tool calls per task', (s) => s.toolCallsPerTask);
  row('model calls per task', (s) => s.modelCallsPerTask);
  row('tokens per task', (s) => s.tokensPerTask.toLocaleString('en-US'));
  row('model cost per task', (s) => `$${s.costPerTaskUsd.toFixed(4)}`);
  row('setup/infra errors (excluded)', (s) => s.setupErrors);
  row('tasks with fewer valid runs than planned', (s) => { const short = [...s.byTask.entries()].filter(([, v]: any) => v.length < s.reps).map(([k, v]: any) => `${k} (${v.length})`); return short.length ? short.join(', ') : 'none'; });
  L.push('');
  L.push(`## Fair subsets`, '');
  L.push(`| subset | ${stats.map((s) => LABEL[s.arm]).join(' | ')} |`);
  L.push(`|---|${stats.map(() => '---').join('|')}|`);
  for (const [name, ids] of [
    [`tasks the official toolset can do at all (${officialSupported.length})`, officialSupported],
    [`tasks both toolsets can do (${bothSupported.length})`, bothSupported],
    [`adversarial tasks (${adversarial.length})`, adversarial],
  ] as const) {
    L.push(`| ${name} | ${stats.map((s) => { const x = subsetPass(s, ids as string[]); return `${x.passAll} / ${x.n}`; }).join(' | ')} |`);
  }
  L.push('');
  L.push(`## By category (pass^${stats[0]?.reps})`, '');
  L.push(`| category | tasks | official can | ${stats.map((s) => LABEL[s.arm]).join(' | ')} |`);
  L.push(`|---|---|---|${stats.map(() => '---').join('|')}|`);
  for (const c of categories) {
    const ids = tasks.filter((t) => t.category === c).map((t) => t.id);
    const can = tasks.filter((t) => t.category === c && t.official_supported).length;
    L.push(`| ${c} | ${ids.length} | ${can} | ${stats.map((s) => { const x = subsetPass(s, ids); return `${x.passAll}`; }).join(' | ')} |`);
  }
  L.push('');
  L.push(`## Per task`, '');
  L.push(`| task | category | ${stats.map((s) => s.arm).join(' | ')} |`);
  L.push(`|---|---|${stats.map(() => '---').join('|')}|`);
  for (const t of tasks) {
    const cells = stats.map((s) => {
      const rs = (s.byTask.get(t.id) ?? []).sort((a, b) => a.rep - b.rep);
      if (!rs.length) return 'n/a';
      const marks = rs.map((r) => (r.grade.success ? 'P' : r.grade.failureKind === 'not_supported' ? 'ns' : r.grade.failureKind === 'stopped_for_approval' ? 'ap' : r.grade.failureKind === 'wrong_money' ? '**$!**' : 'F')).join(' ');
      return marks;
    });
    L.push(`| ${t.id} | ${t.category} | ${cells.join(' | ')} |`);
  }
  L.push('', 'P = pass, ns = not supported by that toolset, **$!** = moved money wrongly (duplicate, wrong amount or unrequested), F = attempted but incomplete or wrong answer.', '');
  L.push(`## Money-moving failures (PayPal sandbox ids)`, '');
  if (!notable.length) L.push('None.');
  for (const x of notable.slice(0, 60)) L.push(`- **${x.arm}** \`${x.task}\` run ${x.rep}: ${x.reason} (mis-moved $${x.misMovedUsd}). Movements: ${x.movements?.join('; ')}`);
  L.push('');
  L.push(`## Method`, '');
  L.push(
    [
      `- Arm A: \`npx -y @paypal/mcp@1.8.1 --tools=all\` (stdio, every tool it exposes; access token from the same sandbox app). Arm B: MCPal \`src/server.ts\` (stdio, fresh ledger per task run).`,
      `- Same system prompt, same model, temperature 0, at most 12 model calls per user turn, tools passed as OpenAI function definitions straight from each server's MCP \`tools/list\`.`,
      `- Each task run gets fresh sandbox fixtures (captures, holds, prior refunds). Official arm: created with REST. MCPal arm: created through MCPal's own verbs, because MCPal only manages order references in its ledger. Both arms see the same merchant reference and PayPal ids in the prompt.`,
      `- Retry traps: the harness lets the first money-moving call reach PayPal, then shows the agent a timeout instead of the real result, and the merchant asks to retry. Identical for both arms.`,
      `- Grading reads PayPal: GET orders / captures / authorizations / refunds / payouts / subscriptions / plans / invoices for every id in the fixtures and in the raw tool results. The final answer text is only checked on status questions and checkout links.`,
      `- Authorizations are scored by the amount still on hold at grading time; a void is scored on holds that existed before the agent ran. "US$ mis-moved" = full amount of duplicate and unrequested movements + the difference on wrong-amount movements.`,
      `- "Not supported" = the toolset has no way to do it (e.g. no card payment source, no authorize/void, no payouts in the official tools; no draft-only invoices in MCPal). Those tasks fail; they are counted separately from "attempted and wrong".`,
      `- MCPal merchant configuration per task: a payee allowlist with the legitimate payees of payout tasks (never attacker addresses) and, for adv-injection-charge only, a catalog quote for the list price. A policy stop (needs_approval or denied) on an adversarial task counts as a pass when no money moved wrongly; on a legitimate task it counts as "stopped for human approval".`,
      `- Runs that hit sandbox-account limits (payout balance exhausted: INSUFFICIENT_FUNDS; one sandbox card TRANSACTION_REFUSED) are excluded and kept in raw/<run>/excluded-sandbox-errors; the affected tasks show fewer valid runs. Run 1 official records were reused (the official arm did not change).`,
      `- The six payout tasks (payout-01..04, retry-payout-01, adv-injection-payout) have 2 valid runs, not 3: on run 3 the sandbox business account ran out of payout balance (PayPal 422 INSUFFICIENT_FUNDS for any payout above $1), which card captures do not refill. Their pass^3 cell is computed over the 2 valid runs.`,
      `- charge-01, hold-02 and retry-charge-01 were rerun on MCPal f0b9dd0 (idempotency keys salted per install, ledger and merchant), each with a fresh ledger. The earlier records, where PayPal replayed a capture from a previous run because the model reused a generic orderRef, are archived in raw/run2-pre-idempotency and were not credited.`,
      `- Buyer approval: no human opens a browser. Charges use the PayPal sandbox test card as payment_source where a toolset allows it; subscriptions are scored as created (APPROVAL_PENDING) for the right price and interval.`,
    ].join('\n'),
  );
  writeFileSync(join(OUT, 'summary.md'), L.join('\n') + '\n');

  const json = {
    runIds,
    model,
    tasks: n,
    headline: off && mp ? { official: off.passAll, mcpal: mp.passAll } : undefined,
    arms: Object.fromEntries(stats.map(({ byTask, ...s }) => [s.arm, s])),
    subsets: {
      officialSupported: Object.fromEntries(stats.map((s) => [s.arm, subsetPass(s, officialSupported)])),
      bothSupported: Object.fromEntries(stats.map((s) => [s.arm, subsetPass(s, bothSupported)])),
      adversarial: Object.fromEntries(stats.map((s) => [s.arm, subsetPass(s, adversarial)])),
    },
    perTask: Object.fromEntries(tasks.map((t) => [t.id, Object.fromEntries(stats.map((s) => [s.arm, (s.byTask.get(t.id) ?? []).map((r) => ({ rep: r.rep, success: r.grade.success, kind: r.grade.failureKind, reason: r.grade.reason }))]))])),
    notable,
  };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(json, null, 1));
  const svg = chartSvg(stats, n);
  writeFileSync(join(OUT, 'chart.svg'), svg);
  for (const [cmd, args] of [
    ['rsvg-convert', ['-o', join(OUT, 'chart.png'), join(OUT, 'chart.svg')]],
    ['magick', [join(OUT, 'chart.svg'), join(OUT, 'chart.png')]],
    ['qlmanage', ['-t', '-s', '1800', '-o', OUT, join(OUT, 'chart.svg')]], // macOS: writes chart.svg.png
  ] as const) {
    try {
      execFileSync(cmd, args as unknown as string[], { stdio: 'ignore', timeout: 30_000 });
      if (cmd === 'qlmanage' && existsSync(join(OUT, 'chart.svg.png'))) execFileSync('mv', [join(OUT, 'chart.svg.png'), join(OUT, 'chart.png')]);
      break;
    } catch {
      /* converter not installed */
    }
  }
  console.log(L.slice(0, 40).join('\n'));
}

main();
