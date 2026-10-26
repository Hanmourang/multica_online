/**
 * Member and agent mentions in rendered chat (and every other RichContent
 * surface) are real links to that actor's page.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NavigationProvider } from "../navigation/context";
import type { NavigationAdapter } from "../navigation/types";

vi.mock("../issues/hooks", () => ({
  useResolveIssueIdentifier: () => null,
}));

vi.mock("../i18n", async () => {
  const editor = (await import("../locales/en/editor.json")).default;
  return {
    useT: () => ({
      t: (select: (bundle: typeof editor) => string) => select(editor),
    }),
    useTimeAgo: () => "just now",
  };
});

vi.mock("@multica/core/api", () => ({
  api: { getAttachmentTextContent: vi.fn() },
  PreviewTooLargeError: class extends Error {},
  PreviewUnsupportedError: class extends Error {},
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
    projectDetail: (id: string) => `/acme/projects/${id}`,
    memberDetail: (id: string) => `/acme/members/${id}`,
    agentDetail: (id: string) => `/acme/agents/${id}`,
    squadDetail: (id: string) => `/acme/squads/${id}`,
  }),
  useWorkspaceSlug: () => "acme",
}));

vi.mock("../issues/components/issue-mention-card", () => ({
  IssueMentionCard: ({ issueId }: { issueId: string }) => <span>{issueId}</span>,
}));

vi.mock("../projects/components/project-chip", () => ({
  ProjectChip: () => null,
}));

vi.mock("../editor/link-hover-card", () => ({
  useLinkHover: () => ({}),
  LinkHoverCard: () => null,
}));

import { RichContent } from "./rich-content";

const MEMBER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AGENT_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function makeAdapter(overrides: Partial<NavigationAdapter> = {}): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (p) => p,
    ...overrides,
  };
}

function renderContent(content: string, adapter: NavigationAdapter = makeAdapter()) {
  return render(
    <NavigationProvider value={adapter}>
      <RichContent content={content} />
    </NavigationProvider>,
  );
}

describe("RichContent actor mentions", () => {
  it("renders an @member as a link to that member", () => {
    const push = vi.fn();
    renderContent(
      `hi [@Ada](mention://member/${MEMBER_ID})`,
      makeAdapter({ push }),
    );

    const link = screen.getByRole("link", { name: "@Ada" });
    expect(link).toHaveAttribute("href", `/acme/members/${MEMBER_ID}`);
    expect(link).toHaveClass("mention");

    expect(fireEvent.click(link)).toBe(false);
    expect(push).toHaveBeenCalledWith(`/acme/members/${MEMBER_ID}`);
  });

  it("renders an @agent as a link to that agent", () => {
    const push = vi.fn();
    renderContent(
      `hi [@OpenClaw](mention://agent/${AGENT_ID})`,
      makeAdapter({ push }),
    );

    const link = screen.getByRole("link", { name: "@OpenClaw" });
    expect(link).toHaveAttribute("href", `/acme/agents/${AGENT_ID}`);
    fireEvent.click(link);
    expect(push).toHaveBeenCalledWith(`/acme/agents/${AGENT_ID}`);
  });

  it("keeps @all as text", () => {
    renderContent(`hi [@all](mention://all/workspace)`);
    expect(screen.queryByRole("link", { name: "@all" })).toBeNull();
    expect(screen.getByText("@all")).toBeInTheDocument();
  });
});
