import { describe, expect, it } from "vitest";
import {
  viewsForProjectTemplate,
  isViewAllowedForTemplate,
  resolveProjectTemplate,
} from "./templates";

describe("project templates", () => {
  it("maps general / rd / data onto the product TAB sets", () => {
    expect(viewsForProjectTemplate("general")).toEqual([
      "archive",
      "assets",
      "requirements",
      "tasks",
      "deliverables",
      "workflows",
      "sprints",
    ]);
    expect(viewsForProjectTemplate("rd")).toEqual([
      "archive",
      "assets",
      "features",
      "requirements",
      "tasks",
      "acceptance",
      "deliverables",
      "filing",
      "workflows",
      "sprints",
    ]);
    expect(viewsForProjectTemplate("data")).toEqual([
      "archive",
      "assets",
      "data-model",
      "requirements",
      "tasks",
      "acceptance",
      "deliverables",
      "workflows",
      "sprints",
    ]);
  });

  it("keeps the eight-tab shell for legacy and unknown templates", () => {
    expect(resolveProjectTemplate(undefined)).toBe("full");
    expect(resolveProjectTemplate("full")).toBe("full");
    expect(viewsForProjectTemplate(null)).toHaveLength(11);
    expect(isViewAllowedForTemplate("data-model", "rd")).toBe(false);
    expect(isViewAllowedForTemplate("features", "rd")).toBe(true);
    expect(isViewAllowedForTemplate("filing", "general")).toBe(false);
  });
});
