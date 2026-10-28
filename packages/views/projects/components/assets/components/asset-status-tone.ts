// 工作项状态 → 展示色（纯函数，无 IO）。资产面（列表「需求/任务」列、编辑抽屉
// 候选行）只消费 7 个内置状态类别的语义色；自定义状态键收敛到中性灰，与
// issue 面的状态解析保持同样的「先归类别再上色」口径。
// spec: change_logs/multica/plans/20261024-coco对标-工作流迭代资产/03_资产管理模块.md（关联列拆需求/任务轮）

/** 7 个内置状态类别（与 core IssueStatusCategory 对齐，避免 views 引 core 造成类型耦合）。 */
export type AssetIssueStatusCategory =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

/** 状态类别 → 徽标类（底色/文字/描边），done 绿、in_progress 琥珀、blocked 玫红…… */
export const STATUS_TONE_CLASS: Record<AssetIssueStatusCategory, string> = {
  backlog: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  todo: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  in_progress: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  in_review: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  blocked: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  cancelled: "bg-neutral-500/10 text-neutral-500 dark:text-neutral-400 line-through",
};

/** 需求 / 任务的类型分色（列表列徽标与编辑抽屉行首圆点共用同一对色相）。 */
export const REQUIREMENT_TONE_CLASS =
  "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
export const TASK_TONE_CLASS = "bg-teal-500/10 text-teal-700 dark:text-teal-300";
export const REQUIREMENT_DOT_CLASS = "bg-indigo-500";
export const TASK_DOT_CLASS = "bg-teal-500";

const BUILT_IN_STATUS_CATEGORIES: ReadonlySet<string> = new Set<AssetIssueStatusCategory>([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);

/** 状态键 → 类别（7 内置键自身即类别；其余（自定义键/空）归 "backlog" 中性展示）。 */
export function assetIssueStatusCategory(status: string): AssetIssueStatusCategory {
  return BUILT_IN_STATUS_CATEGORIES.has(status)
    ? (status as AssetIssueStatusCategory)
    : "backlog";
}

/** 状态键 → 徽标色类；未知/自定义状态落到 backlog 灰。 */
export function statusToneClass(status: string): string {
  return STATUS_TONE_CLASS[assetIssueStatusCategory(status)];
}
