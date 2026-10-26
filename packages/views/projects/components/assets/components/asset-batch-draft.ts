import type {
  AssetBinding,
  AssetCategory,
  AssetLifecycleStage,
  AssetRole,
  BatchUpdateAssetMetaRequest,
} from "@multica/core/types";

/**
 * 批量编辑草稿与跨项目分组的纯函数（五阶段对齐 plan §7.4）。
 *
 * Dialog 只负责表单；提交行为由容器注入：项目/工作项一次调用项目级事务端点，
 * 工作区按 `project_id` 分组顺序逐项目调用——分组只基于当前已加载行，
 * 不引用未定义的全量数据。
 */

/** 表单三态哨兵：UNCHANGED 不下发该字段，CLEAR 下发空串（后端=清除）。 */
export const UNCHANGED = "__unchanged__";
export const CLEAR = "__clear__";

export interface BatchFormState {
  stage: string;
  role: string;
  category: string;
  tagsText: string;
  tagsMode: "replace" | "add" | "remove";
}

/** 组装批量请求；无任何改动或无选择时返回 null（不提交）。 */
export function buildBatchUpdateRequest(
  form: BatchFormState,
  selectedIds: readonly string[],
): BatchUpdateAssetMetaRequest | null {
  if (selectedIds.length === 0) return null;
  const data: BatchUpdateAssetMetaRequest = { binding_ids: [...selectedIds] };
  if (form.stage !== UNCHANGED) {
    data.lifecycle_stage = form.stage === CLEAR ? "" : (form.stage as AssetLifecycleStage);
  }
  if (form.role !== UNCHANGED) {
    data.asset_role = form.role === CLEAR ? "" : (form.role as AssetRole);
  }
  if (form.category !== UNCHANGED && form.category !== CLEAR) {
    data.asset_category = form.category as AssetCategory;
  }
  const parsedTags = form.tagsText
    .split(/[,，;；、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tags = [...new Set(parsedTags)];
  if (tags.length > 0) {
    data.tags = tags;
    data.tags_mode = form.tagsMode;
  }
  const hasChange =
    data.lifecycle_stage !== undefined ||
    data.asset_role !== undefined ||
    data.asset_category !== undefined ||
    data.tags !== undefined;
  return hasChange ? data : null;
}

/** 已选且已加载的行按 project_id 分组为 bindingIds（保持行序，串行提交用）。 */
export function groupSelectedByProject(
  rows: readonly AssetBinding[],
  selectedIds: ReadonlySet<string>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (!selectedIds.has(row.id)) continue;
    const list = groups.get(row.project_id);
    if (list) list.push(row.id);
    else groups.set(row.project_id, [row.id]);
  }
  return groups;
}

/**
 * 剔除已不存在于当前加载行的选择（解绑/刷新后失效 ID 不参与批量提交）。
 * `changed` 为 false 时调用方可保持原 state 引用不动。
 */
export function pruneSelectedIds(
  selected: ReadonlySet<string>,
  rows: readonly AssetBinding[],
): { ids: Set<string>; changed: boolean } {
  const alive = new Set(rows.map((row) => row.id));
  let changed = false;
  const ids = new Set<string>();
  for (const id of selected) {
    if (alive.has(id)) ids.add(id);
    else changed = true;
  }
  return changed ? { ids, changed: true } : { ids: selected instanceof Set ? selected : ids, changed: false };
}

export interface GroupedBatchResult {
  succeededIds: string[];
  /** 失败的项目组（保留选择与表单供重试）。 */
  failedGroups: Array<{ projectId: string; bindingIds: string[] }>;
}

/**
 * 跨项目分组批量提交（五阶段对齐 plan §7.4.4/§7.4.5）：
 * 顺序逐项目调用项目级事务端点（避免无上限并发），每个项目组事务独立；
 * 失败组收集后返回供容器保留选择并重试。不伪造跨项目单事务。
 * 每组请求体由容器在 send 内用草稿 closure 构造（binding_ids 换成本组 ID）。
 */
export async function submitBatchByProject(
  groups: ReadonlyMap<string, string[]>,
  send: (projectId: string, bindingIds: string[]) => Promise<unknown>,
): Promise<GroupedBatchResult> {
  const succeededIds: string[] = [];
  const failedGroups: GroupedBatchResult["failedGroups"] = [];
  for (const [projectId, bindingIds] of groups) {
    try {
      await send(projectId, bindingIds);
      succeededIds.push(...bindingIds);
    } catch {
      failedGroups.push({ projectId, bindingIds });
    }
  }
  return { succeededIds, failedGroups };
}
