import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROTOTYPE_FIT_HEIGHT,
  PROTOTYPE_FIT_MESSAGE,
  __PROTOTYPE_FIT_SHIM__,
  __PROTOTYPE_MEASURE_SHIM__,
  readPrototypeFitHeight,
  withPrototypeFitShim,
} from "./prototype-fit";

describe("prototype fit shim", () => {
  it("appends the shim after the document and only for fixed-size prototypes", () => {
    const html = '<html style="width: 1322px; height: 868px"><body>x</body></html>';
    const next = withPrototypeFitShim(html);
    expect(next.startsWith(html)).toBe(true);
    expect(next).toContain(PROTOTYPE_FIT_MESSAGE);
    // 只在 <html> 上带 px 尺寸时缩放；响应式原型（且未要求量高度）靠这一句早退。
    expect(__PROTOTYPE_FIT_SHIM__).toContain("parseFloat(root.style.width)");
    expect(__PROTOTYPE_FIT_SHIM__).toContain("if (!fixed && !MEASURE) return;");
  });

  it("reports scrollHeight for responsive prototypes when asked", () => {
    // 默认不量：响应式原型行为不变。
    expect(withPrototypeFitShim("<html></html>")).not.toContain("var MEASURE = true;");
    // 原型画布需要内容高度，才能把超出的下半截缩进来。
    expect(withPrototypeFitShim("<html></html>", { measureScroll: true })).toContain(
      "var MEASURE = true;",
    );
    expect(__PROTOTYPE_MEASURE_SHIM__).toContain("Math.max(root.scrollHeight");
  });

  it("reads the reported height and ignores anything else", () => {
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: 231 })).toBe(231);
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: "231.4" })).toBe(231);
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: 0 })).toBeNull();
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: Number.NaN })).toBeNull();
    expect(readPrototypeFitHeight({ type: "multica-prototype-fp", id: "fp.x" })).toBeNull();
    expect(readPrototypeFitHeight(null)).toBeNull();
    expect(readPrototypeFitHeight("231")).toBeNull();
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: 9e7 })).toBe(9e7);
  });
});

/**
 * 在 jsdom 里真跑一遍注入脚本。响应式原型的上报曾与宿主回写高度互相喂，
 * 高度无上限上涨（真机上 8 秒涨了 22 万 px，flex 居中的内容被推到视口外），
 * 所以这里必须验证「连续测量不再涨」，而不只是断言源码里出现了某个字符串。
 */
describe("prototype fit shim 防正反馈", () => {
  let resizeHandlers: EventListener[] = [];

  afterEach(() => {
    // shim 每次 eval 都会注册一个 resize 监听，不清掉的话上一个用例的
    // fit 会跟着下一个用例的 resize 一起跑，上报次数就变成 N 倍。
    for (const handler of resizeHandlers) window.removeEventListener("resize", handler);
    resizeHandlers = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.documentElement.innerHTML = "<head></head><body></body>";
  });

  type Frame = { viewport: number; content: number };

  function createFrame(postMessage = vi.fn()) {
    vi.useFakeTimers();
    vi.spyOn(window, "postMessage").mockImplementation(postMessage);
    const nativeAdd = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation(
      (
        type: string,
        handler: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        const listener = handler as EventListener;
        if (type === "resize") resizeHandlers.push(listener);
        nativeAdd(type as keyof WindowEventMap, listener, options);
      },
    );
    /** 视口高就是 iframe 高度；内容高是 scrollHeight，两者在撑满视口的布局里联动。 */
    const setFrame = (frame: Frame) => {
      Object.defineProperty(window, "innerHeight", {
        value: frame.viewport,
        configurable: true,
      });
      Object.defineProperty(document.documentElement, "scrollHeight", {
        value: frame.content,
        configurable: true,
      });
    };
    return { setFrame };
  }

  /** 跑一次 shim（首帧同步 fit），返回上报过的元素高度。 */
  function runShim(frames: Frame[]): number[] {
    const [first, ...rest] = frames;
    if (!first) return [];
    const reported: number[] = [];
    const postMessage = vi.fn((message: { height: number }) => {
      reported.push(message.height);
    });
    const { setFrame } = createFrame(postMessage);
    setFrame(first);

    const code = __PROTOTYPE_MEASURE_SHIM__.replace(/^<script>/, "").replace(/<\/script>$/, "");
    window.eval(code);

    for (const frame of rest) {
      // 模拟宿主把上报高度写回 iframe：视口随之变大，而撑满视口的布局让
      // scrollHeight 同步再高一截。
      setFrame(frame);
      window.dispatchEvent(new Event("resize"));
    }
    return reported;
  }

  it("撑满视口的布局只报一次，之后不再跟着视口一起涨", () => {
    // 每轮视口 +10、内容也 +10：这正是 100dvh + padding 的形态。
    const reported = runShim([
      { viewport: 800, content: 810 },
      { viewport: 810, content: 820 },
      { viewport: 820, content: 830 },
      { viewport: 830, content: 840 },
    ]);
    expect(reported).toEqual([810]);
  });

  it("恒定溢出的手机原型只报一次（视口 + 480 型结构性留白）", () => {
    // 实测样本：`2.3 人脉 - 搭子.html` 在窄断点下 documentElement.scrollHeight
    // 恒为视口 + 480，每回写一次高度就再涨 480，内容被推到视口外只剩空白。
    const reported = runShim([
      { viewport: 1068, content: 1548 },
      { viewport: 1548, content: 2028 },
      { viewport: 2028, content: 2508 },
      { viewport: 2508, content: 2988 },
    ]);
    expect(reported).toEqual([1548]);
  });

  it("真实长内容上报一次后就收敛", () => {
    const reported = runShim([
      { viewport: 800, content: 3000 },
      { viewport: 3000, content: 3000 },
      { viewport: 3000, content: 3000 },
    ]);
    expect(reported).toEqual([3000]);
  });

  it("视口没变时内容真的变长，仍然照常上报", () => {
    const reported = runShim([
      { viewport: 800, content: 3000 },
      { viewport: 3000, content: 3000 },
      // 内容真变长（懒加载更多列表），视口跟随回写到 5200 后就收敛。
      { viewport: 3000, content: 5200 },
      { viewport: 5200, content: 5200 },
    ]);
    expect(reported).toEqual([3000, 5200]);
  });

  it("离谱高度不再上报，宁可让内容滚动", () => {
    const reported = runShim([
      { viewport: 800, content: MAX_PROTOTYPE_FIT_HEIGHT + 1 },
      { viewport: 800, content: MAX_PROTOTYPE_FIT_HEIGHT + 1 },
    ]);
    expect(reported).toEqual([]);
  });
});
