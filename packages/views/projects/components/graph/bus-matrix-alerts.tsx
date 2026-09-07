"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Ban,
  CircleDashed,
  ShieldAlert,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { busMatrixAlertsOptions } from "@multica/core/graph/queries";
import type {
  BusMatrixAlert,
  BusMatrixAlertSeverity,
  BusMatrixAlertType,
} from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";

/**
 * f11 矩阵告警面板（原型 f11 侧栏「矩阵告警」anno 5）。
 *
 * GET .../graph/bus-matrix/alerts derives structural problems from the latest
 * snapshot. Three rules are implemented server-side — cross_domain_write (one
 * alert per offending cell), orphan_table (matrix tables no module_summary
 * entry claims) and unclassified (access edges with no usable domain) — and
 * every alert carries a severity plus real locators: table names and/or edge
 * refs, never a synthesized one.
 *
 * `rule_coverage` is the other half of the contract and the reason this panel
 * is not a plain list. deprecated_access needs ontology lifecycle metadata
 * that migration 457 created but nothing fills yet, and orphan_table needs
 * table names inside the bus-matrix cells that the CLI pre-aggregation does
 * not emit. A rule that could not run comes back evaluated=false with a
 * machine-readable reason, and this panel says so: an empty alert list must
 * never read as "the matrix is clean" when half the rules were blind.
 *
 * The prototype's 改判 / 建域 actions are out of scope — they route through
 * the f3 override mechanism, not this endpoint — and are deliberately not
 * stubbed.
 */

type ArchiveT = ReturnType<typeof useT<"archive">>["t"];

/**
 * Per-type visual identity. The prototype gives each of the four alert kinds
 * its own glyph and weight (⛔ / ⚠ / ⚠ / ○), so the accent rides the type
 * while the row tint rides the severity: a warning orphan_table and a warning
 * deprecated_access share a tint but never an icon or an accent.
 */
interface AlertVisual {
  icon: LucideIcon;
  /** Left accent border, in the type's own hue. */
  accent: string;
  iconClass: string;
}

const ALERT_VISUAL: Record<BusMatrixAlertType, AlertVisual> = {
  cross_domain_write: {
    icon: ArrowLeftRight,
    accent: "border-l-destructive",
    iconClass: "text-destructive",
  },
  orphan_table: {
    icon: Table2,
    accent: "border-l-amber-500",
    iconClass: "text-amber-600 dark:text-amber-400",
  },
  deprecated_access: {
    icon: Ban,
    accent: "border-l-orange-500",
    iconClass: "text-orange-600 dark:text-orange-400",
  },
  unclassified: {
    icon: CircleDashed,
    accent: "border-l-primary",
    iconClass: "text-primary",
  },
};

// A rule type this client was built before the server added it: keep it
// visible with a neutral glyph rather than dropping the row on the floor.
const FALLBACK_VISUAL: AlertVisual = {
  icon: ShieldAlert,
  accent: "border-l-surface-border",
  iconClass: "text-muted-foreground",
};

const SEVERITY_TINT: Record<BusMatrixAlertSeverity, string> = {
  error: "bg-destructive/5",
  warning: "bg-amber-500/5",
  info: "bg-transparent",
};

function visualFor(type: BusMatrixAlertType): AlertVisual {
  return ALERT_VISUAL[type] ?? FALLBACK_VISUAL;
}

// Static key paths only — a dynamic `t(\`…${type}\`)` would defeat both the
// typed selector and the parity test, so the mapping is an explicit switch.
// The fallback keys are named `*_fallback`, never `*_other`: i18next reads an
// `_other` suffix as a plural form and collapses it into the base key.
function alertTypeLabel(type: BusMatrixAlertType, t: ArchiveT): string {
  switch (type) {
    case "cross_domain_write":
      return t(($) => $.bus_matrix_detail.alerts_type_cross_domain_write);
    case "orphan_table":
      return t(($) => $.bus_matrix_detail.alerts_type_orphan_table);
    case "deprecated_access":
      return t(($) => $.bus_matrix_detail.alerts_type_deprecated_access);
    case "unclassified":
      return t(($) => $.bus_matrix_detail.alerts_type_unclassified);
    default:
      return t(($) => $.bus_matrix_detail.alerts_type_fallback);
  }
}

/**
 * Localized sentence for an alert. The server also sends an English
 * `description`; the client re-renders from the structured locators so a
 * zh-Hans / ja / ko user never reads English. The server string stays as the
 * fallback for types this client has no copy for.
 */
function alertDescription(alert: BusMatrixAlert, t: ArchiveT): string {
  switch (alert.type) {
    case "cross_domain_write":
      return t(($) => $.bus_matrix_detail.alerts_desc_cross_domain_write, {
        module: alert.module_name ?? "",
        page: alert.page_name ?? "",
        domain: alert.domain ?? "",
        count: alert.write_count ?? 0,
      });
    case "orphan_table":
      return t(($) => $.bus_matrix_detail.alerts_desc_orphan_table, {
        count: alert.count,
      });
    case "unclassified":
      return t(($) => $.bus_matrix_detail.alerts_desc_unclassified, {
        count: alert.count,
      });
    default:
      return alert.description;
  }
}

