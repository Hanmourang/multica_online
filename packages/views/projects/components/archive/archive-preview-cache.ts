import { normalizeScanRel } from "./archive-import";
import { previewRelPathCandidates } from "./archive-preview-resolve";

const texts = new Map<string, string>();
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  generation += 1;
  for (const listener of listeners) listener();
}

export function archivePreviewCacheGeneration(): number {
  return generation;
}

export function subscribeArchivePreviewCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function putArchivePreviewTexts(
  entries: Array<{ relPath: string; text: string }>,
) {
  for (const entry of entries) {
    const raw = entry.relPath.replace(/\\/g, "/");
    const normalized = normalizeScanRel(raw);
    if (raw) texts.set(raw, entry.text);
    if (normalized) texts.set(normalized, entry.text);
  }
  emit();
}

export function getArchivePreviewText(relPath: string): string | null {
  for (const candidate of previewRelPathCandidates(relPath)) {
    const raw = candidate.replace(/\\/g, "/");
    const hit = texts.get(raw) ?? texts.get(normalizeScanRel(raw));
    if (hit) return hit;
    for (const [key, text] of texts) {
      if (key.endsWith(`/${raw}`) || normalizeScanRel(key) === raw) return text;
    }
  }
  return null;
}

export async function pickWebDirectoryFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.addEventListener(
      "change",
      () => resolve(Array.from(input.files ?? [])),
      { once: true },
    );
    input.click();
  });
}
