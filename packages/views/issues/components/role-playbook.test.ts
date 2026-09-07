import { describe, expect, it } from "vitest";
import type { RolePlaybook, RolePlaybookBundle } from "@multica/core/types";
import {
  emptyRolePlaybook,
  overridesEqual,
  playbookHasOverride,
  resolvedPlaybook,
  withOverride,
} from "./role-playbook";

function bundle(partial?: Partial<RolePlaybookBundle>): RolePlaybookBundle {
  const builtin = emptyRolePlaybook("developer");
  builtin.background = "研发背景";
  builtin.standards = "交付标准";
  builtin.process = "执行流程";
  builtin.init_content = "初始化";
  return {
    playbooks: { developer: { ...builtin, source: "builtin" } },
    overrides: {},
    builtins: { developer: builtin },
    ...partial,
  };
}

describe("role-playbook helpers", () => {
  it("treats default init_mode as not an override", () => {
    expect(playbookHasOverride(emptyRolePlaybook("pm"))).toBe(false);
    expect(
      playbookHasOverride({ ...emptyRolePlaybook("pm"), init_mode: "checklist" }),
    ).toBe(true);
  });

  it("merges a field-level override onto the builtin", () => {
    const next = withOverride(bundle(), "developer", {
      ...emptyRolePlaybook("developer"),
      standards: "只改 packages/views",
    });
    expect(next.playbooks.developer?.standards).toBe("只改 packages/views");
    expect(next.playbooks.developer?.background).toBe("研发背景");
    expect(next.playbooks.developer?.source).toBe("custom");
    expect(next.overrides.developer?.standards).toBe("只改 packages/views");
  });

  it("drops an all-empty override back to builtin", () => {
    const customized = withOverride(bundle(), "developer", {
      ...emptyRolePlaybook("developer"),
      process: "自定义流程",
    });
    const reset = withOverride(customized, "developer", emptyRolePlaybook("developer"));
    expect(reset.overrides.developer).toBeUndefined();
    expect(reset.playbooks.developer?.source).toBe("builtin");
    expect(reset.playbooks.developer?.process).toBe("执行流程");
  });

  it("compares overrides for create-issue dirty detection", () => {
    const a: RolePlaybook = {
      ...emptyRolePlaybook("pm"),
      background: "x",
    };
    expect(overridesEqual({ pm: a }, { pm: { ...a } })).toBe(true);
    expect(overridesEqual({ pm: a }, {})).toBe(false);
    expect(overridesEqual({}, {})).toBe(true);
  });

  it("falls back to builtin when resolved map is empty", () => {
    const b = bundle({ playbooks: {} });
    expect(resolvedPlaybook(b, "developer").background).toBe("研发背景");
  });
});
