"use client";

import { useRef, useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import {
  collectMarqueeIds,
  normalizeMarqueeBox,
  shouldStartMarquee,
  type MarqueeBox,
} from "./archive-marquee";

const MIN_SIZE = 4;

export function ArchiveMarqueeSurface({
  children,
  className,
  onPickIds,
}: {
  children: React.ReactNode;
  className?: string;
  onPickIds: (ids: string[], additive: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number; additive: boolean } | null>(null);
  const [box, setBox] = useState<MarqueeBox | null>(null);

  return (
    <div
      ref={rootRef}
      className={cn("relative", className)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (!shouldStartMarquee(event.target)) return;
        startRef.current = {
          x: event.clientX,
          y: event.clientY,
          additive: event.shiftKey || event.metaKey || event.ctrlKey,
        };
        setBox(normalizeMarqueeBox(event.clientX, event.clientY, event.clientX, event.clientY));
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = startRef.current;
        if (!start) return;
        setBox(normalizeMarqueeBox(start.x, start.y, event.clientX, event.clientY));
      }}
      onPointerUp={() => {
        const start = startRef.current;
        const current = box;
        startRef.current = null;
        setBox(null);
        if (!start || !current || !rootRef.current) return;
        if (current.width < MIN_SIZE && current.height < MIN_SIZE) return;
        const ids = collectMarqueeIds(rootRef.current, current, (node) =>
          node.getBoundingClientRect(),
        );
        if (ids.length > 0) onPickIds(ids, start.additive);
      }}
      onPointerCancel={() => {
        startRef.current = null;
        setBox(null);
      }}
    >
      {children}
      {box && (box.width >= MIN_SIZE || box.height >= MIN_SIZE) ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-20 border border-amber-500/70 bg-amber-400/15"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          }}
        />
      ) : null}
    </div>
  );
}
