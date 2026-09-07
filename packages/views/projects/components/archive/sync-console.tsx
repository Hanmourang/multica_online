"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, FolderSearch, Link2Off, RefreshCw, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { toast } from "sonner";
import { clientErrorMessage } from "@multica/core/api";
import { useBindArtifact, useDeleteArtifact } from "@multica/core/artifacts";
import {
  projectArtifactListOptions,
  unboundArtifactsOptions,
} from "@multica/core/artifacts/queries";
import { latestGraphSnapshotOptions } from "@multica/core/graph/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import type { Issue, ProjectArtifact } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@multica/ui/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { isDesktopShell, useLocalDaemonStatus } from "../../../platform";
import { useT } from "../../../i18n";
import { groupUnboundArtifacts, suggestRequirement } from "./archive-bind-helpers";
import { artifactDisplayName } from "./archive-display";
import { ArchiveRootCard } from "./archive-root-card";
import { ArchiveEmpty, QueryError, QueryLoading, formatTimestamp } from "./query-states";
import { projectRequirements } from "../requirements/requirement-helpers";

/**
 * 同步与关联：待绑定队列 + 候选推荐 + 档案根绑定。
 *
 * 全量清单只能由能读目录的 CLI / Desktop 产出。此页的「校验」只 refetch，
 * 不 POST `[]`。绑定走已有 POST /artifacts/{id}/bind，不改目录名。
 */
