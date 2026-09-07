"use client";

import type { FilingItem, FilingStatus, FilingTier } from "@multica/core/types";
import { Check, CircleAlert, X } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

type Translator = ReturnType<typeof useT<"archive">>["t"];

/**
 * f12 申报清单 · must / conditional / aux 三档分组。
 *
 * The ring counts must items only (原型标注 2：辅助件不计入分母); the
 * checklist itself renders every tier the readiness payload carries.
 * Item rows show the binding state (bound artifact vs 待补件) — the
 * prototype's per-rule check lines arrive with the rule engine and are not
 * fabricated here.
 */

const TIER_ORDER: FilingTier[] = ["must", "conditional", "aux"];

function tierLabel(t: Translator, tier: FilingTier): string {
  switch (tier) {
    case "must":
      return t(($) => $.filing.tier_must);
    case "conditional":
      return t(($) => $.filing.tier_conditional);
    default:
      return t(($) => $.filing.tier_aux);
  }
}

function tierDesc(t: Translator, tier: FilingTier): string {
  switch (tier) {
    case "must":
      return t(($) => $.filing.tier_must_desc);
    case "conditional":
      return t(($) => $.filing.tier_conditional_desc);
    default:
      return t(($) => $.filing.tier_aux_desc);
  }
}

function statusLabel(t: Translator, status: FilingStatus): string {
  switch (status) {
    case "ready":
      return t(($) => $.filing.status_ready);
    case "partial":
      return t(($) => $.filing.status_partial);
    default:
      return t(($) => $.filing.status_missing);
  }
}

function statusIcon(status: FilingStatus) {
  switch (status) {
    case "ready":
      return <Check aria-hidden className="size-4 text-emerald-500" />;
    case "partial":
      return <CircleAlert aria-hidden className="size-4 text-amber-500" />;
    default:
      return <X aria-hidden className="size-4 text-destructive" />;
  }
}

export function FilingChecklist({ items }: { items: FilingItem[] }) {
  const { t } = useT("archive");

  const byTier = new Map<FilingTier, FilingItem[]>();
  for (const tier of TIER_ORDER) byTier.set(tier, []);
  for (const item of items) {
    byTier.get(item.tier)?.push(item);
  }

  return (
    <div className="space-y-5">
      {TIER_ORDER.flatMap((tier) => {
        const group = (byTier.get(tier) ?? []).sort(
          (a, b) => a.sort_order - b.sort_order,
        );
        if (group.length === 0) return [];
        const ready = group.filter((item) => item.status === "ready").length;
        return [
          <section key={tier} aria-label={tierLabel(t, tier)}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-micro font-semibold",
                  tier === "must" && "bg-destructive/10 text-destructive",
                  tier === "conditional" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                  tier === "aux" && "bg-muted text-muted-foreground",
                )}
              >
                {tierLabel(t, tier)}
              </span>
              <span className="text-caption text-muted-foreground">
                {tierDesc(t, tier)}
              </span>
              <span className="ml-auto text-caption tabular-nums text-muted-foreground">
                {ready} / {group.length}
              </span>
            </div>
            <ul className="rounded-lg border border-surface-border">
              {group.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "flex items-start gap-2.5 border-b border-surface-border px-3 py-2.5 last:border-b-0",
                    item.status === "missing" && "bg-destructive/5",
                  )}
                >
                  <span className="mt-0.5 shrink-0">{statusIcon(item.status)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-medium">{item.label}</span>
                      <span
                        className={cn(
                          "text-micro",
                          item.status === "ready"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : item.status === "partial"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-destructive",
                        )}
                      >
                        {statusLabel(t, item.status)}
                      </span>
                    </div>
                    {item.description && (
                      <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-micro",
                      item.artifact_id
                        ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                        : "border-dashed border-destructive/40 text-destructive",
                    )}
                  >
                    {item.artifact_id
                      ? t(($) => $.filing.bound_artifact)
                      : t(($) => $.filing.unbound)}
                  </span>
                </li>
              ))}
            </ul>
          </section>,
        ];
      })}
    </div>
  );
}
