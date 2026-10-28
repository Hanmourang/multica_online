---
name: multica-assets
description: "Use when asked what a project owns or consumes (repos, packages, knowledge docs), which lifecycle stage S1-S5 an asset is in, or which requirement it serves. Asset bindings are not archive rows; sync bridges the two."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Assets and their stages

An **asset binding** is one row: an asset (`asset_category` + `asset_name`)
attached either to a project (`issue_id` empty) or to one work item
(`issue_id` set), plus `lifecycle_stage`, `asset_role`, `tags` and `links` to
requirements/tasks. The asset file itself lives elsewhere — a repo, a package,
a knowledge base, or a path inside the project's archive.

An asset binding is **not** an archive row. An archive row (`multica artifact`)
is a document; `asset sync` creates bindings *from* archive documents, which is
why the same doc can appear in both tabs.

## Reading

```bash
multica asset list --project <p> --limit 200          # every binding of one project
multica asset list --project <p> --scope project      # project-level only
multica asset list --project <p> --scope issue --issue <id>
multica asset list --category knowledge_repo --name spec
multica asset matrix --project <p>                    # stage × role matrix + linkable issues
```

- `--scope all` (default) spans every project in the workspace; pass
  `--project` for one project. `--issue` implies `--scope issue`.
- Envelope: `items[]`, `page`, `pageSize`, `totalCount`, `totalPages`. The
  server pages with `toPage`/`pageSize`; `--limit` is the page size and caps at
  **200**. `totalCount` is the count over all matches — never conclude "the
  project has 3 assets" from one page whose `totalCount` is larger.
- `matrix` calls a different, unpaged endpoint (up to 1000 bindings) and returns
  `bindings[]` plus `issues[]` (candidate work items, each with
  `is_requirement`). Use it when the question is about stages, roles or "which
  requirement does this asset serve" — not the paged list.

Enums: `asset_category` = `code_repository` | `application` | `package` |
`knowledge_repo` | `knowledge_group` | `other`; `lifecycle_stage` = `S1`..`S5`
| `general`; `asset_role` = `input` | `output`; link types = `depends_on` |
`produces` | `resolves`.

## Writing

```bash
multica asset bind <project> --name <n> --category <c> \
  [--stage S1..S5|general] [--role input|output] [--subtype <t>] \
  [--tags a,b] [--ref '{"path":"docs/x.md"}'] [--resource <resource-id>] \
  [--issue <id>] [--source manual] [--links <issue>:produces,<issue>:depends_on]

multica asset meta <binding-id> --project <p> \
  [--stage S1..S5|general|""] [--role input|output|""] [--category <c>] \
  [--tags a,b] [--links <issue>:produces]
```

- `bind` without `--issue` creates a project-level binding; with `--issue`, a
  work-item binding.
- `meta` **replaces** the sets it touches: `--tags` overwrites all tags,
  `--links` overwrites all links. Read the current row first (the `matrix`
  output already carries `tags` and `links`) and re-send what must survive.
- Passing an empty string to `--stage` / `--role` clears it back to unclassified.
  Use it deliberately, not to "reset" a row you do not understand.
- `--resource` must be an id from `multica project resource list <p>`; a made-up
  id fails.

Two commands are gated because they destroy or bulk-write:

```bash
multica asset unbind <binding-id> --project <p> --yes   # binding only; the asset row/file stays
multica asset sync <project> [--category knowledge_repo] --yes   # import unbound archive docs
```

`unbind` removes the binding, so the asset leaves the project's asset tab and
any stage matrix; it does not delete the repo, package or document. `sync`
walks the archive and creates a binding for each unbound document (default
category `knowledge_repo`). Both are **level B** in `multica-module-map`: say
what changes, get the person's agreement, then run with `--yes` in a second call.

## Stage alignment with the archive

Linked rows share one stage model. When an archive row is tied to an asset
binding, the server keeps `stage`/`doc_type` consistent in both directions: a
`meta --stage` write can move the archive row, and an archive patch can move the
binding. Do not try to force the two sides apart; if they disagree, re-read both
(`asset matrix`, `artifact list`) before writing.

## Rules

- One asset, one binding per scope. Binding the same repo twice at project scope
  creates two rows the person cannot tell apart — search first.
- Everything is workspace-scoped. A project resolved from another workspace
  produces a 404, not an empty list.
- Removing an asset the person did not name is a mistake even when it looks
  redundant. Ask, then run.
- Do not fall back to raw `/api/assets/*` calls when a command is missing a
  filter; report the gap instead.
