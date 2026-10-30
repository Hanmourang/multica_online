import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_FILL_PAGE_SIZE,
  MIN_FILL_PAGE_SIZE,
  estimateFillPageSize,
  useFillPageSize,
} from "./use-fill-page-size";

// jsdom has no layout, so the box height and the real header/row heights are
// stubbed per case. The hook reads `clientHeight` and two rects, nothing else.
function stubLayout(boxHeight: number, rowHeight = 48, headerHeight = 36) {
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(boxHeight);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const height =
      this.tagName === "THEAD" ? headerHeight : this.tagName === "TR" ? rowHeight : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: height,
      width: 0,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function Harness({
  apply,
  rows,
  total = rows,
  enabled = true,
}: {
  apply: (pageSize: number) => void;
  rows: number;
  total?: number;
  enabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFillPageSize(ref, apply, { enabled, rowCount: rows, totalCount: total });
  return (
    <div ref={ref}>
      <table>
        <thead>
          <tr>
            <th>header</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, index) => (
            <tr key={index}>
              <td>row</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

describe("estimateFillPageSize", () => {
  // Fallback only: the box could not be measured (hidden container, slow data).
  // It has to land close to the measured value so the first request never drags
  // a full screen of overflow in with it.
  it("estimates the same size the measurement would find", () => {
    // (900 - 336) / 48 = 11.75 -> 11, matching a 601px box: (601 - 36) / 48.
    expect(estimateFillPageSize(900)).toBe(11);
    // (1200 - 336) / 48 = 18 exactly.
    expect(estimateFillPageSize(1200)).toBe(18);
    // (300 - 336) is negative: clamped to the floor instead of returning 0.
    expect(estimateFillPageSize(300)).toBe(MIN_FILL_PAGE_SIZE);
    expect(estimateFillPageSize(100000)).toBe(MAX_FILL_PAGE_SIZE);
  });
});

describe("useFillPageSize", () => {
  // The measurement is scheduled on the next frame; run it inline so a render
  // is enough to observe the write.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports how many rows fit under the header", () => {
    stubLayout(516); // (516 - 36) / 48 = 10
    const apply = vi.fn();
    render(<Harness apply={apply} rows={6} total={120} />);
    expect(apply).toHaveBeenCalledWith(10);
  });

  it("uses the tallest rendered row so wrapped rows can never be clipped", () => {
    stubLayout(516);
    vi.restoreAllMocks();
    stubLayout(516, 60); // (516 - 36) / 60 = 8
    const apply = vi.fn();
    render(<Harness apply={apply} rows={3} total={120} />);
    expect(apply).toHaveBeenCalledWith(8);
  });

  it("clamps a tiny box to the floor and a huge one to the server cap", () => {
    stubLayout(80); // fits 0
    const small = vi.fn();
    render(<Harness apply={small} rows={6} total={120} />);
    expect(small).toHaveBeenLastCalledWith(MIN_FILL_PAGE_SIZE);

    vi.restoreAllMocks();
    stubLayout(20000);
    const huge = vi.fn();
    render(<Harness apply={huge} rows={6} total={120} />);
    expect(huge).toHaveBeenLastCalledWith(MAX_FILL_PAGE_SIZE);
  });

  it("stays quiet when the whole filtered set already fits", () => {
    stubLayout(516);
    const apply = vi.fn();
    render(<Harness apply={apply} rows={4} total={4} />);
    expect(apply).not.toHaveBeenCalled();
  });

  it("measures a backgrounded tab through the timer fallback", () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    // rAF is paused in a hidden document; drop the inline stub so only the
    // timer can produce the measurement.
    vi.stubGlobal("requestAnimationFrame", () => 1);
    stubLayout(516); // 10 rows
    const apply = vi.fn();
    render(<Harness apply={apply} rows={6} total={120} />);

    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(apply).toHaveBeenCalledWith(10);

    visibility.mockRestore();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.useRealTimers();
  });

  it("sizes the very first paint from the fallback row height", () => {
    // No rows yet (the skeleton is showing) and no response yet, but the box
    // already has its height: the page size must be written right away, or the
    // first request goes out at the default 20 and the table jumps a second
    // later.
    stubLayout(516); // (516 - 36) / 48 = 10
    const apply = vi.fn();
    render(<Harness apply={apply} rows={0} total={0} />);
    expect(apply).toHaveBeenCalledWith(10);
  });

  it("retries while the box has no height yet", () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    vi.stubGlobal("requestAnimationFrame", () => 1);
    stubLayout(0); // parent layout not done
    const apply = vi.fn();
    render(<Harness apply={apply} rows={6} total={120} />);

    vi.advanceTimersByTime(120); // still no height, arms the retry
    expect(apply).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    stubLayout(516);
    vi.advanceTimersByTime(120);
    expect(apply).toHaveBeenCalledWith(10);

    visibility.mockRestore();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.useRealTimers();
  });

  it("does not measure while another view owns the box", () => {
    stubLayout(516);
    const apply = vi.fn();
    render(<Harness apply={apply} rows={6} total={120} enabled={false} />);
    expect(apply).not.toHaveBeenCalled();
  });
});
