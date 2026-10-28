---
name: multica-data-model
description: "Use when asked about a project's 数据模型: the module list, one module's objects, issues, strategies or code neighborhood, the business-unit matrix, drilldown and alerts. Read-only."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Data model (graph) — read-only on purpose

The data model is a **snapshot** produced by scanning the project's codebase,
not a live table. A daemon run writes one snapshot; every command here reads the
latest one. Nothing in this skill changes data.

Two consequences worth stating to a person:

- If the graph looks outdated, the fix is a rescan, not an edit. There is no CLI
  to write the graph, and the rebridge endpoint rewires every module ↔ object
  mapping at once — agents must not call it.
- Node ids are stable only within a snapshot. Cite them with the snapshot's
  `scan_id` / `git_sha`, and re-read `latest` before reusing an id from an older
  answer.

## Reading

```bash
multica graph latest <project>                        # snapshot summary
multica graph detail <project>                        # full snapshot: nodes/edges/communities
multica graph modules <project>                       # feature modules + graph bridge (table)
multica graph objects <project> <graph-node-id>        # objects inside one module
multica graph changes <project> <graph-node-id>        # issues filed under that module
multica graph strategies <project> <graph-node-id>     # strategy projection of the module
multica graph neighborhood <project> <graph-node-id> [--depth 1..3]
multica graph matrix <project>                        # business-unit matrix
multica graph drilldown <project> [--module-node <id>] [--page <key>] [--process <key>] [--domain <d>]
multica graph timeline <project> [--limit 20]         # ontology changelog of the snapshot
multica graph alerts <project>                        # matrix anomalies
```

- `latest` is the orientation call: `id`, `scan_id`, `git_sha`,
  `gitnexus_version`, `stats`, `module_summary[]`, `bus_matrix[]`,
  `data_model{}`, `created_at`. Read it first so a later empty answer is
  recognised as "no snapshot" rather than "empty project".
- `detail` returns the whole node/edge/community payload — large. Use it only
  when you need edges or a node's properties; otherwise stay on `modules` +
  `objects` + `neighborhood`.
- `modules` prints a table (`ID`, `MODULE`, `GRAPH NODE`, `ISSUES`); add
  `--output json` for the raw fields. See the next section before using it.
- Everything per-module is JSON. `objects` answers
  `module_id, node_id, name, obj_count, tables_touched, objects[]`;
  `strategies` adds `ontology_ready` (`empty` | `ready`) and `strategies[]`;
  `neighborhood` adds `center_node`, `neighbor_nodes`, `edges`, `depth`,
  `node_count`, `edge_count`.
- `matrix` rows carry `module_name`, `module_node_id`, `page_name`, `page_key`,
  `process_name`, `process_key`, `domain`, `table_count`, `read_count`,
  `write_count`, and the flags `is_new_table` / `is_cross_domain_write`.
  `alerts` reports `alerts[]` (severity, type, module/page/domain, write count,
  description) plus `rule_coverage[]` — a rule that was not evaluated says so
  instead of reporting "clean".
- `drilldown` rolls the matched cells up into `tables[]` with columns. When the
  snapshot carried no table detail it sets `detail_available: false` (and
  `columns_available: false`): report the aggregate numbers as the answer, do
  not invent a schema.

## `graph modules` is the bridge table, not the scanner output

`graph modules` lists **feature modules** (`project_module` rows) with their
bridge state — `id`, `name`, `color`, `graph_node_id`, `issue_count`. It is not
the set of communities the scanner found, and it carries no object/change
counts.

- `graph_node_id` is the key every per-module command takes. A module whose
  column is empty is **not bridged**: the per-module endpoints answer
  `404 no module is bridged to this graph node`.
- To repair that, bind it — `multica module update <module> --graph-node <id>`
  (`""` unbinds). Read the graph first and state which node you are binding.
- To find the node id for an unbridged module by hand, use `graph detail` and
  the community list; do not guess an id from a module name.

## What the three per-module answers are

- `objects` — the ontology objects under the node (entity type, qualified name,
  domain, lifecycle, impl status). Empty `objects[]` means ontology extraction
  has not run for this snapshot; `obj_count` / `tables_touched` may still be
  filled from the snapshot's `module_summary`.
- `changes` — the **issues** filed under that module, newest 50 by `updated_at`
  (`id`, `title`, `status`, `updated_at`). It is not a code diff and not a
  snapshot-to-snapshot delta. For code-level movement compare two snapshots'
  `git_sha`.
- `strategies` — key/value pairs flattened from the objects' properties, with
  `source: ontology` and the object's impl status. `ontology_ready: empty` means
  there is nothing to project yet, not "the module has no strategy".

## Recording it next to the TAB

`multica project tab get <p> data-model` returns `graph_modules` and
`bus_matrix` in one payload — use it when the person wants the TAB, and this
skill's commands when they want one module in depth, the drilldown or alerts.

## Rules

- Read-only. There is no `graph create|update|delete`, and no supported way to
  write objects, changes or strategies from the CLI.
- Never call the rebridge / resync endpoints directly. If a rescan is needed,
  say so and let the person start it in the UI or via the daemon.
- An empty `objects` list is the normal pre-extraction state. Compare with
  `latest` (`data_model`) before concluding the module is empty.
- Do not derive asset or archive state from the graph: assets are bindings
  (`multica asset`), documents are archive rows (`multica artifact`). The graph
  only describes code structure.
