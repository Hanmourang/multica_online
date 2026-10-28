---
name: multica-inbox
description: "Use when a person asks what needs their attention, wants unread counts, needs to mark notifications read or archived, or wants to change which notifications they receive in Multica."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Inbox (收件箱) and notification preferences

The inbox is per person, not per role: every command here acts on the
notifications addressed to the token's own user. There is no write model — a
notification appears because a task, comment, assignment or status change
happened, and disappears only when the underlying object is deleted.

## Reading before acting

```bash
multica inbox unread              # {"count": N} for the active workspace
multica inbox summary             # unread counts across every workspace you belong to
multica inbox list --limit 20     # active notifications, newest first
multica inbox archived --limit 20 # the Archived sub-view
```

`inbox summary` deliberately ignores the active workspace — use it when someone
asks "do I have anything waiting anywhere" and only one workspace is configured.

Table columns are `ID READ TYPE SEVERITY ISSUE TITLE CREATED`. `ID` is trimmed to
8 characters unless you pass `--full-id` — pass it before running `read`,
`archive` or `unarchive`, which need the whole UUID (or read `--output json`).

## Triaging

```bash
multica inbox read <id>            # mark one read
multica inbox mark-unread <id>     # flip one back
multica inbox archive <id>         # archive one
multica inbox unarchive <id>       # restore one
multica inbox mark-all-read        # every active item in this workspace
multica inbox archive-all          # archive every active item
multica inbox archive-read         # archive only the read ones
multica inbox archive-completed    # archive items whose issue reached a terminal status
```

All of these are reversible (that is what `unarchive` is for), so none of them
needs `--yes`. Bulk commands return `count`.

**Level A.** You may clear your own queue after saying what you are clearing.
`archive-all` and `mark-all-read` affect everything in the workspace for this
user — say the number from `inbox unread` first so the person knows the blast
radius, and never run them as a side effect of another task.

## Preferences

```bash
multica notification get
multica notification set --group comments --value muted
multica notification set --prefs '{"comments":"muted","mentions":"all"}'
multica notification set --prefs '{...}' --replace   # PUT: keys you omit are dropped
```

Groups: `assignments`, `status_changes`, `comments`, `mentions`, `updates`,
`agent_activity`, `system_notifications`. Values: `all` or `muted`. The CLI
validates both locally, so an unknown key fails without a round trip.

Default is **merge** (PATCH): only the groups you name change. `--replace` is the
"reset everything to this document" form — prefer merge unless the person asked
for a clean slate.

Muting never hides the item from `inbox list`; it only stops the notification
from being generated for that class of event.

## What is not here

- Deleting a notification: delete the underlying issue/task instead.
- Reading another person's inbox: every route is scoped to the token's user.
- Calendar: it has no CLI surface yet; do not invent endpoints.
