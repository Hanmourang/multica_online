import type { ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";

export type FeaturePillTone = "ok" | "run" | "wait" | "mute" | "warn";

export function featurePillTone(raw: string | null | undefined): FeaturePillTone {
  const value = (raw ?? "").toLowerCase();
  if (value.includes("implemented") || value.includes("实证")) return "run";
  if (
    value.includes("完成") ||
    value.includes("accepted") ||
    value === "done" ||
    value === "ok"
  ) {
    return "ok";
  }
  if (
    value.includes("执行") ||
    value.includes("验收中") ||
    value === "in_progress" ||
    value === "in_review" ||
    value === "doing" ||
    value === "run"
  ) {
    return "run";
  }
  if (
    value.includes("失败") ||
    value.includes("阻塞") ||
    value === "blocked" ||
    value === "stuck"
  ) {
    return "warn";
  }
  if (
    value.includes("待") ||
    value.includes("未拆") ||
    value.includes("empty") ||
    value.includes("pending")
  ) {
    return "wait";
  }
  return "mute";
}

export function FeaturePill({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: FeaturePillTone;
}) {
  const resolved = tone ?? "mute";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[9.5px] font-bold",
        resolved === "ok" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        resolved === "run" && "bg-primary/12 text-primary",
        resolved === "wait" && "bg-amber-500/15 text-amber-800 dark:text-amber-300",
        resolved === "warn" && "bg-destructive/12 text-destructive",
        resolved === "mute" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function TypeChip({
  children,
  muted = false,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-[3px] px-1 py-px text-[8.5px] font-bold",
        muted ? "bg-muted text-muted-foreground" : "bg-primary/12 text-primary",
      )}
    >
      {children}
    </span>
  );
}

export function FeaturePane({
  tag,
  title,
  meta,
  children,
}: {
  tag: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[10px] border border-surface-border bg-surface">
      <header className="flex items-center gap-1.5 border-b border-surface-border bg-muted/25 px-3 py-2">
        <TypeChip>{tag}</TypeChip>
        <h4 className="text-[11px] font-bold text-foreground">{title}</h4>
        {meta ? (
          <div className="ml-auto text-[9px] font-semibold text-muted-foreground">{meta}</div>
        ) : null}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function FeatureNode({
  type,
  children,
  caption,
}: {
  type: string;
  children: ReactNode;
  caption?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-surface-border bg-surface px-2 py-1 text-[10.5px]">
      <TypeChip>{type}</TypeChip>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {caption ? (
        <span className="shrink-0 text-[9px] text-muted-foreground">{caption}</span>
      ) : null}
    </div>
  );
}

export function FeatureEdge({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pb-1 font-mono text-[9.5px] leading-relaxed text-muted-foreground">
      └ {children}
    </p>
  );
}

export function FeatureLinkRow({
  children,
  last = false,
}: {
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 py-1 text-[11px]",
        !last && "border-b border-dashed border-surface-border",
      )}
    >
      {children}
    </li>
  );
}

export function FeatureTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  );
}

export function FeatureTh({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-2 py-1.5 text-left text-[10px] font-semibold text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function FeatureTd({
  children,
  className,
  mono = false,
}: {
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-t border-surface-border px-2 py-1.5 align-middle",
        mono && "font-mono text-[10.5px]",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function formatScanWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}
