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
 * 响应式这一支必须防正反馈：宿主拿到高度就写进 iframe 的 style.height，而
 * `min-height:100dvh` / `height:100vh` 类布局的 scrollHeight 恒等于「视口高 +
 * 自身 padding」，视口一变高它跟着变高，于是两者互相喂，高度无上限上涨（实测
 * 8 秒涨 22 万 px，flex 居中的内容被推到视口外，预览区只剩空白）。
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

/**
 * 上报高度的绝对上限。上面的防反馈判据覆盖不了的异常布局，一律按异常处理：
 * 宁可让内容滚动，也不能让一个坏原型把整页撑爆。
 */
export const MAX_PROTOTYPE_FIT_HEIGHT = 30_000;

function buildShim(measureScroll: boolean): string {
  return `<script>
(function(){
  var TYPE = ${JSON.stringify(PROTOTYPE_FIT_MESSAGE)};
  var MIN_SCALE = ${MIN_FIT_SCALE};
  var MAX_FIT = ${MAX_PROTOTYPE_FIT_HEIGHT};
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
  var prevViewport = 0;
  var prevHeight = 0;
  function contentHeight(){
    var body = document.body;
    return Math.max(root.scrollHeight || 0, body ? body.scrollHeight : 0);
  }
  // 撑满视口的原型会在根元素/body 上留垂直 padding，这段 padding 会原样
  // 计入 scrollHeight，却不是「内容真的更高」。
  function viewportPadding(){
    var pad = 0;
    var nodes = [root, document.body];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i] || !window.getComputedStyle) continue;
      var cs = getComputedStyle(nodes[i]);
      pad += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    }
    return pad;
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
    // 响应式：内容比视口高才上报，且要排除「撑满视口」造成的假高度。
    var height = contentHeight();
    var viewport = window.innerHeight || 0;
    var lastHeight = prevHeight;
    // 上一轮测量时「内容比视口高多少」。撑满视口的布局里这个差值恒定不变。
    var lastOverflow = prevHeight - prevViewport;
    prevViewport = viewport;
    prevHeight = height;
    var overflow = height - viewport;
    if (!(overflow > 0)) return;
    // 1) 溢出量只有这层 padding：视口已经装得下内容，撑高只会让下次测量再涨一截。
    if (overflow <= viewportPadding() + 8) return;
    // 2) 溢出量与上一轮持平：说明这截高度是布局的结构性留白（100dvh/100vh 加
    //    固定偏移），不会因为视口变高而收敛。实测某手机原型恒为「视口 + 480」，
    //    每回写一次就再涨 480，直到把内容推到视口外。
    if (lastHeight > 0 && Math.abs(overflow - lastOverflow) <= 8) return;
    if (height > MAX_FIT) return;
    report(height);
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
