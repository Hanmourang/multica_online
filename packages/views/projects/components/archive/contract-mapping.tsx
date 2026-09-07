"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderSearch, FolderTree, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { clientErrorMessage } from "@multica/core/api";
import { useDeleteArtifact } from "@multica/core/artifacts";
import { projectArtifactListOptions } from "@multica/core/artifacts/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import type { ProjectArtifact } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../../../i18n";
import { artifactDisplayName } from "./archive-display";
import { ArchiveRootCard } from "./archive-root-card";
import { ArchiveEmpty, QueryError, QueryLoading } from "./query-states";

/**
 * 档案设置：档案根绑定 + 已索引指针的增删改。
 *
 * 路径规则仍以 CONTRACT.md 为事实源，UI 不另造规则表，所以目录契约只读。
 */
export function ContractMapping({
  projectId,
  onCreate,
  onEdit,
  onImport,
}: {
  projectId: string;
  onCreate?: () => void;
  onEdit?: (artifact: ProjectArtifact) => void;
  onImport?: () => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const listQuery = useQuery(projectArtifactListOptions(wsId, projectId));
  const [query, setQuery] = useState("");
  const artifacts = useMemo(() => {
    const rows = listQuery.data?.artifacts ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (artifact) =>
        artifact.rel_path.toLowerCase().includes(needle) ||
        artifact.doc_type.toLowerCase().includes(needle) ||
        (artifact.requirement_key ?? "").toLowerCase().includes(needle),
    );
  }, [listQuery.data, query]);

  const dirRows = [
    { path: "_shared/", label: t(($) => $.mapping.dir_shared) },
    { path: "overview/", label: t(($) => $.mapping.dir_overview) },
    { path: "requirements/", label: t(($) => $.mapping.dir_requirements) },
    { path: "filing/", label: t(($) => $.mapping.dir_filing) },
    { path: "change_logs/", label: t(($) => $.mapping.dir_changelogs) },
  ];

  return (
    <div className="space-y-4" data-testid="archive-contract-mapping">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-title-sm font-medium">{t(($) => $.mapping.title)}</h3>
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.mapping.subtitle)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onImport && (
            <Button type="button" size="xs" variant="outline" onClick={onImport}>
              <FolderSearch />
              {t(($) => $.import.action)}
            </Button>
          )}
          {onCreate && (
            <Button type="button" size="xs" onClick={onCreate}>
              <Plus />
              {t(($) => $.manage.create)}
            </Button>
          )}
        </div>
      </div>

      <ArchiveRootCard projectId={projectId} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-title-sm">
              <FolderTree className="size-4 text-muted-foreground" />
              {t(($) => $.mapping.dir_title)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-caption leading-relaxed text-muted-foreground">
              {t(($) => $.mapping.rules_readonly)}
            </p>
            {dirRows.map((row) => (
              <div
                key={row.path}
                className="flex flex-col gap-1 rounded-lg border border-surface-border bg-surface px-3 py-2"
              >
                <code className="text-caption font-medium">{row.path}</code>
                <span className="text-caption leading-relaxed text-muted-foreground">
                  {row.label}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-title-sm">
              <Layers className="size-4 text-muted-foreground" />
              {t(($) => $.mapping.stage_title)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-caption leading-relaxed text-muted-foreground">
              {t(($) => $.mapping.stage_rule)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {[1, 2, 3, 4].map((stage) => (
                <Badge key={stage} variant="secondary">
                  {`s${stage}`}
                </Badge>
              ))}
              <Badge variant="outline">{t(($) => $.browser.stage_all)}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-title-sm">{t(($) => $.mapping.index_title)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.mapping.index_hint)}
          </p>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(($) => $.mapping.index_search)}
            aria-label={t(($) => $.mapping.index_search)}
          />
          {listQuery.isPending ? (
            <QueryLoading rows={4} />
          ) : listQuery.isError ? (
            <QueryError
              compact
              onRetry={() => void listQuery.refetch()}
              message={String(listQuery.error)}
            />
          ) : artifacts.length === 0 ? (
            <ArchiveEmpty title={t(($) => $.mapping.index_empty)} />
          ) : (
            <ul className="divide-y divide-surface-border rounded-lg border border-surface-border">
              {artifacts.map((artifact) => (
                <IndexRow
                  key={artifact.id}
                  artifact={artifact}
                  projectId={projectId}
                  onEdit={onEdit}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function IndexRow({
  artifact,
  projectId,
  onEdit,
}: {
  artifact: ProjectArtifact;
  projectId: string;
  onEdit?: (artifact: ProjectArtifact) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const remove = useDeleteArtifact(wsId, projectId);
  const name = artifactDisplayName(artifact.rel_path);

  const confirmRemove = () => {
    if (!window.confirm(t(($) => $.mapping.remove_confirm, { name }))) return;
    void remove
      .mutateAsync(artifact.id)
      .then(() => toast.success(t(($) => $.manage.deleted)))
      .catch((err) =>
        toast.error(clientErrorMessage(err) ?? t(($) => $.manage.delete_failed)),
      );
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-caption font-medium" title={artifact.rel_path}>
          {name}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <code className="truncate font-mono" title={artifact.rel_path}>
            {artifact.rel_path}
          </code>
          <Badge variant="outline">{artifact.scope}</Badge>
          {artifact.stage ? <Badge variant="outline">{`S${artifact.stage}`}</Badge> : null}
          <Badge variant="secondary">{artifact.doc_type}</Badge>
          <Badge variant="outline">{artifact.source}</Badge>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {onEdit && (
          <Button type="button" size="xs" variant="ghost" onClick={() => onEdit(artifact)}>
            <Pencil />
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
          <Trash2 />
          {t(($) => $.manage.delete)}
        </Button>
      </div>
    </li>
  );
}
