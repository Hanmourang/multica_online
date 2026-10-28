import { create } from "zustand";
import type { Attachment } from "@multica/core/types";

export const PAGE_CONTEXT_MARK = "<!-- multica-page-context -->";
export const PROTOTYPE_DIRECTORY_FILENAME = "prototype-directory.txt";

export type PrototypePageSurfaceContext = {
  surface: "prototype";
  projectId: string;
  /** 模块 id：原型挂在模块下时带上，用作写库主键（moduleName 只用于显示）。 */
  moduleId?: string;
  moduleName?: string;
  version?: number;
  htmlPath?: string;
  html?: string;
  /** 与原型文件同目录的档案相对路径。 */
  directoryFiles?: string[];
};

/**
 * 模块上下文（不挂具体原型版本）。聊天侧只读展示，写库靠消息的 resource_refs，
 * 所以这里不落库、不带 HTML。coverage 是百分比 0–100；模块对账（07）未上线时为 null。
 */
export type ModulePageSurfaceContext = {
  surface: "module";
  projectId: string;
  moduleId: string;
  moduleName: string;
  specVersion: number;
  canonicalPrototypeVersion: number | null;
  coverage?: number | null;
  featurePointCount?: number;
};

export type PageSurfaceContext = PrototypePageSurfaceContext | ModulePageSurfaceContext;

type PageSurfaceStore = {
  context: PageSurfaceContext | null;
  setContext: (context: PageSurfaceContext | null) => void;
};

type UploadApi = {
  uploadFile: (
    file: File,
    opts?: { chatSessionId?: string },
  ) => Promise<Attachment>;
};

/** 当前可见页面（原型图 Tab）挂给浮层/全页会话的上下文。不落盘。 */
export const usePageSurfaceContext = create<PageSurfaceStore>((set) => ({
  context: null,
  setContext: (context) => set({ context }),
}));

export function prototypeDirectory(htmlPath: string | undefined): string {
  if (!htmlPath) return "";
  const normalized = htmlPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

export function directoryFilesForPath(htmlPath: string | undefined, paths: string[]): string[] {
  const dir = prototypeDirectory(htmlPath);
  if (!dir) return [];
  const prefix = `${dir}/`;
  return [...new Set(paths.map((path) => path.replace(/\\/g, "/")))]
    .filter((path) => path === htmlPath?.replace(/\\/g, "/") || path.startsWith(prefix))
    .sort();
}

export function prototypeDirectoryListing(context: PageSurfaceContext): string {
  if (context.surface !== "prototype") return "";
  const path = context.htmlPath?.replace(/\\/g, "/");
  const dir = prototypeDirectory(path);
  const files = context.directoryFiles?.length
    ? context.directoryFiles
    : path
      ? [path]
      : [];
  if (!dir && files.length === 0) return "";
  const lines = dir ? [`${dir}/`] : [];
  for (const file of files) lines.push(`- ${file}`);
  return lines.join("\n");
}

export function prototypeAttachmentFiles(context: PageSurfaceContext): File[] {
  if (context.surface !== "prototype") return [];
  const files: File[] = [];
  const listing = prototypeDirectoryListing(context);
  if (listing) {
    files.push(new File([listing], PROTOTYPE_DIRECTORY_FILENAME, { type: "text/plain" }));
  }
  const html = context.html?.trim();
  if (html && context.htmlPath) {
    const name = context.htmlPath.split("/").pop() || "prototype.html";
    files.push(new File([html], name, { type: "text/html" }));
  }
  return files;
}

/** 气泡 / 预览只显示用户原话，不显示页面挂载块。 */
export function visiblePageSurfaceContent(content: string): string {
  if (!content.includes(PAGE_CONTEXT_MARK)) return content;
  const start = content.indexOf(PAGE_CONTEXT_MARK);
  const sep = content.indexOf("\n\n", start);
  const before = content.slice(0, start).trim();
  const after = sep >= 0 ? content.slice(sep + 2) : "";
  return [before, after].filter(Boolean).join("\n\n");
}

/** 模块上下文的紧凑形态：一段可读文本，不进 HTML 注释（模块不挂文件）。 */
export function formatModuleSurfaceContext(context: ModulePageSurfaceContext): string {
  const parts = [
    `${context.moduleName} (module ${context.moduleId})`,
    `spec v${context.specVersion}`,
    context.canonicalPrototypeVersion != null
      ? `canonical prototype v${context.canonicalPrototypeVersion}`
      : "no canonical prototype",
  ];
  if (context.featurePointCount != null && context.featurePointCount > 0) {
    parts.push(`${context.featurePointCount} feature points`);
  }
  if (context.coverage != null) parts.push(`coverage ${Math.round(context.coverage)}%`);
  return parts.join(" · ");
}

/** 上传失败时的兜底：只留路径 + 目录，不灌 HTML。 */
export function formatPageSurfaceContext(context: PageSurfaceContext): string {
  if (context.surface === "module") {
    return formatModuleSurfaceContext(context);
  }
  const listing = prototypeDirectoryListing(context);
  const path = context.htmlPath?.replace(/\\/g, "/");
  const lines = [PAGE_CONTEXT_MARK];
  if (path) lines.push(`file: ${path}`);
  if (listing) lines.push(listing);
  return lines.join("\n");
}

export function applyPageSurfaceContext(
  content: string,
  context: PageSurfaceContext | null,
): string {
  const body = content.trim();
  if (!context || !body) return content;
  if (body.includes(PAGE_CONTEXT_MARK)) return content;
  const pack = formatPageSurfaceContext(context);
  if (pack === PAGE_CONTEXT_MARK) return content;
  return `${pack}\n\n${content}`;
}

export async function bindPageSurfaceAttachments(
  api: UploadApi,
  context: PageSurfaceContext | null,
  sessionId: string,
): Promise<{ attachmentIds: string[]; attachments: Attachment[] }> {
  if (!context) return { attachmentIds: [], attachments: [] };
  const files = prototypeAttachmentFiles(context);
  if (files.length === 0) return { attachmentIds: [], attachments: [] };
  const attachments: Attachment[] = [];
  for (const file of files) {
    attachments.push(await api.uploadFile(file, { chatSessionId: sessionId }));
  }
  return { attachmentIds: attachments.map((row) => row.id), attachments };
}

export async function preparePageSurfaceSend(
  api: UploadApi,
  content: string,
  context: PageSurfaceContext | null,
  sessionId: string,
): Promise<{ content: string; attachmentIds: string[]; attachments: Attachment[] }> {
  if (!context) {
    return { content, attachmentIds: [], attachments: [] };
  }
  try {
    const bound = await bindPageSurfaceAttachments(api, context, sessionId);
    if (bound.attachmentIds.length > 0) {
      return { content, ...bound };
    }
  } catch {
    // 上传失败时退回路径清单，保证消息仍能发出。
  }
  return {
    content: applyPageSurfaceContext(content, context),
    attachmentIds: [],
    attachments: [],
  };
}

export function pageSurfaceChip(context: PageSurfaceContext): string {
  if (context.surface === "module") {
    return context.specVersion > 0
      ? `${context.moduleName} · v${context.specVersion}`
      : context.moduleName;
  }
  if (context.htmlPath) {
    const name = context.htmlPath.split("/").pop() ?? context.htmlPath;
    return context.version != null ? `v${context.version} · ${name}` : name;
  }
  if (context.moduleName) return context.moduleName;
  return context.surface;
}

export function buildPrototypeAgentPrompt(append?: string): string {
  const extra = append?.trim();
  return extra
    ? `按附件中的原型文件改一版。${extra}`
    : "按附件中的原型文件改一版。";
}
