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
| capability spec (`module_spec/v1`) | `module spec get` | `module spec draft` / `publish`, `module spec feature add` / `update` / `remove`, `module spec import` |
| capability brief (the right pane) | `module brief get` | `module brief patch` |
| prototype versions | `module prototype list` / `read` / `diff` | `module prototype register` / `update` / `confirm` / `delete` / `parse` |
| releases (brief × prototype) | `module release list` | `module release publish` / `rollback` |
| graph bridge (objects / strategies / neighbourhood) | `modules_graph_*` / `graph modules, objects, strategies, neighborhood, changes` | — (read only; see Boundaries) |

A prototype version has **two possible owners**, and the difference decides which
commands may touch it:

- **module-owned** (`issue_id` is null): registered straight onto the module, e.g.
  by a prototype builder or by `multica module prototype register`. This is the
  one `module prototype confirm|delete` and `--status` may change.
- **requirement-owned** (`issue_id` set): the output of a requirement's stage, so
  it follows the requirement's own approval gates. `module prototype list|read|diff`
  shows it (OWNER=requirement) and `module prototype update --html-path` still
  corrects its file (the command finds the owning requirement and patches that
  side); `--status` and `confirm|delete` answer 409 and point at
  `multica requirement prototype …`.

`multica module prototype list` merges both axes into one version timeline, so you
never have to reassemble the chain by hand, and a module with no requirements still
has a readable prototype. Do not rebuild that chain from `issue` / `requirement`
commands and do not open an `html_path` yourself.

## Two front doors, one backend

Every capability below exists twice and forwards to the same handlers, so
permissions, flag gating, change events and audit are identical:

- **MCP tools** `modules_*` (preferred when your tool list has them — structured
  args, no shell quoting).
- **CLI** `multica module …` (works for every agent; the runtime gives you a
  `MULTICA_TOKEN`, so the CLI authenticates by itself).

