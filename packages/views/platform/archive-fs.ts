/**
 * Desktop archive directory helpers (list / read / write).
 * Web has no silent disk access — callers should use a user-picked FileList instead.
 */

export type ListArchiveDocsResult = {
  ok: boolean;
  files?: string[];
  reason?: "unsupported" | "not_found" | "error";
  error?: string;
};

export type WriteArchiveFileResult = {
  ok: boolean;
  reason?: "unsupported" | "error";
  error?: string;
};

export type ReadArchiveFileResult = {
  ok: boolean;
  content?: string;
  reason?: "unsupported" | "not_found" | "error";
  error?: string;
};

interface DesktopArchiveAPI {
  listArchiveDocs?: (root: string) => Promise<ListArchiveDocsResult>;
  writeArchiveFile?: (
    root: string,
    relPath: string,
    content: string,
  ) => Promise<WriteArchiveFileResult>;
  readArchiveFile?: (
    root: string,
    relPath: string,
  ) => Promise<ReadArchiveFileResult>;
  removeArchiveFile?: (
    root: string,
    relPath: string,
  ) => Promise<WriteArchiveFileResult>;
}

function readDesktopAPI(): DesktopArchiveAPI | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { desktopAPI?: DesktopArchiveAPI }).desktopAPI;
}

export async function listArchiveDocs(
  root: string,
): Promise<ListArchiveDocsResult> {
  const api = readDesktopAPI();
  if (!api?.listArchiveDocs) return { ok: false, reason: "unsupported" };
  return api.listArchiveDocs(root);
}

export async function writeArchiveFile(
  root: string,
  relPath: string,
  content: string,
): Promise<WriteArchiveFileResult> {
  const api = readDesktopAPI();
  if (!api?.writeArchiveFile) return { ok: false, reason: "unsupported" };
  return api.writeArchiveFile(root, relPath, content);
}

export async function readArchiveFile(
  root: string,
  relPath: string,
): Promise<ReadArchiveFileResult> {
  const api = readDesktopAPI();
  if (!api?.readArchiveFile) return { ok: false, reason: "unsupported" };
  return api.readArchiveFile(root, relPath);
}

export async function removeArchiveFile(
  root: string,
  relPath: string,
): Promise<WriteArchiveFileResult> {
  const api = readDesktopAPI();
  if (!api?.removeArchiveFile) return { ok: false, reason: "unsupported" };
  return api.removeArchiveFile(root, relPath);
}
