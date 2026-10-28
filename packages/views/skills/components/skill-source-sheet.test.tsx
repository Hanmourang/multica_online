// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BuiltinSkill } from "@multica/core/types";
import { ApiError } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";

// Platform skills carry no route and no edit affordance, so this sheet is the
// only way to read what a skill tells an agent. The assertions below pin the
// two halves of that promise: the detail header (metadata) and the source pane
// (file rail + line-numbered body).

const state = vi.hoisted(() => ({
  current: null as BuiltinSkill | null,
  error: null as Error | null,
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/workspace/queries", () => ({
  builtinSkillDetailOptions: (wsId: string, skillId: string) => ({
    queryKey: ["builtin-skill", wsId, skillId],
    queryFn: () =>
      state.error ? Promise.reject(state.error) : Promise.resolve(state.current),
  }),
}));
vi.mock("../../rich-content", () => ({
  RichContent: ({ content }: { content: string }) => (
    <div data-testid="preview">{content}</div>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { SkillSourceSheet } from "./skill-source-sheet";
import {
  SKILL_SHEET_WIDTH_DEFAULT,
  SKILL_SHEET_WIDTH_KEY,
  SKILL_SHEET_WIDTH_MIN,
} from "./use-skill-sheet-width";

const SKILL: BuiltinSkill = {
  id: "builtin:multica-autopilots",
  name: "multica-autopilots",
  description:
    "Use when creating, updating, inspecting, triggering, or debugging a Multica autopilot.",
  content:
    "---\nname: multica-autopilots\ndescription: autopilots\n---\n\n# Autopilots\n\nBody line\n",
  files: [
    {
      path: "references/autopilots-source-map.md",
      content: "# Source map\n\nreference body\n",
    },
  ],
};

function renderSheet(onClose = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <SkillSourceSheet skillId="builtin:multica-autopilots" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, unmount: result.unmount };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.current = SKILL;
  state.error = null;
  window.localStorage.clear();
  // jsdom defaults to 1024px, which would clamp every width assertion below.
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1512,
  });
});

