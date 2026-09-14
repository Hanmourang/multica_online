export type MarqueeBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function normalizeMarqueeBox(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): MarqueeBox {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  return {
    left,
    top,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function rectsIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: MarqueeBox,
): boolean {
  const right = b.left + b.width;
  const bottom = b.top + b.height;
  return a.left < right && a.right > b.left && a.top < bottom && a.bottom > b.top;
}

export function collectMarqueeIds(
  container: ParentNode,
  box: MarqueeBox,
  lookup: (node: Element) => DOMRect,
): string[] {
  const ids: string[] = [];
  container.querySelectorAll("[data-artifact-id]").forEach((node) => {
    const id = node.getAttribute("data-artifact-id");
    if (!id) return;
    if (rectsIntersect(lookup(node), box)) ids.push(id);
  });
  return ids;
}

export function shouldStartMarquee(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    "[data-artifact-id], input, textarea, button, [role='checkbox'], a",
  );
}
