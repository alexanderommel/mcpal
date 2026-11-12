import type { BenchSummary } from "@/lib/data";

export function LineIcon({
  kind = "shield",
}: {
  kind?: "shield" | "retry" | "person" | "refund" | "lock" | "log";
}) {
  const paths = {
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    retry: (
      <>
        <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
        <path d="M12 8v5l3 2" />
      </>
    ),
    person: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3m1-9 2 2 4-5" />
      </>
    ),
    refund: (
      <>
        <path d="M4 8h11a6 6 0 0 1 0 12h-3M4 8l5-5M4 8l5 5" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
      </>
    ),
    log: (
      <>
        <path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h5" />
      </>
    ),
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[kind]}
    </svg>
  );
}

export function ArchitectureDiagram({ verbs }: { verbs: string[] }) {
  const rows = Array.from({ length: Math.ceil(verbs.length / 2) }, (_, i) =>
    verbs.slice(i * 2, i * 2 + 2),
  );
  return (
    <div className="architecture-visual">
      <svg
        className="architecture-svg"
        viewBox="0 0 1120 360"
        role="img"
        aria-labelledby="architecture-title architecture-description"
      >
        <title id="architecture-title">Where MCPal sits</title>
        <desc id="architecture-description">
          Your AI agent sends one verb per intent to MCPal. Idempotency,
          approval rules, merchant quotes and a signed log wrap the ordered
          calls to PayPal REST APIs.
        </desc>
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path
              d="m1 1 7 4-7 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </marker>
        </defs>
        <rect
          x="1"
          y="80"
          width="238"
          height="220"
          rx="12"
          className="diagram-box"
        />
        <text x="25" y="116" className="diagram-kicker">
          01 / YOUR CLIENT
        </text>
        <text x="25" y="156" className="diagram-title">
          Your AI agent
        </text>
        <text x="25" y="197" className="diagram-copy">
          Claude · Cursor
        </text>
        <text x="25" y="225" className="diagram-copy">
          ChatGPT · your code
        </text>
        <text x="25" y="274" className="diagram-mono">
          Streamable HTTP / MCP
        </text>
        <path
          d="M240 188h120"
          className="diagram-arrow"
          markerEnd="url(#flow-arrow)"
        />
        <text x="300" y="150" textAnchor="middle" className="diagram-label">
          <tspan x="300">one verb</tspan>
          <tspan x="300" dy="18">
            per intent
          </tspan>
        </text>
        <rect
          x="371"
          y="32"
          width="365"
          height="308"
          rx="12"
          className="diagram-core"
        />
        <text x="397" y="70" className="diagram-kicker">
          02 / THE INTENT LAYER
        </text>
        <text x="397" y="112" className="diagram-title">
          MCPal
        </text>
        {rows.map((row, i) => (
          <text key={i} x="397" y={150 + i * 27} className="diagram-verb">
            {row.join("  ·  ")}
          </text>
        ))}
        <path d="M397 255h313" className="diagram-rule" />
        {["idempotency", "approval rules", "merchant quotes", "signed log"].map(
          (label, i) => (
            <g
              key={label}
              transform={`translate(${397 + (i % 2) * 162} ${273 + Math.floor(i / 2) * 27})`}
            >
              <path
                d="m0 0 6-2 6 2v5c0 5-6 8-6 8S0 10 0 5Z"
                className="diagram-shield"
              />
              <text x="20" y="9" className="diagram-small">
                {label}
              </text>
            </g>
          ),
        )}
        <path
          d="M737 188h118"
          className="diagram-arrow"
          markerEnd="url(#flow-arrow)"
        />
        <text x="796" y="150" textAnchor="middle" className="diagram-label">
          <tspan x="796">the right PayPal</tspan>
          <tspan x="796" dy="18">
            calls, in order
          </tspan>
        </text>
        <rect
          x="867"
          y="80"
          width="252"
          height="220"
          rx="12"
          className="diagram-box"
        />
        <text x="891" y="116" className="diagram-kicker">
          03 / THE PAYMENT RAILS
        </text>
        <text x="891" y="156" className="diagram-title">
          PayPal REST APIs
        </text>
        <text x="891" y="197" className="diagram-copy">
          Orders v2 · Payments v2
        </text>
        <text x="891" y="225" className="diagram-copy">
          Payouts · Invoicing
        </text>
        <text x="891" y="253" className="diagram-copy">
          Subscriptions · Webhooks
        </text>
      </svg>
      <div className="architecture-mobile">
        <div>
          <span>01 / YOUR CLIENT</span>
          <h3>Your AI agent</h3>
          <p>Claude · Cursor · ChatGPT · your code</p>
        </div>
        <p className="mobile-flow">
          ↓ <span>one verb per intent</span>
        </p>
        <div className="mobile-core">
          <span>02 / THE INTENT LAYER</span>
          <h3>MCPal</h3>
          <p className="mono">{verbs.join(" · ")}</p>
          <p className="mobile-shields">
            <LineIcon /> idempotency · approval rules
            <br />
            merchant quotes · signed log
          </p>
        </div>
        <p className="mobile-flow">
          ↓ <span>the right PayPal calls, in order</span>
        </p>
        <div>
          <span>03 / THE PAYMENT RAILS</span>
          <h3>PayPal REST APIs</h3>
          <p>
            Orders v2 · Payments v2 · Payouts
            <br />
            Invoicing · Subscriptions · Webhooks
          </p>
        </div>
      </div>
    </div>
  );
}

