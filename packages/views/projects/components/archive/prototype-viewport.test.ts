import { describe, expect, it } from "vitest";
import {
  clampPan,
  clampZoom,
  fitZoomFor,
  readFrameContentHeight,
  wheelZoomFactor,
  zoomAt,
  FIT_PADDING,
  MAX_ZOOM,
  MIN_ZOOM,
} from "./prototype-viewport";

describe("prototype viewport fit", () => {
  it("shrinks a tall phone prototype to the viewport height with padding", () => {
    const zoom = fitZoomFor(812, 600);
    expect(zoom).toBeCloseTo((600 - FIT_PADDING * 2) / 812, 5);
    // 缩放后内容连同留白正好装进视口。
    expect(812 * zoom).toBeLessThanOrEqual(600);
  });

  it("never upscales content that already fits", () => {
    expect(fitZoomFor(400, 600)).toBe(1);
    expect(fitZoomFor(600, 600)).toBe(1);
  });

  it("falls back to 100% for unmeasured sizes and clamps degenerate ones", () => {
    expect(fitZoomFor(0, 600)).toBe(1);
    expect(fitZoomFor(812, 0)).toBe(1);
    expect(fitZoomFor(100000, 600)).toBe(MIN_ZOOM);
  });
});

describe("prototype viewport zoom", () => {
  it("clamps zoom inside the usable range", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("keeps the anchored point under the cursor while zooming", () => {
    const pan = { x: -40, y: -120 };
    const anchor = { x: 200, y: 300 };
    const zoom = 0.75;
    const next = zoomAt(pan, zoom, 1.25, anchor);

    const worldBefore = {
      x: (anchor.x - pan.x) / zoom,
      y: (anchor.y - pan.y) / zoom,
    };
    expect((anchor.x - next.x) / 1.25).toBeCloseTo(worldBefore.x, 5);
    expect((anchor.y - next.y) / 1.25).toBeCloseTo(worldBefore.y, 5);
  });

  it("maps wheel direction to zoom in / out", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });
});

describe("prototype viewport pan bounds", () => {
  const view = { w: 1000, h: 600 };

  it("centers content that is smaller than the viewport", () => {
    const pan = clampPan({ x: -500, y: -500 }, { w: 400, h: 300 }, 1, view);
    expect(pan).toEqual({ x: 300, y: 150 });
  });

  it("keeps tall content inside the viewport while dragging", () => {
    const content = { w: 1000, h: 1600 };
    const zoom = 0.75; // 缩放后 1200，比视口高 600
    const top = clampPan({ x: 0, y: 200 }, content, zoom, view);
    const bottom = clampPan({ x: 0, y: -5000 }, content, zoom, view);
    expect(top.y).toBe(0);
    expect(bottom.y).toBe(600 - 1200);
  });

  it("locks vertical pan when the scaled content fits", () => {
    const pan = clampPan({ x: 0, y: -80 }, { w: 1000, h: 500 }, 1, view);
    expect(pan.y).toBe(50);
  });
});

describe("prototype frame height", () => {
  it("reads the height reported by the fit shim", () => {
    expect(readFrameContentHeight("812px", 600)).toBe(812);
    expect(readFrameContentHeight("407.6px", 600)).toBe(408);
  });

  it("falls back to the viewport for responsive prototypes", () => {
    expect(readFrameContentHeight("", 600)).toBe(600);
    expect(readFrameContentHeight(undefined, 600)).toBe(600);
    expect(readFrameContentHeight("0px", 600)).toBe(600);
  });
});
