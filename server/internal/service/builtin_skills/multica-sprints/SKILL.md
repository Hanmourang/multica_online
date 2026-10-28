---
name: multica-sprints
description: "Use when a person talks about a project's sprint / 迭代: list it, create or edit it, start or complete it, move issues in or out, or read progress against capacity."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Sprints (迭代)

A sprint is a time box inside one project. Issues belong to at most one sprint
through `issue.sprint_id`; membership is cleared when the sprint is deleted, so
those issues fall back to the backlog rather than disappearing.

States: `planned` → `active` → `completed`. Transitions are compare-and-set on
the server, so two people starting the same sprint at once produce one success
and one conflict, not a corrupted state.

## Reading

```bash
multica sprint list <project> [--status planned|active|completed]
multica sprint get <project> <sprint>      # one sprint
multica sprint progress <project> <sprint> # done / cancelled / total vs capacity
```

`list` counts (`issue_count`, `done_count`) come from a join; a single `get`
returns them as 0, so **progress always comes from `sprint progress`**.
`sprint` accepts a full id, an id prefix, or the sprint name (case-insensitive).

## Writing

```bash
multica sprint create <project> --name <n> [--goal <g>] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--capacity <n>]
multica sprint update <project> <sprint> [--name|--goal|--start|--end|--capacity]
multica sprint assign <project> <sprint> <issue-id>...   # issues move in
multica sprint remove <project> <sprint> <issue-id>...   # back to the backlog
```

- `--capacity` is a number of issues, not hours; omit it for unlimited.
- `update --goal ""` clears the goal; an omitted flag keeps the current value.
- `assign` on a `completed` sprint is rejected (`sprint_completed`) — reopen
  first. An issue id that does not belong to the project fails the whole batch,
  so a partial write never happens.
- `remove` leaves the issue intact; only its sprint membership is cleared.

Gated transitions (**level B**: state the effect, get agreement, then run with
`--yes` in a separate call):

```bash
multica sprint start <project> <sprint> --yes      # planned → active
multica sprint complete <project> <sprint> --yes   # active → completed
multica sprint reopen <project> <sprint> --yes     # completed → active
multica sprint delete <project> <sprint> --yes     # row gone; its issues stay
```

- Starting a sprint opens the time box for everyone on the project; completing
  it closes it. Neither is a private edit.
- `complete` does not move unfinished issues anywhere — say what remains in the
  sprint when you report the result.
- `delete` cannot be undone, and the sprint's goal, dates and capacity are lost
  with it. Its issues survive with no sprint.

## Rules

- The server allows more than one `active` sprint, but progress, capacity and
  "what are we doing now" all stop being answerable. Complete or reopen the
  existing one instead of opening a second.
- Do not infer sprint membership from issue status. Read `sprint get` /
  `sprint progress`, or `multica issue list --project <p> --output json` and read
  `sprint_id`.
- Dates are calendar days (`YYYY-MM-DD`), not timestamps.
- Deleting a sprint is not "cleaning up a list"; if the person wants the issues
  gone, that is `multica issue ...` and a different decision.
