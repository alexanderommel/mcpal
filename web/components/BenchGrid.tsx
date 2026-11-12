"use client";
// All benchmark tasks × both toolsets in one AG Grid Community grid: filter by category, result or
// toolset, search ids and grader reasons, export CSV. Data comes from bench/results/summary.json and
// bench/tasks/*.yaml at build time (no transcripts).
import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useRef, useState } from "react";
import { mcpalGridTheme } from "./agTheme";

export interface BenchGridRow {
  id: string;
  category: string;
  task: string;
  toolset: "Official PayPal MCP" | "MCPal";
  officialCan: boolean;
  result: "pass" | "flaky" | "fail";
  passed: string;
  failureKind: string;
  wrongMovements: number;
  misMovedUsd: number;
  sandboxIds: string;
  reason: string;
  prompt: string;
}

function ResultCell(p: ICellRendererParams<BenchGridRow>) {
  if (p.node.rowPinned) return null;
  const v = String(p.value ?? "");
  return <span className={v === "pass" ? "pill" : v === "flaky" ? "pill warn" : "pill bad"}>{v === "pass" ? "pass all runs" : v === "flaky" ? "some runs" : "fail"}</span>;
}

export function BenchGrid({ rows }: { rows: BenchGridRow[] }) {
  const api = useRef<GridApi | null>(null);
  const [quick, setQuick] = useState("");
  const [toolset, setToolset] = useState<"both" | BenchGridRow["toolset"]>("both");
  const [onlyBad, setOnlyBad] = useState(false);
  const shown = useMemo(() => rows.filter((r) => (toolset === "both" || r.toolset === toolset) && (!onlyBad || r.result !== "pass" || r.wrongMovements > 0)), [rows, toolset, onlyBad]);

  const cols = useMemo<ColDef<BenchGridRow>[]>(
    () => [
      { field: "category", headerName: "Category", width: 140, filter: "agTextColumnFilter", floatingFilter: true, valueFormatter: (p) => String(p.value ?? "").replace(/_/g, " ") },
      { field: "task", headerName: "Task", width: 170, pinned: "left", cellClass: "mono", filter: "agTextColumnFilter", floatingFilter: true, tooltipField: "prompt" },
      { field: "toolset", headerName: "Toolset", width: 170, filter: "agTextColumnFilter", floatingFilter: true },
      { field: "result", headerName: "Result", width: 135, cellRenderer: ResultCell, filter: "agTextColumnFilter", floatingFilter: true },
      { field: "passed", headerName: "Runs correct", width: 120 },
      { field: "officialCan", headerName: "Official has tools", width: 140, valueFormatter: (p) => (p.value ? "yes" : "no"), filter: "agTextColumnFilter" },
      { field: "failureKind", headerName: "Failure kind", width: 140, filter: "agTextColumnFilter", valueFormatter: (p) => String(p.value ?? "").replace(/_/g, " ") },
      { field: "wrongMovements", headerName: "Wrong movements", width: 145, type: "numericColumn", filter: "agNumberColumnFilter" },
      { field: "misMovedUsd", headerName: "US$ moved wrongly", width: 150, type: "numericColumn", valueFormatter: (p) => (p.value ? `$${Number(p.value).toFixed(2)}` : "") },
      { field: "sandboxIds", headerName: "PayPal movements", width: 340, cellClass: "mono", tooltipField: "sandboxIds" },
      { field: "reason", headerName: "Grader reason", width: 320, tooltipField: "reason", filter: "agTextColumnFilter" },
      { field: "prompt", headerName: "Merchant request", width: 420, tooltipField: "prompt" },
    ],
    [],
  );

  const t = useMemo(() => {
    const pass = shown.filter((r) => r.result === "pass").length;
    return [{ id: "totals", task: `${shown.length} rows`, result: undefined, passed: `${pass} pass all`, wrongMovements: shown.reduce((a, r) => a + r.wrongMovements, 0), misMovedUsd: shown.reduce((a, r) => a + r.misMovedUsd, 0) }];
  }, [shown]);

  return (
    <div className="bgrid">
      <div className="ledger-bar">
        <input className="ledger-q" type="search" placeholder="Search tasks, reasons, PayPal ids…" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick filter" />
        <div className="ledger-seg" role="tablist" aria-label="Toolset">
          {(["both", "Official PayPal MCP", "MCPal"] as const).map((x) => (
            <button key={x} role="tab" aria-selected={toolset === x} onClick={() => setToolset(x)}>
              {x === "both" ? "Both" : x === "MCPal" ? "MCPal" : "Official"}
            </button>
          ))}
        </div>
        <label className="ledger-check">
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> Only failures and wrong money
        </label>
        <button className="btn ghost small" onClick={() => api.current?.exportDataAsCsv({ fileName: "mcpal-benchmark-tasks.csv" })}>
          Export CSV
        </button>
      </div>
      <div className="ledger-grid">
        <AgGridReact<BenchGridRow>
          theme={mcpalGridTheme}
          rowData={shown}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => p.data.id}
          quickFilterText={quick}
          pinnedBottomRowData={t as unknown as BenchGridRow[]}
          getRowClass={(p) => (p.node.rowPinned ? "ledger-total" : undefined)}
          onGridReady={(e) => (api.current = e.api)}
          tooltipShowDelay={300}
          animateRows={false}
        />
      </div>
      <p className="small" style={{ margin: "6px 0 0" }}>
        One row per task and toolset. Hover a task for the merchant&apos;s request. Sort or filter any column from its header; on a phone the grid scrolls sideways.
      </p>
    </div>
  );
}
