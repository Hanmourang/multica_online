/**
 * 固定尺寸原型（导出工具把 width/height 直接写在 <html> 上）的预览适配。
 *
 * 这类原型在 350px 宽的预览区里只能看到左上角一条，看起来像「绑定坏了」。
 * 这里在 srcdoc 内注入一小段脚本：按 iframe 视口宽等比缩放整页，并把缩放后
 * 的高度 postMessage 给宿主，让 iframe 收窄到内容高度，避免下方大片留白。
 *
 * 响应式原型（<html> 上没有 px 尺寸）直接早退，行为完全不变。
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

const FIT_SHIM = `<script>
(function(){
  var TYPE = ${JSON.stringify(PROTOTYPE_FIT_MESSAGE)};
  var MIN_SCALE = ${MIN_FIT_SCALE};
  var root = document.documentElement;
  var designW = parseFloat(root.style.width);
  var designH = parseFloat(root.style.height);
  if (!(designW > 0) || !(designH > 0)) return;
  function fit(){
    var avail = window.innerWidth || root.clientWidth || designW;
    var scale = avail / designW;
    if (!(scale > 0)) return;
    scale = Math.min(1, Math.max(MIN_SCALE, scale));
    root.style.transformOrigin = "top left";
    root.style.transform = scale < 0.999 ? "scale(" + scale + ")" : "";
    // transform 不改变布局盒子，缩放后超出的部分仍会撑出滚动条，直接裁掉。
    root.style.overflow = "hidden";
    try {
      parent.postMessage({ type: TYPE, height: Math.round(designH * scale) }, "*");
    } catch (e) {}
  }
  window.addEventListener("resize", fit);
  fit();
  // Tailwind CDN 与字体加载后会改写尺寸，补量两次。
  setTimeout(fit, 60);
  setTimeout(fit, 400);
})();
</script>`;

export const __PROTOTYPE_FIT_SHIM__ = FIT_SHIM;

export function withPrototypeFitShim(html: string | undefined): string {
  return (html ?? "") + FIT_SHIM;
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
