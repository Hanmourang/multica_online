/**
 * 原型预览适配 shim（注入到 srcdoc 末尾）。
 *
 * 两种原型：
 * 1. 固定尺寸导出件——`<html>` 上直接写 px 尺寸。按 iframe 视口宽等比缩放整页，
 *    并把缩放后的高度 postMessage 给宿主，让 iframe 收窄到内容高度。
 * 2. 响应式原型——没有内联尺寸。默认行为完全不变（早退）；原型画布需要时
 *    （`measureScroll`）额外上报 `scrollHeight`，宿主据此知道「内容其实比
 *    容器高」，从而可以整体缩放/拖动，而不是把下半截直接裁掉。
 *
 * 预览走 sandbox="allow-scripts"（无 allow-same-origin），脚本能跑但读不到
 * 父文档；postMessage 仍可用，父页按 event.source 校验来源。
 */

export const PROTOTYPE_FIT_MESSAGE = "multica-prototype-fit";

export type PrototypeFitMessage = {
  type: typeof PROTOTYPE_FIT_MESSAGE;
  height: number;
};

/** 缩得太狠会变成一条细缝，留一个下限；低于它宁可出现滚动。 */
const MIN_FIT_SCALE = 0.2;

function buildShim(measureScroll: boolean): string {
  return `<script>
(function(){
  var TYPE = ${JSON.stringify(PROTOTYPE_FIT_MESSAGE)};
  var MIN_SCALE = ${MIN_FIT_SCALE};
  var MEASURE = ${measureScroll ? "true" : "false"};
  var root = document.documentElement;
  var designW = parseFloat(root.style.width);
  var designH = parseFloat(root.style.height);
  var fixed = designW > 0 && designH > 0;
  if (!fixed && !MEASURE) return;
  function report(height){
    if (!(height > 0)) return;
    try { parent.postMessage({ type: TYPE, height: Math.round(height) }, "*"); } catch (e) {}
  }
  function contentHeight(){
    var body = document.body;
    return Math.max(root.scrollHeight || 0, body ? body.scrollHeight : 0);
  }
  function fit(){
    if (fixed) {
      var avail = window.innerWidth || root.clientWidth || designW;
      var scale = avail / designW;
      if (!(scale > 0)) return;
      scale = Math.min(1, Math.max(MIN_SCALE, scale));
      root.style.transformOrigin = "top left";
      root.style.transform = scale < 0.999 ? "scale(" + scale + ")" : "";
      // transform 不改变布局盒子，缩放后超出的部分仍会撑出滚动条，直接裁掉。
      root.style.overflow = "hidden";
      report(designH * scale);
      return;
    }
    // 响应式：内容比视口高才上报，避免与宿主设高度的回写互相触发。
    var height = contentHeight();
    if (height > (window.innerHeight || 0) + 8) report(height);
  }
  window.addEventListener("resize", fit);
  window.addEventListener("load", fit);
  fit();
  // Tailwind CDN、字体与图片加载后会改写尺寸，补量几次。
  setTimeout(fit, 60);
  setTimeout(fit, 400);
  setTimeout(fit, 1200);
  setTimeout(fit, 2500);
})();
</script>`;
}

export const __PROTOTYPE_FIT_SHIM__ = buildShim(false);
export const __PROTOTYPE_MEASURE_SHIM__ = buildShim(true);

export function withPrototypeFitShim(
  html: string | undefined,
  options?: { measureScroll?: boolean },
): string {
  return (html ?? "") + (options?.measureScroll ? buildShim(true) : buildShim(false));
}

/** 读出宿主需要的 iframe 高度；来源校验由调用方按 event.source 完成。 */
export function readPrototypeFitHeight(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Partial<PrototypeFitMessage>;
  if (rec.type !== PROTOTYPE_FIT_MESSAGE) return null;
  const height = Number(rec.height);
  if (!Number.isFinite(height) || height <= 0) return null;
  return Math.round(height);
}
