import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { ActivityStreamFilters } from "./activity-stream-filters";

afterEach(() => cleanup());

describe("ActivityStreamFilters", () => {
  it("toggles a filter chip and switches the time window", () => {
    const onToggle = vi.fn();
    const onTimeWindow = vi.fn();
    renderWithI18n(
      <ActivityStreamFilters
        selected={new Set(["comment", "status", "artifact"])}
        onToggle={onToggle}
        timeWindow="all"
        onTimeWindow={onTimeWindow}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "System progress" }));
    expect(onToggle).toHaveBeenCalledWith("system");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onTimeWindow).toHaveBeenCalledWith("today");
    expect(screen.getByRole("button", { name: "Comments" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "System progress" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
