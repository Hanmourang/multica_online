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

/**
 * 把 HTML 里的相对样式、脚本嵌进正文，供 srcdoc 直接当原型打开。
 * srcdoc 没有页面地址，`./shared.css` 这类链接不会自己去拉同目录附件。
 */
export async function inlineHtmlRelativeAssets(
  html: string,
  fromRelPath: string,
  load: (resolvedRelPath: string) => Promise<string | null | undefined>,
): Promise<string> {
  const hrefs = collectRelativeStylesheets(html);
  const scripts = collectRelativeScripts(html);
  if (hrefs.length === 0 && scripts.length === 0) {
    return stripRemotePreviewAssets(html);
  }
  const files: Record<string, string> = {};
  await Promise.all(
    [...hrefs, ...scripts].map(async (href) => {
      const text = await load(resolveRelativeRelPath(fromRelPath, href));
      if (text) files[href] = text;
    }),
  );
  return stripRemotePreviewAssets(
    inlineRelativeScripts(inlineRelativeStylesheets(html, files), files),
  );
}

const CONTRACT_PREVIEW_STYLE = `<style data-contract-prototype>
html,body{margin:0;background:#f4f5f8;color:#1c1c1e;}
body{box-sizing:border-box;min-height:100vh;padding:16px;font-family:ui-sans-serif,system-ui,sans-serif;display:flex;flex-direction:column;gap:10px;}
[data-fp]{display:block;background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 1px 2px rgba(16,24,40,.06);font-size:13px;line-height:1.5;}
[data-fp]::before{content:attr(data-title);display:block;margin-bottom:4px;font-size:10px;font-weight:700;letter-spacing:.04em;color:#8a8f98;}
</style>`;

/** 只有 data-fp 标记、没有样式的契约稿。按原文渲染会变成几行纯文本。 */
export function isContractPrototypeHtml(html: string): boolean {
  const source = html.trim();
  if (!source || !/data-fp\s*=/i.test(source)) return false;
  if (/<style\b/i.test(source)) return false;
  if (/<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i.test(source)) return false;
  if (/\bclass\s*=/.test(source)) return false;
  return true;
}

/** 给契约稿补上原型页底，热点文字仍来自原文件。已有样式的 HTML 原样返回。 */
export function withContractPrototypeChrome(html: string): string {
  if (!isContractPrototypeHtml(html)) return html;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${CONTRACT_PREVIEW_STYLE}`);
  }
  if (/<body[\s>]/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<head>${CONTRACT_PREVIEW_STYLE}</head><body$1>`);
  }
  return `${CONTRACT_PREVIEW_STYLE}${html}`;
}

/** Tailwind Play CDN / Google Fonts 在国内经常十几秒；预览里直接丢掉，改走本地 CSS。 */
export function stripRemotePreviewAssets(html: string): string {
  return html
    .replace(/<script\b[^>]*\bsrc=["']https?:\/\/cdn\.tailwindcss\.com[^>]*>\s*<\/script>/gi, "")
    .replace(/<link\b[^>]*\bhref=["']https?:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/gi, "");
}
