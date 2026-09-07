// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { DeliverablePreviewDialog } from "./deliverable-preview-dialog";
import type { Deliverable } from "./build-deliverables";

afterEach(cleanup);

const items: Deliverable[] = [
  {
    path: "docs/a.md", name: "a.md", kind: "added", source: "trace",
    addedLines: 3, removedLines: 0, content: "# Title\n\nbody text",
  },
  {
    path: "src/b.ts", name: "b.ts", kind: "modified", source: "trace",
    addedLines: 1, removedLines: 1,
    diff: [
      { kind: "remove", text: "const old = 1" },
      { kind: "add", text: "const newVal = 2" },
    ],
  },
];

function renderDialog(index = 0, list: Deliverable[] = items) {
  const onIndexChange = vi.fn();
  const onClose = vi.fn();
  const result = renderWithI18n(
    <DeliverablePreviewDialog
      deliverables={list}
      index={index}
      onIndexChange={onIndexChange}
      onClose={onClose}
    />,
  );
  return { onIndexChange, onClose, container: result.container };
}

describe("DeliverablePreviewDialog", () => {
  it("renders name, path and position indicator", () => {
    renderDialog(0);
    // The sr-only DialogTitle also carries the name; assert the visible one.
    expect(screen.getByText("a.md", { selector: "div.truncate" })).toBeInTheDocument();
    expect(screen.getByText("docs/a.md")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("renders markdown content for a full-text deliverable", () => {
    renderDialog(0);
    expect(screen.getByTestId("deliverable-markdown")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("body text")).toBeInTheDocument();
  });

  it("renders diff lines for an edit-only deliverable", () => {
    renderDialog(1);
    const diff = screen.getByTestId("deliverable-diff");
    expect(diff.textContent).toContain("const old = 1");
    expect(diff.textContent).toContain("const newVal = 2");
  });

  it("navigates with prev/next and disables at the boundaries", () => {
    const { onIndexChange } = renderDialog(0);
    expect(screen.getByTestId("deliverable-prev")).toBeDisabled();
    expect(screen.getByTestId("deliverable-next")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("deliverable-next"));
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it("renders a full-text code file inside a syntax-highlighted fence, not as markdown", () => {
    const codeItems: Deliverable[] = [
      {
        path: "src/util.ts", name: "util.ts", kind: "added", source: "trace",
        addedLines: 2, removedLines: 0,
        content: "# not a heading\nexport const x = 1;",
      },
    ];
    renderDialog(0, codeItems);
    const code = screen.getByTestId("deliverable-code");
    expect(code.textContent).toContain("export const x = 1;");
    expect(code.textContent).toContain("# not a heading");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("closes on Escape", () => {
    const { onClose } = renderDialog(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
