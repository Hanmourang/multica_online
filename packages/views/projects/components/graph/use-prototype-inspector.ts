"use client";

import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

export const INSPECTOR_WIDTH_MIN = 240;
export const INSPECTOR_WIDTH_MAX = 520;
export const INSPECTOR_WIDTH_DEFAULT = 320;
export const INSPECTOR_WIDTH_KEY = "multica.prototype-inspector.width";

export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) return INSPECTOR_WIDTH_DEFAULT;
  return Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, Math.round(width)));
}

export function readStoredInspectorWidth(): number {
  if (typeof localStorage === "undefined") return INSPECTOR_WIDTH_DEFAULT;
  return clampInspectorWidth(Number(localStorage.getItem(INSPECTOR_WIDTH_KEY)));
}

/**
 * 原型右侧详情：默认收缩；宽度拖动手柄记到 localStorage。
 * 展开态不持久化，保证每次进入都是收起的产品默认。
 */
export function usePrototypeInspector() {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(INSPECTOR_WIDTH_DEFAULT);

  useEffect(() => {
    setWidth(readStoredInspectorWidth());
  }, []);

  const persistWidth = useCallback((next: number) => {
    const clamped = clampInspectorWidth(next);
    setWidth(clamped);
    try {
      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(clamped));
    } catch {
      // private mode / quota
    }
  }, []);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startW = width;
      handle.setPointerCapture(event.pointerId);

      const onMove = (move: PointerEvent) => {
        persistWidth(startW + (startX - move.clientX));
      };
      const onUp = () => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [persistWidth, width],
  );

  return { open, setOpen, width, startResize };
}
