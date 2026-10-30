---
name: multica-feature-modules
description: "Use when a person asks about a project's feature module (功能模块): its prototype screen, spec, brief, prototype versions, releases, or what changed between two versions. Reads and writes every object under 项目 → 功能模块 and summarizes version diffs."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Feature modules: everything under 项目 → 功能模块

A **feature module** (功能模块) groups a project's requirements and is usually how
a person names a screen — "图谱浏览页", "设备建模页". Six kinds of object live
under it, and **every one is readable and writable through `multica module …`**:

| Object | Read | Write |
| --- | --- | --- |
| the module itself | `module list` / `get` | `module create` / `update` / `delete` |
| the requirements inside it | `module get` (its `issues[]`) | `module requirement add` / `remove` |
| capability spec (`module_spec/v1`) | `module spec get` | `module spec draft` / `publish`, `module spec feature add` / `update` / `remove` |
| capability brief (the right pane) | `module brief get` | `module brief patch` |
| prototype versions | `module prototype list` / `read` / `diff` | `module prototype register` / `update` / `confirm` / `delete` / `parse` |
| releases (brief × prototype) | `module release list` | `module release publish` / `rollback` |

A prototype version has **two possible owners**, and the difference decides which
commands may touch it:

- **module-owned** (`issue_id` is null): registered straight onto the module, e.g.
  by a prototype builder or by `multica module prototype register`. This is the
  one `module prototype update|confirm|delete` may change.
- **requirement-owned** (`issue_id` set): the output of a requirement's stage, so
  it follows the requirement's own approval gates. `module prototype list|read|diff`
  shows it (OWNER=requirement) but `update|confirm|delete` answers 409 and points
  at `multica requirement prototype …`. Do not try to edit it here.

`multica module prototype list` merges both axes into one version timeline, so you
never have to reassemble the chain by hand, and a module with no requirements still
has a readable prototype. Do not rebuild that chain from `issue` / `requirement`
commands and do not open an `html_path` yourself.

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
| `modules_workspace_get` | `multica module brief get` |
| `modules_brief_patch` | `multica module brief patch` |
| `modules_prototype_versions` | `multica module prototype list` |
| `modules_prototype_register` / `_update` / `_confirm` / `_delete` | `multica module prototype register` / `update` / `confirm` / `delete` |
| `modules_prototype_parse` | `multica module prototype parse` |
| `modules_prototype_plan_create` / `_get` / `_apply` | `multica module plan create` / `get` / `apply` |
| `modules_releases_list` / `modules_release_publish` / `modules_release_rollback` | `multica module release list` / `publish` / `rollback` |
| `modules_reconcile` / `modules_coverage` | `multica module reconcile` / `coverage` |

`module prototype diff`, `module brief versions` and `module brief diff` are CLI
only: they read the HTML files and the stored change log on this machine, which a
structured tool call cannot do.

## Reading

```bash
multica module list --project <project-id> --output json   # modules of one project
multica module list --output json                          # every module in the workspace
multica module get <module> --output json                  # module + requirements + versions
multica module prototype list <module> --output json       # VERSION STATUS OWNER FILE REQUIREMENT
multica module prototype read <module>                     # absolute path of the live version
multica module prototype read <module> --version 2         # one specific version
multica module prototype read <module> --raw               # print the HTML itself
multica module brief get <module> --output json            # brief + field_defs + versions + releases
multica module brief versions <module>                     # who changed which fields, and when
multica module release list <module> --output json         # paired releases + both pointers
multica module coverage <module> --output json             # KPI badge numbers
multica module reconcile <module> --output json            # four-state spec × prototype matrix
```

`<module>` accepts the module UUID, a UUID prefix, or its name. When a name could
exist in more than one project, add `--project <project-id>`; when you need a
copyable id, add `--full-id` to any list.

`multica module brief get` is the whole right pane in one call: the current
`brief` values, the writable `field_defs` (labels, kinds, scope), the `features[]`
from the spec, the `versions[]` change log and the `releases[]`.

## Editing content (spec, features, brief, requirements)

### One feature point at a time

```bash
multica module spec feature add <module> --code FP-05 --title "群设置" --group 会话
multica module spec feature update <module> FP-05 --title "群设置（改）"
multica module spec feature update <module> FP-05 --code-new FP-06
multica module spec feature remove <module> FP-05
```

These are a **read-modify-write over the published spec**: only the row you name
changes, every other feature round-trips untouched. Prefer them over hand-writing
a whole `features[]` — a hand-built array silently deletes whatever you forgot.