export function SyncConsole({
  projectId,
  onImport,
  onEdit,
}: {
  projectId: string;
  onImport?: () => void;
  onEdit?: (artifact: ProjectArtifact) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const desktop = isDesktopShell();
  const daemon = useLocalDaemonStatus();

  const listQuery = useQuery(projectArtifactListOptions(wsId, projectId));
  const snapshotQuery = useQuery(latestGraphSnapshotOptions(wsId, projectId));
  const unboundQuery = useQuery(unboundArtifactsOptions(wsId, projectId));
  const issuesQuery = useQuery(calendarIssuesOptions(wsId));

  const artifacts = listQuery.data?.artifacts ?? [];
  const lastSyncedAt = artifacts.reduce<string | null>((acc, artifact) => {
    if (!acc || artifact.synced_at > acc) return artifact.synced_at;
    return acc;
  }, null);
  const unbound = unboundQuery.data ?? [];
  const requirements = useMemo(
    () => projectRequirements(issuesQuery.data ?? [], projectId),
    [issuesQuery.data, projectId],
  );
  const unboundGroups = useMemo(() => groupUnboundArtifacts(unbound), [unbound]);
  const candidates = useMemo(
    () =>
      unbound
        .map((artifact) => ({
          artifact,
          issue: suggestRequirement(artifact, requirements),
        }))
        .filter((row): row is { artifact: ProjectArtifact; issue: Issue } => row.issue !== null),
    [unbound, requirements],
  );

  const [revalidating, setRevalidating] = useState(false);
  const refreshAll = () => {
    void listQuery.refetch();
    void snapshotQuery.refetch();
    void unboundQuery.refetch();
    void issuesQuery.refetch();
  };
  const handleRevalidate = () => {
    setRevalidating(true);
    void Promise.allSettled([
      listQuery.refetch(),
      snapshotQuery.refetch(),
      unboundQuery.refetch(),
      issuesQuery.refetch(),
    ]).then(() => {
      setRevalidating(false);
      toast.info(t(($) => $.sync.revalidate_noop));
    });
  };
  const isRefetching =
    listQuery.isFetching ||
    snapshotQuery.isFetching ||
    unboundQuery.isFetching ||
    issuesQuery.isFetching;

  return (
    <div className="space-y-4" data-testid="archive-sync-console">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-title-sm font-medium">{t(($) => $.sync.title)}</h3>
          <div className="flex flex-wrap items-center gap-2">
            {onImport && (
              <Button type="button" size="xs" onClick={onImport}>
                <FolderSearch />
                {t(($) => $.sync.import_now)}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleRevalidate}
              disabled={revalidating}
              aria-label={t(($) => $.sync.revalidate)}
              data-testid="archive-sync-revalidate"
            >
              <ShieldCheck className={revalidating ? "animate-pulse" : undefined} />
              {revalidating
                ? t(($) => $.sync.revalidate_pending)
                : t(($) => $.sync.revalidate)}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={refreshAll}
              disabled={isRefetching}
              aria-label={t(($) => $.common.refresh)}
            >
              <RefreshCw className={isRefetching ? "animate-spin" : undefined} />
              {t(($) => $.common.refresh)}
            </Button>
          </div>
        </div>
        <p
          className="text-caption leading-relaxed text-muted-foreground"
          data-testid="archive-sync-web-noop"
        >
          {t(($) => $.sync.subtitle)}
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-title-sm">{t(($) => $.sync.last_sync)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {listQuery.isPending ? (
            <QueryLoading rows={2} />
          ) : listQuery.isError ? (
            <QueryError
              compact
              onRetry={() => void listQuery.refetch()}
              message={String(listQuery.error)}
            />
          ) : (
            <dl className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-surface-border bg-surface px-3 py-2">
                <dt className="text-caption text-muted-foreground">
                  {t(($) => $.sync.last_sync)}
                </dt>
                <dd className="mt-0.5 text-body font-medium">
                  {lastSyncedAt
                    ? formatTimestamp(lastSyncedAt)
                    : t(($) => $.sync.never)}
                </dd>
                {artifacts.length > 0 && (
                  <dd className="mt-0.5 text-caption text-muted-foreground">
                    {t(($) => $.sync.artifact_count, { count: artifacts.length })}
                  </dd>
                )}
              </div>
              <div className="rounded-lg border border-surface-border bg-surface px-3 py-2">
                <dt className="text-caption text-muted-foreground">
                  {t(($) => $.sync.last_scan)}
                </dt>
                <dd className="mt-0.5 text-body font-medium">
                  {snapshotQuery.data
                    ? formatTimestamp(snapshotQuery.data.created_at)
                    : t(($) => $.sync.never)}
                </dd>
                {snapshotQuery.data && (
                  <dd className="mt-0.5 flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="font-mono">
                      {t(($) => $.sync.scan_id)} {snapshotQuery.data.scan_id.slice(0, 8)}
                    </Badge>
                    <Badge variant="outline" className="font-mono">
                      {t(($) => $.sync.git_sha)} {snapshotQuery.data.git_sha.slice(0, 8)}
                    </Badge>
                  </dd>
                )}
              </div>
            </dl>
          )}
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <span className="text-muted-foreground">{t(($) => $.sync.source_daemon)}</span>
            {!desktop ? (
              <Badge variant="outline">{t(($) => $.sync.daemon_unavailable)}</Badge>
            ) : daemon.running ? (
              <Badge variant="outline" className="gap-1 text-emerald-600 dark:text-emerald-400">
                <Check className="size-3" aria-hidden />
                {t(($) => $.sync.daemon_running)}
              </Badge>
            ) : (
              <Badge variant="outline">{t(($) => $.sync.daemon_offline)}</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <ArchiveRootCard projectId={projectId} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-title-sm">
            <Sparkles className="size-4 text-muted-foreground" />
            {t(($) => $.sync.candidate_title)}
            {candidates.length > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {candidates.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.sync.candidate_hint)}
          </p>
          {unboundQuery.isPending || issuesQuery.isPending ? (
            <QueryLoading rows={2} />
          ) : candidates.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.sync.candidate_empty)}
            </p>
          ) : (
            <ul className="space-y-2">
              {candidates.map(({ artifact, issue }) => (
                <li
                  key={artifact.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-caption font-medium" title={artifact.rel_path}>
                      {artifactDisplayName(artifact.rel_path)}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
                      <Badge variant="outline">{t(($) => $.sync.suggested)}</Badge>
                      <span className="font-mono">
                        {issue.identifier} {issue.title}
                      </span>
                    </div>
                  </div>
                  <BindButton
                    projectId={projectId}
                    artifactId={artifact.id}
                    issueId={issue.id}
                    issueLabel={issue.identifier}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-title-sm">
            <Link2Off className="size-4 text-muted-foreground" />
            {t(($) => $.sync.unbound_title)}
            {unbound.length > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {unbound.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.sync.unbound_hint)}
          </p>
          {unboundQuery.isPending ? (
            <QueryLoading rows={3} />
          ) : unboundQuery.isError ? (
            <QueryError
              compact
              onRetry={() => void unboundQuery.refetch()}
              message={String(unboundQuery.error)}
            />
          ) : unboundGroups.length === 0 ? (
            <ArchiveEmpty
              title={t(($) => $.sync.unbound_empty)}
              icon={<Link2Off className="size-4" />}
            />
          ) : requirements.length === 0 ? (
            <p className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-caption text-muted-foreground">
              {t(($) => $.sync.no_requirements)}
            </p>
          ) : (
            <ul className="space-y-3" data-testid="archive-unbound-list">
              {unboundGroups.map((group) => (
                <UnboundGroup
                  key={group.key}
                  groupKey={group.key}
                  items={group.items}
                  projectId={projectId}
                  requirements={requirements}
                  onEdit={onEdit}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-title-sm">
            <Terminal className="size-4 text-muted-foreground" />
            {t(($) => $.sync.cli_title)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.sync.revalidate_hint)}
          </p>
          <code className="block rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-[11px]">
            {t(($) => $.sync.cli_command)}
          </code>
        </CardContent>
      </Card>
    </div>
  );
}

function UnboundGroup({
  groupKey,
  items,
  projectId,
  requirements,
  onEdit,
}: {
  groupKey: string;
  items: ProjectArtifact[];
  projectId: string;
  requirements: Issue[];
  onEdit?: (artifact: ProjectArtifact) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const bind = useBindArtifact(wsId, projectId);
  const suggested =
    items.length > 0 ? suggestRequirement(items[0]!, requirements) : null;
  const [groupIssueId, setGroupIssueId] = useState<string | null>(
    suggested?.id ?? null,
  );
  const issueItems = requirements.map((issue) => ({
    value: issue.id,
    label: `${issue.identifier} ${issue.title}`,
  }));

  const bindAll = async () => {
    if (!groupIssueId) return;
    try {
      for (const artifact of items) {
        await bind.mutateAsync({ artifactId: artifact.id, issueId: groupIssueId });
      }
      const issue = requirements.find((row) => row.id === groupIssueId);
      toast.success(
        t(($) => $.sync.bind_issue_ok, { id: issue?.identifier ?? groupIssueId }),
      );
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.sync.bind_failed));
    }
  };

  return (
    <li className="rounded-lg border border-surface-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-caption font-medium">
            {groupKey === "__none__" ? t(($) => $.sync.none_key) : groupKey}
          </code>
          <Badge variant="secondary">
            {t(($) => $.sync.artifact_count, { count: items.length })}
          </Badge>
        </div>
        {items.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              items={issueItems}
              value={groupIssueId}
              onValueChange={(value) => setGroupIssueId(value)}
            >
              <SelectTrigger className="min-w-52" aria-label={t(($) => $.sync.pick_issue)}>
                <SelectValue placeholder={t(($) => $.sync.pick_issue)} />
              </SelectTrigger>
              <SelectContent>
                {requirements.map((issue) => (
                  <SelectItem key={issue.id} value={issue.id}>
                    {issue.identifier} {issue.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="xs"
              disabled={!groupIssueId || bind.isPending}
              onClick={() => void bindAll()}
            >
              {t(($) => $.sync.bind_all_group)}
            </Button>
          </div>
        )}
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((artifact) => (
          <UnboundRow
            key={artifact.id}
            artifact={artifact}
            projectId={projectId}
            requirements={requirements}
            onEdit={onEdit}
          />
        ))}
      </ul>
    </li>
  );
}

function UnboundRow({
  artifact,
  projectId,
  requirements,
  onEdit,
}: {
  artifact: ProjectArtifact;
  projectId: string;
  requirements: Issue[];
  onEdit?: (artifact: ProjectArtifact) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const remove = useDeleteArtifact(wsId, projectId);
  const suggested = suggestRequirement(artifact, requirements);
  const [issueId, setIssueId] = useState<string | null>(suggested?.id ?? null);
  const issueItems = requirements.map((issue) => ({
    value: issue.id,
    label: `${issue.identifier} ${issue.title}`,
  }));

  const confirmRemove = () => {
    if (
      !window.confirm(
        t(($) => $.mapping.remove_confirm, {
          name: artifactDisplayName(artifact.rel_path),
        }),
      )
    ) {
      return;
    }
    void remove
      .mutateAsync(artifact.id)
      .then(() => toast.success(t(($) => $.manage.deleted)))
      .catch((err) =>
        toast.error(clientErrorMessage(err) ?? t(($) => $.manage.delete_failed)),
      );
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-surface-border px-2 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-caption font-medium" title={artifact.rel_path}>
          {artifactDisplayName(artifact.rel_path)}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={artifact.rel_path}>
          {artifact.rel_path}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {suggested && issueId === suggested.id && (
          <Badge variant="outline">{t(($) => $.sync.suggested)}</Badge>
        )}
        <Select
          items={issueItems}
          value={issueId}
          onValueChange={(value) => setIssueId(value)}
        >
          <SelectTrigger className="min-w-48" aria-label={t(($) => $.sync.pick_issue)}>
            <SelectValue placeholder={t(($) => $.sync.pick_issue)} />
          </SelectTrigger>
          <SelectContent>
            {requirements.map((issue) => (
              <SelectItem key={issue.id} value={issue.id}>
                {issue.identifier} {issue.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <BindButton
          projectId={projectId}
          artifactId={artifact.id}
          issueId={issueId}
          issueLabel={
            requirements.find((issue) => issue.id === issueId)?.identifier ?? issueId ?? ""
          }
        />
        {onEdit && (
          <Button type="button" size="xs" variant="ghost" onClick={() => onEdit(artifact)}>
            {t(($) => $.manage.edit)}
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={remove.isPending}
          onClick={confirmRemove}
        >
          {t(($) => $.sync.remove_index)}
        </Button>
      </div>
    </li>
  );
}

function BindButton({
  projectId,
  artifactId,
  issueId,
  issueLabel,
}: {
  projectId: string;
  artifactId: string;
  issueId: string | null;
  issueLabel: string;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const bind = useBindArtifact(wsId, projectId);
  return (
    <Button
      type="button"
      size="xs"
      disabled={!issueId || bind.isPending}
      onClick={() => {
        if (!issueId) return;
        void bind
          .mutateAsync({ artifactId, issueId })
          .then(() => toast.success(t(($) => $.sync.bind_issue_ok, { id: issueLabel })))
          .catch((err) =>
            toast.error(clientErrorMessage(err) ?? t(($) => $.sync.bind_failed)),
          );
      }}
    >
      {t(($) => $.sync.bind)}
    </Button>
  );
}
