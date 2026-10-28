---
name: multica-project-tabs
description: "Use when a person asks what is in a project, or about one of its detail tabs — archive, assets, data model, requirements, tasks, acceptance, deliverables, workflows, sprints, filing. Maps each tab to the command that reads it, with response shapes and paging rules."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Project detail tabs

A project's detail page is a fixed set of tabs, and **each tab is a different
resource underneath the project**. "Read the assets tab" and "read the tasks
tab" hit different endpoints with different shapes; guessing which command
serves which tab — and then guessing at the JSON — is where the wasted steps
happen.

Start every project-scoped question with the map:

```bash
multica project tab list <project>                 # tabs + row counts, one call
multica project tab get <project> <tab>            # that tab's data as JSON
```

`tab list` already tells you which tabs exist and how full they are. Read it
before fetching anything: an empty answer for a tab the project does not show
is not "no data", it is "wrong tab".

## Three questions, three shortest paths

| the person asks | run |
| --- | --- |
| "what does this project contain?" | `tab list <p>` then read only the tabs with a count |
| "what assets does it have?" | `tab get <p> assets --limit 200` (both scopes, see below) |
| "what did it deliver / produce?" | `tab get <p> deliverables` (project-wide rollup) |

Add `--output json` where a command supports it; `tab get` always prints JSON.

## Tab → command

| tab | what it holds | read it with |
| --- | --- | --- |
| `archive` | documents synced from the archive repo (`project_artifact`) | `multica artifact list <p> --limit 200` |
| `assets` | asset bindings — project-level **and** work-item-level | `multica asset list --project <p>` |
| `features` | feature modules (功能模块) | `multica module list --project <p>` |
| `data-model` | graph modules + the bus matrix | `multica graph latest <p>` / `multica graph modules <p>` |
| `requirements` | top-level requirements, goals, acceptance | `multica requirement list --project <p> --output json` |
| `tasks` | every issue of the project | `multica issue list --project <p> --output json` |
| `acceptance` | acceptance criteria and verdicts | `multica requirement get <issue> --output json` |
| `deliverables` | archive rows carrying an issue — project rollup, or one issue | `multica artifact matrix <p>` / `multica artifact unbound <p>` |
| `filing` | filing readiness (软著 / 专利 tracks) | `multica filing readiness <p>` |
| `workflows` | workflow templates and instances | `multica workflow instance list <p>` |
| `sprints` | 迭代 of the project | `multica sprint list <p>` |

Prefer the dedicated command in the third column: it is shaped for that question
and can be filtered. Use `tab get <p> <tab>` when you want one tab in one call, or
when the tab has no dedicated command. The deeper rules live in
`multica-archive`, `multica-assets`, `multica-sprints`, `multica-filing`,
`multica-workflows`, `multica-data-model` and `multica-feature-modules`.

## Response shapes

Every payload is a **JSON object**. Lists live under a named key; none of these
commands returns a bare array.

| tab | top-level keys |
| --- | --- |
| `archive` | `artifacts[]`, `total` |
| `assets` | `items[]`, `total`, `page`, `page_size`, `total_pages`, `scope` |
| `assets --matrix` | the above plus `matrix_bindings[]`, `linkable_issues[]` |
| `deliverables` (no `--issue`) | `rollup{total, by_scope, by_stage, by_issue[], unassigned, scope_note}` |
| `deliverables --issue` | `data{artifacts{total, by_scope, by_stage}, todos{total, by_status}, completeness{artifact_total, missing_count}, …}` |
| `features` | `modules[]{id, name, graph_node_id, issue_count, issue_ids}` |
| `data-model` | `graph_modules`, `bus_matrix` |
| `workflows` | `templates`, `instances`, `status_counts` |
| `sprints` | `sprints[]`, `total` |
| `filing` | readiness document (`blocking_count`, `tracks[]`) |

Every payload also carries `source` — the endpoint and query that answered.
Quote it when a person asks where a number came from, and use `next` when it is
present: it names the one command that continues the reading.

Do not re-shape these payloads with ad-hoc parsing before reading them. Parse
the object, read the key named above, and if a key is missing say the field is
absent — do not assume a different type.

## Paging and counts

- `assets` is paged with `toPage` / `pageSize` (server caps `pageSize` at 200).
  `--limit` sets `pageSize`, so `--limit 200` really is 200 rows.
