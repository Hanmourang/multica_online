import type {
  RoleAssignment,
  RolePlaybook,
  RolePlaybookBundle,
  RolePlaybookInitMode,
} from "@multica/core/types";

export type RolePlaybookKey = RoleAssignment["role"];

export const ROLE_PLAYBOOK_ORDER: RolePlaybookKey[] = [
  "pm",
  "prototyper",
  "developer",
  "data",
  "tester",
];

export function emptyRolePlaybook(
  role: RolePlaybookKey,
  initMode: RolePlaybookInitMode = "brief",
): RolePlaybook {
  return {
    role,
    background: "",
    standards: "",
    process: "",
    init_mode: initMode,
    init_content: "",
  };
}

export function playbookHasOverride(p?: RolePlaybook | null): boolean {
  if (!p) return false;
  // init_mode is a closed union, but rows written before the checklist mode
  // existed still carry an empty string at runtime.
  const initMode: string = p.init_mode;
  return (
    p.background.trim() !== "" ||
    p.standards.trim() !== "" ||
    p.process.trim() !== "" ||
    p.init_content.trim() !== "" ||
    (initMode !== "" && initMode !== "brief")
  );
}

export function resolvedPlaybook(
  bundle: RolePlaybookBundle | undefined,
  role: RolePlaybookKey,
): RolePlaybook {
  return (
    bundle?.playbooks[role] ??
    bundle?.builtins[role] ??
    emptyRolePlaybook(role)
  );
}

export function overridePlaybook(
  bundle: RolePlaybookBundle | undefined,
  role: RolePlaybookKey,
): RolePlaybook {
  return bundle?.overrides[role] ?? emptyRolePlaybook(role);
}

export function withOverride(
  bundle: RolePlaybookBundle,
  role: RolePlaybookKey,
  override: RolePlaybook,
): RolePlaybookBundle {
  const nextOverrides = { ...bundle.overrides };
  if (playbookHasOverride(override)) {
    nextOverrides[role] = { ...override, role };
  } else {
    delete nextOverrides[role];
  }
  const builtin = bundle.builtins[role] ?? emptyRolePlaybook(role);
  const resolved: RolePlaybook = {
    role,
    background: override.background.trim() || builtin.background,
    standards: override.standards.trim() || builtin.standards,
    process: override.process.trim() || builtin.process,
    init_mode: override.init_mode || builtin.init_mode || "brief",
    init_content: override.init_content.trim() || builtin.init_content,
    source: playbookHasOverride(override) ? "custom" : "builtin",
  };
  return {
    ...bundle,
    overrides: nextOverrides,
    playbooks: { ...bundle.playbooks, [role]: resolved },
  };
}

export function overridesEqual(
  a: RolePlaybookBundle["overrides"],
  b: RolePlaybookBundle["overrides"],
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key as RolePlaybookKey];
    const right = b[key as RolePlaybookKey];
    if (!playbookHasOverride(left) && !playbookHasOverride(right)) continue;
    if (!left || !right) return false;
    if (
      left.background !== right.background ||
      left.standards !== right.standards ||
      left.process !== right.process ||
      left.init_mode !== right.init_mode ||
      left.init_content !== right.init_content
    ) {
      return false;
    }
  }
  return true;
}