The platform mounts the facade for you: on every task claim it adds a server
named **`multica-modules`** (URL = the deployment's public base +
`/api/mcp/modules`, bearer = this task's own token) to the agent's `mcp_config`.
So `modules_*` is normally already in your tool list with nothing to bind and
no restart. Two things can still make it absent, and both are deployment
facts, not your problem to fix:

- `MULTICA_PUBLIC_URL` is unset (nothing to point the entry at), or an operator
  set `MULTICA_MODULE_MCP_AUTOINJECT=off`.
- The agent declares its own server under that name — its entry wins.

When the tools are missing, **use the CLI; nothing is lost** — every tool below
has a CLI twin. Never conclude the module is broken because the tool list is
short.

| MCP tool | CLI equivalent |
| --- | --- |
| `modules_list` / `modules_get` | `multica module list` / `get` |
| `modules_create` / `modules_update` / `modules_delete` | `multica module create` / `update` / `delete` |
| `modules_requirements` | `multica module get <module>` (its `issues[]`) |
| `modules_requirements_attach` / `_detach` | `multica module requirement add` / `remove` |
| `modules_spec_get` / `modules_spec_draft` / `modules_spec_publish` | `multica module spec get` / `draft` / `publish` |
| `modules_spec_feature_add` / `_update` / `_remove` | `multica module spec feature add` / `update` / `remove` |
| `modules_spec_import` | `multica module spec import` |
| `modules_workspace_get` | `multica module brief get` |
| `modules_brief_patch` | `multica module brief patch` |
| `modules_prototype_versions` | `multica module prototype list` |
| `modules_prototype_register` / `_update` / `_confirm` / `_delete` | `multica module prototype register` / `update` / `confirm` / `delete` |
| `modules_prototype_parse` | `multica module prototype parse` |
| `modules_prototype_plan_create` / `_get` / `_apply` | `multica module plan create` / `get` / `apply` |
| `modules_releases_list` / `modules_release_publish` / `modules_release_rollback` | `multica module release list` / `publish` / `rollback` |
| `modules_reconcile` / `modules_coverage` | `multica module reconcile` / `coverage` |
| `modules_graph_bridges` | `multica graph modules` |
| `modules_graph_objects` / `_strategies` / `_changes` | `multica graph objects` / `strategies` / `changes` |
| `modules_graph_neighborhood` | `multica graph neighborhood --depth <1..3>` |

**CLI only** (they need the stored HTML files, which the server does not keep):
`module prototype diff`, `module prototype read`. `brief versions` and `brief diff`
are covered by `modules_workspace_get` — its `versions[]` is the same change log.

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
multica graph modules <project>                            # module ↔ graph node bridge + counts
multica graph objects <project> <graph-node-id>            # objects inside one bridged module
multica graph strategies <project> <graph-node-id>         # strategies projected from its objects
multica graph neighborhood <project> <graph-node-id>       # ego network (nodes + edges)
multica graph changes <project> <graph-node-id>            # issues filed under that module
```

`<module>` accepts the module UUID, a UUID prefix, or its name. When a name could
exist in more than one project, add `--project <project-id>`; when you need a
copyable id, add `--full-id` to any list.

`multica module brief get` is the whole right pane in one call: the current
`brief` values, the `field_defs` (labels, kinds, scope), the `features[]`
from the spec, the `versions[]` change log and the `releases[]`.

## Every control in the TAB, and what to run instead

The TAB is one screen with a toolbar, a module rail, a prototype pane and a
three-section right pane. This is the complete inventory — if a person asks for
one of these, run the command; if it is marked **view only**, say so instead of
inventing a command.

### Toolbar (above the module list)

| Control | What it does | What you run |
| --- | --- | --- |
| 列表 / 图谱 / 表格 (three views) | same server data, three renderings | nothing — `module list --output json` is the data all three share |
| 搜索 module name | client-side substring filter | `module list --output json`, then filter `name` yourself |
| 业务类型 (biz_kind) filter | client-side filter on the same rows | same JSON; rows carry `biz_kind` |
| 仅看未绑定 graph node | client-side filter | same JSON; keep rows whose `graph_node_id` is null |
| 新建模块 | creates a module | `module create <project> --name "…" --color "#4F46E5" --graph-node <node>` |
| 重新扫描 (rebridge) | rewires **every** module ↔ object mapping at once | **not exposed, and not yours to trigger.** Say it needs a person. |
| 导出报告 | front-end Blob download | build the file yourself from `module list` + `coverage` + `reconcile --output json` |

### Left rail (one card per module)

| Control | What it does | What you run |
| --- | --- | --- |
| select a module | loads the right pane | `module get` / `brief get` |
| rename | `project_module.name` | `module update <module> --name "新名字"` |
| recolor | display color | `module update <module> --color "#0EA5E9"` |
| bind / unbind a graph node | `graph_node_id` | `module update <module> --graph-node <node-id>` / `--graph-node ""` |
| delete | removes the module; requirements survive as module-less | `module delete <module> --yes` |
| counts (对象 / 策略 / 需求 / 社区 / 任务进度 / 健康) | read-only rollups | 对象 / 策略: `modules_graph_bridges` or `graph modules`; requirements: `module get` (`issues[]`); 社区 / 任务进度 come from graph + issue rows — quote `graph modules` and `coverage`, never recompute them from module rows by hand |

### 原型 sub-TAB

| Control | What it does | What you run |
| --- | --- | --- |
| version timeline + pick one | one row per prototype version, both owners | `module prototype list <module>` |
| single-version preview | renders the stored HTML | `module prototype read <module> --version <n> --raw` (or just the path) |
| side-by-side compare | two versions in two panes | data half: `module prototype diff <module> --from <a> --to <b>`; the visual panes are **view only** |
| 新建原型 (upload) | uploads an HTML file into the archive, then registers it | **upload path is view/UI only** (it needs a chat task id). Write the HTML into the archive directory, then `module prototype register <module> --html-path <file>` |
| 生成原型 (sparkle) | opens a chat session that builds a new prototype | **you are that builder.** Produce the HTML, then register it; there is no command that "generates" one |
| 关联 | registers an existing HTML as a **requirement**'s prototype and binds the archive row | `requirement prototype register <issue> --html-path <file>` then `artifact bind <project> <artifact-id> --issue <issue>` |
| 更新文件 | corrects `html_path` / note of the selected version | `module prototype update <module> <version> --html-path <file>` (works on both owners; `--status` only module-owned) |
| 写变更摘要到需求 | posts the diff summary as a requirement comment | `module prototype diff …` then `issue comment add <issue-id> --content "…"` |
| Storybook preview | story/community renderer | **view only** |
| 一键登记预览为模块原型 | copies the previewed version into a confirmed, canonical module-owned version | `module prototype register <module> --html-path <the same file> --status confirmed --set-canonical` |

### Right pane · 模块说明 / 功能点 / 版本记录

| Control | What it does | What you run |
| --- | --- | --- |
| edit a 说明 field | one `brief.*` field, versioned | `module brief patch <module> --base-version <v> --field 'brief.goal=…'` |
| 从原型导入 | turns the prototype's anchors (or headings) into feature points | `module spec import <module> --dry-run`, then without `--dry-run` |
| add / edit / delete one feature point | one row of `spec.features[]` | `module spec feature add` / `update` / `remove` |
| the four sections per feature point | `fp.<code>.desc`, `.loc`, `.req`, `.interaction`, `.deps`, `.acceptance` | `module brief patch … --field 'fp.FP-01.req=…'` |
| 版本记录 | append-only brief versions | `module brief versions` / `brief diff` |
| 成对发布 | pins brief version × prototype version | `module release publish <module> --yes` |
| 回滚 | re-points both pointers at an old release | `module release rollback <module> <version> --yes` |
| requirement / task binding block | which requirements this module owns, and on which feature point | `module get` (`issues[]`), `module requirement add` / `remove` |

### 变更概览 / 验收与覆盖

`变更概览` is the diff between the two chosen prototype versions plus the brief
change log; `验收与覆盖` is the reconcile matrix and its KPI badge. Both are
computed on the server from the same rows — quote them, never estimate:

```bash
multica module prototype diff <module> --from 2 --to 4      # 变更概览
multica module brief versions <module>                       # 谁改了哪些字段
multica graph changes <project> <graph-node-id>              # 挂在该模块下的工作项（最新 50）
multica module reconcile <module> --output json              # 四态矩阵（对的/缺的/多的/没标）
multica module coverage <module> --output json               # 验收与覆盖的徽章数字
```

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
The MCP tools `modules_spec_feature_add|update|remove` do exactly the same
read-modify-write, so an MCP-only runtime is never forced into the dangerous
whole-spec write.

Every one publishes by default (`spec_version` +1, projection rebuilt, change
event recorded). `--draft` stores without bumping the version; `--expected-version
<n>` turns the write into a compare-and-swap (409 `spec_version_conflict` when
someone else published first — re-read, merge, retry).

Removing a feature point does **not** delete its `fp.<code>.*` brief rows; they
stay in the version history and simply stop rendering. Renaming a code shows up
as "removed + added" in the reconcile matrix, so only use `--code-new` when you
also change the anchor in the prototype HTML.

### Import from the prototype (从原型导入)

The right pane's 从原型导入 button has a CLI twin. It merges what the page really
draws into the published spec, so you never hand-build the first `features[]` of
an empty module:

```bash
multica module spec import <module> --dry-run          # print the candidate list, write nothing
multica module spec import <module>                    # publish, then upload the anchor cache
multica module spec import <module> --version 3        # read a specific prototype version
multica module spec import <module> --html-path drafts/v5.html --no-brief
```

The MCP twin `modules_spec_import` runs the exact same parse and merge (one shared
implementation) but takes the HTML **inline** in `html` — the server cannot read your
disk. `dry_run`, `draft`, `fill_brief`, `prototype_version` mirror the flags below.

- **Source of truth**: `data-fp="FP-05" data-title="群设置"` becomes feature point
  `FP-05 / 群设置`, verbatim — `reconcile` matches `code` against the anchor cache.
  A `data-fp` without a `data-title` is titled with its own code.
- **Fallback**: when the page has no anchor at all, `h2` becomes a group and each
  `h3` becomes a feature point (`FP-nn`, continuing from the highest existing
  number). `h1` is the page title and is ignored.
- **Idempotent**: codes already in the spec and titles already present are
  skipped and reported under `skipped`, so running it twice imports nothing new.
- **It fills, it does not overwrite**: `brief.scope` is filled from the `h2`
  sections and `brief.flow` from the nav order — only when those fields are still
  empty. `--no-brief` skips this entirely.
- **It uploads the anchor cache** (same as `prototype parse`) unless `--no-anchors`
  is passed; without that cache reconcile/coverage treat every feature point as a
  missing slot.
- Scripts, styles and comments are stripped before parsing, so `data-fp="' + code + '"`
  inside a template string is never mistaken for an anchor.

Always run `--dry-run` first when the module already has feature points, and quote
the `added` / `skipped` lists to the person.

### Brief fields (the right pane's prose)

```bash
multica module brief get <module> --output json                     # note brief_version
multica module brief patch <module> --base-version 3 \
  --field 'brief.goal=把下单链路收敛成一步' \
  --field 'fp.FP-01.interaction=点选后右侧抽屉展开' \
  --note "补全目标与交互" --source agent
multica module brief patch <module> --base-version 3 --fields '{"brief.scope":"..."}'
```

`field_defs` in `brief get` lists every key the UI knows about:

- module scope: `brief.position` `brief.goal` `brief.scope` `brief.non_goal`
  `brief.roles` `brief.flow` `brief.acceptance_goal`
- per feature point: `fp.<code>.desc` `fp.<code>.loc` `fp.<code>.req`
  `fp.<code>.interaction` `fp.<code>.deps` `fp.<code>.acceptance`

`field_defs` is **not a whitelist**. A `brief.*` key that is not listed yet is
accepted and registered into `module_field_def` on the fly (that is how a team
adds a module-level field); it then appears in `field_defs` for everyone. Prefer
the documented keys unless the person explicitly asks for a new one.

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
multica module requirement add <module> MUL-123 --feature FP-03
multica module requirement remove <module> MUL-123
```

This only moves `issue.module_id` (remove sets it to null; the requirement is not
deleted). It changes which module groups the requirement and therefore cross-module
locks — say what you are moving before you move it.

`--feature` additionally binds the issue to ONE feature point of that module
(`issue.feature_code`). That is the bottom of the ownership chain
project → module → prototype → feature point, and the granularity fine-grained
iteration works at: one issue = one feature point. The server refuses a code that
is not in this module's feature list (404) and a feature point on an issue with no
module (409). Changing or clearing the module clears the feature point
automatically — codes are only unique inside their module, so nothing carries over.
When a work item genuinely spans several feature points, split it into one issue
per feature point instead of trying to bind many.

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
#    or, when the spec is still empty: multica module spec import <module>

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

  `--html-path` / `--prompt` work on requirement-owned versions too (the command
  locates the owning requirement and patches that side). `--status` is a
  module-owned knob: on a requirement version the server owns the state machine.
  The canonical version may not leave `confirmed`.
- `delete` removes a wrong version for good:

  ```bash
  multica module prototype delete <module> 4 --yes
  ```

  It needs `--yes` (MCP: `confirm=true`, refused otherwise). The canonical version,
  any version referenced by a release, and requirement-owned versions are refused
  server-side; the parsed-anchor cache is dropped with it. Prefer `--status
  superseded` when you only want it out of the way.

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

`prototype diff` reports three layers (sections / anchors / text) and `brief diff`
replays the stored field-level change log. What each layer means and the phrasing
a summary must use is in `rules/version-diffs.md` — read it before answering.
Never say "several things changed": name the versions, the sections, the anchor
codes and the field keys.

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

## Boundaries: what the TAB can do and you cannot

Say these out loud instead of improvising:

- **重新扫描 (rebridge)** rewires every module ↔ object mapping for the whole
  project in one call. No CLI/MCP command exists and you should not look for a
  workaround (issuing several `module update --graph-node` calls is not the same
  thing and will drift). The read side is different: `modules_graph_objects` /
  `_strategies` / `_neighborhood` / `_changes` (or `multica graph …`) is the
  supported way to see what a bridged module holds, and it answers 404 for a
  module with no `graph_node_id`.
- **Storybook**, the three view modes and their filters, and **导出报告** are
  renderings/downloads of data you can already read. Do the data work; do not
  pretend the pixels moved.
- **Upload-created prototypes** (新建原型) need a chat task id for the attachment
  upload. Writing the HTML into the archive directory and calling `prototype
  register` produces the same stored version; the person can upload if they insist
  on the upload row.
- **生成原型** is a chat session that asks an agent to produce HTML. You are the
  agent: build the file, register it, parse it.
- **发布 / 回滚 / plan apply / 删除 / 移动 canonical** are level B. State exactly
  what will move, then use `--yes` (MCP: `confirm=true`).

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
- **Two version counters** exist and they are not the same number: `spec_version`
  (bumped by every spec publish, shown on the feature list) and `brief_version`
  (bumped by every brief patch, shown in 版本记录). Deleting a feature point moves
  the first and not the second — that is expected, not a bug.
- The endpoints behind spec, brief, prototype versions, plans, releases,
  reconcile and coverage are gated by the `module_spec_center` server flag. When
  it is off the MCP tools are absent from `tools/list` and the CLI answers 404
  with a flag hint. `module list|get` and `prototype list|read` still work (they
  fall back to the requirement axis) — do not conclude that the module is missing.
- Coverage and reconcile are computed on the server from the same rows the TAB
  renders. Never recompute, estimate or "fix" the numbers in a message; quote
  `modules_coverage` / `modules_reconcile`.
- The 对象 / 策略 / 社区 numbers in the module rail come from the graph bridge,
  not from the module row. Read `modules_graph_bridges` (or `graph modules`) —
  a module with no `graph_node_id` is simply unbridged and has none of them; it
  is not an error and its prototype/spec still work.
- For the module list as a project tab (row counts, template visibility), use
  `multica project tab list <project>` / `multica project tab get <project>
  features`. Details in the `multica-project-tabs` skill.
- Reading is free; writing is not. Create, rename, bind, edit a spec or brief,
  register a version, import, parse, confirm, publish, roll back or delete only
  when the person asked for that exact change. Deletes and canonical/release
  moves are level B: state what will move, then use `--yes`.

## When the command fails

- `no module named ...`: the name is not in the targeted scope. Run
  `multica module list` (or `--project <id>`) and use the name or id it prints.
- `ambiguous module name`: the same name exists in several projects. Re-run with
  `--project`.
- `prototype file for module ... does not exist on this machine`: the stored path
  is stale (common for superseded versions). The message lists every root it
  tried; switch versions with `--version`, or report that the file is gone.
- `no data-fp anchor and no h2/h3 heading found`: `spec import` had nothing to
  import. Add `data-fp="FP-01"` (or an `h2`/`h3` structure) to the HTML and
  re-run; do not fall back to hand-writing the spec for a page with no structure.
- `module prototype confirm|delete` → 409 `prototype_owned_by_requirement`: that
  version came out of a requirement's stage. Use `multica requirement prototype …`
  (see `multica-requirements`) or register a module-owned version instead.
  `prototype update --html-path` is the one exception and works on both owners.
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
