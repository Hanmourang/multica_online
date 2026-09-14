import { describe, expect, it } from "vitest";
import { collectMatrixTables, filterMatrixTables } from "./bus-matrix-tables";

describe("collectMatrixTables", () => {
  it("marks summary tables bound and orphan tables unbound", () => {
    const rows = collectMatrixTables({
      summaries: [
        {
          node_id: "comm-1",
          name: "订单",
          obj_count: 1,
          strategy_count: 0,
          edge_stats: { calls_internal: 0, calls_external: 0 },
          tables_touched: ["order.orders"],
        },
      ],
      drilldownTables: [{ name: "pay.bills", domain: "pay", columns: [] }],
      alerts: [{ severity: "warning", type: "orphan_table", description: "", tables: ["pay.bills"], count: 1 }],
      bindings: {},
    });
    expect(rows.find((row) => row.name === "order.orders")?.bound).toBe(true);
    expect(rows.find((row) => row.name === "pay.bills")?.bound).toBe(false);
    expect(filterMatrixTables(rows, "unbound").map((row) => row.name)).toEqual(["pay.bills"]);
  });

  it("applies a manual binding", () => {
    const rows = collectMatrixTables({
      summaries: [],
      drilldownTables: [{ name: "ext.logs", columns: [] }],
      alerts: [],
      bindings: {
        "ext.logs": { moduleName: "日志", moduleNodeId: "comm-log", domain: "ops" },
      },
    });
    expect(rows[0]?.bound).toBe(true);
    expect(rows[0]?.modules[0]?.name).toBe("日志");
    expect(rows[0]?.attributed).toBe(true);
  });
});
