import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { workflowKeys } from "./queries";
import type {
  CreateWorkflowInstanceRequest,
  CreateWorkflowTemplateRequest,
  GateDecision,
  UpdateWorkflowTemplateDefinitionRequest,
  UpdateWorkflowTemplateRequest,
  WorkflowGateMessagesResponse,
  WorkflowTemplate,
} from "../types";

/**
 * Workflow mutations (plan 20261024 §01 F2).
 *
 * 服务端状态唯一所有权在 React Query：每个写动作 onSettled invalidate 所属
 * 切片（模板 → templates 键；实例/门动作 → instance 详情 + project 列表键）。
 * 门消息附加走乐观更新（对照 CoCo gate 乐观策略）：onMutate 先 setQueryData
 * 追加占位行，onError 回滚快照，onSettled invalidate 用真实行收敛。
 */

/** 模板写动作的公共失效集（模板列表 + 任何派生视图）。 */
function useTemplateInvalidation(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return () => {
    qc.invalidateQueries({ queryKey: workflowKeys.templates(wsId, projectId) });
    qc.invalidateQueries({ queryKey: workflowKeys.instances(wsId, projectId) });
  };
}

export function useCreateWorkflowTemplate(projectId: string) {
  const settle = useTemplateInvalidation(projectId);
  return useMutation({
    mutationFn: (data: CreateWorkflowTemplateRequest) =>
      api.createWorkflowTemplate(projectId, data),
    onSettled: settle,
  });
}

export function useUpdateWorkflowTemplate(projectId: string) {
  const settle = useTemplateInvalidation(projectId);
  return useMutation({
    mutationFn: (vars: {
      templateId: string;
      data: UpdateWorkflowTemplateRequest;
    }) => api.updateWorkflowTemplate(projectId, vars.templateId, vars.data),
    onSettled: settle,
  });
}

export function usePublishWorkflowTemplate(projectId: string) {
  const settle = useTemplateInvalidation(projectId);
  return useMutation({
    mutationFn: (templateId: string) =>
      api.publishWorkflowTemplate(projectId, templateId),
    onSettled: settle,
  });
}

export function useArchiveWorkflowTemplate(projectId: string) {
  const settle = useTemplateInvalidation(projectId);
  return useMutation({
    mutationFn: (templateId: string) =>
      api.archiveWorkflowTemplate(projectId, templateId),
    onSettled: settle,
  });
}

export function useDuplicateWorkflowTemplate(projectId: string) {
  const settle = useTemplateInvalidation(projectId);
  return useMutation({
    mutationFn: (vars: { templateId: string; name?: string }) =>
      api.duplicateWorkflowTemplate(projectId, vars.templateId, vars.name),
    onSettled: settle,
  });
}

export function useShareWorkflowTemplate(projectId: string) {
  const settle = useTemplateInvalidation(projectId);
  return useMutation({
    mutationFn: (vars: { templateId: string; targetProjectId: string }) =>
      api.shareWorkflowTemplate(projectId, vars.templateId, vars.targetProjectId),
    onSettled: settle,
  });
}

/**
 * 工作区级模板写动作（侧边栏「工作流」编辑器保存 / enforce）的失效集：
 * 画廊 filters 进 key 尾段，故按 workflow 父键前缀整片失效，同时覆盖项目级
 * templates 切片与派生视图。
 */
function useWorkspaceTemplateInvalidation() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return () => {
    qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) });
  };
}

export function useUpdateWorkflowTemplateDefinition() {
  const settle = useWorkspaceTemplateInvalidation();
  return useMutation({
    mutationFn: (vars: {
      templateId: string;
      data: UpdateWorkflowTemplateDefinitionRequest;
    }) => api.updateWorkflowTemplateDefinition(vars.templateId, vars.data),
    onSettled: settle,
  });
}

export function useSetWorkflowTemplateEnforce() {
  const settle = useWorkspaceTemplateInvalidation();
  return useMutation({
    mutationFn: (vars: { templateId: string; enforce: boolean }) =>
      api.setWorkflowTemplateEnforce(vars.templateId, vars.enforce),
    onSettled: settle,
  });
}

/** 实例写动作的公共失效集：列表（行集 + status_counts）+ 详情。 */
function useInstanceInvalidation(projectId: string | undefined, instanceId?: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return () => {
    if (projectId) {
      // filters 进 key 的尾段，父键前缀 invalidate 覆盖所有已缓存过滤组合。
      qc.invalidateQueries({
        queryKey: workflowKeys.project(wsId, projectId),
      });
    }
    if (instanceId) {
      qc.invalidateQueries({ queryKey: workflowKeys.instance(wsId, instanceId) });
    }
  };
}

