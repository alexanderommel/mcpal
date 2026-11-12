import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { BenchHeadline, modelName } from "@/components/Bench";
import { BenchGrid, type BenchGridRow } from "@/components/BenchGrid";
import { GITHUB_URL, Nav } from "@/components/Nav";
import { SecondModel } from "@/components/SecondModel";
import { benchPreFix, benchSummary, benchTasks, usd, type BenchArm, type BenchSummary, type Notable } from "@/lib/data";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Benchmark — MCPal",
  description: "Official PayPal MCP tools vs MCPal: same model, same payment tasks, graded on the real PayPal sandbox.",
};

/** The Method bullets from bench/results/summary.md, so the page says exactly what the report says. */
function methodBullets(): string[] {
  const p = join(process.cwd(), "..", "bench/results/summary.md");
  if (!existsSync(p)) return [];
  const md = readFileSync(p, "utf8");
  const sec = md.split(/\n## Method\n/)[1]?.split(/\n## /)[0] ?? "";
  return sec
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

/** Inline `code` and **bold** from the markdown bullets. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

function armRows(o: BenchArm, m: BenchArm): [string, string, string][] {
  const fk = (a: BenchArm, key: string) => String(a.failureKinds?.[key] ?? 0);
  return [
    ["tools exposed", `${o.toolCount} (${Math.round(o.toolSchemaChars / 1000)}k chars of schema)`, `${m.toolCount} (${Math.round(m.toolSchemaChars / 1000)}k chars of schema)`],
    [`tasks correct in all runs`, `${o.passAll} / ${o.tasks}`, `${m.passAll} / ${m.tasks}`],
    ["tasks correct in at least one run", `${o.passAny} / ${o.tasks}`, `${m.passAny} / ${m.tasks}`],
    ["mean tasks correct per run", `${o.meanTasksPerRun} / ${o.tasks}`, `${m.meanTasksPerRun} / ${m.tasks}`],
    ["run success rate", `${Math.round(o.successRate * 100)}%`, `${Math.round(m.successRate * 100)}%`],
    ["duplicate money movements", String(o.duplicates), String(m.duplicates)],
    ["wrong-amount movements", String(o.wrongAmount), String(m.wrongAmount)],
    ["unrequested movements", String(o.unexpected), String(m.unexpected)],
    ["US$ moved wrongly", usd(o.misMovedUsd), usd(m.misMovedUsd)],
    ["runs that moved money wrongly", `${o.runsWithBadMoney} / ${o.runs}`, `${m.runsWithBadMoney} / ${m.runs}`],
    ["failed runs: not supported by the toolset", fk(o, "not_supported"), fk(m, "not_supported")],
    ["failed runs: attempted, incomplete", fk(o, "incomplete"), fk(m, "incomplete")],
    ["failed runs: attempted, wrong money", fk(o, "wrong_money"), fk(m, "wrong_money")],
    ["tool calls per task", String(o.toolCallsPerTask), String(m.toolCallsPerTask)],
    ["model calls per task", String(o.modelCallsPerTask), String(m.modelCallsPerTask)],
    ["tokens per task", o.tokensPerTask.toLocaleString("en-US"), m.tokensPerTask.toLocaleString("en-US")],
    ["model cost per task", `$${o.costPerTaskUsd.toFixed(4)}`, `$${m.costPerTaskUsd.toFixed(4)}`],
  ];
}

function byCategory(s: BenchSummary) {
  const tasks = benchTasks().filter((t) => t.id in s.perTask);
  const op = new Set(s.arms.official!.passAllIds);
  const mp = new Set(s.arms.mcpal!.passAllIds);
  const cats: { cat: string; n: number; can: number; o: number; m: number }[] = [];
  for (const t of tasks) {
    let c = cats.find((x) => x.cat === t.category);
    if (!c) cats.push((c = { cat: t.category, n: 0, can: 0, o: 0, m: 0 }));
    c.n++;
    if (t.officialSupported) c.can++;
    if (op.has(t.id)) c.o++;
    if (mp.has(t.id)) c.m++;
  }
  return cats;
}

/** Every task × toolset for the grid: result over all runs, failure kind, wrong movements with sandbox ids, grader reason. */
function gridRows(s: BenchSummary): BenchGridRow[] {
  const tasks = benchTasks();
  const meta = new Map(tasks.map((t) => [t.id, t]));
  const ids = [...tasks.map((t) => t.id).filter((id) => id in s.perTask), ...Object.keys(s.perTask).filter((id) => !meta.has(id))];
  const out: BenchGridRow[] = [];
  for (const id of ids) {
    const t = meta.get(id);
    for (const arm of ["official", "mcpal"] as const) {
      const runs = s.perTask[id]?.[arm] ?? [];
      const ok = runs.filter((r) => r.success).length;
      const bad = s.notable.filter((n) => n.arm === arm && n.task === id);
      const fail = runs.find((r) => !r.success);
      out.push({
        id: `${id}|${arm}`,
        category: t?.category ?? "other",
        task: id,
        toolset: arm === "mcpal" ? "MCPal" : "Official PayPal MCP",
        officialCan: t?.officialSupported ?? true,
        result: runs.length && ok === runs.length ? "pass" : ok > 0 ? "flaky" : "fail",
        passed: `${ok} / ${runs.length}`,
        failureKind: fail?.kind ?? "",
        wrongMovements: bad.length,
        misMovedUsd: Math.round(bad.reduce((a, n) => a + n.misMovedUsd, 0) * 100) / 100,
        sandboxIds: bad.map((n) => `run ${n.rep}: ${n.movements.join("; ")}`).join(" | "),
        reason: fail ? [...new Set(runs.filter((r) => !r.success).map((r) => r.reason))].join(" / ") : "ok",
        prompt: t?.prompt ?? "",
      });
    }
  }
  return out;
}

function groupByTask(rows: Notable[]): { task: string; runs: Notable[] }[] {
  const out: { task: string; runs: Notable[] }[] = [];
  for (const r of rows) {
    const g = out.find((x) => x.task === r.task);
    if (g) g.runs.push(r);
    else out.push({ task: r.task, runs: [r] });
  }
  return out;
}

function NotableTable({ rows }: { rows: Notable[] }) {
  return (
    <div className="scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Task</th>
            <th>Run</th>
            <th>What happened</th>
            <th>Mis-moved</th>
            <th>PayPal movements</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={`${n.task}-${n.rep}`}>
              <td className="mono">{n.task}</td>
              <td>{n.rep}</td>
              <td>{n.reason}</td>
              <td>{usd(n.misMovedUsd)}</td>
              <td className="mono" style={{ fontSize: 12 }}>
                {n.movements.map((mv) => (
                  <div key={mv}>{mv}</div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BenchmarkPage() {
  const s = benchSummary();
  const pre = benchPreFix();
  const method = methodBullets();

  return (
    <>
      <Nav current="benchmark" />
      <main className="wrap">
        <div style={{ padding: "28px 0 8px" }}>
          <div className="eyebrow">Benchmark{s ? ` · run ${s.runIds.join(", ")}` : ""}</div>
          <h1 className="page-h1">Official PayPal MCP vs MCPal</h1>
        </div>
        {!s ? (
          <div className="pending">Benchmark running. Results will appear here when the full run is finished.</div>
        ) : (
          <>
            <BenchHeadline s={s} full />

            <section>
              <h2>Per toolset</h2>
              <div className="scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Official PayPal MCP</th>
                      <th>MCPal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {armRows(s.arms.official!, s.arms.mcpal!).map(([l, o, m]) => (
                      <tr key={l}>
                        <td>{l}</td>
                        <td>{o}</td>
                        <td>
                          <b>{m}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2>By category</h2>
              <p className="sub">Tasks correct in all runs. &ldquo;Official can&rdquo; is how many tasks in the category the official toolkit has the tools for at all.</p>
              <div className="scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Tasks</th>
                      <th>Official can</th>
                      <th>Official PayPal MCP</th>
                      <th>MCPal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCategory(s).map((c) => (
                      <tr key={c.cat}>
                        <td>{c.cat.replace(/_/g, " ")}</td>
                        <td>{c.n}</td>
                        <td>{c.can}</td>
                        <td>{c.o}</td>
                        <td>
                          <b>{c.m}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {s.subsets && (
                <p className="small">
                  Fair subsets: on the {s.subsets.officialSupported?.official?.n} tasks the official toolkit can do, official {s.subsets.officialSupported?.official?.passAll}, MCPal{" "}
                  {s.subsets.officialSupported?.mcpal?.passAll}. Adversarial tasks: official {s.subsets.adversarial?.official?.passAll}/{s.subsets.adversarial?.official?.n}, MCPal{" "}
                  {s.subsets.adversarial?.mcpal?.passAll}/{s.subsets.adversarial?.mcpal?.n}.
                </p>
              )}
            </section>

            <section>
              <h2>Every task, both toolsets</h2>
              <p className="sub">
                All {s.tasks} tasks for each toolset: result over all runs, why the grader failed it, and every wrong money movement with its PayPal ids.
              </p>
              <BenchGrid rows={gridRows(s)} />
            </section>

            <section>
              <h2>Money moved wrongly, with PayPal ids</h2>
              <p className="sub">
                Every wrong movement in the final run. Each id can be looked up in PayPal. In the retry traps the harness hides the first result behind a
                timeout and the merchant asks to retry; the official tools refund a second time.
              </p>
              {s.notable.length ? <NotableTable rows={s.notable} /> : <p>None.</p>}
            </section>

            {pre && (
              <section>
                <h2>Before and after: MCPal&apos;s first version</h2>
                <p className="sub">
                  The first MCPal version ran the same {pre.tasks} tasks with the same model. The benchmark found these failures; each one was fixed in the verbs, the
                  policy or the tool descriptions, and the run above is the fixed version.
                </p>
                <div className="bench">
                  <div className="stat">
                    <div className="k">Tasks correct in all runs</div>
                    <div className="v">
                      {pre.arms.mcpal!.passAll} → {s.arms.mcpal!.passAll} <small>of {s.tasks}</small>
                    </div>
                  </div>
                  <div className="stat">
                    <div className="k">US$ moved wrongly</div>
                    <div className="v">
                      {usd(pre.arms.mcpal!.misMovedUsd)} → {usd(s.arms.mcpal!.misMovedUsd)}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="k">Runs that moved money wrongly</div>
                    <div className="v">
                      {pre.arms.mcpal!.runsWithBadMoney} → {s.arms.mcpal!.runsWithBadMoney}
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 16 }}>
                  <NotableTable rows={groupByTask(pre.notable.filter((n) => n.arm === "mcpal")).flatMap((g) => g.runs)} />
                </div>
              </section>
            )}

            <SecondModel />

            {method.length > 0 && (
              <section>
                <h2>Method</h2>
                <ul className="method">
                  {method.map((b, i) => (
                    <li key={i}>
                      <Inline text={b} />
                    </li>
                  ))}
                </ul>
                <p className="small">
                  Model: {modelName(s)}. Full report, per-task grid and raw transcripts: <code>bench/results/</code> in the <a href={GITHUB_URL}>repository</a>.
                </p>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
