// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithI18n } from "../../test/i18n";

import { ModuleBadge } from "./module-badge";

afterEach(cleanup);

describe("ModuleBadge", () => {
  it("renders the module name with its color", () => {
    renderWithI18n(<ModuleBadge name="内核" color="#3b82f6" />);
    expect(screen.getByText("内核")).toBeInTheDocument();
  });

  it("shows the shield only when avoid_conflict is set", () => {
    const { container: plain } = renderWithI18n(
      <ModuleBadge name="Flow" color="#22c55e" />,
    );
    expect(plain.querySelector("svg")).toBeNull();

    const { container: shielded } = renderWithI18n(
      <ModuleBadge name="Flow" color="#22c55e" avoidConflict />,
    );
    expect(shielded.querySelector("svg")).not.toBeNull();
  });
});
