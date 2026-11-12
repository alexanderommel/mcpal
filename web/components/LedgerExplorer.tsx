"use client";
// Decision log explorer: every MCPal decision for this browser's demo key (hosted remote MCP) and its
// judge-console session, in an AG Grid Community grid. The hash chain is re-verified in the browser.
import type { ColDef, GridApi, GridReadyEvent, GridSizeChangedEvent, ICellRendererParams, RowClickedEvent, ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mcpalGridTheme } from "./agTheme";
import { useDemoKey } from "./DemoKey";
import { rowsFromLog, rowsFromProof, type ChainCheck, type LedgerRow, type LedgerSource } from "@/lib/ledgerRows";

const JUDGE_STORE = "mcpal-judge-v1";
const DECISIONS = ["moved", "allowed", "replayed", "needs_approval", "denied", "error", "approved", "rejected"] as const;
type Proof = { run: string; at: string; proof: Record<string, any> };

interface OrderRow {
  orderRef: string;
  source: LedgerSource;
  decisions: number;
  lastState: string;
  lastAt: string;
  captured: number;
  paidOut: number;
  refunded: number;
  held: number;
  stopped: number;
  stops: number;
  replays: number;
  orderId: string;
}

const usd = (n: number | null | undefined) => (n ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "");
const moneyFmt = (p: ValueFormatterParams) => usd(p.value as number);
const timeFmt = (p: ValueFormatterParams) => {
  if (!p.value) return "";
  const d = new Date(String(p.value));
  return Number.isNaN(d.getTime()) ? String(p.value) : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

function pillClass(d: string): string {
  if (d === "moved" || d === "approved") return "pill";
  if (d === "needs_approval" || d === "replayed") return "pill warn";
  if (d === "denied" || d === "error" || d === "rejected") return "pill bad";
  return "pill neutral";
}

function DecisionCell(p: ICellRendererParams) {
  if (!p.value || p.node.rowPinned) return <b>{p.value}</b>;
  return <span className={pillClass(String(p.value))}>{String(p.value).replace("_", " ")}</span>;
}

function ChainCell(p: ICellRendererParams<LedgerRow>) {
  if (p.node.rowPinned || !p.data) return null;
  const c = p.data.chain;
  return <span className={c === "verified" ? "pill" : c === "broken" ? "pill bad" : "pill neutral"}>{c === "sample" ? "sample" : c}</span>;
}

const sumKeys = ["captured", "paidOut", "refunded", "held", "stopped"] as const;

function totals<T extends Record<(typeof sumKeys)[number], number>>(rows: T[]) {
  const t = { captured: 0, paidOut: 0, refunded: 0, held: 0, stopped: 0 };
  for (const r of rows) for (const k of sumKeys) t[k] += r[k] || 0;
  for (const k of sumKeys) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

function ordersOf(rows: LedgerRow[]): OrderRow[] {
  const map = new Map<string, OrderRow>();
  for (const r of rows) {
    const k = `${r.source}|${r.orderRef}`;
    let o = map.get(k);
    if (!o) map.set(k, (o = { orderRef: r.orderRef || "(none)", source: r.source, decisions: 0, lastState: "", lastAt: "", captured: 0, paidOut: 0, refunded: 0, held: 0, stopped: 0, stops: 0, replays: 0, orderId: "" }));
    o.decisions++;
    if (r.verb !== "status" && r.state) o.lastState = r.state;
    o.lastAt = r.ts;
    for (const s of sumKeys) o[s] = Math.round((o[s] + (r[s] || 0)) * 100) / 100;
    if (r.decision === "needs_approval" || r.decision === "denied") o.stops++;
    if (r.decision === "replayed") o.replays++;
    if (r.orderId) o.orderId = r.orderId;
  }
  return [...map.values()];
}

const NARROW_HIDE = ["seq", "state", "currency", "authorizationId", "captureIds", "refundIds", "payoutId", "otherIds", "debugId", "hash", "source", "paidOut", "held"];

export function LedgerExplorer({ proof }: { proof: Proof }) {
  const key = useDemoKey();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [chains, setChains] = useState<Partial<Record<LedgerSource, ChainCheck>>>({});
  const [status, setStatus] = useState<string>("Loading your decision log…");
  const [loading, setLoading] = useState(true);
  const [quick, setQuick] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<LedgerSource | "all">("all");
  const [view, setView] = useState<"decisions" | "orders">("decisions");
  const [grouped, setGrouped] = useState(false);
  const [selected, setSelected] = useState<LedgerRow | undefined>();
  const [pinned, setPinned] = useState<Record<string, unknown>[]>([]);
  const api = useRef<GridApi | null>(null);
  const orderApi = useRef<GridApi | null>(null);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    const out: LedgerRow[] = [];
    const ch: Partial<Record<LedgerSource, ChainCheck>> = {};
    const notes: string[] = [];
    try {
      const r = await fetch(`/api/remote/log?key=${encodeURIComponent(key)}`, { cache: "no-store" });
      const j = await r.json();
      if (r.ok && Array.isArray(j.log)) {
        const { rows: rr, chain } = await rowsFromLog(j.log, "demo key");
        out.push(...rr);
        if (j.log.length) ch["demo key"] = chain;
      } else notes.push(j.error ?? "Could not read the demo-key ledger.");
    } catch {
      notes.push("Could not reach the demo-key ledger.");
    }
    try {
      const r = await fetch("/api/commerce/log", { cache: "no-store" });
      const j = await r.json();
      if (r.ok && Array.isArray(j.log) && j.log.length) {
        const { rows: rr, chain } = await rowsFromLog(j.log, "merchant checkout (UCP)");
        out.push(...rr);
        ch["merchant checkout (UCP)"] = chain;
      }
    } catch {
      /* merchant log is optional */
    }
    try {
      const raw = localStorage.getItem(JUDGE_STORE);
      const log = raw ? (JSON.parse(raw)?.snapshot?.state?.log as string[] | undefined) : undefined;
      if (Array.isArray(log) && log.length) {
        const { rows: rr, chain } = await rowsFromLog(log, "judge session");
        out.push(...rr);
        ch["judge session"] = chain;
      }
    } catch {
      /* storage blocked */
    }
    setRows((prev) => [...out, ...prev.filter((p) => p.source === "sample (sandbox proof)")]);
    setChains(ch);
    setStatus(out.length ? "" : notes[0] ?? "No decisions yet for this browser. Run something in the judge console or through the remote MCP, or load the sample.");
    setLoading(false);
  }, [key]);

  useEffect(() => {
    void load();
    const p = new URLSearchParams(window.location.search).get("source");
    if (p === "judge") setSourceFilter("judge session");
    if (p === "key") setSourceFilter("demo key");
    if (p === "merchant") setSourceFilter("merchant checkout (UCP)");
  }, [load]);

  const loadSample = () => {
    setRows((prev) => [...prev.filter((p) => p.source !== "sample (sandbox proof)"), ...rowsFromProof(proof)]);
    setSourceFilter("all");
  };
  const hasSample = rows.some((r) => r.source === "sample (sandbox proof)");

  const visibleRows = useMemo(() => (sourceFilter === "all" ? rows : rows.filter((r) => r.source === sourceFilter)), [rows, sourceFilter]);
  const shownRows = useMemo(() => (grouped ? [...visibleRows].sort((a, b) => a.orderRef.localeCompare(b.orderRef) || (a.seq ?? 0) - (b.seq ?? 0)) : visibleRows), [visibleRows, grouped]);
  const orders = useMemo(() => ordersOf(visibleRows), [visibleRows]);

  const refreshTotals = useCallback(() => {
    const a = api.current;
    if (!a) return;
    const list: LedgerRow[] = [];
    a.forEachNodeAfterFilter((n) => n.data && list.push(n.data as LedgerRow));
    const next = [{ id: "totals", verb: `${list.length} decisions`, decision: "Totals", ...totals(list) }];
    setPinned((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }, []);

  useEffect(() => {
    api.current?.onFilterChanged();
  }, [decisionFilter]);

  const cols = useMemo<ColDef<LedgerRow>[]>(
    () => [
      { field: "ts", headerName: "Time", valueFormatter: timeFmt, width: 150, sort: grouped ? undefined : "desc", filter: "agDateColumnFilter", filterValueGetter: (p) => (p.data?.ts ? new Date(p.data.ts) : null) },
      { field: "source", headerName: "Source", width: 130, filter: "agTextColumnFilter" },
      { field: "seq", headerName: "#", width: 64, type: "numericColumn" },
      { field: "verb", headerName: "Verb", width: 120, filter: "agTextColumnFilter", floatingFilter: true },
      { field: "orderRef", headerName: "orderRef", width: 170, filter: "agTextColumnFilter", floatingFilter: true, spanRows: grouped, cellClass: grouped ? "ledger-span" : undefined },
      { field: "amount", headerName: "Amount", width: 105, type: "numericColumn", valueFormatter: moneyFmt, filter: "agNumberColumnFilter" },
      { field: "currency", headerName: "Cur.", width: 70 },
      { field: "decision", headerName: "Decision", width: 140, cellRenderer: DecisionCell, filter: "agTextColumnFilter", floatingFilter: true },
      { field: "rule", headerName: "Policy rule", width: 170, filter: "agTextColumnFilter", tooltipField: "reason" },
      { field: "state", headerName: "State", width: 150, filter: "agTextColumnFilter" },
      { field: "captured", headerName: "Captured", width: 105, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "paidOut", headerName: "Paid out", width: 100, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "refunded", headerName: "Refunded", width: 105, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "held", headerName: "On hold", width: 100, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "stopped", headerName: "Stopped by policy", width: 140, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "orderId", headerName: "PayPal order", width: 170, cellClass: "mono" },
      { field: "authorizationId", headerName: "Authorization", width: 170, cellClass: "mono" },
      { field: "captureIds", headerName: "Captures", width: 190, cellClass: "mono", tooltipField: "captureIds" },
      { field: "refundIds", headerName: "Refunds", width: 190, cellClass: "mono", tooltipField: "refundIds" },
      { field: "payoutId", headerName: "Payout", width: 190, cellClass: "mono" },
      { field: "otherIds", headerName: "Other PayPal ids", width: 220, cellClass: "mono", tooltipField: "otherIds" },
      { field: "debugId", headerName: "PayPal debug id", width: 140, cellClass: "mono" },
      { field: "hash", headerName: "Hash", width: 120, cellClass: "mono", valueFormatter: (p) => (p.value ? `${String(p.value).slice(0, 12)}…` : ""), tooltipField: "hash" },
      { field: "chain", headerName: "Chain", width: 105, cellRenderer: ChainCell, filter: "agTextColumnFilter" },
    ],
    [grouped],
  );

  const orderCols = useMemo<ColDef<OrderRow>[]>(
    () => [
      { field: "orderRef", headerName: "orderRef", width: 190, pinned: "left", filter: "agTextColumnFilter", floatingFilter: true },
      { field: "source", headerName: "Source", width: 140 },
      { field: "decisions", headerName: "Decisions", width: 105, type: "numericColumn" },
      { field: "lastState", headerName: "Last state", width: 160 },
      { field: "captured", headerName: "Captured", width: 110, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "paidOut", headerName: "Paid out", width: 105, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "refunded", headerName: "Refunded", width: 110, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "held", headerName: "On hold", width: 105, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "stopped", headerName: "Stopped by policy", width: 140, type: "numericColumn", valueFormatter: moneyFmt },
      { field: "stops", headerName: "Stops", width: 85, type: "numericColumn" },
      { field: "replays", headerName: "Replays", width: 95, type: "numericColumn" },
      { field: "orderId", headerName: "PayPal order", width: 180, cellClass: "mono" },
      { field: "lastAt", headerName: "Last activity", width: 160, valueFormatter: timeFmt, sort: "desc" },
    ],
    [],
  );

  const onGridSize = (e: GridSizeChangedEvent) => {
    e.api.setColumnsVisible(NARROW_HIDE, e.clientWidth >= 760);
  };

  const exportCsv = () => {
    const a = view === "orders" ? orderApi.current : api.current;
    a?.exportDataAsCsv({ fileName: `mcpal-${view === "orders" ? "orders" : "decisions"}-${new Date().toISOString().slice(0, 10)}.csv` });
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of visibleRows) c[r.decision] = (c[r.decision] ?? 0) + 1;
    return c;
  }, [visibleRows]);
  const t = useMemo(() => totals(visibleRows), [visibleRows]);
  const sources = (["demo key", "judge session", "merchant checkout (UCP)", "sample (sandbox proof)"] as LedgerSource[]).filter((s) => rows.some((r) => r.source === s));

  return (
    <div className="ledger">
      <div className="bench ledger-stats">
        <div className="stat">
          <div className="k">Money captured</div>
          <div className="v">{usd(t.captured) || "$0"}</div>
          <div className="small">plus {usd(t.paidOut) || "$0"} paid out</div>
        </div>
        <div className="stat">
          <div className="k">Refunded</div>
          <div className="v">{usd(t.refunded) || "$0"}</div>
        </div>
        <div className="stat">
          <div className="k">Still on hold</div>
          <div className="v">{usd(t.held) || "$0"}</div>
        </div>
        <div className="stat">
          <div className="k">Stopped by policy</div>
          <div className="v">{usd(t.stopped) || "$0"}</div>
          <div className="small">
            {(counts.needs_approval ?? 0) + (counts.denied ?? 0)} stops · {counts.replayed ?? 0} replays absorbed
          </div>
        </div>
      </div>

      <div className="ledger-chains small">
        {Object.entries(chains).map(([s, c]) => (
          <span key={s} className={c!.ok ? "pill" : "pill bad"}>
            {s}: {c!.count} entries, hash chain {c!.ok ? "verified in your browser" : `BROKEN at line ${c!.brokenAt} (${c!.reason})`}
          </span>
        ))}
        {hasSample && <span className="pill neutral">sample: real sandbox results from docs/sandbox-proof.json (run {proof.run}), not a hash-chained log</span>}
      </div>

      {status && !loading && (
        <div className="pending" style={{ margin: "12px 0" }}>
          {hasSample && !rows.some((r) => r.source !== "sample (sandbox proof)") ? "No decisions yet for this browser, so the grid shows the sample. Your own runs appear here after you use the judge console or the remote MCP." : status}{" "}
          {!hasSample && (
            <button className="btn small" onClick={loadSample} style={{ marginLeft: 8 }}>
              Load sample from the sandbox proof
            </button>
          )}{" "}
          <Link href="/judge" className="btn ghost small">
            Open the judge console
          </Link>
        </div>
      )}

      <div className="ledger-bar">
        <input className="ledger-q" type="search" placeholder="Search everything: orderRef, PayPal id, rule, state…" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick filter" />
        <div className="ledger-seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "decisions"} onClick={() => setView("decisions")}>
            Decisions
          </button>
          <button role="tab" aria-selected={view === "orders"} onClick={() => setView("orders")}>
            By order
          </button>
        </div>
        {view === "decisions" && (
          <label className="ledger-check">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by orderRef
          </label>
        )}
        <button className="btn ghost small" onClick={exportCsv} disabled={!visibleRows.length}>
          Export CSV
        </button>
        <button className="btn ghost small" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        {!hasSample && !status && (
          <button className="btn ghost small" onClick={loadSample}>
            Add sample
          </button>
        )}
      </div>

      <div className="ledger-chips">
        {sources.length > 1 && (
          <>
            {(["all", ...sources] as const).map((s) => (
              <button key={s} className={`chip${sourceFilter === s ? " on" : ""}`} onClick={() => setSourceFilter(s)}>
                {s === "all" ? "All sources" : s}
              </button>
            ))}
            <span className="chip-sep" />
          </>
        )}
        {DECISIONS.filter((d) => counts[d]).map((d) => (
          <button
            key={d}
            className={`chip${decisionFilter.includes(d) ? " on" : ""}`}
            onClick={() => setDecisionFilter((f) => (f.includes(d) ? f.filter((x) => x !== d) : [...f, d]))}
          >
            {d.replace("_", " ")} <b>{counts[d]}</b>
          </button>
        ))}
      </div>

      <div className="ledger-grid">
        {view === "decisions" ? (
          <AgGridReact<LedgerRow>
            key={grouped ? "g" : "f"}
            theme={mcpalGridTheme}
            rowData={shownRows}
            columnDefs={cols}
            defaultColDef={{ sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: false }}
            getRowId={(p) => p.data.id}
            quickFilterText={quick}
            enableCellSpan={grouped}
            isExternalFilterPresent={() => decisionFilter.length > 0}
            doesExternalFilterPass={(n) => !!n.data && decisionFilter.includes(n.data.decision)}
            pinnedBottomRowData={pinned}
            onGridReady={(e: GridReadyEvent) => {
              api.current = e.api;
              refreshTotals();
            }}
            onModelUpdated={refreshTotals}
            onGridSizeChanged={onGridSize}
            onFirstDataRendered={(e) => e.api.setColumnsVisible(NARROW_HIDE, (document.querySelector(".ledger-grid")?.clientWidth ?? 1000) >= 760)}
            onRowClicked={(e: RowClickedEvent<LedgerRow>) => !e.node.rowPinned && setSelected(e.data)}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            getRowClass={(p) => (p.node.rowPinned ? "ledger-total" : undefined)}
            tooltipShowDelay={300}
            overlayNoRowsTemplate={loading ? "Loading…" : "No decisions match."}
            animateRows={false}
          />
        ) : (
          <AgGridReact<OrderRow>
            theme={mcpalGridTheme}
            rowData={orders}
            columnDefs={orderCols}
            defaultColDef={{ sortable: true, resizable: true, filter: true }}
            quickFilterText={quick}
            getRowId={(p) => `${p.data.source}|${p.data.orderRef}`}
            pinnedBottomRowData={[{ orderRef: `${orders.length} orders`, ...totals(orders) } as Partial<OrderRow>] as OrderRow[]}
            onGridReady={(e) => (orderApi.current = e.api)}
            getRowClass={(p) => (p.node.rowPinned ? "ledger-total" : undefined)}
            onRowClicked={(e) => {
              if (e.node.rowPinned || !e.data) return;
              setQuick(e.data.orderRef);
              setGrouped(true);
              setView("decisions");
            }}
            overlayNoRowsTemplate={loading ? "Loading…" : "No orders yet."}
          />
        )}
      </div>
      <p className="small" style={{ margin: "6px 0 0" }}>
        {view === "orders" ? "Click an order to see its decisions." : "Click a row for the full log entry and the PayPal result."} Columns are sortable, resizable and filterable from their menus; on a phone
        the grid scrolls sideways and the id columns are hidden.
      </p>

      {selected && view === "decisions" && (
        <div className="ledger-detail">
          <div className="ledger-detail-h">
            <div>
              <span className={pillClass(selected.decision)}>{selected.decision.replace("_", " ")}</span> <b>{selected.verb}</b> <span className="mono">{selected.orderRef}</span>{" "}
              {selected.amount ? `· ${usd(selected.amount)} ${selected.currency}` : ""}
            </div>
            <button className="btn ghost small" onClick={() => setSelected(undefined)}>
              Close
            </button>
          </div>
          {selected.reason && selected.source !== "sample (sandbox proof)" && <p style={{ margin: "8px 0" }}>{selected.reason}</p>}
          {selected.rule && (
            <p className="small" style={{ margin: "4px 0" }}>
              Policy rule: <b>{selected.rule}</b>
            </p>
          )}
          <p className="small" style={{ margin: "4px 0 8px" }}>
            {selected.chain === "sample"
              ? "Sample row from the sandbox proof script: the raw MCPal result as PayPal returned it."
              : `Log line #${selected.seq} · hash ${selected.hash} · chain ${selected.chain}. Below: the log line exactly as stored, including the PayPal result (ids, debug id, state).`}
          </p>
          <pre className="ledger-json">{JSON.stringify(selected.raw, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

