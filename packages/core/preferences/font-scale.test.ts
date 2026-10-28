// 字体大小偏好（设置 → 偏好设置）：纯逻辑 + store 契约。
// 关键约束：缩放只作用于排版 token（--text-*），不碰间距与图标；
// 因此在 documentElement 上发布档位名，由 tokens.css 把档位换算成乘数。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FONT_SCALE,
  FONT_SCALES,
  FONT_SCALE_ATTRIBUTE,
  FONT_SCALE_STORAGE_KEY,
  applyFontScale,
  isFontScale,
  useFontScaleStore,
} from "./font-scale";
import { FONT_SCALE_RESTORE_SCRIPT } from "./font-scale-script";

function fakeRoot() {
  return { setAttribute: vi.fn() };
}

describe("font scale preference", () => {
  beforeEach(() => {
    useFontScaleStore.setState({ scale: DEFAULT_FONT_SCALE });
  });

  it("defaults to a real tier", () => {
    expect(isFontScale(DEFAULT_FONT_SCALE)).toBe(true);
  });

  it("rejects unknown values coming from stale storage", () => {
    expect(isFontScale("lg")).toBe(true);
    expect(isFontScale("huge")).toBe(false);
    expect(isFontScale(null)).toBe(false);
    expect(isFontScale(1.5)).toBe(false);
  });

  it("publishes the tier on the root element", () => {
    const root = fakeRoot();
    applyFontScale("lg", root);

    expect(root.setAttribute).toHaveBeenCalledWith(FONT_SCALE_ATTRIBUTE, "lg");
  });

  it("no-ops when there is no document (SSR / node)", () => {
    expect(() => applyFontScale("xl", null)).not.toThrow();
  });

  it("keeps the store in sync and persists under a stable key", () => {
    useFontScaleStore.getState().setScale("xl");

    expect(useFontScaleStore.getState().scale).toBe("xl");
    expect(FONT_SCALE_STORAGE_KEY).toBe("multica_font_scale");
  });

  it("ignores a setScale call with an unknown tier", () => {
    useFontScaleStore.getState().setScale("huge" as never);

    expect(useFontScaleStore.getState().scale).toBe(DEFAULT_FONT_SCALE);
  });

  // 档位列表同时存在于本模块与 tokens.css；漂移会让某个档位静默退回 1x。
  it("has a multiplier rule in tokens.css for every accepted tier", () => {
    const tokensCss = readFileSync(
      fileURLToPath(new URL("../../ui/styles/tokens.css", import.meta.url)),
      "utf8",
    );

    for (const scale of FONT_SCALES) {
      expect(tokensCss).toContain(`html[data-font-scale="${scale}"]`);
    }
  });
});

describe("font scale restore script (web pre-hydration)", () => {
  // 真跑脚本，而不是只断言字符串包含什么：zustand persist 的落盘结构
  // （{state:{scale}}）很容易写错，而错了只会在浏览器里静默失效。
  function runScript(stored: string | null) {
    const attributes: Record<string, string> = {};
    vm.runInNewContext(FONT_SCALE_RESTORE_SCRIPT, {
      localStorage: {
        getItem: (key: string) =>
          key === FONT_SCALE_STORAGE_KEY ? stored : null,
      },
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => {
            attributes[name] = value;
          },
        },
      },
    });
    return attributes;
  }

  it("replays a persisted tier onto the root element", () => {
    const attributes = runScript(
      JSON.stringify({ state: { scale: "xl" }, version: 0 }),
    );

    expect(attributes[FONT_SCALE_ATTRIBUTE]).toBe("xl");
  });

  it("stays put for missing, stale, or corrupt storage", () => {
    expect(runScript(null)[FONT_SCALE_ATTRIBUTE]).toBeUndefined();
    expect(
      runScript(JSON.stringify({ state: { scale: "huge" } }))[
        FONT_SCALE_ATTRIBUTE
      ],
    ).toBeUndefined();
    expect(runScript("not json")[FONT_SCALE_ATTRIBUTE]).toBeUndefined();
  });
});
