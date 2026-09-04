// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  viewStoreSlice,
  viewStorePersistOptions,
  type IssueViewState,
} from "./view-store";

/**
 * Requirement calendar: the issues surface gains a `calendar` view mode with
 * its own zoom preference (week | month), persisted alongside ganttZoom.
 * Calendar renders requirement time windows; the minute component is floored
 * to days for cells (see date.test.ts) and shown verbatim in tooltips.
 */
describe("calendar view state", () => {
  let store: StoreApi<IssueViewState>;
  beforeEach(() => {
    store = createStore<IssueViewState>()((set) => viewStoreSlice(set));
  });

  it("supports the calendar view mode", () => {
    store.getState().setViewMode("calendar");

    expect(store.getState().viewMode).toBe("calendar");
    // Switching away and back must not disturb the zoom preference.
    store.getState().setViewMode("board");
    store.getState().setViewMode("calendar");
    expect(store.getState().viewMode).toBe("calendar");
  });

  it("defaults the calendar zoom to month", () => {
    expect(store.getState().calendarZoom).toBe("month");
  });

  it("switches calendar zoom between week and month", () => {
    store.getState().setCalendarZoom("week");
    expect(store.getState().calendarZoom).toBe("week");

    store.getState().setCalendarZoom("month");
    expect(store.getState().calendarZoom).toBe("month");
  });

  it("keeps calendar zoom independent from the gantt zoom", () => {
    store.getState().setCalendarZoom("week");
    store.getState().setGanttZoom("day");

    expect(store.getState().calendarZoom).toBe("week");
    expect(store.getState().ganttZoom).toBe("day");
  });

  it("persists the calendar zoom preference", () => {
    const { partialize } = viewStorePersistOptions("test-calendar-view");
    store.getState().setCalendarZoom("week");

    const persisted = partialize(store.getState()) as Record<string, unknown>;
    expect(persisted.calendarZoom).toBe("week");
  });
});
