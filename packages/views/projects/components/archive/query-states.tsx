"use client";

import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@multica/ui/components/ui/empty";
import { useT } from "../../../i18n";

/**
 * Shared loading / error / empty states for every project-archive view.
 * All archive components render through these so the twelve frames keep one
 * visual language — a Skeleton block while loading, a retry row on failure,
 * an Empty card when the server legitimately has no data.
 */

export function QueryLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="space-y-2"
      role="status"
      aria-busy="true"
      data-testid="archive-loading"
    >
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function QueryError({
  onRetry,
  message,
  compact = false,
}: {
  onRetry?: () => void;
  message?: string;
  compact?: boolean;
}) {
  const { t } = useT("archive");
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 text-body text-destructive",
        compact ? "px-3 py-2" : "px-4 py-3",
      )}
      role="alert"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        {message ?? t(($) => $.common.retry_hint)}
      </span>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onRetry}
          aria-label={t(($) => $.common.retry)}
        >
          <RefreshCw />
          {t(($) => $.common.retry)}
        </Button>
      )}
    </div>
  );
}

export function ArchiveEmpty({
  title,
  description,
  icon,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("border", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}

/** Local byte formatter — sizes come back as raw `size_bytes` integers. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exp;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`;
}

/** Neutral timestamp formatting for metadata rows (ISO → locale string). */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
