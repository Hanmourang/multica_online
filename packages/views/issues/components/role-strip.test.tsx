/**
 * @vitest-environment jsdom
 *
 * Role strip: five role cards (pm / prototyper / developer / data / tester)
 * rendered horizontally. PM and developer are required — their toggles are
 * locked. Developer supports multiple assignees. Disabled cards render in a
 * dimmed dashed style.
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import type { RoleAssignment } from "@multica/core/types";
import { RoleStrip } from "./role-strip";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/workspace/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/workspace/hooks")>()),
  useActorName: () => ({
    getActorName: (_type: string, id: string) => {
      const names: Record<string, string> = {
        "agent-1": "Atlas",
        "agent-2": "Orion",
        "agent-3": "Nova",
        "agent-4": "Kai",
      };
      return names[id] ?? id;
    },
    getActorInitials: (_type: string, id: string) => id.slice(0, 1).toUpperCase(),
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@multica/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", slug: "acme" }),
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

function entry(
  role: RoleAssignment["role"],
  assigneeId: string,
  enabled: boolean,
): RoleAssignment {
  return {
    id: `${role}-${assigneeId}`,
    role,
    assignee_type: "agent",
    assignee_id: assigneeId,
    enabled,
    ordinal: 0,
  };
}

const DEFAULT_ENTRIES: RoleAssignment[] = [
  entry("pm", "agent-1", true),
  entry("prototyper", "agent-3", true),
  entry("developer", "agent-2", true),
  entry("data", "agent-4", false),
  entry("tester", "agent-3", true),
];

afterEach(cleanup);

describe("RoleStrip", () => {
  it("renders five role cards horizontally with disabled card dimmed", () => {
    renderWithI18n(
      <RoleStrip entries={DEFAULT_ENTRIES} onChange={() => {}} />,
    );

    // All five role labels visible.
    expect(screen.getByText("PM")).toBeTruthy();
    expect(screen.getByText("Prototyper")).toBeTruthy();
    expect(screen.getByText("Developer")).toBeTruthy();
    expect(screen.getByText("Data")).toBeTruthy();
    expect(screen.getByText("Tester")).toBeTruthy();

    // Disabled card (data) has the "off" styling marker.
    const dataCard = screen.getByTestId("role-card-data");
    expect(dataCard.className).toContain("off");

    // Enabled card does not.
    const pmCard = screen.getByTestId("role-card-pm");
    expect(pmCard.className).toContain("on");
    expect(pmCard.className).not.toContain("off");
  });

  it("pm and developer toggles are locked (cannot be clicked off)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(
      <RoleStrip entries={DEFAULT_ENTRIES} onChange={onChange} />,
    );

    // PM toggle should be disabled/locked (Base UI renders span, not button).
    const pmToggle = screen.getByTestId("role-toggle-pm");
    expect(pmToggle.getAttribute("data-disabled")).not.toBeNull();

    // Developer toggle should also be disabled/locked.
    const devToggle = screen.getByTestId("role-toggle-developer");
    expect(devToggle.getAttribute("data-disabled")).not.toBeNull();

    // Clicking them should not fire onChange.
    await user.click(pmToggle);
    await user.click(devToggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("developer card supports multiple assignees", () => {
    const entries: RoleAssignment[] = [
      entry("pm", "agent-1", true),
      entry("developer", "agent-2", true),
      entry("developer", "agent-4", true),
    ];
    renderWithI18n(
      <RoleStrip entries={entries} onChange={() => {}} />,
    );

    // Both developer tags visible inside the developer card.
    const devCard = screen.getByTestId("role-card-developer");
    expect(devCard.textContent).toContain("Orion");
    expect(devCard.textContent).toContain("Kai");
  });

  it("calls onChange with toggled entry when optional role toggle clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(
      <RoleStrip entries={DEFAULT_ENTRIES} onChange={onChange} />,
    );

    // Toggle off the tester role.
    const testerToggle = screen.getByTestId("role-toggle-tester");
    await user.click(testerToggle);
    expect(onChange).toHaveBeenCalledTimes(1);

    // The callback should produce entries with tester disabled.
    const newEntries: RoleAssignment[] = onChange.mock.calls[0]?.[0] ?? [];
    const testerEntries = newEntries.filter((e) => e.role === "tester");
    expect(testerEntries.every((e) => !e.enabled)).toBe(true);
  });
});