function coverageReasonLabel(reason: string | undefined, t: ArchiveT): string {
  switch (reason) {
    case "no_bus_matrix":
      return t(($) => $.bus_matrix_detail.coverage_reason_no_bus_matrix);
    case "no_table_names":
      return t(($) => $.bus_matrix_detail.coverage_reason_no_table_names);
    case "no_module_summary":
      return t(($) => $.bus_matrix_detail.coverage_reason_no_module_summary);
    case "module_summary_malformed":
      return t(($) => $.bus_matrix_detail.coverage_reason_module_summary_malformed);
    case "edges_unavailable":
      return t(($) => $.bus_matrix_detail.coverage_reason_edges_unavailable);
    case "no_snapshot_edges":
      return t(($) => $.bus_matrix_detail.coverage_reason_no_snapshot_edges);
    case "no_access_edges":
      return t(($) => $.bus_matrix_detail.coverage_reason_no_access_edges);
    case "not_implemented":
      return t(($) => $.bus_matrix_detail.coverage_reason_not_implemented);
    default:
      return t(($) => $.bus_matrix_detail.coverage_reason_fallback);
  }
}

export function BusMatrixAlerts() {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();

  const query = useQuery(busMatrixAlertsOptions(wsId, projectId));

  if (query.isPending) {
    return <QueryLoading rows={3} />;
  }
  if (query.isError) {
    return <QueryError compact onRetry={() => void query.refetch()} />;
  }

  const { alerts, rule_coverage: ruleCoverage } = query.data;
  // Rules that could not run. Shown alongside the alerts so "nothing fired"
  // and "nothing could fire" stay visually distinct.
  const skipped = ruleCoverage.filter((rule) => !rule.evaluated);

  if (alerts.length === 0 && skipped.length === 0) {
    return (
      <ArchiveEmpty
        icon={<ShieldAlert className="size-5" />}
        title={t(($) => $.bus_matrix.alerts_title)}
        description={t(($) => $.bus_matrix_detail.alerts_clean)}
      />
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-caption font-medium text-foreground">
        {t(($) => $.bus_matrix.alerts_title)}
      </h4>

      {alerts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-surface-border px-3 py-2 text-caption text-muted-foreground">
          {t(($) => $.bus_matrix_detail.alerts_clean)}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {alerts.map((alert, index) => {
            const visual = visualFor(alert.type);
            const Icon = visual.icon;
            const tables = alert.tables ?? [];
            const edges = alert.edges ?? [];
            return (
              <li
                key={`${alert.type}:${index}`}
                className={cn(
                  "rounded-lg border border-surface-border border-l-2.5 px-3 py-2",
                  visual.accent,
                  SEVERITY_TINT[alert.severity] ?? SEVERITY_TINT.info,
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Icon className={cn("size-3.5 shrink-0", visual.iconClass)} />
                  <span className="text-caption font-medium text-foreground">
                    {alertTypeLabel(alert.type, t)}
                  </span>
                  <span className="shrink-0 rounded-full border border-surface-border px-1.5 text-micro tabular-nums text-muted-foreground">
                    {alert.count}
                  </span>
                </div>

                <p className="mt-1 text-caption leading-relaxed">
                  {alertDescription(alert, t)}
                </p>

                {tables.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {tables.map((table) => (
                      <span
                        key={table}
                        className="rounded border border-surface-border px-1.5 py-0.5 font-mono text-micro text-muted-foreground"
                      >
                        {table}
                      </span>
                    ))}
                    {alert.count > tables.length && (
                      <span className="px-1.5 py-0.5 text-micro text-muted-foreground">
                        {t(($) => $.bus_matrix_detail.alerts_more, {
                          count: alert.count - tables.length,
                        })}
                      </span>
                    )}
                  </div>
                )}

                {edges.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    <span className="text-micro text-muted-foreground">
                      {t(($) => $.bus_matrix_detail.alerts_edges_label)}
                    </span>
                    <ul className="flex flex-wrap gap-1">
                      {edges.map((edge) => (
                        <li
                          key={edge.id}
                          className="rounded border border-surface-border px-1.5 py-0.5 font-mono text-micro text-muted-foreground"
                        >
                          {`${edge.source} → ${edge.target}`}
                        </li>
                      ))}
                    </ul>
                    {alert.count > edges.length && (
                      <p className="text-micro text-muted-foreground">
                        {t(($) => $.bus_matrix_detail.alerts_more, {
                          count: alert.count - edges.length,
                        })}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {skipped.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-dashed border-surface-border px-3 py-2">
          <p className="text-micro font-medium text-foreground">
            {t(($) => $.bus_matrix_detail.alerts_coverage_title)}
          </p>
          <ul className="space-y-1">
            {skipped.map((rule) => (
              <li
                key={rule.type}
                className="text-micro leading-relaxed text-muted-foreground"
              >
                <span className="font-medium text-foreground">
                  {alertTypeLabel(rule.type, t)}
                </span>
                {` — ${coverageReasonLabel(rule.reason, t)}`}
              </li>
            ))}
          </ul>
          <p className="text-micro leading-relaxed text-muted-foreground">
            {t(($) => $.bus_matrix_detail.alerts_coverage_hint)}
          </p>
        </div>
      )}
    </div>
  );
}
