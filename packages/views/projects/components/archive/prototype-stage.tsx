"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Hand, Maximize2, Minus, Plus } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import {
  clampPan,
  clampZoom,
  fitZoomFor,
  readFrameContentHeight,
  wheelZoomFactor,
  zoomAt,
  type Point,
} from "./prototype-viewport";

/** 右下工具条的占位：适配时从可用高度里扣除，避免盖住原型底部。 */
const TOOLBAR_RESERVE = 40;

/**
 * 自动适配的宽容度：内容比视口高 2.4 倍以上就别自动缩了（缩完字小到不可读），
 * 保持 100% 让用户拖。手动点「适应窗口」不受这个限制。
 */
const FIT_MAX_OVERFLOW = 2.4;

/**
 * 原型画布：给嵌入的原型预览加「适应窗口 / 缩放 / 拖动平移」。
 *
 * 背景：固定尺寸原型（375×812 这类导出件）在预览卡片里高度被裁掉，底部导航
 * 完全看不到，而 iframe 内部被 fit shim 设成 overflow:hidden，滚动条也无处可滚。
 * 这里把 iframe 放进一层可变换的容器：默认按高度「适应窗口」整页可见，需要
 * 校对细节时可以放大到 100% 以上，再用抓手模式拖动查看。
 *
 * 事件交给谁：默认浏览态不盖任何遮罩，原型里的热点点击/悬停照旧；抓手模式下
 * 才铺一层透明遮罩接管拖拽与滚轮（iframe 内部事件不会冒泡到父页，这是必需的一层）。
 */
