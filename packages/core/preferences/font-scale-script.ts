// 字体大小偏好的纯常量与启动脚本。
//
// 这个文件故意没有 "use client"：apps/web/app/layout.tsx 是服务端组件，
// 只有不带 client 边界的模块才能安全读取导出值（从 "use client" 模块只能
// 拿到组件引用，读普通常量会在渲染时报错）。
export const FONT_SCALES = ["sm", "md", "lg", "xl"] as const;

export type FontScale = (typeof FONT_SCALES)[number];

export const DEFAULT_FONT_SCALE: FontScale = "md";

/** 挂在根元素上的档位名；比例由 packages/ui/styles/tokens.css 解析。 */
export const FONT_SCALE_ATTRIBUTE = "data-font-scale";

export const FONT_SCALE_STORAGE_KEY = "multica_font_scale";

export function isFontScale(value: unknown): value is FontScale {
  return typeof value === "string" && (FONT_SCALES as readonly string[]).includes(value);
}

/**
 * 在 hydration 之前把已保存的档位回放到 <html> 上。
 *
 * Web 是 SSR：首屏 HTML 先于 JS 绘制，缺了这段就能看到字号从 1x 跳到用户
 * 选择的档位。桌面端是纯 CSR，store 的 onRehydrateStorage 已经覆盖，不需要它。
 *
 * 只读取档位名——乘数在 tokens.css——所以这里不必复制比例表。
 */
export const FONT_SCALE_RESTORE_SCRIPT = [
  "(function () {",
  "  try {",
  `    var saved = JSON.parse(localStorage.getItem(${JSON.stringify(FONT_SCALE_STORAGE_KEY)}) || "null");`,
  "    var scale = saved && saved.state && saved.state.scale;",
  `    if (${JSON.stringify(FONT_SCALES)}.indexOf(scale) !== -1) {`,
  `      document.documentElement.setAttribute(${JSON.stringify(FONT_SCALE_ATTRIBUTE)}, scale);`,
  "    }",
  "  } catch (error) {}",
  "})();",
].join("\n");
