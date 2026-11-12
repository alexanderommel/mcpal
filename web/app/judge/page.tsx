import type { Metadata } from "next";
import { JudgeConsole } from "@/components/JudgeConsole";
import { Nav } from "@/components/Nav";
import { AMOUNT_CAP, JUDGE_POLICY, MODEL, PRESETS } from "@/lib/agent";
import { RUNS_PER_HOUR } from "@/lib/ratelimit";

export const metadata: Metadata = {
  title: "Judge console — MCPal",
  description: "Give an AI agent a business request and watch it move money through PayPal with MCPal.",
  robots: { index: false },
};

export default function JudgePage() {
  return (
    <>
      <Nav current="judge" />
      <main className="wrap">
        <div style={{ paddingTop: 28 }}>
          <div className="eyebrow">Judge console</div>
          <p className="lede" style={{ margin: "8px 0 12px" }}>
            An AI agent ({MODEL}, temperature 0) gets your request and only MCPal&apos;s tools. Each tool call runs the real MCPal server, which calls
            PayPal. Policy for this demo: a human approves anything over ${JUDGE_POLICY.approval_threshold} and every payout to a recipient never paid before (the
            regular courier is pre-approved); daily cap $
            {JUDGE_POLICY.daily_cap}; refunds above ${JUDGE_POLICY.refund_ceiling} need approval.
          </p>
        </div>
        <JudgeConsole presets={PRESETS} runsPerHour={RUNS_PER_HOUR} amountCap={AMOUNT_CAP} />
      </main>
    </>
  );
}
