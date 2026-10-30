---
name: multica-feature-modules
description: "Use when a person asks about a project's feature modules (功能模块), wants a module's prototype screen, or wants a module's capability spec or prototype upgraded. Reads modules, requirements and prototype versions; edits the spec or proposes a new prototype. Never assemble html_path by hand."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Feature modules and prototypes

A **feature module** (功能模块) groups a project's requirements and is usually
how a person names a screen — "图谱浏览页", "设备建模页". It is not a document
and not a project resource, and it owns no prototype HTML of its own: the files
hang off the prototype versions of the requirements inside it.

Reading "a module's prototype" is therefore always three hops —
**module → requirements → prototype versions → file** — and `multica module`
does them for you. Do not reimplement the chain with `issue`/`requirement`
commands and do not open an `html_path` yourself.

The module also carries a **capability spec** (`module_spec/v1`: a summary plus
`features[]` of code / title / kind / priority). The spec is what the 功能模块 TAB
lists on the left and what the reconcile matrix counts against the prototype.

## Two front doors, one backend

Every capability below exists twice and forwards to the same handlers, so
permissions, flag gating, change events and audit are identical:

- **MCP tools** `modules_*` on the module facade (preferred when your tool list
  has them — structured args, no shell quoting).
- **CLI** `multica module …` (works for every agent; the runtime gives you a
  `MULTICA_TOKEN`, so the CLI authenticates by itself).

If your tool list has no `modules_*` tools, the facade is not attached to this
runtime (a workspace admin adds it once). Use the CLI; nothing is lost.

| MCP tool | CLI equivalent |
| --- | --- |
| `modules_list` / `modules_get` | `multica module list` / `get` |
| `modules_create` / `modules_update` / `modules_delete` | `multica module create` / `update` / `delete` |
| `modules_requirements` | `multica module get <module>` (its `issues[]`) |
| `modules_spec_get` / `modules_spec_draft` / `modules_spec_publish` | `multica module spec get` / `draft` / `publish` |
| `modules_prototype_versions` | `multica module prototype list` |
| `modules_prototype_register` | (MCP only — the builder registers versions) |
| `modules_prototype_plan_create` / `_get` / `_apply` | `multica module plan create` / `get` / `apply` |
| `modules_reconcile` / `modules_coverage` | `multica module reconcile` / `coverage` |

## Reading

```bash
multica module list --project <project-id> --output json   # modules of one project
multica module list --output json                          # every module in the workspace
multica module get <module> --output json                  # module + requirements + versions
multica module prototype list <module> --output json       # versions, FILE=ok|missing|no-path
multica module prototype read <module>                     # absolute path of the live version
multica module prototype read <module> --version 2         # one specific version
multica module prototype read <module> --raw               # print the HTML itself
multica module coverage <module> --output json             # KPI badge numbers
multica module reconcile <module> --output json            # four-state spec × prototype matrix
```

`<module>` accepts the module UUID, a UUID prefix, or its name. When a name
could exist in more than one project, add `--project <project-id>`; when you
need a copyable id, add `--full-id` to any list.

## Writing a module

- `create` needs `--name`; names are unique per project, so a duplicate is a
  server error, not a silent merge. `--color` is a display hex string.
- `update` sends only the flags you pass. `--graph-node` binds the module to a
  data-model node; `--graph-node ""` unbinds it. Binding decides which scanned
  module the 数据模型 TAB reports for this feature module, so read
  `multica graph modules <project>` first and say which node you are binding
  (see `multica-data-model`).
- `delete` is level B in `multica-module-map`: the FK is `ON DELETE SET NULL`,
  so the module's requirements survive but become module-less and leave any
  cross-module lock. Prototypes and archive documents are untouched. State that
  before running it with `--yes` (MCP: `confirm=true`, and without it the tool
  refuses before touching the API).
- When someone says "this module is wrong", renaming and rebinding is usually
  the answer — deleting loses the grouping for every requirement inside it.

## Editing the capability spec

```bash
multica module spec get <module> --output json
multica module spec draft <module> --file spec.json          # or --spec '<json>', or --file -
multica module spec publish <module> --file spec.json --expected-version 3
```

- **draft** stores the spec without touching `spec_version` or the feature
  projection: it is a workspace for review, invisible to everyone else.
