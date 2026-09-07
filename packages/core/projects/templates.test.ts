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
      "requirements",
      "tasks",
      "deliverables",
    ]);
    expect(viewsForProjectTemplate("rd")).toEqual([
      "archive",
      "features",
      "requirements",
      "tasks",
      "acceptance",
      "deliverables",
      "filing",
    ]);
    expect(viewsForProjectTemplate("data")).toEqual([
      "archive",
      "data-model",
      "requirements",
      "tasks",
      "acceptance",
      "deliverables",
    ]);
  });

  it("keeps the eight-tab shell for legacy and unknown templates", () => {
    expect(resolveProjectTemplate(undefined)).toBe("full");
    expect(resolveProjectTemplate("full")).toBe("full");
    expect(viewsForProjectTemplate(null)).toHaveLength(8);
    expect(isViewAllowedForTemplate("data-model", "rd")).toBe(false);
    expect(isViewAllowedForTemplate("features", "rd")).toBe(true);
    expect(isViewAllowedForTemplate("filing", "general")).toBe(false);
  });
});
