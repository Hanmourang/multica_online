"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, FolderSearch, Link2Off, RefreshCw, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { toast } from "sonner";
import { clientErrorMessage } from "@multica/core/api";
import {
  useBindArtifact,
  useDeleteArtifact,
  usePutArchiveSyncConfig,
} from "@multica/core/artifacts";
import { useCreateIssue } from "@multica/core/issues/mutations";
import {
  archiveSyncConfigOptions,
  archiveSyncDiagnosticsOptions,
  projectArtifactListOptions,
  unboundArtifactsOptions,
} from "@multica/core/artifacts/queries";
import { listArchiveDocs, readArchiveFile, writeArchiveFile } from "../../../platform/archive-fs";
import { resolveInboxRoots } from "./requirement-scaffold";
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
import {
  groupUnboundArtifacts,
  rankRequirementMatches,
  suggestRequirement,
} from "./archive-bind-helpers";
import { upsertArchiveFrontmatter } from "./archive-frontmatter";
import {
  batchBindPercent,
  PLANNING_SHELVES,
  splitInboxAbsolutePath,
  suggestInboxAdopt,
  suggestedAdoptRelPath,
  writebackArtifactFrontmatter,
  type PlanningShelf,
} from "./archive-mapping";
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
  archiveRoot,
  onImport,
  onDesktopSync,
  desktopSyncPending,
  onEdit,
}: {
  projectId: string;
  archiveRoot?: string | null;
  onImport?: () => void;
  onDesktopSync?: () => void;
  desktopSyncPending?: boolean;
  onEdit?: (artifact: ProjectArtifact) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const desktop = isDesktopShell();
  const daemon = useLocalDaemonStatus();

  const listQuery = useQuery(projectArtifactListOptions(wsId, projectId));
  const snapshotQuery = useQuery(latestGraphSnapshotOptions(wsId, projectId));
  const unboundQuery = useQuery(unboundArtifactsOptions(wsId, projectId));
  const diagQuery = useQuery(archiveSyncDiagnosticsOptions(wsId, projectId));
  const syncConfigQuery = useQuery(archiveSyncConfigOptions(wsId, projectId));
  const putSyncConfig = usePutArchiveSyncConfig(wsId, projectId);
  const [writebackFrontmatter, setWritebackFrontmatter] = useState(true);
  const bindThreshold = batchBindPercent(
    syncConfigQuery.data?.batch_bind_threshold,
  );
  const inboxQuery = useQuery({
    queryKey: ["archive-inbox", archiveRoot],
    enabled: Boolean(desktop && archiveRoot),
    queryFn: async () => {
      const files: string[] = [];
      for (const root of resolveInboxRoots(archiveRoot)) {
        const listed = await listArchiveDocs(root);
        if (!listed.ok) continue;
        for (const rel of listed.files ?? []) {
          if (rel.endsWith(".md")) files.push(`${root}/${rel}`.replace(/\/+/g, "/"));
        }
      }
      return files;
    },
  });
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
        .map((artifact) => {
          const match = rankRequirementMatches(artifact, requirements)[0];
          return match
            ? { artifact, issue: match.issue, confidence: match.confidence }
            : null;
        })
        .filter(
          (row): row is { artifact: ProjectArtifact; issue: Issue; confidence: number } =>
            row !== null,
        ),
    [unbound, requirements],
  );
  const highGroups = useMemo(
    () =>
      unboundGroups.filter((group) => {
        const first = group.items[0];
        if (!first) return false;
        const match = rankRequirementMatches(first, requirements)[0];
        return Boolean(match && match.confidence >= bindThreshold);
      }),
    [bindThreshold, unboundGroups, requirements],
  );
  const pipe = useMemo(() => deriveSyncPipe(diagQuery.data ?? []), [diagQuery.data]);
  const createIssue = useCreateIssue();
  const bindIssue = useBindArtifact(wsId, projectId);

  const bindHighConfidence = async () => {
    try {
      for (const group of highGroups) {
        const first = group.items[0];
        if (!first) continue;
        const match = rankRequirementMatches(first, requirements)[0];
        if (!match) continue;
        for (const artifact of group.items) {
          await bindIssue.mutateAsync({ artifactId: artifact.id, issueId: match.issue.id });
          await maybeWritebackBinding({
            archiveRoot,
            artifact,
            issueId: match.issue.id,
            enabled: writebackFrontmatter,
          });
        }
      }
      toast.success(
        t(($) => $.sync.batch_high, { n: highGroups.length, pct: bindThreshold }),
      );
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.sync.bind_failed));
    }
  };

  const [revalidating, setRevalidating] = useState(false);
  const refreshAll = () => {
    void listQuery.refetch();
    void snapshotQuery.refetch();
    void unboundQuery.refetch();
    void diagQuery.refetch();
    void inboxQuery.refetch();
    void issuesQuery.refetch();
  };
  const handleRevalidate = () => {
    setRevalidating(true);
    void Promise.allSettled([
      listQuery.refetch(),
      snapshotQuery.refetch(),
      unboundQuery.refetch(),
      diagQuery.refetch(),
      inboxQuery.refetch(),
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
    diagQuery.isFetching ||
    inboxQuery.isFetching ||
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
            {onDesktopSync && (
              <Button
                type="button"
                size="xs"
                onClick={onDesktopSync}
                disabled={desktopSyncPending}
                data-testid="archive-desktop-sync"
              >
                <Terminal className={desktopSyncPending ? "animate-pulse" : undefined} />
                {desktopSyncPending
                  ? t(($) => $.sync.trigger_pending)
                  : t(($) => $.sync.trigger)}
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
          <CardTitle className="text-title-sm">{t(($) => $.sync.policy_title)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-caption text-muted-foreground">{t(($) => $.sync.policy_hint)}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["path_first", "review_queue"] as const).map((policy) => {
              const active =
                (syncConfigQuery.data?.conflict_policy ?? "path_first") === policy;
              return (
                <button
                  key={policy}
                  type="button"
                  disabled={putSyncConfig.isPending}
                  onClick={() =>
                    void putSyncConfig
                      .mutateAsync({
                        sync_mode: syncConfigQuery.data?.sync_mode ?? "manual",
                        conflict_policy: policy,
                        batch_bind_threshold:
                          syncConfigQuery.data?.batch_bind_threshold ?? 0.85,
                        scope_filter: syncConfigQuery.data?.scope_filter ?? {},
                      })
                      .then(() => toast.success(t(($) => $.sync.policy_saved)))
                      .catch((err) =>
                        toast.error(
                          clientErrorMessage(err) ?? t(($) => $.sync.policy_save_failed),
                        ),
                      )
                  }
                  className={`rounded-lg border px-3 py-2 text-left ${
                    active
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : "border-surface-border bg-surface"
                  }`}
                >
                  <div className="text-caption font-medium">
                    {policy === "path_first"
                      ? t(($) => $.sync.policy_path_first)
                      : t(($) => $.sync.policy_review_queue)}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {policy === "path_first"
                      ? t(($) => $.sync.policy_path_first_hint)
                      : t(($) => $.sync.policy_review_queue_hint)}
                  </p>
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-caption">
            <input
              type="checkbox"
              checked={writebackFrontmatter}
              onChange={(event) => setWritebackFrontmatter(event.target.checked)}
            />
            {t(($) => $.sync.writeback_default)}
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-title-sm">{t(($) => $.sync.pipeline_title)}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-caption text-muted-foreground">{t(($) => $.sync.pipeline_hint)}</p>
          <div className="grid gap-2 sm:grid-cols-5">
            {pipe.map((step) => (
              <div
                key={step.id}
                className={`rounded-lg border px-3 py-2 ${
                  step.status === "bad"
                    ? "border-destructive/40 bg-destructive/5"
                    : step.status === "ok"
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : "border-surface-border bg-surface"
                }`}
              >
                <div className="text-caption font-medium">{pipeLabel(t, step.id)}</div>
                <div className="text-[10px] text-muted-foreground">
                  {step.status === "ok"
                    ? t(($) => $.sync.stage_done)
                    : step.status === "bad"
                      ? t(($) => $.sync.diag_title)
                      : t(($) => $.sync.pipe_pending)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

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
              {candidates.map(({ artifact, issue, confidence }) => (
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
                      <Badge variant="secondary">
                        {t(($) => $.sync.confidence, { n: confidence })}
                      </Badge>
                      <span className="font-mono">
                        {issue.identifier} {issue.title}
                      </span>
                    </div>
                  </div>
                  <BindButton
                    projectId={projectId}
                    artifact={artifact}
                    issueId={issue.id}
                    issueLabel={issue.identifier}
                    archiveRoot={archiveRoot}
                    writeback={writebackFrontmatter}
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
            {t(($) => $.sync.diag_title)}
            {(diagQuery.data?.length ?? 0) > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {diagQuery.data?.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-caption text-muted-foreground">{t(($) => $.sync.diag_hint)}</p>
          {diagQuery.isPending ? (
            <QueryLoading rows={2} />
          ) : (diagQuery.data?.length ?? 0) === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.sync.diag_empty)}</p>
          ) : (
            <ul className="space-y-1.5">
              {(diagQuery.data ?? []).slice(0, 20).map((entry) => (
                <li key={entry.id ?? `${entry.sync_run_id}-${entry.rel_path}`} className="text-caption">
                  <code className="font-mono">{entry.rel_path ?? "—"}</code>
                  <span className="ml-2 text-muted-foreground">{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-title-sm">
            {t(($) => $.sync.inbox_title)}
            {(inboxQuery.data?.length ?? 0) > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {inboxQuery.data?.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-caption text-muted-foreground">{t(($) => $.sync.inbox_hint)}</p>
          {!desktop ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.sync.inbox_empty)}</p>
          ) : inboxQuery.isPending ? (
            <QueryLoading rows={2} />
          ) : (inboxQuery.data?.length ?? 0) === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.sync.inbox_empty)}</p>
          ) : (
            <ul className="space-y-2">
              {(inboxQuery.data ?? []).map((path) => (
                <InboxAdoptRow
                  key={path}
                  path={path}
                  archiveRoot={archiveRoot}
                  inboxRoots={resolveInboxRoots(archiveRoot)}
                  onAdopted={() => void inboxQuery.refetch()}
                />
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
          {highGroups.length > 0 && (
            <Button
              type="button"
              size="xs"
              disabled={bindIssue.isPending}
              onClick={() => void bindHighConfidence()}
            >
              {t(($) => $.sync.batch_high, { n: highGroups.length, pct: bindThreshold })}
            </Button>
          )}
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
                  archiveRoot={archiveRoot}
                  writeback={writebackFrontmatter}
                  bindThreshold={bindThreshold}
                  onEdit={onEdit}
                  onCreateAndBind={async (items, key) => {
                    const issue = await createIssue.mutateAsync({
                      title: key === "__none__" ? items[0]?.rel_path ?? "archive" : key,
                      project_id: projectId,
                      decompose_mode: "manual",
                      auto_trigger: false,
                    });
                    for (const artifact of items) {
                      await bindIssue.mutateAsync({
                        artifactId: artifact.id,
                        issueId: issue.id,
                      });
                      await maybeWritebackBinding({
                        archiveRoot,
                        artifact,
                        issueId: issue.id,
                        enabled: writebackFrontmatter,
                      });
                    }
                    toast.success(
                      t(($) => $.sync.bind_issue_ok, { id: issue.identifier }),
                    );
                  }}
                  creating={createIssue.isPending || bindIssue.isPending}
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
          <div className="space-y-1.5">
            <div className="text-caption font-medium">{t(($) => $.sync.contract_title)}</div>
            <ul className="space-y-1 text-caption text-muted-foreground">
              <li className="font-mono">projects/&lt;key&gt;/ → project_key</li>
              <li className="font-mono">overview/&lt;shelf&gt;/ → scope=project</li>
              <li className="font-mono">requirements/&lt;REQ-KEY&gt;/sN-… → stage N</li>
              <li className="font-mono">filing/&lt;cat&gt;/ → filing-*</li>
              <li className="font-mono">_attic/ · dist/ · vendor/ → skip</li>
            </ul>
          </div>
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
  archiveRoot,
  writeback,
  bindThreshold,
  onEdit,
  onCreateAndBind,
  creating,
}: {
  groupKey: string;
  items: ProjectArtifact[];
  projectId: string;
  requirements: Issue[];
  archiveRoot?: string | null;
  writeback: boolean;
  bindThreshold: number;
  onEdit?: (artifact: ProjectArtifact) => void;
  onCreateAndBind?: (items: ProjectArtifact[], key: string) => Promise<void>;
  creating?: boolean;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const bind = useBindArtifact(wsId, projectId);
  const topMatch =
    items.length > 0 ? rankRequirementMatches(items[0]!, requirements)[0] : null;
  const suggested = topMatch?.issue ?? null;
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
        await maybeWritebackBinding({
          archiveRoot,
          artifact,
          issueId: groupIssueId,
          enabled: writeback,
        });
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
          {topMatch && (
            <Badge variant="outline">
              {t(($) => $.sync.confidence, { n: topMatch.confidence })}
            </Badge>
          )}
          {(!topMatch || topMatch.confidence < bindThreshold) && onCreateAndBind && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={creating}
              onClick={() =>
                void onCreateAndBind(items, groupKey).catch((err) =>
                  toast.error(clientErrorMessage(err) ?? t(($) => $.sync.bind_failed)),
                )
              }
            >
              {t(($) => $.sync.create_and_bind)}
            </Button>
          )}
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
            archiveRoot={archiveRoot}
            writeback={writeback}
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
  archiveRoot,
  writeback,
  onEdit,
}: {
  artifact: ProjectArtifact;
  projectId: string;
  requirements: Issue[];
  archiveRoot?: string | null;
  writeback: boolean;
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
          artifact={artifact}
          issueId={issueId}
          issueLabel={
            requirements.find((issue) => issue.id === issueId)?.identifier ?? issueId ?? ""
          }
          archiveRoot={archiveRoot}
          writeback={writeback}
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
  artifact,
  issueId,
  issueLabel,
  archiveRoot,
  writeback,
}: {
  projectId: string;
  artifact: ProjectArtifact;
  issueId: string | null;
  issueLabel: string;
  archiveRoot?: string | null;
  writeback: boolean;
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
          .mutateAsync({ artifactId: artifact.id, issueId })
          .then(async () => {
            const written = await maybeWritebackBinding({
              archiveRoot,
              artifact,
              issueId,
              enabled: writeback,
            });
            toast.success(
              written
                ? t(($) => $.sync.bind_writeback_ok, { id: issueLabel })
                : t(($) => $.sync.bind_issue_ok, { id: issueLabel }),
            );
          })
          .catch((err) =>
            toast.error(clientErrorMessage(err) ?? t(($) => $.sync.bind_failed)),
          );
      }}
    >
      {t(($) => $.sync.bind)}
    </Button>
  );
}

async function maybeWritebackBinding(input: {
  archiveRoot?: string | null;
  artifact: ProjectArtifact;
  issueId: string;
  enabled: boolean;
}): Promise<boolean> {
  if (!input.enabled || !input.archiveRoot) return false;
  const result = await writebackArtifactFrontmatter({
    archiveRoot: input.archiveRoot,
    relPath: input.artifact.rel_path,
    issueId: input.issueId,
    docType: input.artifact.doc_type,
    docClass: input.artifact.doc_class ?? null,
    requirementKey: input.artifact.requirement_key ?? null,
  });
  return result.ok;
}

function InboxAdoptRow({
  path,
  archiveRoot,
  inboxRoots,
  onAdopted,
}: {
  path: string;
  archiveRoot?: string | null;
  inboxRoots: string[];
  onAdopted: () => void;
}) {
  const { t } = useT("archive");
  const suggestion = suggestInboxAdopt(path);
  const [shelf, setShelf] = useState<PlanningShelf>(suggestion.shelf);
  const [pending, setPending] = useState(false);
  const parts = splitInboxAbsolutePath(path, inboxRoots);

  const adopt = async () => {
    if (!archiveRoot || !parts) {
      toast.error(t(($) => $.sync.inbox_adopt_failed));
      return;
    }
    setPending(true);
    try {
      const read = await readArchiveFile(parts.root, parts.relPath);
      if (!read.ok || read.content == null) {
        toast.error(t(($) => $.sync.inbox_adopt_failed));
        return;
      }
      const dest = suggestedAdoptRelPath(parts.relPath, shelf);
      const existing = await readArchiveFile(archiveRoot, dest);
      if (existing.ok && existing.content) {
        toast.error(t(($) => $.sync.inbox_exists, { path: dest }));
        return;
      }
      const hint = suggestInboxAdopt(parts.relPath, read.content);
      const body = upsertArchiveFrontmatter(read.content, {
        docType: shelf,
        docClass: hint.docClass ?? null,
      });
      const written = await writeArchiveFile(archiveRoot, dest, body);
      if (!written.ok) {
        toast.error(t(($) => $.sync.inbox_adopt_failed));
        return;
      }
      toast.success(t(($) => $.sync.inbox_adopted, { path: dest }));
      onAdopted();
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface px-3 py-2">
      <code className="min-w-0 truncate font-mono text-caption" title={path}>
        {path.split("/").slice(-2).join("/")}
      </code>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          items={PLANNING_SHELVES.map((value) => ({ value, label: value }))}
          value={shelf}
          onValueChange={(value) => value && setShelf(value as PlanningShelf)}
        >
          <SelectTrigger className="min-w-40" aria-label={t(($) => $.sync.inbox_pick_shelf)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLANNING_SHELVES.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="xs"
          disabled={pending || !archiveRoot}
          onClick={() => void adopt()}
        >
          {t(($) => $.sync.inbox_adopt)}
        </Button>
      </div>
    </li>
  );
}

const PIPE_STAGES = ["scan", "parse", "upload", "index", "recount"] as const;

function deriveSyncPipe(
  diagnostics: { stage?: string; level?: string }[],
): { id: (typeof PIPE_STAGES)[number]; status: "ok" | "bad" | "pending" }[] {
  return PIPE_STAGES.map((id) => {
    const rows = diagnostics.filter((row) => row.stage === id);
    if (rows.some((row) => row.level === "error")) return { id, status: "bad" as const };
    if (rows.length > 0) return { id, status: "ok" as const };
    return { id, status: "pending" as const };
  });
}

function pipeLabel(
  t: ReturnType<typeof useT<"archive">>["t"],
  id: (typeof PIPE_STAGES)[number],
): string {
  switch (id) {
    case "scan":
      return t(($) => $.sync.stage_scan);
    case "parse":
      return t(($) => $.sync.stage_parse);
    case "upload":
      return t(($) => $.sync.stage_upload);
    case "index":
      return t(($) => $.sync.stage_index);
    case "recount":
      return t(($) => $.sync.stage_recompute);
  }
}
