"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScanSearch } from "lucide-react";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@multica/ui/components/ui/card";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { isDesktopShell } from "../../../platform";
import { readArchiveFile } from "../../../platform/archive-fs";
import { useT } from "../../../i18n";
import {
  parseRecognitionReport,
  RECOGNITION_CLI,
  RECOGNITION_JSON_REL,
  resolveProjectsMgmtRoot,
  type RecognitionReport,
} from "./archive-recognition";
import { QueryLoading } from "./query-states";

const CASCADE = [
  { lv: "L1", conf: 95 },
  { lv: "L2", conf: 90 },
  { lv: "L3", conf: 70 },
  { lv: "L4", conf: 55 },
  { lv: "L5", conf: 40 },
  { lv: "L6", conf: 100 },
] as const;

const SHELVES = ["research", "product-design", "architecture", "retrospective"];
const TAXONOMY_FOLD = [
  "diagnosis→research",
  "selection→research",
  "integration→architecture",
  "report→retrospective",
];
const REQ_TYPES = ["requirement", "plan", "decomposition", "design", "test-plan", "acceptance", "report"];
const FORMATS = [
  { tag: "full", label: "md · html" },
  { tag: "index", label: "pdf · json · yaml · ts · py" },
  { tag: "asset", label: "png · jpg · svg" },
  { tag: "skip", label: "zip · dist · vendor" },
];

/**
 * 画面 4：识别引擎看板。数字只来自 classifier JSON，级联/分类法是只读说明，
 * 不在产品里再跑一套归类。
 */
