---
name: multica-requirements
description: "Use when a person asks to create, list, inspect, or update a Multica project, task, or requirement from chat. Covers the non-delete CLI. Do not delete projects, tasks, requirements, comments, or resources."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Projects, tasks, and requirements

Use the `multica` CLI. Print `--output json` and read that JSON. Do not call
HTTP routes yourself, and do not delete records. If the shell rejects the
command, say the runtime blocked exec; do not invent a result.

A **task** is an issue (`task_N` or `PREFIX-N`). A **requirement** is a
top-level issue that has a planned start time, a bound repo, or a
decomposition/trigger record (`req_N`). Child issues are always tasks.

## Projects

```bash
multica project list --output json
multica project get <project-id> --output json
multica project create --title "<title>" --output json
multica project update <project-id> --title "<title>" --output json
multica project status <project-id> in_progress --output json
multica project resource list <project-id> --output json
multica project resource add <project-id> --type github_repo --url <github-url> --output json
multica project resource update <project-id> <resource-id> --ref <branch-or-sha> --output json
multica project roles list <project-id> --output json
multica project roles set <project-id> --file roster.json --output json
```

`roster.json` is `{"entries":[{"role":"pm","assignee_type":"agent","assignee_id":"<uuid>","enabled":true}]}`.
Roles: `pm`, `prototyper`, `developer`, `data`, `tester`. Assignee type is
`member` or `agent`. There is no delete command here; `roles set` replaces the
whole roster.

## Tasks

```bash
multica issue list --kind task --project <project-id> --output json
multica issue get <id> --output json
multica issue search "<query>" --output json
multica issue create --title "<title>" --project <project-id> --status todo --output json
multica issue update <id> --title "<title>" --output json
multica issue status <id> <status> --output json
multica issue assign <id> --to "<name>" --output json
multica issue children <id> --output json
multica issue comment list <id> --output json
multica issue comment add <id> --content "<text>" --output json
```

Status keys: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`,
`cancelled`. Do not run `issue delete`, `comment delete`, or `resource remove`
unless the user explicitly asked to remove that one record and a delete command
already exists. Prefer status `cancelled` for work that should stop.

## Requirements

Create one with `--start-at`. Without that timestamp the server stores a task.

```bash
multica requirement create \
  --title "<title>" \
  --project <project-id> \
  --goal "<goal>" \
  --start-at 2026-11-02T09:00:00Z \
  --decompose-mode confirm \
  --output json
multica requirement list --project <project-id> --output json
multica requirement get <id> --output json
multica requirement update <id> --goal "<goal>" --output json
multica requirement roles list <id> --output json
multica requirement roles set <id> --file roster.json --output json
multica requirement prototype generate <id> --output json
multica requirement prototype list <id> --output json
multica requirement prototype register <id> --html-path <path> --output json
multica requirement prototype confirm <id> <version> --output json
multica requirement decompose <id> --output json
multica requirement decomposition <id> --output json
multica requirement confirm <id> --file drafts.json --output json
multica requirement trigger <id> --output json
multica requirement acceptance criteria <id> --checked <criterion-id> --output json
multica requirement acceptance verdict <id> --verdict pass --evidence "<why>" --output json
```

`--decompose-mode` is `auto`, `confirm`, or `manual`. `drafts.json` is
`{"drafts":[...]}` from the PM decomposition. `--verdict` is `pass` or `fail`.

Order when the user asks to move a requirement forward:

1. Create or update the requirement and its goal.
2. Set the roster (`pm` must be enabled before decompose).
3. Generate or register a prototype, then confirm the version.
4. Decompose, then confirm the draft.
5. Trigger only after decomposition is confirmed.
6. Record acceptance criteria, then a verdict.

`issue list --kind requirement` is the same filter as `requirement list`.
`issue create --start-at <RFC3339>` also creates a requirement; prefer
`requirement create` so the timestamp cannot be omitted.

## When the command fails

- `invocation_revoked` or a shell allowlist error: the runtime or the agent
  permission blocked the action. Report that; do not retry with a different tool.
- `pm role disabled`: set an enabled `pm` on the roster, then decompose again.
- `decomposition_not_confirmed`: confirm the draft before trigger.
- `not_a_top_level_requirement`: the id is a task. Use `multica issue` instead.
