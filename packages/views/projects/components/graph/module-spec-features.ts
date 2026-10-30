/**
 * 模块规格里功能点的增删改（纯函数）。
 *
 * `project_module.spec` 的 features 是功能点的唯一真源：`project_module_feature`
 * 只是发布时重建的投影表（`rebuildModuleFeatureProjection` 在同一事务里先 DELETE
 * 再 INSERT）。因此「删一个功能点」= 发布一份不含该项的 spec，「改一个功能点」=
 * 发布一份替换掉该项的 spec —— 都不需要新增删除/更新端点。
 */
import type { ModuleSpec, ModuleSpecFeature, ModuleWorkspaceFeature } from "@multica/core/types";

export const FEATURE_CODE_PREFIX = "FP-";

export function formatFeatureCode(sequence: number): string {
  return `${FEATURE_CODE_PREFIX}${String(sequence).padStart(2, "0")}`;
}

/** 现有功能点编号的最大尾号：新增与导入都从这里往后接，不重号。 */
export function maxFeatureNumber(features: ReadonlyArray<{ code: string }>): number {
  let max = 0;
  for (const feature of features) {
    const match = /(\d+)\s*$/.exec(feature.code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * 下一个可用编号。
 *
 * `reserved` 传「历史上用过、但已从 spec 删掉」的编号（见 `reservedFeatureCodes`）。
 * 编号是四段详情的字段前缀（`fp.<code>.desc`），删掉功能点后这些字段仍留在 brief
 * 里；直接复用编号会把上一份残留详情复活到新功能点上，所以生成时要一并避开。
 */
export function nextFeatureCode(
  features: ReadonlyArray<{ code: string }>,
  reserved: Iterable<string> = [],
): string {
  const used = new Set<string>();
  for (const feature of features) used.add(feature.code);
  for (const code of reserved) used.add(code);

  let sequence = maxFeatureNumber([...used].map((code) => ({ code })));
  let next = formatFeatureCode(sequence + 1);
  while (used.has(next)) {
    sequence += 1;
    next = formatFeatureCode(sequence + 1);
  }
  return next;
}

/**
 * 从 brief 字段里收集「历史上用过的功能点编号」。
 * 键形如 `fp.FP-03.desc`；功能点从 spec 删掉后，这些字段仍会留在 brief 里。
 */
export function reservedFeatureCodes(
  fields: Record<string, unknown> | null | undefined,
): string[] {
  const codes = new Set<string>();
  for (const key of Object.keys(fields ?? {})) {
    const match = /^fp\.([^.]+)\./.exec(key);
    if (!match) continue;
    const code = match[1]?.trim();
    if (code) codes.add(code);
  }
  return [...codes];
}

/**
 * 当前 spec 里的功能点列表。
 * spec 一旦存在就以它为准：`features: []` 表示「确实一个都没有」。只有在模块从未
 * 发布过 spec（spec 为 null）时才回退到右栏行（那是上一版投影）—— 否则删完最后一条
 * 再新增时，会把刚删掉的功能点又带回来。
 */
export function specFeaturesOf(
  spec: ModuleSpec | null | undefined,
  rows: ReadonlyArray<ModuleWorkspaceFeature>,
): ModuleSpecFeature[] {
  if (spec) return spec.features ?? [];
  return rows.map((row) => ({
    code: row.code,
    title: row.title,
    kind: row.kind === "edge" ? "edge" : "core",
    priority: row.priority,
    group: row.group,
  }));
}

/** 用给定功能点列表拼一份新 spec，保留原有的 schema 与 summary。 */
export function specWithFeatures(
  previous: ModuleSpec | null | undefined,
  features: ModuleSpecFeature[],
): ModuleSpec {
  return {
    schema: previous?.schema || "module_spec/v1",
    summary: previous?.summary,
    features,
  };
}

export function withFeatureAdded(
  list: ReadonlyArray<ModuleSpecFeature>,
  draft: { code: string; title: string; group?: string },
): ModuleSpecFeature[] {
  return [
    ...list,
    {
      code: draft.code,
      title: draft.title,
      kind: "core",
      group: draft.group?.trim() || undefined,
    },
  ];
}

/** 删除功能点：整条从 spec 里移除，投影重建后右栏的行与详情一起消失。 */
export function withFeatureRemoved(
  list: ReadonlyArray<ModuleSpecFeature>,
  code: string,
): ModuleSpecFeature[] {
  return list.filter((feature) => feature.code !== code);
}

/**
 * 改功能点：编号是稳定标识（也是四段详情的字段前缀），不在此处修改。
 * `group` 传空串表示「移出分组」，落库前归一成 undefined。
 */
export function withFeatureUpdated(
  list: ReadonlyArray<ModuleSpecFeature>,
  code: string,
  patch: { title?: string; group?: string; kind?: "core" | "edge" },
): ModuleSpecFeature[] {
  return list.map((feature) => {
    if (feature.code !== code) return feature;
    const next: ModuleSpecFeature = { ...feature };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.group !== undefined) next.group = patch.group.trim() || undefined;
    return next;
  });
}
