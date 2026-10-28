"use client";

// UI 字号偏好（设置 → 偏好设置）。
//
// 缩放只作用于排版 token（--text-*），间距、图标、控件高度保持原样，
// 因此这里发布的是一个乘数变量，而不是把 html 的 font-size 改掉
// （后者会连锁放大所有 rem 尺寸，把布局撑变形）。
//
// 使用方：packages/ui/styles/tokens.css 里
//   --text-body: calc(14px * var(--ui-font-scale, 1));
//
// 分工：本模块只发布档位名（html[data-font-scale]）；档位 → 乘数的映射
// 在 tokens.css，因为那是样式决策，且这样 Web 的防闪烁脚本只需回放档位名，
// 不必复制一份比例表。
import { useEffect, useLayoutEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { defaultStorage } from "../platform/storage";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_ATTRIBUTE,
  FONT_SCALE_STORAGE_KEY,
  isFontScale,
  type FontScale,
} from "./font-scale-script";

// 档位、存储键、启动脚本都住在无 client 边界的 font-scale-script，
// 这里重新导出，调用方只需要记住一个入口。
export * from "./font-scale-script";

/** 只依赖这一个成员，便于在 node / 测试里注入替身。 */
export type FontScaleRoot = {
  setAttribute(name: string, value: string): void;
};

/**
 * 把档位写到根元素。没有 document（SSR、node 测试）时静默返回，
 * 由默认值兜底，避免在服务端渲染路径里抛错。
 */
export function applyFontScale(
  scale: FontScale,
  root?: FontScaleRoot | null,
): void {
  const target =
    root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!target) return;

  // 属性同时留给 e2e / devtools 核对当前档位。
  target.setAttribute(FONT_SCALE_ATTRIBUTE, scale);
}

type FontScaleState = {
  scale: FontScale;
  setScale: (scale: FontScale) => void;
};

export const useFontScaleStore = create<FontScaleState>()(
  persist(
    (set) => ({
      scale: DEFAULT_FONT_SCALE,
      setScale: (scale) => {
        if (!isFontScale(scale)) return;
        set({ scale });
      },
    }),
    {
      name: FONT_SCALE_STORAGE_KEY,
      storage: createJSONStorage(() => defaultStorage),
      partialize: (state) => ({ scale: state.scale }),
      // localStorage 是同步存储，这会在 create() 期间就执行完，比首次
      // 渲染更早——桌面端因此不会看到一帧默认字号。
      onRehydrateStorage: () => (state) => {
        if (state) applyFontScale(state.scale);
      },
      // 线上旧版本可能写过别的枚举值，落盘后仍然必须是合法档位。
      merge: (persisted, current) => {
        const raw = (persisted as { scale?: unknown } | undefined)?.scale;
        return { ...current, scale: isFontScale(raw) ? raw : DEFAULT_FONT_SCALE };
      },
    },
  ),
);

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 挂在 CoreProvider 下（web 与 desktop 共用），首帧就把档位同步到 DOM，
 * 避免刷新时先按 1x 绘制再跳字号。
 */
export function FontScaleSync() {
  const scale = useFontScaleStore((s) => s.scale);

  useIsomorphicLayoutEffect(() => {
    applyFontScale(scale);
  }, [scale]);

  return null;
}
