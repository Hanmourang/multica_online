---
name: multica-chat
description: "Use when a person wants to start, list, rename or archive a Multica chat, send or reply to a message, react, mark it read, or manage a group chat's participants."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Chat (会话)

A session is one conversation. Three kinds share the same list:

| kind | created by | participants |
|---|---|---|
| `agent` | `chat session create --agent <a>` | you and one agent |
| `dm` | `chat session dm --member <m>` | you and one person |
| `group` | `chat session group` | you, members, agents |

Sessions are per creator — `chat session list` returns **yours**, and the id
prefix resolver only searches that list, so a prefix can never resolve to
somebody else's conversation.

`dm` and `group` sit behind a server feature flag. If they answer 404 the flag is
off; say so instead of guessing that the person has no permission.

## Reading

```bash
multica chat session list [--status active|archived|all] [--limit 20]
multica chat session get <session>
multica chat messages <session> [--limit 50] [--before-created-at T] [--before-id ID]
multica chat pending                     # chat tasks queued or running for you
```

`messages` returns the newest page first. To page further back, pass the
`created_at` and `id` of the **oldest** message you already have as the two
cursor flags — the pair is required together, not either-or. `--limit` is 1..100.

`chat history` and `chat thread` (older commands) are the agent-task view of the
same data; prefer `messages` when the question is about the conversation.

## Writing

```bash
multica chat session create --agent <a> [--title t] [--project p]
multica chat session dm --member <m>
multica chat session group --title t [--member id]... [--agent id]...
multica chat session update <session> [--title t] [--project p]   # --project "" clears it
multica chat session pin <session> [--off]
multica chat session archive <session> [--off]
multica chat session delete <session> --yes
```

```bash
multica chat send <session> --content "text" [--attachment ./shot.png]...
multica chat send <session> --content-file ./prompt.md
multica chat reply <session> <message-id> --content "text"
multica chat react <session> <message-id> --emoji 👍
multica chat read <session> [--through <message-id>]
```

**Sending into an agent chat creates a real task** — the agent starts working. It
is not a draft. Before `chat send` to an agent, state what you are asking the
agent to do; do not chain it silently after a read.

Long bodies: prefer `--content-file` over `--content` so shell quoting cannot
mangle it. `--content` decodes `\n`, `\r`, `\t`, `\\`; the file and `--content-stdin`
forms are byte-exact.

`--attachment` uploads a local file inside the working directory first and
forwards its id. A URL is rejected; a path outside the workdir is rejected unless
`--allow-external-file`.

## Group participants

```bash
multica chat participant list <session>
multica chat participant add <session> [--member id]... [--agent id]...
multica chat participant remove <session> <member|agent> <id>
multica chat participant admin <session> <member-id> [--off]
multica chat participant leave <session>
```

An agent chat has no participant set and a DM is fixed to its pair — these
commands only make sense on `group`.

## Approval levels

- **Level A**: read, send a message to a DM/group, react, mark read, pin, archive.
- **Level B**: `chat send` to an **agent** session (starts a task someone pays
  for), `chat session group` (creates a shared room), `participant add/remove`,
  `participant admin`, `participant leave`.
- **Level C**: `chat session delete` — drops the transcript for everyone. Print
  the command for the person; do not run it on your own initiative.
