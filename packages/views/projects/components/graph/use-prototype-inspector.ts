"use client";

import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

// 原型图 TAB 右栏（v2 画面 4）：宽度三态 + 收起态都写本地偏好，换模块不重置。
//   默认 360 · 窄 300 · 拖动范围 300–560 · 收起态 30px 竖条
export const INSPECTOR_WIDTH_MIN = 300;
export const INSPECTOR_WIDTH_MAX = 560;
export const INSPECTOR_WIDTH_DEFAULT = 360;
export const INSPECTOR_WIDTH_NARROW = 300;
export const INSPECTOR_COLLAPSED_WIDTH = 30;
export const INSPECTOR_WIDTH_KEY = "multica.prototype-inspector.width";
export const INSPECTOR_OPEN_KEY = "multica.prototype-inspector.open";

export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) return INSPECTOR_WIDTH_DEFAULT;
  return Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, Math.round(width)));
}

export function readStoredInspectorWidth(): number {
  if (typeof localStorage === "undefined") return INSPECTOR_WIDTH_DEFAULT;
  return clampInspectorWidth(Number(localStorage.getItem(INSPECTOR_WIDTH_KEY)));
}

/** 折叠态也持久化：首次进入默认展开（右栏就是主阅读区），收起后记住。 */
export function readStoredInspectorOpen(): boolean {
  if (typeof localStorage === "undefined") return true;
  const stored = localStorage.getItem(INSPECTOR_OPEN_KEY);
  return stored === null ? true : stored === "1";
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / quota
  }
}

/**
 * 原型右侧详情：宽度三态 + 折叠态持久化，中缝拖拽 300–560。
 * 快捷键（⌥[ / ⌥] 切宽、⌘⇧B 折叠）由 useInspectorShortcuts 绑定到窗口。
 */
export function usePrototypeInspector() {
  const [open, setOpenState] = useState(true);
  const [width, setWidth] = useState(INSPECTOR_WIDTH_DEFAULT);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setWidth(readStoredInspectorWidth());
    setOpenState(readStoredInspectorOpen());
    setHydrated(true);
  }, []);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    writeLocal(INSPECTOR_OPEN_KEY, next ? "1" : "0");
  }, []);

  const persistWidth = useCallback((next: number) => {
    const clamped = clampInspectorWidth(next);
    setWidth(clamped);
    writeLocal(INSPECTOR_WIDTH_KEY, String(clamped));
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

  return { open, setOpen, width, setWidth: persistWidth, startResize, hydrated };
}

/** 窗口级快捷键：⌥[ 窄 / ⌥] 宽，⌘⇧B（或 ⌃⇧B）折叠。 */
export function useInspectorShortcuts({
  onToggle,
  onNarrow,
  onWide,
  enabled = true,
}: {
  onToggle: () => void;
  onNarrow: () => void;
  onWide: () => void;
  enabled?: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.code === "BracketLeft") {
        event.preventDefault();
        onNarrow();
        return;
      }
      if (event.altKey && event.code === "BracketRight") {
        event.preventDefault();
        onWide();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyB") {
        event.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onNarrow, onToggle, onWide]);
}