- `total` on `assets` is the server's `totalCount`: the count over **all**
  matching rows, not the rows in this page. If `total > len(items)`, narrow the
  question with `--category`, `--name`, `--scope` or `--issue` instead of
  paging blindly.
- `archive` has no server-side paging: it returns every match and `--limit`
  only truncates what is printed. Filter with `--stage`, `--doc-class`,
  `--doc-type`, `--q` before raising the limit.
- `tab list` counts come from the same endpoints, so they agree with `total`.

## Assets: two scopes

Asset bindings exist at two scopes, and the project's UI tab shows only one of
them. Reading only the tab is the usual reason "the assets are missing".

```bash
multica project tab get <p> assets                  # default: BOTH scopes (project + work items)
multica project tab get <p> assets --scope project   # only project-level (issue_id IS NULL)
multica project tab get <p> assets --scope issue --issue <issue-id>   # one work item
multica project tab get <p> assets --matrix          # + stage matrix and linkable issues
```

- Default `--scope all` reads the workspace aggregate narrowed by `projectId`,
  which returns project-level and work-item-level bindings — the archive-imported
  ones included. Use it for any "what does this project own" question.
- `--scope project` mirrors the UI tab exactly; a work item's assets never
  appear there. Use it only when the person means "project-level only".
- `--matrix` answers stage questions (`lifecycle_stage` S1–S5, `asset_role`,
  links to requirements) in the same call — do not fetch each binding again.

## Deliverables: what the rollup means

A deliverable **is** an archive row that carries an `issue_id`. There is no
separate deliverables table.

```bash
multica project tab get <p> deliverables              # project-wide rollup
multica project tab get <p> deliverables --issue <i>  # one issue's overview
multica project tab get <p> archive --unbound         # requirement rows with no issue yet
```

- Without `--issue` you get `rollup`: counts per `scope`, per `stage`, per
  issue (`by_issue[]` with `sample_paths`), and `unassigned` — the rows no issue
  claims yet. This is the answer to "what does this project deliver".
- `--issue` returns `total: 0` when **that issue** has no archive row bound. It
  does not mean the project has no deliverables — ask the rollup before saying
  a project delivered nothing, and offer `archive --unbound` as the reason why.

## Archive content: the one thing the API does not serve

```bash
multica project tab get <p> archive --doc <artifact-id>
```

returns a **pointer**, not the document: `content_unavailable: true`, plus
`attachment_url` when an attachment exists. The file itself lives at
`artifact.rel_path` inside the archive repo or the project's local directory
(`multica project resource list <p>` shows which). Read it from disk with the
file tools — do not retry the endpoint hoping for text, and do not claim the
document is missing because the endpoint has no body.

## Rules

- **Template decides visibility.** `general` hides `features`, `data-model`,
  `filing`; `rd` hides `data-model`; `data` hides `features` and `filing`;
  `full` (pre-template projects) shows everything. `tab list` already trims to
  the template — an empty tab is usually hidden, not missing. Confirm with
  `--all-tabs` before telling a person it does not exist.
- `project resource list` is **not** the archive or the asset tab. It lists
  external resources attached to the project (git repos, knowledge bases).
- The `features` tab is only the module list. Requirements inside a module and
  the absolute path of a module's prototype screen come from the
  `multica-feature-modules` skill.
- `issue list --project` returns requirements *and* tasks; add
  `--kind requirement` or `--kind task` to separate the two tabs.
- Reading is safe. Writing is not: an asset binding changes through
  `multica asset bind|meta|unbind`, a sprint through `multica sprint ...`, an
  archive row through `multica artifact ...`, readiness through
  `multica filing ...`, and a workflow through `multica workflow ...`; the graph
  is read-only. Every removal follows the approval levels in
  `multica-module-map`. Only do it when the person asked for it in this
  conversation.

## When the command fails

- `unknown tab "x"`: use one of the keys in the table above.
- `--scope issue needs --issue`: pass an issue id, or drop `--scope` for both
  scopes in one call.
- `resolve project: ...`: the project id is not in the workspace the CLI is
  logged into. Run `multica project list --output json` and use an id it returns.
- `invocation_revoked` or a shell allowlist error: the runtime blocked exec.
  Report that; do not fall back to raw HTTP calls.
