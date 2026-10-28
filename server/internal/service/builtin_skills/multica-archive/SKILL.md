---
name: multica-archive
description: "Use when asked to add, reclassify, bind, or look up a project archive document or a requirement's deliverables. Rows carry scope shared/project/requirement and stage 1-5; the body usually lives on disk at rel_path."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Archive documents and deliverables

One `project_artifact` row = one document in the project archive:

- `scope` = `shared` | `project` | `requirement`
- `stage` = `1`..`5` (unclassified when unset)
- `doc_type` / `doc_class` / `doc_module` — what kind of document it is
- `rel_path` — where the file lives inside the archive repo
- `issue_id` — set once the row is bound to a requirement/task

**A deliverable is not a second table.** It is an archive row that carries an
`issue_id`, so "what did this requirement deliver" is the same data read with
`--scope requirement` / the deliverables rollup.

## Reading

```bash
multica artifact list <project> --limit 200
multica artifact list <project> --scope requirement --stage 2 --doc-type design
multica artifact list <project> --q specs/            # path substring
multica artifact get <project> <artifact-id>          # the row
multica artifact get <project> <artifact-id> --content  # the content pointer
multica artifact matrix <project>                     # stage × doc_type coverage
multica artifact unbound <project>                    # rows no issue claims yet
```

- The list endpoint has **no server paging**: it returns every match and
  `--limit` only truncates what is printed. `total` in the payload is the real
  count — filter (`--stage`, `--doc-type`, `--doc-class`, `--q`) instead of
  raising the limit and squinting.
- `--content` does **not** return the document. The server holds no rendered
  copy: you get `content_unavailable`, `rel_path` and, when present,
  `attachment_url`. Read the file from disk with the file tools. Do not retry
  the endpoint hoping for text, and do not report the document as missing.
- `matrix` is the coverage view: which stages/doc types have rows and which are
  empty. Use it before a filing or acceptance question.
- `unbound` returns a bare array (`artifacts[]` in the JSON output). If it is
  non-empty and the person expects deliverables, the rows exist but no issue
  claims them — offer `artifact bind`.

## Writing

```bash
multica artifact create <project> --scope requirement --doc-type design \
  --rel-path specs/design.md [--stage 2] [--issue <id>] [--requirement-key <k>] \
  [--doc-class <c>] [--doc-module <m>] [--content "<markdown>"] [--attachment <attachment-id>] [--version 1]

multica artifact update <project> <artifact-id> \
  [--scope|--stage|--doc-type|--rel-path|--requirement-key|--doc-class|--doc-module|--content|--issue]

multica artifact bind <project> <artifact-id> --issue <issue-id>
```

- `create` writes a `source=manual` row: it survives later archive syncs, which
  soft-delete rows missing from the synced manifest. Use it for documents the
  person authored in Multica, not to fake a file that should be on disk.
- `rel_path` is a path **inside the archive repo**; it is not created for you.
  If the file does not exist there, the row points at nothing.
- `update --issue ""` unbinds. `update` requires at least one flag.
- `bind` is the normal way to turn a shared/project row into a deliverable.
- `--scope`, `--stage` values are validated locally before the call: scope
  `shared|project|requirement`, stage `1..5`.

Gated (**level B**: say what changes, get agreement, then run with `--yes`):

```bash
multica artifact unbind <project> <artifact-id> --yes   # clears issue_id; row and file stay
multica artifact delete <project> <artifact-id> --yes   # row gone; the file on disk is NOT deleted
```

- `delete` refuses with `409 asset_linked` when the row is tied to an asset
  binding, because deleting one side leaves the other dangling. Those rows go
  through `multica asset unbind` (see `multica-assets`), which also removes the
  archive row on the server side.
- Deleting a row never deletes a file. If the person wants the document gone
  from disk, that is a separate, explicit file operation.

## Interaction with assets and filing

- Rows linked to an asset binding share the stage model: the server keeps
  `stage`/`doc_type` consistent in both directions. If `asset matrix` and
  `artifact list` disagree, re-read both before writing anything.
- Filing items bind to archive rows by id (`artifact_id`); the filing skill
  covers that. Do not create a duplicate row to satisfy a filing item.

## Failure modes

- `scope must be shared/project/requirement`: your `--scope` is wrong; there is
  no `task` or `module` scope.
- `stage must be within 1..5`: `--stage 0` is not "unclassified", it is invalid.
  Omit the flag instead.
- `resolve project: ...`: wrong workspace. Run `multica project list`.
- `asset_linked`: delete through the asset side, not here.