export function BenchmarkChart({ summary }: { summary: BenchSummary }) {
  const supported = summary.subsets?.officialSupported,
    m = summary.arms.mcpal,
    o = summary.arms.official;
  const groups = [
    ...(supported?.mcpal && supported.official
      ? [
          {
            title: `${supported.official.n} tasks the official toolkit can attempt`,
            total: supported.official.n,
            m: supported.mcpal.passAll,
            o: supported.official.passAll,
          },
        ]
      : []),
    {
      title: `All ${summary.tasks} tasks`,
      total: summary.tasks,
      m: m.passAll,
      o: o.passAll,
    },
  ];
  const plot = 690;
  return (
    <div className="benchmark-visual">
      <div className="chart-legend">
        <span>
          <i className="legend-mcpal" /> MCPal
        </span>
        <span>
          <i className="legend-official" /> PayPal Agent Toolkit
        </span>
        <small>Tasks correct in every run</small>
      </div>
      {groups.map((g) => (
        <div className="chart-group" key={g.title}>
          <h3>{g.title}</h3>
          <div className="mobile-chart-bars">
            {[
              { name: "MCPal", value: g.m, cls: "mcpal" },
              { name: "Agent Toolkit", value: g.o, cls: "official" },
            ].map((bar) => (
              <div key={bar.name}>
                <div>
                  <span>{bar.name}</span>
                  <code>
                    {bar.value}/{g.total}
                  </code>
                </div>
                <span className="mobile-chart-track">
                  <i
                    className={bar.cls}
                    style={{
                      width: `${(bar.value / Math.max(g.total, 1)) * 100}%`,
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
          <svg
            className="desktop-chart-svg"
            viewBox="0 0 920 104"
            role="img"
            aria-label={`${g.title}: MCPal ${g.m} of ${g.total}; Agent Toolkit ${g.o} of ${g.total}.`}
          >
            <line x1="150" y1="0" x2="150" y2="104" className="chart-rule" />
            <text x="0" y="31" className="chart-label">
              MCPal
            </text>
            <rect
              x="150"
              y="8"
              width={(g.m / Math.max(g.total, 1)) * plot}
              height="32"
              rx="3"
              className="chart-mcpal"
            />
            <text
              x={162 + (g.m / Math.max(g.total, 1)) * plot}
              y="31"
              className="chart-value"
            >
              {g.m}/{g.total}
            </text>
            <text x="0" y="83" className="chart-label">
              Agent Toolkit
            </text>
            <rect
              x="150"
              y="60"
              width={(g.o / Math.max(g.total, 1)) * plot}
              height="32"
              rx="3"
              className="chart-official"
            />
            <text
              x={162 + (g.o / Math.max(g.total, 1)) * plot}
              y="83"
              className="chart-value"
            >
              {g.o}/{g.total}
            </text>
          </svg>
        </div>
      ))}
      <div className="duplicate-chart">
        <div>
          <span className="eyebrow-s">Retries, measured</span>
          <h3>Duplicate payments</h3>
          <p>Lower is better.</p>
        </div>
        <svg
          viewBox="0 0 600 104"
          role="img"
          aria-label={`Duplicate payments: MCPal ${m.duplicates}; Agent Toolkit ${o.duplicates}.`}
        >
          <text x="0" y="31" className="chart-label">
            MCPal
          </text>
          <rect
            x="150"
            y="8"
            width={
              (m.duplicates / Math.max(m.duplicates, o.duplicates, 1)) * 370
            }
            height="32"
            rx="3"
            className="chart-mcpal"
          />
          <circle cx="150" cy="24" r="3" className="chart-mcpal" />
          <text
            x={
              162 +
              (m.duplicates / Math.max(m.duplicates, o.duplicates, 1)) * 370
            }
            y="31"
            className="chart-value"
          >
            {m.duplicates}
          </text>
          <text x="0" y="83" className="chart-label">
            Agent Toolkit
          </text>
          <rect
            x="150"
            y="60"
            width={
              (o.duplicates / Math.max(m.duplicates, o.duplicates, 1)) * 370
            }
            height="32"
            rx="3"
            className="chart-official"
          />
          <text
            x={
              162 +
              (o.duplicates / Math.max(m.duplicates, o.duplicates, 1)) * 370
            }
            y="83"
            className="chart-value"
          >
            {o.duplicates}
          </text>
        </svg>
      </div>
    </div>
  );
}