describe("SkillSourceSheet", () => {
  it("shows the skill's detail and its file list", async () => {
    renderSheet();

    // The loading state already shows the name, so wait on something only the
    // loaded body renders.
    await waitFor(() =>
      expect(screen.getByText(SKILL.description)).toBeDefined(),
    );
    expect(screen.getByText("multica-autopilots")).toBeDefined();
    expect(screen.getByText("Platform skill")).toBeDefined();
    expect(screen.getByText("2 files")).toBeDefined();
    // Rail: the primary file plus the shipped reference.
    expect(
      screen.getByRole("tab", { name: "SKILL.md" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "autopilots-source-map.md" }),
    ).toBeInTheDocument();
  });

  it("previews the body without the frontmatter, and switches files", async () => {
    const user = userEvent.setup();
    renderSheet();

    await waitFor(() =>
      expect(screen.getByTestId("preview").textContent).toContain("# Autopilots"),
    );
    expect(screen.getByTestId("preview").textContent).not.toContain("name:");

    await user.click(
      screen.getByRole("tab", { name: "autopilots-source-map.md" }),
    );
    expect(screen.getByTestId("preview").textContent).toContain("# Source map");
  });

  it("shows numbered source lines on demand", async () => {
    const user = userEvent.setup();
    renderSheet();

    await waitFor(() => expect(screen.getByTestId("preview")).toBeDefined());
    await user.click(screen.getByRole("button", { name: "Source" }));

    const code = screen.getByRole("region", { name: "Source" });
    expect(code.textContent).toContain("Body line");
    // Gutter numbers, so a reader can refer to a line in chat.
    expect(code.textContent).toContain("1");
  });

  it("copies the file that is open", async () => {
    const user = userEvent.setup();
    // userEvent installs its own clipboard stub, so the spy has to come after
    // setup — it is the object the component will actually call.
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderSheet();

    await waitFor(() => expect(screen.getByTestId("preview")).toBeDefined());
    await user.click(screen.getByRole("button", { name: "Copy source" }));

    expect(writeText).toHaveBeenCalledWith(SKILL.content);
    expect(toast.success).toHaveBeenCalled();
  });

  it("reports a failed load instead of an empty pane", async () => {
    state.current = null;
    state.error = new Error("boom");
    renderSheet();

    await waitFor(() =>
      expect(screen.getByText("Couldn't load this skill")).toBeDefined(),
    );
    // The name is the only clue to *which* skill failed when there is no body.
    expect(screen.getByText("multica-autopilots")).toBeDefined();
    expect(screen.getByText("Check your connection and try again.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  // A stale binary serves a list whose ref ids the detail endpoint no longer
  // knows. Echoing the API's `skill not found` reads like a broken product, so
  // the sheet names the skill and says what to do — retrying alone cannot help.
  it("explains a skill the server no longer ships", async () => {
    state.current = null;
    state.error = new ApiError("skill not found", 404, "Not Found");
    renderSheet();

    await waitFor(() =>
      expect(screen.getByText("This skill is no longer available")).toBeDefined(),
    );
    expect(screen.getByText("multica-autopilots")).toBeDefined();
    expect(
      screen.getByText(/restart the server if you just upgraded Multica/),
    ).toBeDefined();
    // The raw API message stays, demoted to a diagnostic line.
    expect(screen.getByText("skill not found")).toBeDefined();
   expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });
});

// The pane renders a document next to a file rail, so its width is a reading
// decision the user owns: it opens wide and can be dragged from the left edge.
const RESIZE_LABEL = "Drag to resize, double-click to reset";

function sheetElement(): HTMLElement {
  const sheet = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  );
  if (!sheet) throw new Error("sheet content was not rendered");
  return sheet;
}

function gripElement(): HTMLElement {
  return screen.getByRole("separator", { name: RESIZE_LABEL });
}

describe("SkillSourceSheet width", () => {
  it("opens wide enough for a readable document column", async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId("preview")).toBeDefined());

    const sheet = sheetElement();
    // Not the sheet primitive's `sm:max-w-sm` (384px), which is what squeezed
    // the preview into a column of single words.
    expect(sheet.style.width).toBe(`${SKILL_SHEET_WIDTH_DEFAULT}px`);
    expect(sheet.style.maxWidth).toContain("100vw");
  });

  it("widens on a leftward drag and remembers the width", async () => {
    const first = renderSheet();
    await waitFor(() => expect(screen.getByTestId("preview")).toBeDefined());

    const grip = gripElement();
    fireEvent.pointerDown(grip, { clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 780 });
    fireEvent.pointerUp(window);

    expect(sheetElement().style.width).toBe(
      `${SKILL_SHEET_WIDTH_DEFAULT + 120}px`,
    );
    expect(window.localStorage.getItem(SKILL_SHEET_WIDTH_KEY)).toBe(
      String(SKILL_SHEET_WIDTH_DEFAULT + 120),
    );

    // Reopening the sheet picks the stored width back up.
    first.unmount();
    renderSheet();
    await waitFor(() =>
      expect(sheetElement().style.width).toBe(
        `${SKILL_SHEET_WIDTH_DEFAULT + 120}px`,
      ),
    );
  });

  it("stops at the minimum width instead of collapsing", async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId("preview")).toBeDefined());

    const grip = gripElement();
    fireEvent.pointerDown(grip, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 2000 });
    fireEvent.pointerUp(window);

    expect(sheetElement().style.width).toBe(`${SKILL_SHEET_WIDTH_MIN}px`);
  });

  it("restores the default width on double-click", async () => {
    window.localStorage.setItem(SKILL_SHEET_WIDTH_KEY, "1300");
    renderSheet();
    await waitFor(() => expect(sheetElement().style.width).toBe("1300px"));

    fireEvent.doubleClick(gripElement());

    expect(sheetElement().style.width).toBe(`${SKILL_SHEET_WIDTH_DEFAULT}px`);
    expect(window.localStorage.getItem(SKILL_SHEET_WIDTH_KEY)).toBe(
      String(SKILL_SHEET_WIDTH_DEFAULT),
    );
  });
});
