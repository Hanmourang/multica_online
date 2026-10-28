---
name: multica-feature-modules
description: "Use when a person asks about a project's feature modules (功能模块) or wants a module's prototype screen. Lists modules, their requirements and prototype versions, and resolves a prototype to an absolute file path. Never assemble html_path by hand."
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

## Commands

```bash
multica module list --project <project-id> --output json   # modules of one project
multica module list --output json                          # every module in the workspace
multica module get <module> --output json                  # module + requirements + versions
multica module create <project> --name <n> [--color <hex>] [--graph-node <node-id>]
multica module update <module> [--name <n>] [--color <hex>] [--graph-node <id>|""]
multica module delete <module> --yes
multica module prototype list <module> --output json       # versions, FILE=ok|missing|no-path
multica module prototype read <module>                     # absolute path of the live version
multica module prototype read <module> --version 2         # one specific version
multica module prototype read <module> --raw               # print the HTML itself
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
  before running it with `--yes`.
- When someone says "this module is wrong", renaming and rebinding is usually
  the answer — deleting loses the grouping for every requirement inside it.

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
- Do not probe `/api/.../modules/{id}/prototype-versions` by hand. That surface
  sits behind the `module_spec_center` server flag and 404s while it is off —
  the CLI chain above works either way.
- For the module list as a project tab (row counts, template visibility), use
  `multica project tab list <project>` / `multica project tab get <project>
  features`. Details in the `multica-project-tabs` skill.
- Modules are read-only from chat unless the person explicitly asks to create,
  rename, bind, or delete one; those are project settings, not conversation
  actions, and a delete is level B (ask, then `--yes`).

## When the command fails

- `no module named ...`: the name is not in the targeted scope. Run
  `multica module list` (or `--project <id>`) and use the name or id it prints.
- `ambiguous module name`: the same name exists in several projects. Re-run with
  `--project`.
- `prototype file for module ... does not exist on this machine`: the stored
  path is stale (common for superseded versions). The message lists every root
  it tried; switch versions with `--version`, or report that the file is gone.
- `invocation_revoked` or a shell allowlist error: the runtime blocked exec.
  Report that; do not retry with a different tool.
