import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One toolset's numbers for one model, as bench/report.ts --models writes them. */
interface ModelArm {
  tasks: number;
  runs: number;
  reps: number;
  tasksCorrect: number;
  duplicates: number;
  wrongAmount: number;
  unexpected: number;
  misMovedUsd: number;
  runsWithBadMoney: number;
  adversarial: { n: number; passAll: number };
}

interface ModelsJson {
  tasks: number;
  models: { runId: string; model: string; provider: string; reps: number; arms: Record<string, { pass1: ModelArm; allRuns?: ModelArm }> }[];
}

function readModels(): ModelsJson | undefined {
  const p = join(process.cwd(), "..", "bench/results/models.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as ModelsJson;
    return j.models?.length > 1 ? j : undefined;
  } catch {
    return undefined;
  }
}

const usd = (x: number) => `$${x.toFixed(2)}`;

/** "Second model" block: the same 50 tasks with another model family, read from bench/results/models.json (run 1 of every task). */
export function SecondModel() {
  const j = readModels();
  if (!j) return null;
  const rows = j.models.flatMap((m) =>
    (["official", "mcpal"] as const).map((arm) => ({ key: `${m.runId}-${arm}`, model: m.model.replace(/^.*\//, ""), arm, s: m.arms[arm]?.pass1 })),
  );
  return (
    <section>
      <h2>Second model</h2>
      <p className="sub">
        The same {j.tasks} tasks, prompt and step budget with a second model from a different family, to check the result is not specific to one model. Run 1 of every
        task for each model (pass^1), so models with different numbers of runs are compared on the same footing.
      </p>
      <div className="scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Model</th>
              <th>Toolset</th>
              <th>Tasks correct</th>
              <th>Duplicates</th>
              <th>Wrong amount</th>
              <th>Unrequested</th>
              <th>US$ moved wrongly</th>
              <th>Adversarial correct</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, model, arm, s }) =>
              s ? (
                <tr key={key}>
                  <td className="mono">{model}</td>
                  <td>{arm === "mcpal" ? <b>MCPal</b> : "Official PayPal MCP"}</td>
                  <td>
                    {s.tasksCorrect} / {s.tasks}
                  </td>
                  <td>{s.duplicates}</td>
                  <td>{s.wrongAmount}</td>
                  <td>{s.unexpected}</td>
                  <td>{usd(s.misMovedUsd)}</td>
                  <td>
                    {s.adversarial.passAll} / {s.adversarial.n}
                  </td>
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      </div>
      <p className="small">
        Full table, including every-run (pass^k) numbers where a model has more than one run: <code>bench/results/models.md</code>.
      </p>
    </section>
  );
}
