---
name: multica-module-map
description: "Use first when asked to create, read, update, or delete anything in Multica and you are unsure which command covers that product module. Maps every product module to its read/write/delete commands and the approval level deletions need."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Multica Module Map

One table for "which command does this module". Read it before guessing an endpoint
or telling someone a feature has no CLI. When a module is not listed as writable,
it is genuinely not writable from the CLI yet — say so instead of improvising.

The feature-module row also has an MCP twin (`modules_*`): the platform mounts the
facade as a server named `multica-modules` on every claimed task, so it is usually
already in the tool list. The CLI below stays authoritative — every MCP tool has a
CLI equivalent, not the other way round.

## Modules → commands

| Module (UI) | Read | Write | Delete |
|---|---|---|---|
| Tasks / requirements | `issue list/get/search/children/timeline`, `requirement list/get` | `issue create/update/status/assign/reorder`, `issue batch update` (one change across many), `issue comment|metadata|property|label|subscriber`, `requirement create/update/acceptance` | `issue comment delete`; `issue delete`, `issue batch delete` (level C — hard delete, also cancels running tasks) |
| Projects | `project list/get`, `project tab list/get` | `project create/update/status`, `project resource add/remove`, `project roles set` | `project delete` (level C) |
| Projects · assets | `asset list`, `asset matrix`, `project tab get <p> assets` | `asset bind`, `asset meta`, `asset sync` | `asset unbind` (level B) |
| Projects · archive & deliverables | `artifact list/get/matrix/unbound`, `project tab get <p> archive`, `project tab get <p> deliverables` | `artifact create/update/bind`, `archive sync`, `archive init` | `artifact unbind`, `artifact delete` (level B; `409 asset_linked` means unbind the asset instead) |
| Projects · feature modules & prototypes | `module list/get`, `module brief get`, `module brief versions`, `module prototype list/read`, `module prototype diff`, `module coverage`, `module reconcile`, `graph modules/objects/strategies/neighborhood/changes` | `module create/update` (`--graph-node` binds/unbinds), `module spec draft/publish` + `module spec feature add/update/remove` (one feature point at a time) + `module spec import` (从原型导入：锚点/区块标题→功能点，先 `--dry-run`), `module brief patch` (brief.* / fp.<code>.* fields), `module requirement add/remove`, `module prototype register/update/confirm/parse`, `module plan create/get`, `module release publish/rollback` (all spec flag-gated) | `module delete` (level B; issues fall back to "no module"); `module prototype delete --yes` (level B — canonical and released versions are refused server-side); `module plan apply --yes` moves the canonical prototype; `module release rollback` re-points both pointers |
| Projects · data model (graph) | `graph latest/detail/modules/objects/changes/strategies/neighborhood/matrix/drilldown/timeline/alerts`, `project tab get <p> data-model` | **nothing — read-only by design** | — |
| Projects · sprints | `sprint list/get/progress` | `sprint create/update/assign/remove`, `sprint start|complete|reopen` | `sprint delete` (level B) |
| Projects · acceptance | `requirement acceptance` (read), `project tab get <p> acceptance` | `requirement acceptance` (verdict/criteria) | **not yet** |
| Projects · filing | `filing readiness/items/cross-project`, `project tab get <p> filing` | `filing patch`, `filing check`, `filing export`, `filing writeback` (level B) | — |
| Projects · workflows | `workflow template list/dry-run`, `workflow instance list/get/diagnosis`, `workflow stage transcript/messages`, `project tab get <p> workflows` | `workflow template create/update/definition/publish/archive/duplicate/share/enforce`, `workflow instance create/pause/resume/succeed/recover`, `workflow stage approve/loop-back/skip/rerun/interrupt/recheck`, `workflow gate decide` | `workflow instance cancel` (level B — cannot be resumed) |
| Chat | `chat session list/get`, `chat messages`, `chat pending`, `chat history/thread` (legacy task view) | `chat session create/dm/group/update/pin/archive`, `chat send/reply/react/read`, `chat participant add/remove/admin/leave`, `attachment upload` | `chat session delete` (level C — drops the transcript for everyone) |
| Inbox & notifications | `inbox list/unread/archived/summary`, `notification get` | `inbox read/unread/archive/archive-read/archive-completed/archive-all/unarchive/mark-all-read`, `notification set` (level A — your own queue) | — |
| Insights (the `/usage` page) | `dashboard usage/usage-by-agent/runtime/agent-runtime/failures/failures-by-agent/overview` | **read-only by design** — the numbers come from task execution | — |
| Board controls · pins | `pin list` | `pin add/remove/reorder` (level A — a personal sidebar only) | — |
| Board controls · saved views | `issue-view list/get`, `issue-view preference get` | `issue-view create/update`, `issue-view preference set` | `issue-view delete` (level B) |
| Board controls · quick actions | `quick-action list`, `issue quick-action render` | `quick-action create/update`, `issue quick-action run` (level B — starts a task) | `quick-action delete` (level B) |
| Board controls · statuses | `issue-status list` | `issue-status create/update/reorder` (level B — changes every board) | `issue-status archive` (level B — issues must move off first) |
| Board controls · workflows | `issue-workflow list/get/brief` | `issue-workflow create/update/handoff` (level B) | `issue-workflow delete` (level B — projects fall back to Default) |
| Autopilots | `autopilot list/get/runs/trigger-list` | `autopilot create/update/trigger/trigger-add/trigger-update/trigger-rotate-url` | `autopilot delete`, `autopilot trigger-delete` (level B) |
| Agents | `agent list/get/tasks`, `agent env` | `agent create/update/copy/avatar/mcp/skills/env set` | `agent archive` (soft, level B), `agent restore` |
| Squads | `squad list/get`, `squad activity` | `squad create/update`, `squad member add/set` | `squad member remove`, `squad delete` (level B) |
| Runtimes | `runtime list/activity/usage`, `runtime profile list` | `runtime rename`, `runtime update`, `runtime profile set/delete` | `runtime delete` (level C), `runtime profile delete` (level B) |
| Skills | `skill list/get/search/files list` | `skill create/update/import/refresh/files` | `skill delete`, `skill files delete` (level B) |
| Labels & properties | `label list/get`, `property list/get` | `label create/update`, `property create/update` | `label delete`, `property archive` (level B) |
| Workspace & members | `workspace list/get`, `workspace member list` (MEMBER ID column), `workspace invitation list/mine`, `workspace share-link list` | `workspace create/update/switch`, `workspace member invite/role/leave`, `workspace invitation accept/decline`, `workspace share-link create` | `workspace member remove`, `workspace invitation revoke`, `workspace share-link revoke`, `workspace delete` (all level C) |
| Workspace MCP library | `workspace mcp list` (names and transports; the stored config is write-only) | `workspace mcp add/update` | `workspace mcp remove` (level B — detaches it from every agent) |
| Plugins (feature-flagged) | `plugin list/invocations`, `plugin package list`, `plugin mcp tools`, `plugin surface` | `plugin preview/install` (grants scopes), `plugin config/enable/disable`, `plugin mcp approve`, `plugin token rotate`, `plugin package publish-local` | `plugin uninstall`, `plugin token revoke`, `plugin package delete` (all level C) |
| Attachments | `attachment download` | `attachment upload` | `attachment delete` (level B) |
| Calendar / integrations / SSO / billing | **not yet** — no CLI. Do not invent endpoints. | — | — |

