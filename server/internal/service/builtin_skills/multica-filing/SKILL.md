---
name: multica-filing
description: "Use when asked whether a project's 软著 or patent filing is ready, which materials are missing, or how to correct one filing item. Covers readiness, items, manual override, rule check, export and writeback."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Filing readiness (软著 / 专利)

Filing is a checklist per project: two tracks (`software_copyright`, `patent`)
and three tiers per track:

- `must` — without it the package cannot be submitted
- `conditional` — required only in some situations
- `aux` — supporting material, never blocking

Each item has a status (`missing` | `partial` | `ready`), an optional bound
`artifact_id`, and a rule that produced the status. Items are seeded from the
project template on first read, so an empty list is unusual — read readiness
first, it seeds and aggregates.

## Reading

```bash
multica filing readiness <project> [--track software_copyright|patent] [--tier must]
multica filing items <project> [--track <t>] [--tier <tt>] [--limit 100]
multica filing cross-project <project>
```

- `readiness` answers "can we submit": top-level `can_export_filing`,
  `blocking_count`, and per-track `tracks[]` with must totals/readies and
  `blocking_items[]` sorted by priority (`P0` first).
- `items` is the line-by-line view: `id`, `track`, `tier`, `title`, `status`,
  `artifact_id`. `--limit` only truncates printing; `total` is the real count.
- `cross-project` lists material reused from other projects. Reuse satisfies an
  item only when the rule says so — it is evidence, not a bypass.
- `can_export_filing: false` means at least one `must` item is not `ready`.
  Quote `blocking_items[]` rather than summarising "a few things missing".

## Correcting one item

```bash
multica filing patch <project> <item-id> --reason "why" \
  [--status missing|partial|ready] [--artifact <artifact-id> | --artifact ""]
```

- `--reason` is **required** by the server (stored as `override_reason`). It is
  the audit trail for disagreeing with the rule engine, so write the actual
  reason ("PNG screenshots are accepted by the IP office; the rule only looks
  for PDF"), not "manual fix".
- `--status` sets the item's status directly; `--artifact` binds a document
  (`""` unbinds). Pass at least one of them.
- Use this only when the rule engine is wrong. If an item is missing because the
  document does not exist, create/bind the archive row (`multica artifact`)
  instead of marking it ready — an override hides a real gap.

## Running the pipeline

```bash
multica filing check <project>      # re-run the rule engine, persist statuses
multica filing export <project>     # build the export package
multica filing writeback <project> --yes
```

- `check` is idempotent by design; run it after binding or creating documents,
  then read `readiness` again. Do not run it in a loop.
- `export` produces the package the person submits. It is meaningful only when
  `can_export_filing` is true; a blocking item still blocks it.
- `writeback` writes the readiness summary back into the archive as a document,
  rewriting rows in bulk. It is **level B** in `multica-module-map`: state the
  effect, get agreement, then run with `--yes`. It does not commit to git, so do
  not promise a commit sha.

## Rules

- The two tracks are independent: a ready 软著 package says nothing about the
  patent package. Always name the track in the answer.
- `must` before `conditional` before `aux`. Reporting aux gaps as blockers is a
  common false alarm.
- Never mark `must` items ready to make `can_export_filing` turn true. Overrides
  are for wrong rules, not for missing documents.
- Filing depends on archive rows existing at the right stage/doc type; if many
  items are missing at once, check `multica artifact matrix <project>` before
  patching item by item.
