import Link from "next/link";
import { benchChartSvg, failedTasks, shortTasks, usd, type BenchSummary } from "@/lib/data";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

export function modelName(s: BenchSummary): string {
  return s.model.replace(/^openai\//, "");
}

/** Headline numbers, chart and the caveats, all read from bench/results/summary.json. */
export function BenchHeadline({ s, full = false }: { s: BenchSummary; full?: boolean }) {
  const o = s.arms.official!;
  const m = s.arms.mcpal!;
  const adv = s.subsets?.adversarial;
  const sup = s.subsets?.officialSupported;
  const chart = benchChartSvg();
  const stats: { label: string; o: string; m: string }[] = [
    { label: `Tasks correct in all ${m.reps} runs`, o: `${o.passAll}/${o.tasks}`, m: `${m.passAll}/${m.tasks}` },
    { label: "Run success rate", o: pct(o.successRate), m: pct(m.successRate) },
    { label: "Duplicate money movements", o: String(o.duplicates), m: String(m.duplicates) },
    { label: "US$ moved wrongly", o: usd(o.misMovedUsd), m: usd(m.misMovedUsd) },
    ...(adv ? [{ label: "Adversarial tasks blocked", o: `${adv.official!.passAll}/${adv.official!.n}`, m: `${adv.mcpal!.passAll}/${adv.mcpal!.n}` }] : []),
    { label: "Tokens per task", o: k(o.tokensPerTask), m: k(m.tokensPerTask) },
  ];
  const short = shortTasks(s, "mcpal");
  const mFail = failedTasks(s, "mcpal");

  return (
    <>
      <p className="lede" style={{ fontSize: 17 }}>
        Same model ({modelName(s)}, temperature 0), same {s.tasks} payment tasks, {m.reps} runs each. Graded from PayPal&apos;s own records, never
        from what the agent says.
      </p>
      <div className="bench">
        {stats.map((x) => (
          <div className="stat" key={x.label}>
            <div className="k">{x.label}</div>
            <div className="v">
              {x.m} <small>MCPal</small>
            </div>
            <div className="small">Official PayPal MCP: {x.o}</div>
          </div>
        ))}
      </div>
      {chart && (
        <div className="chart" role="img" aria-label="Benchmark chart: official PayPal MCP versus MCPal" dangerouslySetInnerHTML={{ __html: chart }} />
      )}
      <ul className="fine">
        {sup && (
          <li>
            Tasks the official toolkit cannot do at all (no card payment source, holds or payouts) count as failures, labelled &ldquo;not supported&rdquo;. On the{" "}
            {sup.official!.n} tasks it can do: official {sup.official!.passAll}/{sup.official!.n}, MCPal {sup.mcpal!.passAll}/{sup.mcpal!.n}.
          </li>
        )}
        {mFail.length > 0 && (
          <li>
            MCPal&apos;s {mFail.length === 1 ? "only failure is" : "failures are"}{" "}
            {mFail.map((f, i) => (
              <span key={f.task}>
                {i ? "; " : ""}
                <code>{f.task}</code> ({f.reason})
              </span>
            ))}
            .
          </li>
        )}
        {short.length > 0 && (
          <li>
            {short.length} payout tasks have {short[0]!.runs} valid runs instead of {m.reps}: the business account ran out of payout balance. Their result is
            computed over the valid runs.
          </li>
        )}
      </ul>
      {!full && (
        <p>
          <Link className="btn ghost" href="/benchmark">
            Method, per-category results and PayPal ids
          </Link>
        </p>
      )}
    </>
  );
}
