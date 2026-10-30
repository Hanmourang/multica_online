# Editing content: spec, features, brief, requirements

Supporting file for `multica-feature-modules`. Load it before the first write of a
session: feature points, import-from-prototype, brief fields, requirement ownership.
Every command here is a read-modify-write that touches only what you name.

## One feature point at a time

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

## Import from the prototype (从原型导入)

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

## Brief fields (the right pane's prose)

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

## Requirement ownership

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
