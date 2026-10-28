"use client";

import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Default pane width: enough for the file rail plus a readable document column. */
export const SKILL_SHEET_WIDTH_DEFAULT = 1040;
/** Below this the file rail + preview stop being usable side by side. */
export const SKILL_SHEET_WIDTH_MIN = 560;
/** Anything wider than this on an ultrawide display is hard to scan. */
export const SKILL_SHEET_WIDTH_CEILING = 1600;
/** Air kept between the panel edge and the window edge. */
const VIEWPORT_GUTTER = 32;
/** One arrow-key press. */
export const SKILL_SHEET_KEYBOARD_STEP = 32;

export const SKILL_SHEET_WIDTH_KEY = "multica.skill-source-sheet.width";

function viewportWidth(): number {
  if (typeof window === "undefined") return 0;
  return window.innerWidth;
}

/**
 * Clamps to the window as well as to the fixed bounds: a width stored on a
 * laptop must not turn into a panel wider than a tablet's screen after the user
 * moves the window.
 */
export function clampSkillSheetWidth(width: number): number {
  const max = viewportWidth();
  const bounded = Math.min(
    SKILL_SHEET_WIDTH_CEILING,
    max > 0 ? max - VIEWPORT_GUTTER : SKILL_SHEET_WIDTH_CEILING,
  );
  const upper = Math.max(SKILL_SHEET_WIDTH_MIN, bounded);
  if (!Number.isFinite(width)) return Math.min(SKILL_SHEET_WIDTH_DEFAULT, upper);
  return Math.min(upper, Math.max(SKILL_SHEET_WIDTH_MIN, Math.round(width)));
}

export function readStoredSkillSheetWidth(): number {
  if (typeof localStorage === "undefined") return clampSkillSheetWidth(SKILL_SHEET_WIDTH_DEFAULT);
  try {
    const stored = localStorage.getItem(SKILL_SHEET_WIDTH_KEY);
    if (stored === null || stored.trim() === "") return clampSkillSheetWidth(SKILL_SHEET_WIDTH_DEFAULT);
    return clampSkillSheetWidth(Number(stored));
  } catch {
    // private mode / blocked storage
    return clampSkillSheetWidth(SKILL_SHEET_WIDTH_DEFAULT);
  }
}

/**
 * Width of the platform-skill sheet, dragged from its left edge and remembered
 * across opens. The default is deliberately wide: the pane shows a rendered
 * markdown document next to a file rail, and the old 3xl cap squeezed prose
 * into a column of single words.
 */
export function useSkillSheetWidth() {
  const [width, setWidth] = useState(SKILL_SHEET_WIDTH_DEFAULT);
  const [resizing, setResizing] = useState(false);

  // Mount-only: the server has no window, so the stored width (and the clamp
  // that depends on it) can only be applied on the client.
  useEffect(() => {
    setWidth(readStoredSkillSheetWidth());
  }, []);

  // Keep a stored width valid when the window shrinks.
  useEffect(() => {
    const onResize = () => setWidth((current) => clampSkillSheetWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistWidth = useCallback((next: number) => {
    const clamped = clampSkillSheetWidth(next);
    setWidth(clamped);
    try {
      localStorage.setItem(SKILL_SHEET_WIDTH_KEY, String(clamped));
    } catch {
      // private mode / quota — resizing still works for this session
    }
  }, []);

  const resetWidth = useCallback(() => {
    persistWidth(SKILL_SHEET_WIDTH_DEFAULT);
  }, [persistWidth]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      setResizing(true);
      // Listening on the window instead of the grip keeps the drag alive when
      // the pointer outruns the narrow handle, and while the body is locked
      // below no text gets selected on the way.
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (move: PointerEvent) => {
        // The handle sits on the panel's left edge: dragging left widens it.
        persistWidth(startWidth + (startX - move.clientX));
      };
      const onUp = () => {
        setResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [persistWidth, width],
  );

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        persistWidth(width + SKILL_SHEET_KEYBOARD_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        persistWidth(width - SKILL_SHEET_KEYBOARD_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        persistWidth(SKILL_SHEET_WIDTH_MIN);
      } else if (event.key === "End") {
        event.preventDefault();
        // `ceiling` is clamped to the window, so End means "as wide as the
        // screen allows" rather than the nominal 1600px.
        persistWidth(SKILL_SHEET_WIDTH_CEILING);
      } else if (event.key === "Enter") {
        event.preventDefault();
        resetWidth();
      }
    },
    [persistWidth, resetWidth, width],
  );

  return { width, resizing, startResize, resetWidth, onResizeKeyDown };
}
