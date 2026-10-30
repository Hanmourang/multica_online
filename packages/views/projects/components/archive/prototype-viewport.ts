/**
 * 原型预览的画布变换（缩放 / 平移）纯逻辑。
 *
 * 固定尺寸原型（导出件把 width/height 写在 <html> 上）在窄高预览区里会被裁掉
 * 下半截：fit shim 按宽度比缩放到 1，iframe 高度就等于设计高度，容器装不下。
 * 这里把「适应窗口 / 实际大小 / 指针锚点缩放 / 平移边界」收敛成可单测的函数，
 * 组件只负责把结果写进 transform。坐标一律是预览容器内的 CSS px。
 */

/** 缩得太狠会看不清；放到 200% 足够校对细节。 */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

/** 适应窗口时四周留白，避免贴边看不出边框。 */
export const FIT_PADDING = 12;

export type Zoom = number;
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

export function clampZoom(zoom: Zoom): Zoom {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * 适应窗口的缩放比：只按高度定，不放大（zoom 上限 1）。
 * 宽度方向不另算——内容宽度就是预览区宽度，按高度缩完一定不会横向溢出。
 */
export function fitZoomFor(contentH: number, viewH: number, padding = FIT_PADDING): Zoom {
  if (!(contentH > 0) || !(viewH > 0)) return 1;
  // 本来就装得下就别动：留白只在需要缩小时参与计算，否则会凭空缩掉一圈。
  if (contentH <= viewH) return 1;
  const usable = Math.max(1, viewH - padding * 2);
  return clampZoom(Math.min(1, usable / contentH));
}

/**
 * 把平移量夹回可视范围：
 * - 缩放后比视口小的方向居中（不留半截空白）；
 * - 比视口大的方向允许 0 到「视口 - 内容」之间移动，内容边缘不会进到视口里侧。
 */
export function clampPan(
  pan: Point,
  content: Size,
  zoom: Zoom,
  view: Size,
): Point {
  const scaledW = content.w * zoom;
  const scaledH = content.h * zoom;

  const x =
    scaledW <= view.w
      ? Math.max(0, (view.w - scaledW) / 2)
      : Math.min(0, Math.max(view.w - scaledW, pan.x));

  const y =
    scaledH <= view.h
      ? Math.max(0, (view.h - scaledH) / 2)
      : Math.min(0, Math.max(view.h - scaledH, pan.y));

  return { x, y };
}

/**
 * 以视口内某个点为锚做缩放：缩放前后该点下方的内容位置不变。
 * 滚轮缩放与工具条缩放都走这里，拖动手感才一致。
 */
export function zoomAt(pan: Point, zoom: Zoom, nextZoom: Zoom, anchor: Point): Point {
  if (zoom <= 0) return pan;
  const worldX = (anchor.x - pan.x) / zoom;
  const worldY = (anchor.y - pan.y) / zoom;
  return {
    x: anchor.x - worldX * nextZoom,
    y: anchor.y - worldY * nextZoom,
  };
}

/** 滚轮增量换算成缩放比：向上（负 delta）放大，向下缩小。 */
export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  return Math.exp(-deltaY * 0.0015);
}

/** 从 iframe 的内联高度（fit shim 上报过）取内容高度；没有就退回视口高度。 */
export function readFrameContentHeight(styleHeight: string | null | undefined, viewH: number): number {
  const parsed = Number.parseFloat(styleHeight ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return viewH;
  return Math.round(parsed);
}
