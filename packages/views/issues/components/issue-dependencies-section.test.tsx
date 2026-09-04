// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

import { IssueDependenciesSection } from "./issue-dependencies-section";

const mocks = vi.hoisted(() => ({
  deps: [
    { issue_id: "dep-1", title: "Schema migration", status: "done" },
    { issue_id: "dep-2", title: "Backfill job", status: "in_progress" },
  ] as { issue_id: string; title: string; status: string }[],
  putMutate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    if (options.queryKey?.[0] === "issue-dependencies") {
      return { data: mocks.deps };
    }
    return { data: undefined };
  },
}));

vi.mock("@multica/core/modules", () => ({
  issueDependenciesOptions: () => ({ queryKey: ["issue-dependencies"] }),
  usePutIssueDependencies: () => ({ mutate: mocks.putMutate }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

// The section only needs StatusIcon off the components barrel; pulling the
// real index would drag the whole component graph into the test.
vi.mock(".", () => ({
  StatusIcon: () => null,
}));

vi.mock("./pickers/dependency-picker", () => ({
  DependencyPicker: (props: {
    selectedIds: string[];
    onChange: (ids: string[]) => void;
  }) => (
    <button
      data-testid="dep-picker"
      onClick={() => props.onChange([...props.selectedIds, "dep-new"])}
    />
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

const ISSUE = {
  id: "issue-1",
  project_id: "proj-1",
  module_id: "mod-1",
} as Issue;

beforeEach(() => {
  mocks.deps = [
    { issue_id: "dep-1", title: "Schema migration", status: "done" },
    { issue_id: "dep-2", title: "Backfill job", status: "in_progress" },
  ];
  mocks.putMutate.mockReset();
  mocks.toastError.mockReset();
});

describe("IssueDependenciesSection", () => {
  it("renders each dependency row with a link and shows the gate hint while one is unfinished", () => {
    renderWithI18n(<IssueDependenciesSection issue={ISSUE} />);
    expect(screen.getByText("Schema migration")).toBeInTheDocument();
    expect(screen.getByText("Backfill job")).toBeInTheDocument();
    expect(
      screen.getByText(/While a dependency is unfinished/),
    ).toBeInTheDocument();
  });

  it("omits the gate hint once every dependency is done or cancelled", () => {
    mocks.deps = [
      { issue_id: "dep-1", title: "Schema migration", status: "done" },
      { issue_id: "dep-2", title: "Backfill job", status: "cancelled" },
    ];
    renderWithI18n(<IssueDependenciesSection issue={ISSUE} />);
    expect(screen.queryByText(/While a dependency is unfinished/)).toBeNull();
  });

  it("removes a row by PUTting the remaining id set", async () => {
    const user = userEvent.setup();
    renderWithI18n(<IssueDependenciesSection issue={ISSUE} />);
    await user.click(
      screen.getByRole("button", { name: "Remove dependency Schema migration" }),
    );
    expect(mocks.putMutate).toHaveBeenCalledWith(
      ["dep-2"],
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("adds through the picker by PUTting the extended id set", async () => {
    const user = userEvent.setup();
    renderWithI18n(<IssueDependenciesSection issue={ISSUE} />);
    await user.click(screen.getByTestId("dep-picker"));
    expect(mocks.putMutate).toHaveBeenCalledWith(
      ["dep-1", "dep-2", "dep-new"],
      expect.anything(),
    );
  });

  it("shows the needs-module hint and hides the picker when the issue has no module", () => {
    renderWithI18n(
      <IssueDependenciesSection issue={{ ...ISSUE, module_id: null }} />,
    );
    expect(
      screen.getByText("Pick a module before adding dependencies"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("dep-picker")).toBeNull();
  });

  it("renders the empty-state copy when the module has no edges yet", () => {
    mocks.deps = [];
    renderWithI18n(<IssueDependenciesSection issue={ISSUE} />);
    expect(screen.getByText(/No dependencies\./)).toBeInTheDocument();
  });

  it("renders nothing for a project-less issue", () => {
    const { container } = renderWithI18n(
      <IssueDependenciesSection issue={{ ...ISSUE, project_id: null }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
