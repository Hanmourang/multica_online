---
name: multica-insights
description: "Use when a person asks how much a workspace or project cost, how long agents ran, how many tasks failed, or which agent is the top offender — the numbers behind the /usage dashboard."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Insights (用量与稳定性看板)

Six read-only rollups behind the workspace `/usage` page. All of them take the
same three scoping flags:

| flag | meaning |
|---|---|
| `--days N` | window in **calendar days**, 1..365, default 30 |
| `--tz <IANA>` | cuts the day buckets; defaults to your stored timezone, else UTC |
| `--project <id>` | scopes the rollup to one project |

Day buckets follow `--tz`, so "yesterday" matches what the person sees in the UI
only if you pass their timezone. Without it the server falls back to the stored
profile timezone and then to UTC — a mismatch at the day boundary is the most
common reason the numbers "look wrong".

## The six views

```bash
multica dashboard usage             # per date × provider × model: tokens, cost, tasks
multica dashboard usage-by-agent    # per agent × provider × model
multica dashboard runtime           # per date: run seconds + task counts
multica dashboard agent-runtime     # per agent: run seconds + task counts
multica dashboard failures          # per date × failure reason: task counts
multica dashboard failures-by-agent # per agent × failure reason: task counts
```

```bash
multica dashboard overview --days 7
```

`overview` returns all six as one JSON document keyed `usage`, `usage_by_agent`,
`runtime`, `agent_runtime`, `failures`, `failures_by_agent` plus the `query` it
sent. Prefer it when the question spans more than one view.

## Reading the numbers

- **Cost**: the server sends `cost_usd_ticks`, i.e. 1e-10 USD per tick; the table
  divides by 1e10 and prints `$0.0000`. Tokens from rows the provider did **not**
  price arrive as `uncosted_*` — the true spend is `cost_usd_ticks` plus an
  estimate for those, so a zero cost with non-zero tokens means "unpriced", not
  "free".
- **`failure_reason: ""` is the succeeded bucket.** Do not report it as an
  unknown failure class.
- **Run time** only counts terminal tasks (completed / failed / cancelled) that
  have both `started_at` and `completed_at`; queued and running work is invisible
  here, so a "0 seconds" answer during a busy period is not a bug.
- `failed_count` and `cancelled_count` are disjoint subsets of `task_count`; the
  succeeded count is the remainder.
- Ids print as 8-character prefixes. Use `--output json` when you need to join a
  row to an agent by full id.

## Interpreting before reporting

These are aggregates with no per-task rows behind them. If someone asks *why* a
number moved, this module cannot answer — pair it with
`multica runtime activity`, `multica agent tasks`, or `issue task-runs` to find
the individual runs, and say which layer the answer came from.

Never present a rollup as a billing statement: unpriced rows and provider-side
rounding mean the dashboard cost is an estimate.

## What is not here

Everything in this skill is a read. There is no write endpoint for usage data —
it is produced by task execution. If a person wants to reduce spend, the lever is
`multica agent update --model/--thinking-level` or the runtime configuration, not
this module.