Every one publishes by default (`spec_version` +1, projection rebuilt, change
event recorded). `--draft` stores without bumping the version; `--expected-version
<n>` turns the write into a compare-and-swap (409 `spec_version_conflict` when
someone else published first — re-read, merge, retry).

### Brief fields (the right pane's prose)

```bash
multica module brief get <module> --output json                     # note brief_version
multica module brief patch <module> --base-version 3 \
  --field 'brief.goal=把下单链路收敛成一步' \
  --field 'fp.FP-01.interaction=点选后右侧抽屉展开' \
  --note "补全目标与交互" --source agent
multica module brief patch <module> --base-version 3 --fields '{"brief.scope":"..."}'
```

Writable keys are exactly what `field_defs` in `brief get` lists:

- module scope: `brief.position` `brief.goal` `brief.scope` `brief.non_goal`
  `brief.roles` `brief.flow` `brief.acceptance_goal`
- per feature point: `fp.<code>.desc` `fp.<code>.loc` `fp.<code>.req`
  `fp.<code>.interaction` `fp.<code>.deps` `fp.<code>.acceptance`

Rules the server enforces and you must not fight: `--base-version` is required
(409 `base_stale` carries the new `current_version` — re-read and re-apply);
re-sending the same value is a `noop` (no new version, not an error); system keys
(`module.*`, `fp.code`, `fp.since`, `fp.removed`) answer 422 `read_only_field`;
`fp.<code>.*` for a code that is not in the spec answers 422 `feature_not_found`
(add the feature point to the spec first). Always pass `--source agent` so the
version record shows who wrote it.

### Requirement ownership

```bash
multica module requirement add <module> MUL-123
multica module requirement remove <module> MUL-123
```

This only moves `issue.module_id` (remove sets it to null; the requirement is not
deleted). It changes which module groups the requirement and therefore cross-module
locks — say what you are moving before you move it.

## Iterating a prototype (the full loop)

```bash
# 1. where are we?
multica module prototype list <module> --output json
multica module spec get <module> --output json

# 2. register the new screen (version defaults to highest + 1)
multica module prototype register <module> --html-path prototypes/module-v4.html \
  --prompt "加群设置面板" --status pending

# 3. make reconcile/coverage see the feature points
multica module prototype parse <module> 4

# 4. what changed?
multica module prototype diff <module> --from 3 --to 4

# 5a. approve in place (module-owned version only)
multica module prototype confirm <module> 4 --canonical

# 5b. or propose the two-phase upgrade when the spec changes with it
multica module plan create <module> --candidate-version 4 --decisions '{"browse.search":"keep"}'
multica module plan apply <module> <plan-id> --yes
```

- `register` stores `--html-path` as a **repository-relative** path when the file
  sits under a known root (`requirements/…` or `change_logs/…`), so other machines
  can resolve it too. `--issue MUL-123` claims the version into that requirement
  instead of the module (then it is requirement-owned and step 5a no longer
  applies).
- `parse` reads the HTML, extracts every `data-fp="<code>"` anchor (plus its
  `data-title`) and uploads the map. **Reconcile and coverage read that cache, not
  the file** — skip it and every feature point looks like an empty slot. Re-run it
  after any HTML edit.
- `confirm` marks a module-owned version `confirmed`; `--canonical` also moves the
  module's canonical pointer and supersedes the previous canonical version. Moving
  the canonical pointer is a product decision: do it when the person asked for
  "this is the version now", and say the version number you moved it to. When the
  spec changes too, prefer the plan path (5b) — it moves spec, projection and
  pointer in one transaction.
- `update` fixes a bad registration without creating a version:

  ```bash
  multica module prototype update <module> 4 --html-path prototypes/module-v4.html
  multica module prototype update <module> 4 --prompt "修正后的意图" --status pending
  ```

  The canonical version may not leave `confirmed`.
- `delete` removes a wrong version for good:

  ```bash
  multica module prototype delete <module> 4 --yes
  ```

  It needs `--yes` (MCP: `confirm=true`, refused otherwise). The canonical version
  and any version referenced by a release are refused server-side, and its
  parsed-anchor cache is dropped with it. Prefer `--status superseded` when you
  only want it out of the way.

## Version comparison summaries

Someone asks "这一版和上一版差在哪" — quote these, do not paraphrase the HTML.

```bash
multica module prototype diff <module>                     # canonical vs the one below
multica module prototype diff <module> --from 2 --to 4
multica module prototype diff <module> --from 2 --to 4 --output json
multica module brief versions <module>                     # the change log itself
multica module brief diff <module>                         # previous → current brief
multica module brief diff <module> --from 2 --to 5         # replay across several patches
```

`prototype diff` reads both files and reports three layers:

