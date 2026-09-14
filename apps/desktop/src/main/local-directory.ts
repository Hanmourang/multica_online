import { ipcMain, dialog, BrowserWindow } from "electron";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

export interface PickDirectoryResult {
  ok: boolean;
  path?: string;
  basename?: string;
  /** Set when ok=false. "cancelled" = user dismissed; otherwise an error blurb. */
  reason?: "cancelled" | "no_window" | "error";
  error?: string;
}

export interface ValidateLocalDirectoryResult {
  ok: boolean;
  /** When ok=false, identifies which check failed so the renderer can render a
   *  specific message without parsing free-form text. */
  reason?:
    | "not_absolute"
    | "not_found"
    | "not_a_directory"
    | "not_readable"
    | "not_writable"
    | "error";
  error?: string;
  /**
   * Whether the directory sits inside a git working tree. Only set when ok=true.
   *
   * Worktree execution mode requires a git repo, and only the desktop app can
   * see the filesystem — the server cannot. Reporting it here lets the picker
   * disable that mode with a reason at selection time, instead of letting the
   * user save a resource whose very first task fails.
   */
  is_git_repo?: boolean;
}

async function validateLocalDirectory(
  path: string,
): Promise<ValidateLocalDirectoryResult> {
  if (!path || !isAbsolute(path)) {
    return { ok: false, reason: "not_absolute" };
  }
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return { ok: false, reason: "not_a_directory" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "error", error: errorMessage(err) };
  }
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    return { ok: false, reason: "not_readable" };
  }
  try {
    await access(path, fsConstants.W_OK);
  } catch {
    return { ok: false, reason: "not_writable" };
  }
  return { ok: true, is_git_repo: await isInsideGitWorkTree(path) };
}

/**
 * Walks up from `path` looking for a `.git` entry, mirroring how git itself
 * resolves a working tree — so a subdirectory of a repo reports true, matching
 * what the daemon does with `rev-parse --show-toplevel` at task time.
 *
 * `.git` is accepted as either a directory (ordinary clone) or a file (a linked
 * worktree, where it holds a gitdir pointer). Any error means "can't tell",
 * which is reported as not-a-repo: this only drives a UI hint, and the daemon
 * re-checks authoritatively before running anything.
 */
async function isInsideGitWorkTree(path: string): Promise<boolean> {
  let current = path;
  for (;;) {
    try {
      await stat(join(current, ".git"));
      return true;
    } catch {
      // Not here — keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function setupLocalDirectory(
  windowGetter: () => BrowserWindow | null,
): void {
  ipcMain.handle(
    "local-directory:pick",
    async (event, defaultPath?: string): Promise<PickDirectoryResult> => {
      const win =
        BrowserWindow.fromWebContents(event.sender) ?? windowGetter();
      if (!win) return { ok: false, reason: "no_window" };
      try {
        const result = await dialog.showOpenDialog(win, {
          // Multiple-selection is intentionally disabled — a project_resource
          // points at a single directory, and the create flow expects one
          // path per click. Multi-add would have to be a separate UX.
          properties: ["openDirectory", "createDirectory"],
          ...(defaultPath ? { defaultPath } : {}),
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, reason: "cancelled" };
        }
        const picked = result.filePaths[0];
        if (!picked) return { ok: false, reason: "cancelled" };
        return { ok: true, path: picked, basename: basename(picked) };
      } catch (err) {
        return { ok: false, reason: "error", error: errorMessage(err) };
      }
    },
  );

  ipcMain.handle(
    "local-directory:validate",
    (_event, path: string): Promise<ValidateLocalDirectoryResult> =>
      validateLocalDirectory(path),
  );

  ipcMain.handle(
    "archive:list-docs",
    async (_event, root: string) => listArchiveDocs(root),
  );

  ipcMain.handle(
    "archive:write-file",
    async (_event, root: string, relPath: string, content: string) =>
      writeArchiveFile(root, relPath, content),
  );

  ipcMain.handle(
    "archive:read-file",
    async (_event, root: string, relPath: string) =>
      readArchiveFile(root, relPath),
  );

  ipcMain.handle(
    "archive:remove-file",
    async (_event, root: string, relPath: string) =>
      removeArchiveFile(root, relPath),
  );
}

const SKIP_DIRS = new Set([
  "_attic",
  "assets",
  "node_modules",
  ".git",
  "__pycache__",
  "qoder_backup",
  "db_backups",
  "wiki_snapshots",
  "dist",
  "vendor",
  "build",
  ".next",
  "coverage",
  "page-navigator",
]);
const DOC_EXTS = new Set([".md", ".html"]);

async function listArchiveDocs(
  root: string,
): Promise<{ ok: boolean; files?: string[]; reason?: string; error?: string }> {
  if (!root || !isAbsolute(root)) {
    return { ok: false, reason: "not_found" };
  }
  try {
    const st = await stat(root);
    if (!st.isDirectory()) return { ok: false, reason: "not_found" };
    const files: string[] = [];
    await walkDocs(root, root, files);
    return { ok: true, files };
  } catch (err) {
    return { ok: false, reason: "error", error: errorMessage(err) };
  }
}

async function walkDocs(
  root: string,
  current: string,
  out: string[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDocs(root, full, out);
      continue;
    }
    const ext = entry.name.includes(".")
      ? `.${entry.name.split(".").pop()?.toLowerCase()}`
      : "";
    if (!DOC_EXTS.has(ext)) continue;
    out.push(relative(root, full).split(sep).join("/"));
  }
}

async function writeArchiveFile(
  root: string,
  relPath: string,
  content: string,
): Promise<{ ok: boolean; reason?: string; error?: string }> {
  if (!root || !isAbsolute(root) || !relPath) {
    return { ok: false, reason: "error", error: "invalid path" };
  }
  const target = resolve(root, relPath);
  const rootResolved = resolve(root);
  if (!target.startsWith(rootResolved + sep) && target !== rootResolved) {
    return { ok: false, reason: "error", error: "path escapes archive root" };
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "error", error: errorMessage(err) };
  }
}

async function readArchiveFile(
  root: string,
  relPath: string,
): Promise<{ ok: boolean; content?: string; reason?: string; error?: string }> {
  if (!root || !isAbsolute(root) || !relPath) {
    return { ok: false, reason: "error", error: "invalid path" };
  }
  const target = resolve(root, relPath);
  const rootResolved = resolve(root);
  if (!target.startsWith(rootResolved + sep) && target !== rootResolved) {
    return { ok: false, reason: "error", error: "path escapes archive root" };
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) return { ok: false, reason: "not_found" };
    const content = await readFile(target, "utf8");
    return { ok: true, content };
  } catch (err) {
    return { ok: false, reason: "error", error: errorMessage(err) };
  }
}

async function removeArchiveFile(
  root: string,
  relPath: string,
): Promise<{ ok: boolean; reason?: string; error?: string }> {
  if (!root || !isAbsolute(root) || !relPath) {
    return { ok: false, reason: "error", error: "invalid path" };
  }
  const target = resolve(root, relPath);
  const rootResolved = resolve(root);
  if (!target.startsWith(rootResolved + sep) && target !== rootResolved) {
    return { ok: false, reason: "error", error: "path escapes archive root" };
  }
  try {
    await rm(target, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "error", error: errorMessage(err) };
  }
}
