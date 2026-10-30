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
  assets?: PreviewAssetSigning,
): Promise<string> {
  const hrefs = collectRelativeStylesheets(html);
  const scripts = collectRelativeScripts(html);
  if (hrefs.length === 0 && scripts.length === 0) {
    return finalizePreviewAssets(html, assets);
  }
  const files: Record<string, string> = {};
  await Promise.all(
    [...hrefs, ...scripts].map(async (href) => {
      const text = await load(resolveRelativeRelPath(fromRelPath, href));
      if (text) files[href] = text;
    }),
  );
  return finalizePreviewAssets(
    inlineRelativeScripts(inlineRelativeStylesheets(html, files), files),
    assets,
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

/**
 * 原型预览的资源归一化（单点收口）。
 *
 * 历史一：为了避开 Tailwind Play CDN / Google Fonts 在国内的十几秒卡顿，老实现
 * 直接把这两个远程依赖删掉（stripRemotePreviewAssets）。代价是：原型几乎都靠
 * Tailwind CDN 现场生成 utility 样式，删掉后整页退化成无样式文本堆叠，
 * Material Symbols 还会把字形名（chevron_right、account_tree）当文字显示 ——
 * 预览看上去就像坏了。CDN 慢只是首屏晚一点变好看，删掉则是永远不对。
 *
 * 历史二：改成原样保留后，原型区域又变回十几秒白屏 —— 这些域名在国内根本不可
 * 达（实测 fonts.googleapis.com / fonts.gstatic.com 25s 才超时），而样式表是
 * 渲染阻塞资源。现在改走服务端：远程引用重写成同源的 `/api/preview-assets`，
 * 由 ECS 代取一次并缓存（见 server/internal/handler/preview_assets.go），浏览器
 * 于是只连本机站点。
 *
 * 历史三：代理端点最初挂在鉴权路由上，结果 iframe 里一个都没加载成 —— srcdoc
 * 是 sandbox 文档（不透明源），子资源请求不带 cookie，33 个请求 33 个 401，页面
 * 于是既无样式、Material Symbols 又把字形名（chevron_right）当文字显示。现在
 * 先请服务端签发（preparePreviewAssetsSigned），路径里的 HMAC 就是凭证。
 *
 * 只重写白名单 host 的样式表 / 脚本 / 图片；preconnect 之类的预处理提示保持
 * 原样，它们不阻塞渲染。
 */
export const PREVIEW_ASSET_HOSTS = [
  "cdn.tailwindcss.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "lh3.googleusercontent.com",
] as const;

function previewProxySrc(url: string, assetBase: string): string {
  return `${assetBase}${unsignedProxyPath(url)}`;
}

/** 签名调用失败时的兜底路径：会 403，但至少是毫秒级失败，不会退回境外直连。 */
function unsignedProxyPath(url: string): string {
  // HTML 属性里的 `&amp;` 是实体，encode 前先还原，否则查询串会带上一个假的
  // `amp;` 参数，Google Fonts 那边就匹配不到 family。
  return `/api/preview-assets?u=${encodeURIComponent(normalizeAssetTarget(url))}`;
}

function normalizeAssetTarget(url: string): string {
  return url.replace(/&amp;/g, "&");
}

function isPreviewAssetUrl(url: string): boolean {
  const host = /^https:\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase();
  return host != null && (PREVIEW_ASSET_HOSTS as readonly string[]).includes(host);
}

const STYLESHEET_TAG =
  /<link\b(?=[^>]*\brel\s*=\s*["']stylesheet["'])[^>]*\bhref\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;
const SCRIPT_TAG = /<script\b(?=[^>]*\bsrc\s*=)[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;
const IMG_TAG = /<img\b(?=[^>]*\bsrc\s*=)[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;
const CSS_REMOTE_URL = /url\((['"]?)(https:\/\/[^)'"\s]+)\1\)/gi;

/** 远程地址 → 同源路径；返回 null 表示保留原文。 */
type PreviewAssetResolver = (url: string) => string | null;

function rewriteAttrSource(
  html: string,
  pattern: RegExp,
  resolve: PreviewAssetResolver,
): string {
  return html.replace(pattern, (match, quote: string, url: string) => {
    if (!isPreviewAssetUrl(url)) return match;
    const replacement = resolve(url);
    if (replacement == null) return match;
    return match.replace(
      `${quote}${url}${quote}`,
      `${quote}${replacement}${quote}`,
    );
  });
}

function rewriteRemoteAssetUrls(
  html: string,
  resolve: PreviewAssetResolver,
): string {
  let out = rewriteAttrSource(html, STYLESHEET_TAG, resolve);
  out = rewriteAttrSource(out, SCRIPT_TAG, resolve);
  out = rewriteAttrSource(out, IMG_TAG, resolve);
  // 内联 <style> 里的字体 / 图片地址同样要指回代理，否则样式到了、字体还在直连。
  return out.replace(CSS_REMOTE_URL, (match, quote: string, url: string) => {
    if (!isPreviewAssetUrl(url)) return match;
    const replacement = resolve(url);
    if (replacement == null) return match;
    return `url(${quote}${replacement}${quote})`;
  });
}

/**
 * 同步版：直接改写成未签名的代理路径。只当兜底用 —— 预览 iframe 是不透明源，
 * 未签名地址会被 403（但毫秒级失败，比境外直连的二十多秒白屏好得多）。
 */
export function preparePreviewAssets(html: string, assetBase = ""): string {
  return rewriteRemoteAssetUrls(html, (url) => previewProxySrc(url, assetBase));
}

/** 需要签发代理路径的远程资源（`&amp;` 已还原），去重。 */
export function collectPreviewAssetUrls(html: string): string[] {
  const found = new Set<string>();
  const scan = (pattern: RegExp) => {
    html.replace(pattern, (match, _quote: string, url: string) => {
      if (isPreviewAssetUrl(url)) found.add(normalizeAssetTarget(url));
      return match;
    });
  };
  scan(STYLESHEET_TAG);
  scan(SCRIPT_TAG);
  scan(IMG_TAG);
  scan(CSS_REMOTE_URL);
  return [...found];
}

/** 签发：把远程地址交给服务端盖 HMAC，再按签名后的路径重写 HTML。 */
export type PreviewAssetSigning = {
  assetBase?: string;
  sign: (urls: string[]) => Promise<Record<string, string>>;
};

async function finalizePreviewAssets(
  html: string,
  assets?: PreviewAssetSigning,
): Promise<string> {
  const assetBase = assets?.assetBase ?? "";
  if (!assets) return preparePreviewAssets(html, assetBase);
  return preparePreviewAssetsSigned(html, assetBase, assets.sign);
}

/**
 * 异步版（正式路径）：先请服务端签发，再重写。
 *
 * 预览 iframe 是 sandbox="allow-scripts" 的 srcdoc 文档，属于不透明源，它的
 * <script>/<link>/<img> 子资源请求不带 cookie 也不带 Authorization，所以未签名
 * 的代理路径一定 401/403。签名只覆盖白名单 host 的绝对地址，由服务端在登录会话
 * 下签发（POST /api/preview-assets/sign），路径里的 HMAC 就是凭证。
 */
export async function preparePreviewAssetsSigned(
  html: string,
  assetBase: string,
  sign: (urls: string[]) => Promise<Record<string, string>>,
): Promise<string> {
  const targets = collectPreviewAssetUrls(html);
  let signed: Record<string, string> = {};
  if (targets.length > 0) {
    signed = await sign(targets).catch(() => ({}));
  }
  return rewriteRemoteAssetUrls(html, (url) => {
    const path = signed[normalizeAssetTarget(url)];
    return `${assetBase}${path ?? unsignedProxyPath(url)}`;
  });
}
