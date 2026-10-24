"use client";

/**
 * 需求抽屉（B4 工作台）右栏的紧凑工作流块 —— 计划 01_工作流模块.md §G，
 * 对标 CoCo「工作项详情 → 发起 workflow-instances → instancesByWorkitem 反查」
 * 主动线：反查该 issue 挂过的实例（issueWorkflowInstancesOptions），并可从
 * published 模板就地发起（useCreateWorkflowInstance 带 issue_id → root_issue_id
 * 桥接，成功后 mutation 已同时失效本切片）。宽版 WorkflowTab 塞不进 ~260px
 * 侧栏，故复用同一组 endpoint 做纵向紧凑清单。Feature-flag 门控在挂载点
 * （requirement-drawer）完成，flag off 时本组件不渲染。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  issueWorkflowInstancesOptions,
  workflowTemplatesOptions,
} from "@multica/core/workflow/queries";
import { useCreateWorkflowInstance } from "@multica/core/workflow/mutations";
import type { WorkflowInstance } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { AppLink } from "../../../navigation";
import { QueryLoading } from "../archive/query-states";
import { useT } from "../../../i18n";
import { InstanceStatusBadge, formatDateTime } from "./workflow-shared";

export function WorkflowIssueSection({
  projectId,
  issueId,
}: {
  projectId: string;
  issueId: string;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [picking, setPicking] = useState(false);

  const listQuery = useQuery(issueWorkflowInstancesOptions(wsId, issueId));
  const instances = listQuery.data?.instances ?? [];

  const templatesQuery = useQuery(workflowTemplatesOptions(wsId, projectId));
  const templates = templatesQuery.data?.templates ?? [];
  const published = templates.filter((tpl) => tpl.status === "published");
  const templateName = (inst: WorkflowInstance) =>
    templates.find((tpl) => tpl.id === inst.template_id)?.name ??
    inst.template_id;

  const createMutation = useCreateWorkflowInstance(projectId);
  const handleStart = async (templateId: string) => {
    try {
      await createMutation.mutateAsync({
        template_id: templateId,
        issue_id: issueId,
      });
      toast.success(t(($) => $.section.started));
      setPicking(false);
    } catch {
      toast.error(t(($) => $.section.start_failed));
    }
  };

  return (
    <div data-testid="issue-workflow-section">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="font-semibold">{t(($) => $.section.title)}</h4>
        {published.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            data-testid="issue-workflow-start"
            onClick={() => setPicking((v) => !v)}
            className="font-normal text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3" />
            {t(($) => $.section.start)}
          </Button>
        )}
      </div>
      {picking && (
        <ul className="mb-2 space-y-1 rounded-md border bg-muted/30 p-2">
          {published.map((tpl) => (
            <li key={tpl.id}>
              <Button
                variant="ghost"
                size="xs"
                className="w-full justify-start truncate font-normal"
                disabled={createMutation.isPending}
                onClick={() => void handleStart(tpl.id)}
              >
                {`${tpl.name} · v${tpl.version}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {listQuery.isPending ? (
        <QueryLoading />
      ) : instances.length === 0 ? (
        <p className="text-muted-foreground">{t(($) => $.section.empty)}</p>
      ) : (
        <ul className="space-y-1.5">
          {instances.map((inst) => (
            <li key={inst.id} className="flex items-center justify-between gap-2">
              <AppLink
                href={paths.projectView(inst.project_id ?? projectId, "workflows")}
                className="min-w-0 truncate text-muted-foreground hover:text-foreground"
                title={`${templateName(inst)} · ${formatDateTime(inst.created_at)}`}
              >
                {templateName(inst)}
              </AppLink>
              <InstanceStatusBadge status={inst.status} />
            </li>
          ))}
        </ul>
      )}
      {instances.length > 0 && (
        <AppLink
          href={paths.projectView(projectId, "workflows")}
          className="mt-2 block text-center text-muted-foreground hover:text-foreground"
        >
          {t(($) => $.section.view_all)} →
        </AppLink>
      )}
    </div>
  );
}