export function PrototypeStage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT("archive");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; panX: number; panY: number } | null>(
    null,
  );
  const [view, setView] = useState({ w: 0, h: 0 });
  const [contentH, setContentH] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  /** fit：跟随容器/内容高度自动重算；manual：用户缩放或拖动过，保持不动。 */
  const [mode, setMode] = useState<"fit" | "manual">("fit");
  const [grab, setGrab] = useState(false);

  const content = useMemo(() => ({ w: view.w || 1, h: contentH || view.h || 1 }), [contentH, view]);
  const viewport = useMemo(() => ({ w: view.w || 1, h: view.h || 1 }), [view]);

  // 视口尺寸
  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    const apply = () => {
      const rect = host.getBoundingClientRect();
      setView((prev) => {
        const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
        return prev.w === next.w && prev.h === next.h ? prev : next;
      });
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 内容高度：fit shim 把缩放后的设计高度写进 iframe 的 style.height，
  // 这里以 style.height 为准（响应式原型没有内联高度，退回视口高度）。
  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    let raf = 0;
    const measure = () => {
      const frame = host.querySelector("iframe");
      const styleHeight = frame?.style.height;
      const next = readFrameContentHeight(styleHeight, view.h || host.clientHeight);
      setContentH((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    if (typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(schedule);
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [view.h]);

  const applyFit = useCallback(
    (force = false) => {
      if (!(view.w > 0) || !(view.h > 0) || !(contentH > 0)) return;
      // 响应式原型（iframe 高度就是视口高度）本来就装得下，不要为了留工具条而缩一圈。
      const tooTall = contentH > view.h * FIT_MAX_OVERFLOW;
      if (contentH <= view.h + 1 || (!force && tooTall)) {
        setZoom(1);
        setMode("fit");
        setPan({ x: 0, y: 0 });
        return;
      }
      // 底部给工具条留出高度：适配后的内容不能藏在缩放条下面，尤其手机原型底部
      // 恰好是导航栏，正是最需要看到的那一截。
      const usableH = Math.max(1, view.h - TOOLBAR_RESERVE);
      const next = fitZoomFor(contentH, usableH);
      setZoom(next);
      setMode("fit");
      // 垂直靠底部预留（而不是居中）：内容底边永远在工具条上方。
      const scaledH = contentH * next;
      const y = Math.max(0, view.h - TOOLBAR_RESERVE - scaledH);
      const x = clampPan({ x: 0, y: 0 }, { w: view.w, h: contentH }, next, view).x;
      setPan({ x, y });
    },
    [contentH, view],
  );

  // 跟进容器与内容变化（切版本后高度会变），手动缩放后不再抢用户的操作。
  useEffect(() => {
    if (mode !== "fit") return;
    applyFit();
  }, [applyFit, mode]);

  const zoomTo = useCallback(
    (nextZoom: number, anchor?: Point) => {
      const next = clampZoom(nextZoom);
      const focus = anchor ?? { x: view.w / 2, y: view.h / 2 };
      setZoom(next);
      setMode("manual");
      setPan((prev) => clampPan(zoomAt(prev, zoom, next, focus), content, next, viewport));
    },
    [content, view.h, view.w, viewport, zoom],
  );

  /** 实际大小：水平居中、垂直从头看，而不是以视口中心为锚跳到内容中段。 */
  const zoomToActual = useCallback(() => {
    setZoom(1);
    setMode("manual");
    setPan(clampPan({ x: 0, y: 0 }, content, 1, viewport));
  }, [content, viewport]);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomTo(zoom * wheelZoomFactor(event.deltaY), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!grab || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, panX: pan.x, panY: pan.y };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = {
      x: drag.panX + (event.clientX - drag.pointerX),
      y: drag.panY + (event.clientY - drag.pointerY),
    };
    setPan(clampPan(next, content, zoom, viewport));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const overflow = contentH > view.h + 1;
  const canPan = overflow || content.w * zoom > view.w + 1 || contentH * zoom > view.h + 1;
  const percent = Math.round(zoom * 100);

  return (
    <div
      ref={stageRef}
      className={cn("relative h-full min-h-0 w-full overflow-hidden bg-white", className)}
      data-testid="prototype-stage"
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: "100%",
          height: contentH > 0 ? contentH : "100%",
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
        }}
      >
        {children}
      </div>

      {/* 抓手模式才接事件：否则原型内部的点击、悬停、热点高亮全部保留。 */}
      <div
        className={cn(
          "absolute inset-0 z-10",
          grab ? "cursor-grab active:cursor-grabbing" : "pointer-events-none",
        )}
        onWheel={grab ? onWheel : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={grab ? () => applyFit() : undefined}
      />

      <div className="absolute bottom-2 right-2 z-20 flex items-center gap-0.5 rounded-full border border-surface-border bg-background/90 px-1 py-0.5 shadow-sm backdrop-blur">
        <StageButton
          label={t(($) => $.features.preview_zoom_out)}
          onClick={() => zoomTo(zoom / 1.25)}
          disabled={zoom <= 0.26}
        >
          <Minus className="size-3.5" />
        </StageButton>
        <button
          type="button"
          className="min-w-10 rounded-full px-1 text-center font-mono text-[11px] font-semibold tabular-nums text-muted-foreground hover:text-foreground"
          title={t(($) => $.features.preview_zoom_actual)}
          onClick={zoomToActual}
        >
          {percent}%
        </button>
        <StageButton
          label={t(($) => $.features.preview_zoom_in)}
          onClick={() => zoomTo(zoom * 1.25)}
          disabled={zoom >= 1.99}
        >
          <Plus className="size-3.5" />
        </StageButton>
        <StageButton
          label={t(($) => $.features.preview_zoom_fit)}
          active={mode === "fit"}
          onClick={() => applyFit(true)}
          disabled={!overflow && zoom >= 1}
        >
          <Maximize2 className="size-3.5" />
        </StageButton>
        <StageButton
          label={t(($) => $.features.preview_pan)}
          active={grab}
          hint={!grab && overflow}
          disabled={!canPan}
          onClick={() => setGrab((prev) => !prev)}
        >
          <Hand className="size-3.5" />
        </StageButton>
      </div>
    </div>
  );
}

function StageButton({
  label,
  active,
  hint,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  /** 内容被裁、尚未开抓手时的静默引导色。 */
  hint?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        active && "bg-violet-500/15 text-violet-600 dark:text-violet-400",
        hint && "text-amber-600 ring-1 ring-amber-400/60 dark:text-amber-400",
      )}
    >
      {children}
    </button>
  );
}
