import type { QueryClient } from "@tanstack/react-query";
import { workflowKeys } from "./queries";
import type {
  WorkflowInstanceDetailResponse,
  WorkflowInstanceStatePayload,
  WorkflowGateDecidedPayload,
} from "../types";

/**
 * WS → React Query 缓存更新器（plan 20261024 §01 F2，铁律 2：实时事件只
 * patch/invalidate React Query，绝不镜像进 Zustand）。
 *
 * workflow:instance_state 携带 {instance_id, status, source}：详情页命中时
 * 直接 setQueryData 就地 patch（不整页刷新、不 refetch 风暴），列表键只做
 * invalidate（行集/计数变化廉价且正确，对照 inbox 的同类取舍）。
 */
export function onWorkflowInstanceState(
  qc: QueryClient,
  wsId: string,
  payload: WorkflowInstanceStatePayload,
) {
  if (!wsId || !payload?.instance_id) return;
  const key = workflowKeys.instance(wsId, payload.instance_id);
  const detail = qc.getQueryData<WorkflowInstanceDetailResponse>(key);
  if (detail && detail.instance.id === payload.instance_id) {
    qc.setQueryData<WorkflowInstanceDetailResponse>(key, {
      ...detail,
      instance: { ...detail.instance, status: payload.status },
    });
  }
  qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) });
}

/**
 * workflow:gate_decided 携带新门（round/generation 递增 = loop 回退信号）：
 * 精确 invalidate 所属实例详情，门面板随 refetch 收敛。
 */
export function onWorkflowGateDecided(
  qc: QueryClient,
  wsId: string,
  payload: WorkflowGateDecidedPayload,
) {
  if (!wsId || !payload?.instance_id) return;
  qc.invalidateQueries({
    queryKey: workflowKeys.instance(wsId, payload.instance_id),
  });
  qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) });
}

/** workflow:template_changed：模板列表 invalidate（无行载荷，不猜内容）。 */
export function onWorkflowTemplateChanged(qc: QueryClient, wsId: string) {
  if (!wsId) return;
  qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) });
}

/**
 * 活跃态轮询兜底（对照 CoCo zLe 的 30s refetch）：仅当实例处于
 * waiting/running 时返回 30_000，终态返回 false 停轮询。挂在详情/列表
 * queryOptions 的 refetchInterval 上使用。
 */
export function workflowActiveRefetchInterval(
  status: string | undefined,
): number | false {
  return status === "waiting" || status === "running" ? 30_000 : false;
}
