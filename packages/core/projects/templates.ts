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
  "features",
  "data-model",
  "requirements",
  "tasks",
  "acceptance",
  "deliverables",
  "filing",
] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number];

export const PROJECT_TEMPLATE_VIEWS: Record<StoredProjectTemplate, readonly ProjectView[]> = {
  general: ["archive", "requirements", "tasks", "deliverables"],
  rd: ["archive", "features", "requirements", "tasks", "acceptance", "deliverables", "filing"],
  data: ["archive", "data-model", "requirements", "tasks", "acceptance", "deliverables"],
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
