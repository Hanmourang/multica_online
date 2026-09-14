/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  collectMarqueeIds,
  normalizeMarqueeBox,
  rectsIntersect,
  shouldStartMarquee,
} from "./archive-marquee";

describe("marquee geometry", () => {
  it("normalizes a backwards drag", () => {
    expect(normalizeMarqueeBox(10, 20, 4, 8)).toEqual({
      left: 4,
      top: 8,
      width: 6,
      height: 12,
    });
  });

  it("hits overlapping chips and misses the rest", () => {
    expect(
      rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, {
        left: 8,
        top: 8,
        width: 10,
        height: 10,
      }),
    ).toBe(true);
    expect(
      rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, {
        left: 20,
        top: 20,
        width: 5,
        height: 5,
      }),
    ).toBe(false);
  });
});

describe("collectMarqueeIds", () => {
  it("returns intersecting data-artifact-id nodes", () => {
    const a = { id: "a", left: 0, top: 0, right: 10, bottom: 10 };
    const b = { id: "b", left: 40, top: 40, right: 50, bottom: 50 };
    const nodes = [a, b];
    const container = {
      querySelectorAll: () =>
        nodes.map((node) => ({
          getAttribute: (key: string) => (key === "data-artifact-id" ? node.id : null),
        })),
    } as unknown as ParentNode;
    const ids = collectMarqueeIds(
      container,
      { left: 5, top: 5, width: 10, height: 10 },
      (el) => {
        const id = (el as { getAttribute: (key: string) => string }).getAttribute(
          "data-artifact-id",
        );
        const hit = nodes.find((node) => node.id === id)!;
        return hit as unknown as DOMRect;
      },
    );
    expect(ids).toEqual(["a"]);
  });
});

describe("shouldStartMarquee", () => {
  it("ignores chips and form controls", () => {
    const chip = document.createElement("div");
    chip.setAttribute("data-artifact-id", "x");
    const blank = document.createElement("div");
    expect(shouldStartMarquee(chip)).toBe(false);
    expect(shouldStartMarquee(blank)).toBe(true);
  });
});