- **sections** — added / removed / reordered `h1–h3` headings, i.e. page structure
- **anchors** — added / removed / retitled `data-fp` codes, i.e. feature points
- **text** — `+N −M` visible lines with a collapsed `-`/`+` preview

Its one-line headline is the sentence to quote ("新增 2 个区块、删除 1 个区块；新增
3 个功能点锚点；正文 +18 −6 行"). `--max-lines 0` drops the preview; `--output json`
gives the same three layers as data.

`brief diff` replays the stored per-version change log and reports, per field, the
value at `--from` and at `--to` — so "说明改了哪些字段" is answered from rows the
right pane renders, not from memory. `brief versions` is the audit list behind the
版本记录 section: version, source, actor, field count, note, timestamp.

A summary that says "several things changed" is useless. Name the versions, the
sections, the anchor codes and the field keys.

## Releases

```bash
multica module release list <module>
multica module release publish <module> --note "v3 定稿"   # pairs current brief + canonical prototype
multica module release rollback <module> 2                 # re-point both pointers at release 2
```

A release is the only object that pins a brief version **and** a prototype version
together; both module pointers move to them. Publish and rollback are level B
(they need the person's agreement) and rollback also appends a brief version with
`source=rollback`, which is why the change log explains itself afterwards.

## Rules that save a lot of wandering

- `html_path` coming back from the API is **repository-relative** and has two
  shapes: `requirements/...` (relative to the archive root) and
  `change_logs/...` (relative to that root's parent directory). Joining it onto
  the working directory, or `find`/`ls`-ing around for it, is the single most
  common way a prototype read fails. Run `multica module prototype read`; it tries
  the archive root, the sibling `change_logs` root, and the workspace dir, then
  prints the absolute path.
- `prototype list` has an OWNER column: `module` rows are yours to edit,
  `requirement` rows belong to the requirement's own flow. The confirmed version
  is starred.
- Without `--version` the **confirmed** version wins, then the newest. A newer
  pending draft is not what "the module's prototype" means.
- Superseded versions often point at a file that no longer exists. `prototype
  list` reports `FILE=missing`; pick a version that says `ok`, and never diff a
  missing file — `prototype diff` tells you which side is gone instead of
  comparing nothing.
- The endpoints behind spec, brief, prototype versions, plans, releases,
  reconcile and coverage are gated by the `module_spec_center` server flag. When
  it is off the MCP tools are absent from `tools/list` and the CLI answers 404
  with a flag hint. `module list|get` and `prototype list|read` still work (they
  fall back to the requirement axis) — do not conclude that the module is missing.
- Coverage and reconcile are computed on the server from the same rows the TAB
  renders. Never recompute, estimate or "fix" the numbers in a message; quote
  `modules_coverage` / `modules_reconcile`.
- For the module list as a project tab (row counts, template visibility), use
  `multica project tab list <project>` / `multica project tab get <project>
  features`. Details in the `multica-project-tabs` skill.
- Reading is free; writing is not. Create, rename, bind, edit a spec or brief,
  register a version, parse, confirm, publish, roll back or delete only when the
  person asked for that exact change. Deletes and canonical/release moves are
  level B: state what will move, then use `--yes`.

## When the command fails

- `no module named ...`: the name is not in the targeted scope. Run
  `multica module list` (or `--project <id>`) and use the name or id it prints.
- `ambiguous module name`: the same name exists in several projects. Re-run with
  `--project`.
- `prototype file for module ... does not exist on this machine`: the stored path
  is stale (common for superseded versions). The message lists every root it
  tried; switch versions with `--version`, or report that the file is gone.
- `module prototype update|confirm|delete` → 409 with `prototype_owned_by_requirement`:
  that version came out of a requirement's stage. Use
  `multica requirement prototype …` (see `multica-requirements`) or register a
  module-owned version instead.
- 409 `canonical_prototype_in_use` / `prototype_in_release`: the version cannot be
  deleted. Supersede it, or roll the release back first.
- `spec_version_conflict` (HTTP 409): someone else published first. Re-read the
  spec, re-apply your change on top of it, publish again.
- 409 `base_stale` on `brief patch`: re-read `brief get`, use the
  `current_version` it now prints, re-send the same fields.
- 422 `feature_not_found` / `read_only_field`: the `fp.<code>` is not in the spec
  yet, or you tried to write a system key. Fix the key, do not retry.
- `plan_expired` / `plan_already_applied`: create a fresh plan instead of reusing
  the id.
- `module_spec_center is disabled`: the feature flag is off on this server. Report
  it; `module list|get` and `prototype list|read` still work.
- `invocation_revoked` or a shell allowlist error: the runtime blocked exec.
  Report that; do not retry with a different tool.
