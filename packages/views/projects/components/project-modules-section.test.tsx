// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@multica/core/api";
import type { ProjectModule } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

import { ProjectModulesSection } from "./project-modules-section";

const mocks = vi.hoisted(() => ({
  modules: [
    {
      id: "mod-1",
      project_id: "proj-1",
      workspace_id: "ws-1",
      name: "Billing",
      color: "#3b82f6",
      created_at: "2026-09-01T00:00:00Z",
      task_count: 3,
    },
    {
      id: "mod-2",
      project_id: "proj-1",
      workspace_id: "ws-1",
      name: "Checkout",
      color: "#22c55e",
      created_at: "2026-09-02T00:00:00Z",
      task_count: 0,
    },
  ] as ProjectModule[],
  createMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  deleteMutateAsync: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.modules }),
}));

vi.mock("@multica/core/modules", () => ({
  projectModulesOptions: () => ({ queryKey: ["project-modules"] }),
  useCreateProjectModule: () => ({
    mutateAsync: mocks.createMutateAsync,
    isPending: false,
  }),
  useUpdateProjectModule: () => ({
    mutateAsync: mocks.updateMutateAsync,
  }),
  useDeleteProjectModule: () => ({
    mutateAsync: mocks.deleteMutateAsync,
  }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

beforeEach(() => {
  mocks.modules = [
    {
      id: "mod-1",
      project_id: "proj-1",
      workspace_id: "ws-1",
      name: "Billing",
      color: "#3b82f6",
      created_at: "2026-09-01T00:00:00Z",
      task_count: 3,
    },
    {
      id: "mod-2",
      project_id: "proj-1",
      workspace_id: "ws-1",
      name: "Checkout",
      color: "#22c55e",
      created_at: "2026-09-02T00:00:00Z",
      task_count: 0,
    },
  ];
  mocks.createMutateAsync.mockReset().mockResolvedValue({});
  mocks.updateMutateAsync.mockReset().mockResolvedValue({});
  mocks.deleteMutateAsync.mockReset().mockResolvedValue(undefined);
  mocks.toastError.mockReset();
});

describe("ProjectModulesSection", () => {
  it("renders each module row with its name and task count", () => {
    renderWithI18n(<ProjectModulesSection projectId="proj-1" />);
    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(screen.getByText("Checkout")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows the empty copy when the project has no modules", () => {
    mocks.modules = [];
    renderWithI18n(<ProjectModulesSection projectId="proj-1" />);
    expect(screen.getByText("No modules yet")).toBeInTheDocument();
  });

  it("creates a module from the inline form and clears the input", async () => {
    const user = userEvent.setup();
    renderWithI18n(<ProjectModulesSection projectId="proj-1" />);
    const input = screen.getByPlaceholderText("Module name");
    await user.type(input, "Payments");
    await user.click(screen.getByRole("button", { name: /New module/ }));
    expect(mocks.createMutateAsync).toHaveBeenCalledWith({
      name: "Payments",
      color: expect.any(String),
    });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("toasts the duplicate-name copy on a 409 create", async () => {
    mocks.createMutateAsync.mockRejectedValue(
      new ApiError("module name already exists in this project", 409, "Conflict"),
    );
    const user = userEvent.setup();
    renderWithI18n(<ProjectModulesSection projectId="proj-1" />);
    await user.type(screen.getByPlaceholderText("Module name"), "Billing");
    await user.click(screen.getByRole("button", { name: /New module/ }));
    expect(mocks.toastError).toHaveBeenCalledWith(
      "A module with this name already exists",
    );
  });

  it("renames inline: pencil reveals the input, Enter commits", async () => {
    const user = userEvent.setup();
    renderWithI18n(<ProjectModulesSection projectId="proj-1" />);
    await user.click(
      screen.getAllByRole("button", { name: "Rename" })[0]!,
    );
    const input = screen.getByDisplayValue("Billing");
    await user.clear(input);
    await user.type(input, "Billing v2{Enter}");
    expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
      moduleId: "mod-1",
      name: "Billing v2",
    });
  });

  it("recolors through the dot's palette popover", async () => {
    const user = userEvent.setup();
    renderWithI18n(<ProjectModulesSection projectId="proj-1" />);
    await user.click(
      screen.getAllByRole("button", { name: "Change color" })[0]!,
    );
    // The module already owns #3b82f6; picking a different swatch PATCHes.
    await user.click(screen.getByRole("button", { name: "#22c55e" }));
    expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
      moduleId: "mod-1",
      color: "#22c55e",
    });
  });

  it("deletes only after the confirm dialog", async () => {
    const user = userEvent.setup();
    renderWithI18n(<ProjectModulesSection projectId="proj-1" />);
    await user.click(
      screen.getAllByRole("button", { name: "Delete" })[0]!,
    );
    expect(
      screen.getByText("Delete module Billing?"),
    ).toBeInTheDocument();
    expect(mocks.deleteMutateAsync).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(mocks.deleteMutateAsync).toHaveBeenCalledWith("mod-1");
  });
});
