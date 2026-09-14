import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __PROTOTYPE_INTERACT_SHIM__,
  PROTOTYPE_FP_MESSAGE,
  postPrototypeHighlight,
  readPrototypeFpId,
  withPrototypeInteractShim,
} from "./prototype-interact";

function loadShimIntoDocument() {
  const inner = __PROTOTYPE_INTERACT_SHIM__
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  new Function(inner)();
}

describe("prototype interact protocol", () => {
  it("appends the interact shim", () => {
    expect(withPrototypeInteractShim("<p>x</p>")).toContain(PROTOTYPE_FP_MESSAGE);
    expect(withPrototypeInteractShim("<p>x</p>")).toContain("[data-fp]");
  });

  it("reads only typed feature-point messages", () => {
    expect(readPrototypeFpId({ type: PROTOTYPE_FP_MESSAGE, id: "fp.retry" })).toBe("fp.retry");
    expect(readPrototypeFpId({ type: "other", id: "fp.retry" })).toBeNull();
    expect(readPrototypeFpId({ type: PROTOTYPE_FP_MESSAGE, id: "  " })).toBeNull();
    expect(readPrototypeFpId(null)).toBeNull();
  });

  it("posts a highlight payload to the iframe window", () => {
    const postMessage = vi.fn();
    postPrototypeHighlight({ postMessage } as unknown as Window, "fp.retry");
    expect(postMessage).toHaveBeenCalledWith(
      { type: PROTOTYPE_FP_MESSAGE, id: "fp.retry" },
      "*",
    );
  });
});

describe("prototype interact shim runtime", () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    scrollSpy = vi.fn();
    Object.defineProperty(window.Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });
    loadShimIntoDocument();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("highlights the clicked data-fp hotspot and posts to parent", () => {
    const postMessage = vi.spyOn(window.parent, "postMessage");
    const hotspot = document.createElement("div");
    hotspot.setAttribute("data-fp", "fp.refund.retry");
    hotspot.textContent = "retry";
    document.body.appendChild(hotspot);

    hotspot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(hotspot.getAttribute("data-multica-sel")).toBe("1");
    expect(scrollSpy).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      { type: PROTOTYPE_FP_MESSAGE, id: "fp.refund.retry" },
      "*",
    );
  });

  it("selects a hotspot when the parent posts a highlight", () => {
    const hotspot = document.createElement("div");
    hotspot.setAttribute("data-fp", "fp.refund.status");
    document.body.appendChild(hotspot);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: PROTOTYPE_FP_MESSAGE, id: "fp.refund.status" },
      }),
    );

    expect(hotspot.getAttribute("data-multica-sel")).toBe("1");
  });
});
