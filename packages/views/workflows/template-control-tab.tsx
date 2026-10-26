"use client";

/**
 * 模板编辑器第三 TAB「流程把控」（对标原型 flow-control TAB，plan 20261025 §A2）。
 *
 * 原型的这一页不是「再编辑模板」，而是「这条模板正在哪些需求上跑到哪一步」：
 * 项目选择器 → 该模板在本项目的实例列表 → 内嵌实例详情。刻意不新增后端端点，
 * 全部复用 workflowInstancesOptions + WorkflowInstanceDetail，避免运行视图出现
 * 第二个事实源。项目选择存在本组件 state 里，进入详情是同级覆盖渲染（组件不
 * 卸载），因此「返回列表不丢项目选择」（验收 A-1）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { projectListOptions } from "@multica/core/projects";
import { workflowInstancesOptions } from "@multica/core/workflow";
import type { WorkflowInstance, WorkflowTemplate } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { AppLink } from "../navigation";
import { QueryError, QueryLoading } from "../projects/components/archive/query-states";
import {
  InstanceStatusBadge,
  formatDateTime,
} from "../projects/components/workflows/workflow-shared";
import { WorkflowInstanceDetail } from "../projects/components/workflows/workflow-instance-detail";

export function TemplateControlTab({ template }: { template: WorkflowTemplate }) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const projectsQuery = useQuery(projectListOptions(wsId));
  const projects = projectsQuery.data ?? [];
  // 默认落在模板自己的项目上；工作区级官方模板（project_id 为空）退到首个项目。
  const [pickedProjectId, setPickedProjectId] = useState("");
  const projectId = pickedProjectId || template.project_id || projects[0]?.id || "";
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  // 项目列表未加载完（或模板指向列表外的项目）时，select 里没有对应 option，
  // 原生控件会把值显示成空白——补一个占位 option 让选择与实际查询一致。
  const inProjectList = projects.some((project) => project.id === projectId);

  if (selectedInstanceId && projectId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="workflow-control-detail">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="self-start"
          onClick={() => setSelectedInstanceId(null)}
        >
          <ArrowLeft />
          {t(($) => $.editor.control_back)}
        </Button>
        <WorkflowInstanceDetail
          projectId={projectId}
          instanceId={selectedInstanceId}
          onBack={() => setSelectedInstanceId(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="workflow-control-tab">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption text-muted-foreground">{t(($) => $.editor.control_project)}</span>
        <select
          value={projectId}
          onChange={(event) => setPickedProjectId(event.target.value)}
          className="h-8 rounded-md border border-surface-border bg-background px-2 text-caption"
          aria-label={t(($) => $.editor.control_project)}
          data-testid="workflow-control-project"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
          {projectId && !inProjectList ? (
            <option value={projectId}>{projectId.slice(0, 8)}</option>
          ) : null}
        </select>
        <AppLink
          href={paths.projectView(projectId, "workflows")}
          className="text-caption text-muted-foreground underline-offset-2 hover:underline"
        >
          {t(($) => $.editor.control_open_runs)}
        </AppLink>
      </div>

      {!projectId ? (
        <p className="text-caption text-muted-foreground">{t(($) => $.gallery.no_projects)}</p>
      ) : (
        <RunList
          wsId={wsId}
          projectId={projectId}
          templateId={template.id}
          onOpen={setSelectedInstanceId}
        />
      )}
    </div>
  );
}

function RunList({
  wsId,
  projectId,
  templateId,
  onOpen,
}: {
  wsId: string;
  projectId: string;
  templateId: string;
  onOpen: (instanceId: string) => void;
}) {
  const { t } = useT("workflow");
  const instancesQuery = useQuery(workflowInstancesOptions(wsId, projectId, {}));

  if (instancesQuery.isPending) {
    return (
      <div className="p-3">
        <QueryLoading rows={3} />
      </div>
    );
  }
  if (instancesQuery.isError) {
    return (
      <QueryError
        onRetry={() => void instancesQuery.refetch()}
        message={String(instancesQuery.error)}
      />
    );
  }

  // 按 template_id 过滤留在前端：列表端点已按项目收窄，量级小且不引入新查询键。
  const runs = (instancesQuery.data?.instances ?? []).filter(
    (row) => row.template_id === templateId,
  );

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-surface-border p-6 text-center">
        <p className="text-caption text-muted-foreground">{t(($) => $.editor.control_empty)}</p>
      </div>
    );
  }

  return (
    <ul className="min-h-0 divide-y divide-surface-border overflow-y-auto rounded-lg border border-surface-border">
      {runs.map((row) => (
        <RunRow key={row.id} row={row} onOpen={() => onOpen(row.id)} />
      ))}
    </ul>
  );
}

function RunRow({ row, onOpen }: { row: WorkflowInstance; onOpen: () => void }) {
  const { t } = useT("workflow");
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <InstanceStatusBadge status={row.status} />
      <span className="font-mono text-micro text-muted-foreground">{row.id.slice(0, 8)}</span>
      <span className="text-caption text-muted-foreground">{`v${row.template_version}`}</span>
      <span className="text-caption text-muted-foreground">
        {formatDateTime(row.created_at)}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="ml-auto"
        onClick={onOpen}
        data-testid={`workflow-control-open-${row.id.slice(0, 8)}`}
      >
        {t(($) => $.actions.detail)}
      </Button>
    </li>
  );
}
