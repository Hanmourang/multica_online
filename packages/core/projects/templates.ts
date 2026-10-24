/**
 * Project templates chosen at create time. Each template is a fixed TAB set
 * on project detail — not a runtime feature flag.
 *
 * `full` is legacy only: existing rows keep the current eight-tab shell so
 * we do not hide 功能模块 / 数据模型 / 申报 from projects created before
 * templates existed.
 */
export const PROJECT_TEMPLATES = ["general", "rd", "data"] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

export const PROJECT_TEMPLATE_STORAGE = [...PROJECT_TEMPLATES, "full"] as const;
export type StoredProjectTemplate = (typeof PROJECT_TEMPLATE_STORAGE)[number];

export const PROJECT_VIEWS = [
  "archive",
  "assets",
  "features",
  "data-model",
  "requirements",
  "tasks",
  "acceptance",
  "deliverables",
  "filing",
  // 工作流 TAB（plan 20261024 §01 F3）：可见性另由 workflow_module flag 在
  // TAB 容器层门控，这里只声明壳层页签集合。
  "workflows",
  // 迭代 TAB（plan 20261024 §02）：sprint_module flag 同样在容器层门控。
  "sprints",
] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number];

export const PROJECT_TEMPLATE_VIEWS: Record<StoredProjectTemplate, readonly ProjectView[]> = {
  general: ["archive", "assets", "requirements", "tasks", "deliverables", "workflows", "sprints"],
  rd: ["archive", "assets", "features", "requirements", "tasks", "acceptance", "deliverables", "filing", "workflows", "sprints"],
  data: ["archive", "assets", "data-model", "requirements", "tasks", "acceptance", "deliverables", "workflows", "sprints"],
  full: PROJECT_VIEWS,
};

export const DEFAULT_CREATE_PROJECT_TEMPLATE: ProjectTemplate = "rd";

export function isProjectTemplate(value: string | null | undefined): value is ProjectTemplate {
  return value === "general" || value === "rd" || value === "data";
}

export function isStoredProjectTemplate(
  value: string | null | undefined,
): value is StoredProjectTemplate {
  return isProjectTemplate(value) || value === "full";
}

/** Unknown / missing template keeps the pre-template eight-tab shell. */
export function resolveProjectTemplate(
  value: string | null | undefined,
): StoredProjectTemplate {
  return isStoredProjectTemplate(value) ? value : "full";
}

export function viewsForProjectTemplate(
  value: string | null | undefined,
): readonly ProjectView[] {
  return PROJECT_TEMPLATE_VIEWS[resolveProjectTemplate(value)];
}

export function isViewAllowedForTemplate(
  view: string,
  template: string | null | undefined,
): view is ProjectView {
  return (viewsForProjectTemplate(template) as readonly string[]).includes(view);
}