Two reading rules that save round trips:

- Counts come from `total`, which is the server's `totalCount`. Page with
  `--limit` (assets cap at 200); never conclude "only N exist" from one page.
- A project tab is a view, not the whole module: `assets` shows project-level
  rows only, so use `asset list` when the question is about all bindings.

## Deleting: three levels

Every destructive CLI command needs `--yes`. `--yes` means *a person approved this
exact command*, not "the agent decided". In a non-interactive run the command
refuses without it, so an unapproved delete cannot happen by accident.

**Level A — you may run it** after telling the person what you are removing, in
the same turn: comments, reactions, issue metadata keys, label/property
detachment, agent skill assignment removal, pins, your own inbox queue
(`inbox archive|archive-all|mark-all-read|…`), messages you posted in a DM or
group, and saved-view preference documents.

**Level B — ask first, then run with `--yes`** in a second call, quoting the
object and what else changes: `asset unbind`, `asset sync` (bulk create),
`artifact delete|unbind`, `module delete`, `attachment delete`, `sprint
delete|start|complete|reopen`, `squad delete`, `label delete`, `property
archive`, `project resource remove`, `autopilot delete`, `agent archive`,
`skill delete`, `runtime profile delete`, `filing writeback`, `workflow
instance cancel`, `workflow stage interrupt|skip`, `issue-view create|update|
delete`, `quick-action create|update|delete`, `issue quick-action run`,
`issue-status create|update|reorder|archive`, `issue-workflow create|update|
delete|handoff`, `chat session group`, `chat send` to an agent session (starts a
task someone pays for), `chat participant add|remove|admin|leave`, `workspace
member invite|role`, `workspace share-link create`, `workspace mcp remove`,
`issue batch update`, `plugin enable|disable|config|install`, `plugin mcp
approve`, `plugin token rotate`.

Workflow decisions are their own case: `workflow stage approve|loop-back` and
`workflow gate decide` approve someone's work. Never run them on your own
initiative — present `workflow instance get` + `diagnosis` and let a person
decide.

**Level C — never run it.** These affect a whole workspace, a person's access,
or history that cannot be restored: `project delete`, `workspace delete`,
`workspace member remove`, invitation revoke, `runtime delete`, `issue delete`,
integration disconnect, `share-link revoke`, `chat session delete`, `issue batch
delete`, `plugin uninstall|token revoke|package delete`, `graph rebind` (rewires
every module ↔ object mapping). Print the command for the person to run, or tell
them where in the UI to click.

Shape of a Level B approval, in one message:

```
I will run: multica sprint delete proj-abc 2026-W45 --yes
Effect: deletes the time box "2026-W45"; its 8 issues stay and fall back to the backlog.
This cannot be undone. Confirm?
```

## Choosing the right skill

This map says *what exists*. Deeper rules live next to the module:

- issues, PRs, status side effects → `multica-working-on-issues`
- creating projects / requirements / tasks → `multica-requirements`
- project tab shapes and paging → `multica-project-tabs`
- feature modules and prototypes → `multica-feature-modules`
- archive documents and deliverables → `multica-archive`
- asset bindings and the stage matrix → `multica-assets`
- sprint time boxes → `multica-sprints`
- 软著/专利 readiness → `multica-filing`
- workflow templates, instances, stages, gates → `multica-workflows`
- data model (graph) reads → `multica-data-model`
- inbox items and notification preferences → `multica-inbox`
- chat sessions, messages, group participants → `multica-chat`
- cost, runtime and failure numbers → `multica-insights`
- pins, saved views, quick actions, status columns, board workflows →
  `multica-board-controls`
- members, invitations, share links → `multica-workspace-admin`
- installed Plugins, their config, token and MCP tool approvals → `multica-plugins`
- agents / squads / autopilots / runtimes → their own `multica-*` skills

If a task needs a module marked "not yet", report the gap with the closest
available command and stop — do not fall back to raw HTTP.
