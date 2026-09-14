/** 档案 HTML 原型预览：拼 file://、收集并内联相对样式 / 脚本。 */

const STYLESHEET_LINK =
  /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;

const SCRIPT_SRC =
  /<script\b(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>\s*<\/script>/gi;

export function archiveFileUrl(root: string, relPath: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\//, "");
  const abs = `${normalizedRoot}/${normalizedRel}`;
  if (/^[A-Za-z]:/.test(abs)) return `file:///${abs}`;
  return abs.startsWith("/") ? `file://${abs}` : `file:///${abs}`;
}

export function isRelativeAssetHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return true;
}

export function resolveRelativeRelPath(fromRelPath: string, href: string): string {
  const fromDir = fromRelPath.replace(/\\/g, "/").split("/").filter(Boolean).slice(0, -1);
  const stack = [...fromDir];
  for (const part of href.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

export function collectRelativeStylesheets(html: string): string[] {
  const hrefs: string[] = [];
  const seen = new Set<string>();
  html.replace(STYLESHEET_LINK, (_tag, href: string) => {
    if (isRelativeAssetHref(href) && !seen.has(href)) {
      seen.add(href);
      hrefs.push(href);
    }
    return _tag;
  });
  return hrefs;
}

export function inlineRelativeStylesheets(
  html: string,
  files: Record<string, string>,
): string {
  return html.replace(STYLESHEET_LINK, (tag, href: string) => {
    if (!isRelativeAssetHref(href)) return tag;
    const css = files[href];
    if (css == null) return tag;
    return `<style data-archive-inline="${href}">\n${css}\n</style>`;
  });
}

export function collectRelativeScripts(html: string): string[] {
  const hrefs: string[] = [];
  const seen = new Set<string>();
  html.replace(SCRIPT_SRC, (_tag, src: string) => {
    if (isRelativeAssetHref(src) && !seen.has(src)) {
      seen.add(src);
      hrefs.push(src);
    }
    return _tag;
  });
  return hrefs;
}

export function inlineRelativeScripts(
  html: string,
  files: Record<string, string>,
): string {
  return html.replace(SCRIPT_SRC, (tag, src: string) => {
    if (!isRelativeAssetHref(src)) return tag;
    const js = files[src];
    if (js == null) return tag;
    return `<script data-archive-inline="${src}">\n${js}\n</script>`;
  });
}

/** Tailwind Play CDN / Google Fonts 在国内经常十几秒；预览里直接丢掉，改走本地 CSS。 */
export function stripRemotePreviewAssets(html: string): string {
  return html
    .replace(/<script\b[^>]*\bsrc=["']https?:\/\/cdn\.tailwindcss\.com[^>]*>\s*<\/script>/gi, "")
    .replace(/<link\b[^>]*\bhref=["']https?:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/gi, "");
}
