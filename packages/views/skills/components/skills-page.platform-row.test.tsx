// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";

// Platform skills are not workspace rows, so there was no click target and no
// page behind them: the list was readable but not inspectable. The row is now
// the door to the source sheet, and it says so in words.

// Heavy leaves pulled in by the skills page module — this test renders only the
// platform section.
vi.mock("./create-skill-dialog", () => ({ CreateSkillDialog: () => null }));
vi.mock("./skill-list-toolbar", () => ({ SkillListToolbar: () => null }));
vi.mock("./skill-list-actions", () => ({
  SkillBatchToolbar: () => null,
  SkillRowActions: () => null,
}));

import { PlatformSkillsSection } from "./skills-page";

const SKILLS = [
  {
    id: "builtin:multica-autopilots",
    name: "multica-autopilots",
    description: "Use when creating or debugging an autopilot.",
  },
  {
    id: "builtin:multica-squads",
    name: "multica-squads",
    description: "Use when creating or debugging a squad.",
  },
];

describe("PlatformSkillsSection", () => {
  it("names the source action on every row", () => {
    renderWithI18n(<PlatformSkillsSection skills={SKILLS} onOpen={vi.fn()} />);

    expect(screen.getByText("Platform skills")).toBeInTheDocument();
    expect(screen.getAllByText("View source")).toHaveLength(SKILLS.length);
  });

  it("opens the source sheet with the clicked skill's id", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderWithI18n(<PlatformSkillsSection skills={SKILLS} onOpen={onOpen} />);

    await user.click(
      screen.getByRole("button", { name: /multica-squads/ }),
    );

    expect(onOpen).toHaveBeenCalledExactlyOnceWith("builtin:multica-squads");
  });
});
