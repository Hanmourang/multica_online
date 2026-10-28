---
name: multica-board-controls
description: "Use when a person wants to pin items to the sidebar, save or share a filtered issue view, add a one-click action, change the board's status columns, or edit which agent handles a column."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Board controls: pins, saved views, quick actions, statuses, workflows

Five small modules that all shape **how the board looks and behaves** rather than
what the work is. They share one property: they are workspace configuration, not
issue data, so a wrong write is felt by every person on the board.

## Pins (personal sidebar)

```bash
multica pin list
multica pin add issue MUL-123
multica pin add project <id|prefix>
multica pin add view <id|prefix>
multica pin remove issue MUL-123
multica pin reorder <pin-id>=0 <pin-id>=10
```

Pins hold only an order — titles and statuses are resolved by the client, so a pin
never goes stale. `pin list` always asks for view pins (`?include=view`); an older
client that omits that would auto-unpin them.

Positions are floats and **explicit**: `pin reorder <id>=1.5` drops an item between
two neighbours without renumbering the rest. Lower sits higher.

## Saved views (named filter snapshots)

```bash
multica issue-view list --scope workspace [--project <id>]
multica issue-view get <id>
multica issue-view create --name "My open bugs" --scope workspace \
    --query '{"status":["todo"],"priority":["high"]}'
multica issue-view update <id> --name "Bugs (P0)" --visibility workspace
multica issue-view delete <id> --yes
```

- `scope_type`: `workspace` | `my` | `project`. `--scope project` requires
  `--project`.
- `scope_variant`: `my` → `assigned|created|involved|any`; `workspace`/`project` →
  `members|agents` (or omit for "all").
- `visibility`: `private` (default) | `workspace`. A `my` view is always private —
  sharing a personal perspective is meaningless.
- `--query` must be a JSON object; `--query-file` reads one from the workdir and
  `--display` sets the layout.
- `update` is **compare-and-set**: the server needs `expected_revision`. Omit
  `--revision` and the CLI reads the current one first — pass it explicitly only
  when you want the write to fail if somebody else edited in between.

Preference documents (`issue-view preference get|set`) are the "last arrangement"
per scope. UI state; do not read anything semantic into them.

## Quick actions (one-click dispatch)

```bash
multica quick-action list [--include-archived]
multica quick-action create --name "Triage" --assignee-type agent --assignee <agent> \
    --prompt "Read the report and file sub-issues"
multica quick-action update <id> --status archived
multica quick-action delete <id> --yes

multica issue quick-action render <issue> <quick-action>   # preview only
multica issue quick-action run <issue> <quick-action>      # dispatch: starts a task
```

`assignee_type` is `agent` or `squad`; `assignee_type` and `assignee` move
together in `update` — change both or neither. `visibility: public` needs the
owner/admin role and a target agent everyone may invoke.

`render` is the safe default: it returns the prompt without posting anything.
`run` writes a comment and starts a task — **Level B**, tell the person which
agent will start working before you run it.

## Status catalog (board columns)

```bash
multica issue-status list [--include-archived]
multica issue-status create --name "In review" --category in_progress [--key in_review] [--color "#8b5cf6"]
multica issue-status update <id> [--name|--description|--color|--position]
multica issue-status reorder <category> <id> <id> ...
multica issue-status archive <id> --yes
```

- `list --output json` also returns `categories` — the fixed set `create` accepts.
- **`key` and `category` are immutable after creation.** Changing a category
  would rewrite the machine meaning (does this count as done?) of every issue on
  that status. If a person needs a different category, create a new status and
  move the issues.
- `reorder` must list **every** active custom status of one category. A subset is
  rejected on purpose: positions come from the array index, so a partial list
  would collide with the rows left out.
- `archive` is the delete path (Level B). Issues must be moved off first.

Do not confuse this with `multica issue status <issue> <key>`, which moves **one
issue** between existing columns.

## Workflows (columns + who handles each)

A workflow is an ordered status list where each column carries a handoff: who
receives the issue, the instructions their run gets, and where it goes next.

```bash
multica issue-workflow list
multica issue-workflow get <id>
multica issue-workflow create --name "Design review" --order todo,in_review,done
multica issue-workflow update <id> --order todo,in_review,done --dry-run
multica issue-workflow handoff <id> in_review --handler-type agent --handler <agent> \
    --instructions "Check the mock against the spec" --next done
multica issue-workflow brief <id> --status-key in_review --handler-type agent --handler <agent>
multica issue-workflow delete <id> --yes
```

- `todo`, `done`, `cancelled` are added when missing; `backlog` and `blocked`
  appear only when you list them.
- `--order` is the shorthand for "which columns exist, in what order". `--steps`
  takes the raw array when you also need handoffs, new statuses or next/back
  links; `--steps-file` reads it from the workdir. The two are exclusive.
- Removing a status that still holds issues requires `--mapping from=to,...`.
  Always run that edit with `--dry-run` first: it returns the mapping plan without
  writing, including which statuses need a target.
- `handoff` sets one column in place; `--copy-for-project` saves it on a copy the
  project then switches to, leaving other projects untouched.
- `brief` renders what the handler's run would receive — use it to check wording
  before saving.

`--handler-type`: `none` | `agent` | `squad` | `member` | `project_lead` |
`creator`. The last three take no `--handler`, except `member`.

## Approval levels

- **Level A**: `pin *`, `issue-view list/get`, `issue-view preference *`,
  `quick-action list`, `issue-status list`, `issue-workflow list/get/brief`,
  `issue quick-action render`.
- **Level B**: `issue-view create/update/delete`, `quick-action create/update/
  delete`, `issue-status create/update/reorder/archive`, `issue-workflow
  create/update/delete/handoff`, `issue quick-action run`.
- **Level C**: nothing here is irreversible enough to forbid, but `issue-workflow
  delete` changes which columns every project using it shows — confirm that
  projects fall back to Default before running it.
