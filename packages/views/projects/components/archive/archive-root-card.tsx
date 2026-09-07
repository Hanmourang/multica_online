"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { toast } from "sonner";
import { clientErrorMessage } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  projectDetailOptions,
  projectResourcesOptions,
  useUpdateProject,
} from "@multica/core/projects";
import type { LocalDirectoryResourceRef, ProjectResource } from "@multica/core/types";
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
import { useT } from "../../../i18n";
import { QueryError, QueryLoading } from "./query-states";

function localPathOf(resource: ProjectResource): string | null {
  if (resource.resource_type !== "local_directory") return null;
  return (resource.resource_ref as LocalDirectoryResourceRef).local_path ?? null;
}

function resourceLabel(resource: ProjectResource): string {
  return localPathOf(resource) ?? resource.label ?? resource.id;
}

export function ArchiveRootCard({ projectId }: { projectId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const projectQuery = useQuery(projectDetailOptions(wsId, projectId));
  const resourcesQuery = useQuery(projectResourcesOptions(wsId, projectId));
  const updateProject = useUpdateProject();
  const locals = useMemo(
    () =>
      (resourcesQuery.data ?? []).filter(
        (resource) => resource.resource_type === "local_directory",
      ),
    [resourcesQuery.data],
  );
  const boundId = projectQuery.data?.archive_resource_id ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked ?? boundId ?? locals[0]?.id ?? null;
  const selectItems = locals.map((resource) => ({
    value: resource.id,
    label: resourceLabel(resource),
  }));
  const bound = locals.find((resource) => resource.id === boundId);

  const bind = async (resourceId: string | null) => {
    try {
      await updateProject.mutateAsync({
        id: projectId,
        archive_resource_id: resourceId,
      });
      setPicked(resourceId);
      toast.success(
        resourceId ? t(($) => $.sync.bind_ok) : t(($) => $.sync.unbind_ok),
      );
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.sync.bind_need_resource));
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-title-sm">
          <FolderGit2 className="size-4 text-muted-foreground" />
          {t(($) => $.sync.source_title)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-caption leading-relaxed text-muted-foreground">
          {t(($) => $.mapping.root_hint)}
        </p>
        {projectQuery.isPending || resourcesQuery.isPending ? (
          <QueryLoading rows={2} />
        ) : projectQuery.isError || resourcesQuery.isError ? (
          <QueryError
            compact
            onRetry={() => {
              void projectQuery.refetch();
              void resourcesQuery.refetch();
            }}
          />
        ) : locals.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.sync.bind_need_resource)}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                items={selectItems}
                value={selectedId}
                onValueChange={(value) => value && setPicked(value)}
              >
                <SelectTrigger className="min-w-64" aria-label={t(($) => $.sync.source_path)}>
                  <SelectValue placeholder={t(($) => $.sync.source_none)} />
                </SelectTrigger>
                <SelectContent>
                  {locals.map((resource) => (
                    <SelectItem key={resource.id} value={resource.id}>
                      {resourceLabel(resource)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                disabled={!selectedId || updateProject.isPending || selectedId === boundId}
                onClick={() => selectedId && void bind(selectedId)}
              >
                {t(($) => $.sync.bind_action)}
              </Button>
              {boundId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={updateProject.isPending}
                  onClick={() => void bind(null)}
                >
                  {t(($) => $.sync.unbind_action)}
                </Button>
              )}
            </div>
            <div className="text-caption text-muted-foreground">
              {boundId ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{t(($) => $.sync.bound)}</Badge>
                  <code className="font-mono text-[11px]">
                    {bound ? resourceLabel(bound) : boundId}
                  </code>
                </span>
              ) : (
                t(($) => $.sync.source_none)
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
