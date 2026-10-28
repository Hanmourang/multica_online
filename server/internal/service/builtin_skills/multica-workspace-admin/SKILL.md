---
name: multica-workspace-admin
description: "Use when a person asks to invite someone, change a member's role, remove or leave a workspace, revoke an invitation, or mint a join link — the Settings → Members / Invitations / Share links surfaces."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Workspace administration

Who may do what, before anything else:

| role | can |
|---|---|
| `member` | see the workspace, answer their own invitations, leave |
| `admin` | everything above, plus invite, change roles (not to/from owner), remove members, revoke invitations, manage share links |
| `owner` | everything above, plus hand over `owner`, delete the workspace |

The server re-checks every one of these. A 403 means the person's role is too
low — report that, do not look for another route.

## Members

```bash
multica workspace member list                  # MEMBER ID, USER ID, NAME, EMAIL, ROLE
multica workspace member invite <email> [--role member|admin]
multica workspace member role <member-id> <owner|admin|member>
multica workspace member remove <member-id> --yes
multica workspace member leave
```

**MEMBER ID and USER ID are different ids.** `role` and `remove` take the
membership row's **MEMBER ID** (first column); `user_id` identifies the person
and is not accepted here. Both print as 8-character prefixes — the commands
resolve a unique prefix, so copy what `list` shows. `--full-id` prints whole
UUIDs for logs.

Notes that matter:

- `invite` **does not add anyone**; it creates a pending invitation the invitee
  must accept. Say so, or the person will think the seat is taken.
- `--role owner` is refused on invite. Ownership only moves through
  `member role`, and only an owner can do it.
- The last owner cannot be demoted — the server refuses to leave a workspace
  without one.
- `remove` is immediate: access is gone, but the person's chats and task history
  stay attributed. Their own pending invitation is not resurrected by re-inviting
  under a different role; invite again.
- `leave` acts as **you**. There is no "leave on behalf of someone else" — that
  is `remove`.

## Invitations

```bash
multica workspace invitation list          # this workspace, admins
multica workspace invitation mine          # addressed to you, any workspace
multica workspace invitation revoke <id> --yes
multica workspace invitation accept <id>
multica workspace invitation decline <id>
```

- `list` and `mine` read different endpoints: `list` is the workspace's outbox,
  `mine` is your personal inbox. An invitation the person mentions is usually in
  `mine`.
- `revoke` kills the link but leaves the address free to be invited again.
- `accept` / `decline` change the caller's own membership. Do not accept an
  invitation on someone's behalf just because they pasted the id — confirm they
  want to join.
- Accepted and expired invitations stay in `list` with their status; only pending
  rows can be revoked.

## Share links

```bash
multica workspace share-link list
multica workspace share-link create --role member [--expires-in 168] [--max-uses 5]
multica workspace share-link revoke <link-id> --yes
```

- `--expires-in` is **hours** from now; omit for no expiry. `--max-uses` counts
  joins, not clicks.
- `--role admin` on a share link means anyone holding the URL becomes an
  administrator. Treat that as handing out the workspace, not as convenience.
- The link code is a credential. Print it to the person who asked; do not paste
  it into issues, comments, or documents that others can read.
- `revoke` stops future joins. People who already joined keep their membership —
  remove them individually if that is the intent.

## Deleting the workspace

```bash
multica workspace delete --yes      # owner only; irreversible
```

This removes every issue, project, chat, agent, skill and artifact, and drops
access for everyone. Do not run it from a vague "clean up" or "reset" request.
Print the command for the owner to run themselves.

## Approval levels

- **Level A**: `workspace list/get`, `member list`, `invitation list/mine`,
  `share-link list`, `member leave` (your own membership only).
- **Level B**: `member invite`, `member role`, `share-link create`, `invitation
  accept/decline` when it changes the caller's own membership.
- **Level C**: `member remove`, `invitation revoke`, `share-link revoke`,
  `workspace delete`. These change another person's access. Never run them on
  your own initiative — present the command and the effect, get an explicit yes.

A Level C confirmation names the human, not the id:

```
I will run: multica workspace member remove 3f2a1b44 --yes
Effect: Zhou (zhou@example.com, member) loses access immediately. Their issues
and task history stay in the workspace. Confirm?
```

## What is not here

Repository connections, MCP libraries and runtime profiles are configured under
`multica workspace mcp *` and `multica runtime *`; SSO and billing have no CLI.
Say that instead of improvising a request.
