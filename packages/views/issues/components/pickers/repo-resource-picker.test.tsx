// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectResource } from "@multica/core/types";
import { renderWithI18n } from "../../../test/i18n";

// The picker answers "which repo does this requirement work on" for two kinds
// of repo: a folder on a daemon machine and a hosted URL. The URL half is what
// makes public open-source repos usable, and it is exercised here because the
// value it produces (`repo_resource_id`) is what the claim turns into a repo the
// agent can clone.

const state = vi.hoisted(() => ({
  resources: [] as ProjectResource[],
  create: vi.fn(),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/projects", () => ({
  projectResourcesOptions: (wsId: string, projectId: string) => ({
    queryKey: ["project-resources", wsId, projectId],
    queryFn: () => Promise.resolve(state.resources),
  }),
  useCreateProjectResource: () => ({ mutateAsync: state.create }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import {
  RepoResourcePicker,
  normalizeGitRepoUrl,
  repoKey,
} from "./repo-resource-picker";

function resource(overrides: Partial<ProjectResource>): ProjectResource {
  return {
    id: "res-1",
    project_id: "proj-1",
    workspace_id: "ws-1",
    resource_type: "github_repo",
    resource_ref: {},
    label: null,
    position: 0,
    created_at: "2026-09-01T00:00:00Z",
    created_by: null,
    ...overrides,
  } as ProjectResource;
}

const GITHUB = resource({
  id: "res-gh",
  resource_ref: { url: "https://github.com/acme/app" },
  label: "acme/app",
});
const LOCAL = resource({
  id: "res-local",
  resource_type: "local_directory",
  resource_ref: { local_path: "/Users/me/work", daemon_id: "daemon-1" },
  label: "work",
});

function renderPicker(value = "", onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <RepoResourcePicker projectId="proj-1" value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.resources = [GITHUB, LOCAL];
  state.create.mockReset();
});

describe("normalizeGitRepoUrl", () => {
  it("accepts the shapes people actually paste", () => {
    expect(normalizeGitRepoUrl("facebook/react")).toBe(
      "https://github.com/facebook/react",
    );
    expect(normalizeGitRepoUrl("github.com/facebook/react")).toBe(
      "https://github.com/facebook/react",
    );
    expect(normalizeGitRepoUrl("https://github.com/facebook/react.git")).toBe(
      "https://github.com/facebook/react.git",
    );
    expect(normalizeGitRepoUrl("git@github.com:facebook/react.git")).toBe(
      "git@github.com:facebook/react.git",
    );
    expect(normalizeGitRepoUrl("  https://gitlab.com/group/proj  ")).toBe(
      "https://gitlab.com/group/proj",
    );
  });

  it("rejects things git clone could not use", () => {
    expect(normalizeGitRepoUrl("")).toBeNull();
    expect(normalizeGitRepoUrl("not a repo")).toBeNull();
    expect(normalizeGitRepoUrl("facebook")).toBeNull();
    expect(normalizeGitRepoUrl("https://github.com/facebook")).toBeNull();
  });
});

describe("repoKey", () => {
  it("treats the same repo written four ways as one repo", () => {
    const key = repoKey("https://github.com/acme/app");
    expect(repoKey("https://github.com/acme/app.git")).toBe(key);
    expect(repoKey("https://github.com/acme/app/")).toBe(key);
    expect(repoKey("ssh://git@github.com/acme/app")).toBe(key);
    expect(repoKey("git@github.com:acme/app.git")).toBe(key);
    expect(repoKey("https://github.com/acme/other")).not.toBe(key);
  });
});

describe("RepoResourcePicker", () => {
  it("lists hosted and local repos and reports the chosen id", async () => {
    const { onChange } = renderPicker();

    const select = (await screen.findByTestId(
      "repo-resource-picker",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.textContent).toContain("acme/app"));
    expect(select.textContent).toContain("work");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["GitHub repos", "Local folders"]);

    fireEvent.change(select, { target: { value: "res-local" } });
    expect(onChange).toHaveBeenCalledWith("res-local");
  });

  it("binds a pasted GitHub URL as a project resource", async () => {
    const user = userEvent.setup();
    const created = resource({ id: "res-new", label: "react" });
    state.create.mockResolvedValue(created);
    const { onChange } = renderPicker();

    const select = (await screen.findByTestId(
      "repo-resource-picker",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__repo_url__" } });

    await user.type(
      screen.getByTestId("repo-resource-picker-url"),
      "facebook/react",
    );
    await user.click(screen.getByRole("button", { name: "Bind" }));

    await waitFor(() => {
      expect(state.create).toHaveBeenCalledWith({
        resource_type: "github_repo",
        resource_ref: { url: "https://github.com/facebook/react" },
        label: "react",
      });
    });
    expect(onChange).toHaveBeenCalledWith("res-new");
    expect(toast.success).toHaveBeenCalledWith("Repo added to the project and bound");
  });

  it("reuses the project's row when the same repo arrives in another form", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    const select = (await screen.findByTestId(
      "repo-resource-picker",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__repo_url__" } });

    await user.type(
      screen.getByTestId("repo-resource-picker-url"),
      "git@github.com:acme/app.git",
    );
    await user.click(screen.getByRole("button", { name: "Bind" }));

    // A second row for a repo the project already has would make "which one is
    // bound" unanswerable, and the daemon would clone it twice.
    expect(state.create).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("res-gh");
  });

  it("stays put and explains why when the input is not a repo", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    const select = (await screen.findByTestId(
      "repo-resource-picker",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__repo_url__" } });
    await user.type(screen.getByTestId("repo-resource-picker-url"), "not a repo");
    await user.click(screen.getByRole("button", { name: "Bind" }));

    expect(
      screen.getByTestId("repo-resource-picker-url-message").textContent,
    ).toContain("Enter a repo URL or owner/repo");
    expect(state.create).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows where the bound repo actually points", async () => {
    renderPicker("res-gh");
    const hint = await screen.findByTestId("repo-resource-picker-hint");
    // The label can be renamed, so the URL is the trustworthy target.
    expect(hint.textContent).toBe("https://github.com/acme/app");
  });
});