- **publish** is the only way a spec becomes the module's truth. In one
  transaction it bumps `spec_version`, rebuilds the `project_module_feature`
  projection and records a change event, so the 功能模块 TAB changes for the
  person too.
- `--expected-version` makes the write conditional: if another writer already
  bumped the version the server answers 409 `spec_version_conflict` and
  **nothing** is written. Re-read, merge, publish again — never retry blindly.
- The payload is `{schema: "module_spec/v1", summary?, features: [{code, title,
  kind: "core"|"edge", priority?}]}`. `code` is the stable join key to the
  prototype's `data-fp` anchors; renaming a code reads as "feature removed plus
  feature added" in the reconcile matrix.

## Upgrading a prototype (two-phase, human-gated)

An agent never moves the canonical pointer. It proposes; a person applies:

```bash
multica module prototype list <module> --output json          # find the candidate version
multica module plan create <module> --candidate-version 4 \
  --file spec.json --decisions '{"browse.search":"keep"}'
multica module plan get <module> <plan-id>                     # status: draft|applying|applied|failed|expired
multica module plan apply <module> <plan-id> --yes            # the person's step
```

- A plan snapshots "candidate version + new spec + feature decisions" and moves
  nothing. `apply` does the canonical move, the spec bump and the projection
  rebuild in one transaction; drafts expire after 24h and a second apply answers
  409 `plan_already_applied`.
- Always print the plan id, the candidate version and what changes before asking
  for `--yes`. Applying is a product decision, not a cleanup step.
- Registering a brand-new prototype version is MCP-only today
  (`modules_prototype_register`) because the HTML is produced by the prototype
  builder, not by hand-editing a file path; pass `set_canonical` only together
  with a `confirmed` status.

## Rules that save a lot of wandering

- `html_path` coming back from the API is **repository-relative** and has two
  shapes: `requirements/...` (relative to the archive root) and
  `change_logs/...` (relative to that root's parent directory). Joining it onto
  the working directory, or `find`/`ls`-ing around for it, is the single most
  common way a prototype read fails. Run `multica module prototype read`; it
  tries the archive root, the sibling `change_logs` root, and the workspace
  dir, then prints the absolute path.
- Without `--version` the **confirmed** version wins, then the newest. A newer
  pending draft is not what "the module's prototype" means.
- Superseded versions often point at a file that no longer exists. `prototype
  list` reports `FILE=missing`; pick a version that says `ok`.
- The module-level endpoints behind spec, prototype versions, plans, reconcile
  and coverage are gated by the `module_spec_center` server flag. When it is off
  the MCP tools are absent from `tools/list` and the CLI answers 404 with a flag
  hint. The read chain above (`list` / `get` / `prototype list|read`) works
  either way — do not conclude that the module is missing.
- Coverage and reconcile are computed on the server from the same rows the TAB
  renders. Never recompute, estimate or "fix" the numbers in a message; quote
  `modules_coverage` / `modules_reconcile`.
- For the module list as a project tab (row counts, template visibility), use
  `multica project tab list <project>` / `multica project tab get <project>
  features`. Details in the `multica-project-tabs` skill.
- Modules are read by default: only create, rename, bind, publish a spec, or
  apply a plan when the person asked for that. Specs and plans are project
  settings, not conversation actions, and a delete is level B (ask, then
  `--yes`).

## When the command fails

- `no module named ...`: the name is not in the targeted scope. Run
  `multica module list` (or `--project <id>`) and use the name or id it prints.
- `ambiguous module name`: the same name exists in several projects. Re-run with
  `--project`.
- `prototype file for module ... does not exist on this machine`: the stored
  path is stale (common for superseded versions). The message lists every root
  it tried; switch versions with `--version`, or report that the file is gone.
- `spec_version_conflict` (HTTP 409): someone else published first. Re-read the
  spec, re-apply your change on top of it, publish again.
- `plan_expired` / `plan_already_applied`: create a fresh plan instead of
  reusing the id.
- `module_spec_center is disabled`: the feature flag is off on this server.
  Report it; the read commands still work.
- `invocation_revoked` or a shell allowlist error: the runtime blocked exec.
  Report that; do not retry with a different tool.
