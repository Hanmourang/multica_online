---
name: multica-workflows
description: "Use when asked about a project's workflow templates, running workflow instances, stage runs, or gate decisions — or when an instance is stuck. These endpoints need FF_WORKFLOW_MODULE; a 404 means the flag is off."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Workflows: templates, instances, stages, gates

> Not this: a project's **status workflow** (MUL-7420) is a different feature —
> an ordered list of issue statuses, each with who an issue is handed to on
> entering it. It is not a template/instance engine, is not behind
> `FF_WORKFLOW_MODULE`, and has no CLI; people manage it in the app
> (Settings → Workflows, or a project's workflow menu). If the question is
> about issue statuses, column handoffs or agent briefs on a status change,
> this skill is the wrong one.

Four layers, in order:

1. **template** — a reusable graph of stages (workspace gallery or project-scoped)
2. **instance** — one run of a template for a work item; it snapshots the
   template version, so later template edits do not change a running instance
3. **stage run** — one node of that snapshot; states `pending` → `running` →
   (`waiting_gate` | `blocked` | `done` | `failed` | `skipped`)
4. **gate run** — the decision point attached to a stage; `loop` sends work back,
   `exit` lets it through

Instance states: `waiting`, `running`, `paused`, `done`, `failed`, `cancelled`.

Everything here is behind the `FF_WORKFLOW_MODULE` feature flag. A 404 almost
always means the flag is off for this workspace — report that instead of
retrying or hunting another endpoint.

## Find things first

```bash
multica workflow template list                      # workspace gallery
multica workflow template list --project <p>         # templates of one project
multica workflow instance list <project>             # instances + per-status counts
multica workflow instance get <iid>                  # {instance, stages[], gates[]}
multica workflow instance diagnosis <iid>            # why it is stuck + suggested action
```

`instance get` is the only place that yields **stage ids and gate ids** —
`stages[].id` for `workflow stage ...`, `gates[].id` for `workflow gate ...`.
Do not reuse a template node id as a stage id; they are different rows.
`instance diagnosis` returns a recommendation per failed/stuck stage
(`task_failed_rerun_stage`, `human_stage_recover_and_approve`, …) — read it
before choosing an action.

## Templates

```bash
multica workflow template create <project> --name <n> \
  [--description <d>] [--nodes-file graph.json | --definition-file d.json] [--enforce]

multica workflow template update <project> <tid> --name <n> --nodes-file graph.json [--description <d>]
multica workflow template definition <tid> --definition-file d.json [--name <n>] [--description <d>]
multica workflow template publish|archive|duplicate|share <project> <tid>
multica workflow template enforce <tid> [--off]
multica workflow template dry-run <tid>
```

- `create` needs a graph: `--nodes-file` (array of nodes, or an object with a
  `nodes` key) or `--definition-file` (the nested CoCo definition, flattened to
  nodes server-side). `-` reads JSON from stdin.
- `update` is a **full replace** (`PUT`): it requires `--name` and
  `--nodes-file`, because omitting nodes would empty the graph. To change only
  the definition, use `definition`.
- Lifecycle: `publish` moves a draft to published; `archive` retires it;
  `duplicate` copies it into a new draft; `share` puts it in the workspace
  gallery. An instance can only start from a published template.
- `enforce` marks a **published, project-scoped** template as the project's
  mandatory gate. Only one per project (a second is a 409). `--off` clears it.
  This changes what new work must pass — state the effect before running it.
- `dry-run` renders the template with no side effects. Use it after writing a
  graph and before publishing.

## Instances

```bash
multica workflow instance create <project> --template <tid> [--issue <id>] [--snapshot-file workitem.json]
multica workflow instance pause|resume|succeed|recover <iid>
multica workflow instance cancel <iid> --yes
```

Legal transitions (anything else is a 409, by design):

| action | allowed from | effect |
|---|---|---|
| `pause` | running | stops dispatching new stages |
| `resume` | paused | continues dispatching |
| `cancel` | waiting, running, paused | stops every stage; **cannot be resumed** |
| `succeed` | running, paused | closes the instance as done |
| `recover` | failed | re-enters the state machine |

`create` without `--issue` runs the template against a snapshot you supply or
against nothing — for real work always bind the issue.

## Stages

```bash
multica workflow stage approve <sid>        # gate decision: exit (let it through)
multica workflow stage loop-back <sid>      # gate decision: loop (send it back)
multica workflow stage skip <sid>           # pending/running/waiting_gate -> skipped
multica workflow stage rerun <sid>          # done/failed/skipped -> pending (instance must be running)
multica workflow stage interrupt <sid>      # running auto stage: cancels its task
multica workflow stage recheck <sid>        # blocked stage: re-evaluate admission now
multica workflow stage transcript <sid>     # tool calls and outputs of the stage's agent
multica workflow stage messages <sid>       # the stage's message thread
```

- `approve` / `loop-back` are the *stage* face of a gate decision; they only
  apply to a stage sitting at `waiting_gate`. Loop rounds are capped by the
  template, so a repeated `loop-back` eventually stops looping.
- `rerun` is the answer to a failed stage that should be retried; `recover` is
  the instance-level counterpart when the whole instance is failed.
- `recheck` exists because a `blocked` stage is missing an input (usually an
  asset binding or a required document). Fix the input first, then recheck —
  rechecking an unchanged project just re-blocks.
- `interrupt` cancels the underlying agent task; the stage converges to
  `failed`, so follow it with `rerun` if the work should continue.
- `transcript` and `messages` are how you explain what an agent actually did.
  Read them instead of guessing why a stage failed.

## Gates

```bash
multica workflow gate decide <gid> --decision loop|exit
```

Only a `waiting` gate can be decided. `loop` re-runs the stage with the
round counter; `exit` advances. Use `stage approve|loop-back` when you have a
stage id, and `gate decide` when you have a gate id — they reach the same
decision path.

## Rules

- Never decide a gate on your own initiative. Approving is a human judgement
  about someone's work; present `instance get` + `diagnosis` and ask.
- `instance cancel` is level B in `multica-module-map`: it stops running work
  and cannot be resumed. Say so, get agreement, then run with `--yes`.
- Do not edit a template that has running instances expecting them to change:
  instances snapshot their template version.
- A 404 on any of these commands means the workflow module is disabled for this
  workspace. Say that; do not fall back to raw HTTP.