export function useCreateWorkflowInstance(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const settle = useInstanceInvalidation(projectId);
  return useMutation({
    mutationFn: (data: CreateWorkflowInstanceRequest) =>
      api.createWorkflowInstance(projectId, data),
    onSettled: (_inst, _err, data) => {
      settle();
      // 从需求发起（计划 §G）：同步刷新需求抽屉的反查切片。
      if (data.issue_id) {
        qc.invalidateQueries({
          queryKey: workflowKeys.instancesByIssue(wsId, data.issue_id),
        });
      }
    },
  });
}

export function useWorkflowInstanceAction(
  projectId: string | undefined,
  instanceId: string,
) {
  const settle = useInstanceInvalidation(projectId, instanceId);
  return useMutation({
    mutationFn: (
      action: "pause" | "resume" | "cancel" | "succeed" | "recover",
    ) => api.workflowInstanceAction(instanceId, action),
    onSettled: settle,
  });
}

export type StageAction =
  | "approve"
  | "loop-back"
  | "skip"
  | "rerun"
  | "interrupt"
  // 缺件 blocked 阶段的手动复评（plan 20261025 §B3c）：补齐资产后不等 sweep。
  | "recheck";

const stageActionFn: Record<
  StageAction,
  (stageRunId: string) => Promise<unknown>
> = {
  approve: (id) => api.approveWorkflowStage(id),
  "loop-back": (id) => api.loopBackWorkflowStage(id),
  skip: (id) => api.skipWorkflowStage(id),
  rerun: (id) => api.rerunWorkflowStage(id),
  interrupt: (id) => api.interruptWorkflowStage(id),
  recheck: (id) => api.recheckWorkflowStage(id),
};

/** 阶段动作统一入口：action ∈ approve|loop-back|skip|rerun|interrupt|recheck。 */
export function useWorkflowStageAction(
  projectId: string | undefined,
  instanceId: string,
) {
  const settle = useInstanceInvalidation(projectId, instanceId);
  return useMutation({
    mutationFn: (vars: { stageRunId: string; action: StageAction }) =>
      stageActionFn[vars.action](vars.stageRunId),
    onSettled: settle,
  });
}

/** 门禁裁决（loop|exit）——service.DecideGate 的 409 冲突由调用方提示。 */
export function useDecideWorkflowGate(
  projectId: string | undefined,
  instanceId: string,
) {
  const settle = useInstanceInvalidation(projectId, instanceId);
  return useMutation({
    mutationFn: (vars: { gateRunId: string; decision: GateDecision }) =>
      api.decideWorkflowGate(vars.gateRunId, vars.decision),
    onSettled: settle,
  });
}

/**
 * 门边发言（乐观更新）。占位行 author_id 留空、id 前缀 optimistic_，真实行
 * 由 onSettled refetch 替换——服务端是唯一事实源，占位只负责即时可见。
 */
export function usePostWorkflowGateMessage(gateRunId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const key = workflowKeys.gateMessages(wsId, gateRunId);
  return useMutation({
    mutationFn: (content: string) =>
      api.postWorkflowGateMessage(gateRunId, content),
    onMutate: async (content) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WorkflowGateMessagesResponse>(key);
      if (previous) {
        const now = new Date().toISOString();
        qc.setQueryData<WorkflowGateMessagesResponse>(key, {
          ...previous,
          messages: [
            ...previous.messages,
            {
              id: `optimistic_${now}_${content.slice(0, 8)}`,
              issue_id: "",
              author_type: "member",
              author_id: "",
              content,
              type: "comment",
              parent_id: null,
              reactions: [],
              attachments: [],
              created_at: now,
              updated_at: now,
              resolved_at: null,
              resolved_by_type: null,
              resolved_by_id: null,
            },
          ],
        });
      }
      return { previous };
    },
    onError: (_err, _content, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) });
    },
  });
}

/**
 * 模板「测试运行」第一版＝零副作用渲染预览（plan 20261025 §C7）。
 * 服务端用与 dispatchStage 同源的渲染链回 prompt + warnings，不写任何表，
 * 因此无需 invalidate——缓存里也没有该结果的位置。
 */
export function useDryRunWorkflowTemplate() {
  return useMutation({
    mutationFn: (vars: {
      templateId: string;
      nodeId?: string;
      workitem?: Record<string, string>;
    }) =>
      api.dryRunWorkflowTemplate(vars.templateId, {
        node_id: vars.nodeId ?? "",
        workitem: vars.workitem,
      }),
  });
}

/** 模板编辑抽屉里选中模板后的浅动作快捷封装（发布后立即回填草稿对象）。 */
export function workflowTemplateAfterWrite(
  templates: WorkflowTemplate[] | undefined,
  updated: WorkflowTemplate,
): WorkflowTemplate[] {
  if (!templates) return [updated];
  const idx = templates.findIndex((t) => t.id === updated.id);
  if (idx === -1) return [updated, ...templates];
  return templates.map((t, i) => (i === idx ? updated : t));
}
