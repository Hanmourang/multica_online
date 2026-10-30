"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Fit-to-viewport paging: how many rows actually fill the table's box, instead
 * of a fixed page size.
 *
 * A fixed size leaves a hole under the last row on tall windows and spends a
 * whole extra page on rows that would have fit there. Here the page size is the
 * measurement itself — `floor((boxHeight - headerHeight) / rowHeight)` — so the
 * last page break always lands exactly where the box runs out.
 *
 * Numbers come from the rendered table, not from a table of constants: row
 * height is the tallest rendered `<tr>` (a row whose chips wrap is taller than
 * its neighbours) and the header is the real `<thead>`. Both are re-measured
 * when the box resizes (window, sidebar, selection toolbar) and when the body's
 * rows are swapped, so a page-size change can never leave rows clipped.
 *
 * Deliberately silent when the box has no layout yet — `clientHeight === 0`
 * in jsdom and on the first paint — so the store keeps its default rather than
 * collapsing to the minimum.
 */

/** Floor/ceiling of the measured size. The ceiling mirrors the server's own cap in
 *  `parseAssetPaging`: anything above 200 is ignored and the response silently
 *  comes back at the default 20, so never ask for more than this. */
export const MIN_FILL_PAGE_SIZE = 5;
export const MAX_FILL_PAGE_SIZE = 200;

/** Only used before the first row has ever rendered (and as a sanity floor). */
const FALLBACK_ROW_HEIGHT = 48;
const FALLBACK_HEADER_HEIGHT = 36;

/** 应用外壳（顶栏 / TAB 条 / 统计条 / 分页条 / 内边距）加表头的总计高度，只用于
 *  容器不可测时的兜底估算。表头也算在内，因为估算直接以 viewport 高为基准。 */
const VIEWPORT_CHROME_HEIGHT = 336;

/** 容器量不到高时的兜底页尺寸：按视口高度估一个保守值，而不是倒回默认的 20
 *  把一屏撑出滚动。测量一旦成功会用实测值覆盖。 */
export function estimateFillPageSize(viewportHeight: number): number {
  const fits = Math.floor((viewportHeight - VIEWPORT_CHROME_HEIGHT) / FALLBACK_ROW_HEIGHT);
  return Math.min(MAX_FILL_PAGE_SIZE, Math.max(MIN_FILL_PAGE_SIZE, fits));
}

export interface FillPageSizeOptions {
  /** Stop measuring (and stop writing) while another view owns the box. */
  enabled?: boolean;
  /** Rows currently rendered, and how many the current filter matches. */
  rowCount?: number;
  totalCount?: number;
  min?: number;
  max?: number;
}

export function useFillPageSize(
  containerRef: RefObject<HTMLElement | null>,
  apply: (pageSize: number) => void,
  {
    enabled = true,
    rowCount = 0,
    totalCount = 0,
    min = MIN_FILL_PAGE_SIZE,
    max = MAX_FILL_PAGE_SIZE,
  }: FillPageSizeOptions = {},
): void {
  // `apply` closes over the store key, which is stable per project but not
  // referentially stable across renders; a ref keeps the observers subscribed.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const boundsRef = useRef({ min, max });
  boundsRef.current = { min, max };
  const countRef = useRef({ rowCount, totalCount });
  countRef.current = { rowCount, totalCount };

  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    // `measure` is a hoisted declaration (the retry closes over it), so keep the
    // non-null element in its own binding for the narrowing to survive.
    const box = el;

    // A measurement can land before the table exists (loading skeleton) or
    // before the box has a height. Neither resolves on its own when the box
    // size never changes, so retry a bounded number of times instead of
    // waiting for the next resize.
    const MAX_RETRIES = 8;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retryLater = () => {
      if (retries >= MAX_RETRIES) return;
      retries += 1;
      clearTimeout(timer);
      timer = setTimeout(measure, 120);
    };

    function measure() {
      const available = box.clientHeight;
      if (available <= 0) {
        retryLater();
        return;
      }

      const header = box.querySelector("thead");
      const rows = box.querySelectorAll("tbody tr");

      // Rows are not awaited: the row height is a CSS constant here (48px), so the
      // first paint can already size the page and ask for the right count in one
      // request. Once rows exist the tallest one overrides the constant, which
      // covers a row whose chips wrap onto a second line.
      let rowHeight = FALLBACK_ROW_HEIGHT;
      let tallest = 0;
      rows.forEach((row) => {
        tallest = Math.max(tallest, row.getBoundingClientRect().height);
      });
      if (tallest > 0) rowHeight = tallest;

      const headerHeight = header
        ? header.getBoundingClientRect().height
        : FALLBACK_HEADER_HEIGHT;
      const fits = Math.floor((available - headerHeight) / rowHeight);
      const { min: floor, max: ceiling } = boundsRef.current;
      const next = Math.min(ceiling, Math.max(floor, fits));
      if (!Number.isFinite(next) || next <= 0) return;

      // Nothing left below: the whole filtered set already fits the page, so a
      // larger size would only buy a redundant fetch with the same rows. Needs a
      // known total — before the first response arrives `total` is 0 and the page
      // size still has to be written.
      const { rowCount: rendered, totalCount: total } = countRef.current;
      if (total > 0 && total <= rendered && next >= rendered) return;

      retries = 0;
      applyRef.current(next);
    }

    let frame = 0;
    const schedule = () => {
      if (typeof requestAnimationFrame !== "function") {
        measure();
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
      // A hidden document pauses the frame loop, so rAF would never fire and the
      // box would keep the default size until the user comes back. A timer still
      // runs there; the measurement is idempotent (the store ignores a repeated
      // size), so the extra call costs nothing.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        clearTimeout(timer);
        timer = setTimeout(measure, 120);
      }
    };
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    // Row swaps (a new page, a loading state) are what changes the measured
    // row height; a box resize alone would keep reading the old rows. Observe
    // the box itself, not `<tbody>`: on the first paint the body may not exist
    // yet, and there would be nothing left to notify us when it arrives.
    const mutation = new MutationObserver(schedule);
    mutation.observe(el, { childList: true, subtree: true });
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      observer.disconnect();
      mutation.disconnect();
    };
  }, [containerRef, enabled]);
}
