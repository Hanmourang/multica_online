"use client";

import { useT } from "../../../../i18n";
import { cn } from "@multica/ui/lib/utils";
import type { ModuleReconcileRowItem, ModuleReconcileState } from "@multica/core/types";
import { stateToneClass } from "./lib/state-tone";

// 结构对账矩阵（07 §2.4 / f3 · M-11）：**行 = 后端 rows 原序**（规格功能点全集 D-B），
// 前端不重排序、不重算状态（07 §六防漂移）。changed 行同时呈现规格旧标题与原型新标题。

export function ReconcileMatrix({
  rows,
  activeState,
  selectedCode,
  onSelectRow,
  className,
}: {
  rows: ModuleReconcileRowItem[];
  activeState?: ModuleReconcileState | null;
  selectedCode?: string | null;
  onSelectRow?: (row: ModuleReconcileRowItem) => void;
  className?: string;
}) {
  const { t } = useT("module-prototype");

  const visible = activeState ? rows.filter((r) => r.state === activeState) : rows;

  if (rows.length === 0) {
    return (
      <div className={cn("rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground", className)}>
        {t(($) => $.matrix.empty)}
      </div>
    );
  }

  return (
    <table className={cn("w-full border-collapse text-sm", className)}>
      <thead>
        <tr className="border-b text-left text-[11px] uppercase text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">{t(($) => $.matrix.col_feature)}</th>
          <th className="py-1.5 pr-3 font-medium">{t(($) => $.matrix.col_state)}</th>
          <th className="py-1.5 pr-3 text-right font-medium">{t(($) => $.matrix.col_anchor)}</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((row) => {
          const selected = selectedCode === row.code;
          return (
            <tr
              key={row.code}
              onClick={() => onSelectRow?.(row)}
              className={cn(
                "border-b border-border/60",
                onSelectRow ? "cursor-pointer hover:bg-accent/50" : "cursor-default",
                selected && "bg-accent",
              )}
            >
              <td className="py-1.5 pr-3">
                <div className="flex flex-col">
                  <span className="font-medium">
                    <span className="text-muted-foreground">{row.code}</span> {row.title}
                  </span>
                  {row.state === "changed" && row.specTitle ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t(($) => $.states.changed)}: {row.specTitle}
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="py-1.5 pr-3">
                <span
                  className={cn(
                    "inline-block rounded border px-1.5 py-0.5 text-[11px]",
                    stateToneClass(row.state),
                  )}
                >
                  {t(($) => $.states[row.state])}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {row.prototypeAnchor ? row.prototypeAnchor : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
