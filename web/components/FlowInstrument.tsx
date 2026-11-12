"use client";
import { useState } from "react";
import { LineIcon } from "./LandingVisuals";

const FLOWS = [
  {
    name: "01  Deposit & hold",
    intent:
      "Take a $40 deposit on order 1042. Hold the remaining $80 until delivery.",
    verb: "hold",
    payload: 'orderRef: "order-1042"\namount: "120.00"\ndeposit: "40.00"',
    rule: "Policy checked",
    detail: "Within the merchant’s limits",
    status: "DEPOSIT CAPTURED",
    amount: "$40.00",
    balance: "$80.00 authorized",
    id: "7KX09366PL2471934",
    rail: "Orders v2 → Payments v2",
    note: "One intent becomes the right API calls, in order.",
  },
  {
    name: "02  Retry safely",
    intent: "That request timed out. Take the $40 deposit on order 1042 again.",
    verb: "hold",
    payload: 'orderRef: "order-1042"\namount: "120.00"\ndeposit: "40.00"',
    rule: "Existing intent found",
    detail: "Same order, verb and amount",
    status: "FIRST RESULT REPLAYED",
    amount: "$0.00",
    balance: "additional money moved",
    id: "7KX09366PL2471934",
    rail: "Idempotency → original result",
    note: "Same intent. Same capture ID. No second payment.",
  },
  {
    name: "03  Ask a human",
    intent:
      "Pay a new courier $6.25 for today’s delivery. They are not on our allowlist.",
    verb: "pay_out",
    payload:
      'orderRef: "courier-0412"\namount: "6.25"\nrecipient: "new-courier"',
    rule: "Human approval required",
    detail: "New recipient · not on allowlist",
    status: "STOPPED BEFORE PAYPAL",
    amount: "$0.00",
    balance: "sent until you approve",
    id: null,
    rail: "Policy gate → merchant approval",
    note: "The model asks. Your payment rules decide.",
  },
];
export function FlowInstrument() {
  const [index, setIndex] = useState(0),
    flow = FLOWS[index];
  return (
    <figure
      className="flow-instrument"
      aria-label="Interactive illustration of MCPal payment controls"
    >
      <figcaption className="flow-toolbar">
        <div
          className="flow-tabs"
          role="tablist"
          aria-label="Explore payment controls"
        >
          {FLOWS.map((f, i) => (
            <button
              key={f.name}
              type="button"
              role="tab"
              id={`flow-tab-${i}`}
              aria-controls="flow-panel"
              aria-selected={index === i}
              onClick={() => setIndex(i)}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? FLOWS.length - 1
                      : (index +
                          (e.key === "ArrowRight" ? 1 : -1) +
                          FLOWS.length) %
                        FLOWS.length;
                setIndex(next);
                document.getElementById(`flow-tab-${next}`)?.focus();
              }}
            >
              {f.name}
            </button>
          ))}
        </div>
        <span className="flow-offline">
          <i /> INTERACTIVE EXAMPLE
        </span>
      </figcaption>
      <div
        className="flow-body"
        id="flow-panel"
        role="tabpanel"
        aria-labelledby={`flow-tab-${index}`}
        key={index}
      >
        <div className="flow-intent">
          <span className="flow-label">INPUT / YOUR AGENT</span>
          <div className="agent-glyph" aria-hidden="true">
            <svg viewBox="0 0 48 48">
              <path d="m16 10-9 14 9 14m16-28 9 14-9 14M27 7l-6 34" />
            </svg>
          </div>
          <p>“{flow.intent}”</p>
          <div className="flow-client-name">
            <span /> Claude · Cursor · your code
          </div>
        </div>
        <div className="flow-engine">
          <span className="flow-label">EXECUTION / MCPAL</span>
          <div className="flow-engine-heading">
            <span className="flow-orb" aria-hidden="true">
              <svg viewBox="0 0 64 64">
                <path d="M12 18h14l12 28h14M12 46h14l12-28h14" />
                <circle cx="12" cy="18" r="3" />
                <circle cx="52" cy="46" r="3" />
                <circle cx="12" cy="46" r="3" />
                <circle cx="52" cy="18" r="3" />
              </svg>
            </span>
            <span>
              Intent in.
              <br />
              <b>Guardrails on.</b>
            </span>
          </div>
          <div className="flow-code">
            <div>
              <code>{flow.verb}</code>
              <span>→</span>
            </div>
            <pre>{flow.payload}</pre>
          </div>
          <div className="flow-gate">
            <LineIcon
              kind={index === 2 ? "person" : index === 1 ? "retry" : "shield"}
            />
            <div>
              <strong>{flow.rule}</strong>
              <span>{flow.detail}</span>
            </div>
            <span className="gate-indicator" />
          </div>
        </div>
        <div className="flow-output">
          <span className="flow-label">OUTPUT / PAYPAL SANDBOX</span>
          <div className="flow-output-state">{flow.status}</div>
          <strong className="flow-amount">{flow.amount}</strong>
          <p className="flow-balance">{flow.balance}</p>
          <div className="flow-provider">
            <LineIcon kind={index === 2 ? "lock" : "log"} />
            <div>
              <span>
                {flow.id
                  ? "CAPTURE ID · ILLUSTRATIVE"
                  : "NO PAYMENT REQUEST SENT"}
              </span>
              <code>{flow.id || "Waiting for the merchant"}</code>
            </div>
          </div>
          <div className="flow-rail">{flow.rail}</div>
        </div>
        <svg
          className="flow-connector connector-one"
          viewBox="0 0 80 40"
          aria-hidden="true"
        >
          <path d="M0 20h80" />
          <circle cx="40" cy="20" r="3" />
        </svg>
        <svg
          className="flow-connector connector-two"
          viewBox="0 0 80 40"
          aria-hidden="true"
        >
          <path d="M0 20h80" />
          <circle cx="40" cy="20" r="3" />
        </svg>
      </div>
      <div className="flow-bottom">
        <span>
          <i /> {flow.note}
        </span>
        <span>Illustration only · No API calls</span>
      </div>
    </figure>
  );
}
