import { artifactParentDir } from "./archive-display";

export function normalizeDocModule(value: string): string {
  const trimmed = value.replace(/\\/g, "/").trim();
  const slash = trimmed.lastIndexOf("/");
  const name = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).trim();
  return name.slice(0, 64);
}

/** 与直属目录相同则清空覆盖，显示回退到路径推导。 */
export function persistDocModuleValue(relPath: string, draft: string): string {
  const next = normalizeDocModule(draft);
  const parent = artifactParentDir(relPath) ?? "";
  return next === parent ? "" : next;
}