export function ArchiveRecognitionPanel({ archiveRoot }: { archiveRoot?: string | null }) {
  const { t } = useT("archive");
  const desktop = isDesktopShell();
  const mgmtRoot = resolveProjectsMgmtRoot(archiveRoot);
  const [pasted, setPasted] = useState("");
  const fileQuery = useQuery({
    queryKey: ["archive-recognition", mgmtRoot],
    enabled: Boolean(desktop && mgmtRoot),
    queryFn: async () => {
      const file = await readArchiveFile(mgmtRoot!, RECOGNITION_JSON_REL);
      if (!file.ok || !file.content) return null;
      return parseRecognitionReport(file.content);
    },
  });
  const report = parseRecognitionReport(pasted) ?? fileQuery.data ?? null;
  const bySource = report?.by_source ?? {};
  const hit = new Set(
    Object.keys(bySource).filter((key) => (bySource[key] ?? 0) > 0),
  );

  return (
    <div className="space-y-3" data-testid="archive-recognition">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-title-sm">
            <ScanSearch className="size-4 text-muted-foreground" />
            {t(($) => $.mapping.recognition_title)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.mapping.recognition_hint)}
          </p>
          <code className="block rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-[11px]">
            {RECOGNITION_CLI}
          </code>
          {fileQuery.isPending && desktop && mgmtRoot ? <QueryLoading rows={2} /> : null}
          <div className="grid gap-2 sm:grid-cols-4">
            <Stat
              label={t(($) => $.mapping.recognition_coverage)}
              value={report?.coverage != null ? `${report.coverage}%` : "—"}
            />
            <Stat
              label={t(($) => $.mapping.recognition_recognized)}
              value={
                report ? `${report.recognized ?? "—"} / ${report.total ?? "—"}` : "—"
              }
            />
            <Stat
              label={t(($) => $.mapping.recognition_unclassified)}
              value={report?.unclassified != null ? String(report.unclassified) : "—"}
            />
            <Stat
              label={t(($) => $.mapping.recognition_failures)}
              value={String(report?.failures?.length ?? "—")}
            />
          </div>
          {!report && (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.mapping.recognition_empty)}
            </p>
          )}
          <Textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder={t(($) => $.mapping.recognition_paste)}
            aria-label={t(($) => $.mapping.recognition_paste)}
            rows={3}
            className="font-mono text-[11px]"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-title-sm">{t(($) => $.mapping.recognition_cascade)}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            {CASCADE.map((step) => {
              const active = hit.has(step.lv) || (step.lv === "L6" && (report?.unclassified ?? 0) > 0);
              return (
                <div
                  key={step.lv}
                  className={`rounded-lg border px-2.5 py-2 ${
                    active
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : "border-surface-border bg-surface"
                  }`}
                >
                  <div className="text-[10px] font-semibold tracking-wide text-muted-foreground">
                    {step.lv}
                  </div>
                  <div className="text-caption font-medium">
                    {cascadeTitle(t, step.lv)}
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded bg-surface-hover">
                    <div className="h-full bg-primary" style={{ width: `${step.conf}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-title-sm">{t(($) => $.mapping.recognition_taxonomy)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-caption text-muted-foreground">
              {t(($) => $.mapping.recognition_taxonomy_hint)}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SHELVES.map((item) => (
                <Badge key={item} variant="secondary" className="font-mono">
                  {item}
                </Badge>
              ))}
              {TAXONOMY_FOLD.map((item) => (
                <Badge key={item} variant="outline" className="font-mono">
                  {item}
                </Badge>
              ))}
              {REQ_TYPES.map((item) => (
                <Badge key={item} variant="outline" className="font-mono">
                  {item}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-title-sm">{t(($) => $.mapping.recognition_formats)}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {FORMATS.map((item) => (
              <div key={item.tag} className="rounded-lg border border-surface-border px-3 py-2">
                <Badge variant="outline">{formatTag(t, item.tag)}</Badge>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">{item.label}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {report && <AttributionBars report={report} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface px-3 py-2">
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="text-body font-medium tabular-nums">{value}</div>
    </div>
  );
}

function AttributionBars({ report }: RecognitionReportProps) {
  const { t } = useT("archive");
  const rows = Object.entries(report.attribution ?? {});
  const sources = Object.entries(report.by_source ?? {});
  const max = Math.max(1, ...rows.map(([, n]) => n), ...sources.map(([, n]) => n));
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-title-sm">{t(($) => $.mapping.recognition_board)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <BarList title={t(($) => $.mapping.recognition_by_source)} rows={sources} max={max} />
        <BarList title={t(($) => $.mapping.recognition_unclassified)} rows={rows} max={max} />
        <div className="lg:col-span-2 space-y-1">
          {(report.failures ?? []).slice(0, 8).map((row) => (
            <div
              key={row.rel ?? row.failure_attribution}
              className="truncate font-mono text-[11px] text-muted-foreground"
            >
              {row.rel ?? "—"}
              {row.failure_attribution ? ` · ${row.failure_attribution}` : ""}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BarList({
  title,
  rows,
  max,
}: {
  title: string;
  rows: [string, number][];
  max: number;
}) {
  if (rows.length === 0) {
    return <p className="text-caption text-muted-foreground">{title} —</p>;
  }
  return (
    <div className="space-y-1.5">
      <div className="text-caption text-muted-foreground">{title}</div>
      {rows.map(([key, count]) => (
        <div key={key} className="flex items-center gap-2 text-caption">
          <span className="w-24 truncate font-mono">{key}</span>
          <span className="h-2 flex-1 overflow-hidden rounded bg-surface-hover">
            <span
              className="block h-full bg-primary"
              style={{ width: `${Math.round((count / max) * 100)}%` }}
            />
          </span>
          <span className="w-8 text-right tabular-nums">{count}</span>
        </div>
      ))}
    </div>
  );
}

type RecognitionReportProps = { report: RecognitionReport };

type ArchiveT = ReturnType<typeof useT<"archive">>["t"];

function cascadeTitle(t: ArchiveT, lv: string): string {
  switch (lv) {
    case "L1":
      return t(($) => $.mapping.recognition_l1);
    case "L2":
      return t(($) => $.mapping.recognition_l2);
    case "L3":
      return t(($) => $.mapping.recognition_l3);
    case "L4":
      return t(($) => $.mapping.recognition_l4);
    case "L5":
      return t(($) => $.mapping.recognition_l5);
    default:
      return t(($) => $.mapping.recognition_l6);
  }
}

function formatTag(t: ArchiveT, tag: string): string {
  switch (tag) {
    case "full":
      return t(($) => $.mapping.recognition_fmt_full);
    case "index":
      return t(($) => $.mapping.recognition_fmt_index);
    case "asset":
      return t(($) => $.mapping.recognition_fmt_asset);
    default:
      return t(($) => $.mapping.recognition_fmt_skip);
  }
}
