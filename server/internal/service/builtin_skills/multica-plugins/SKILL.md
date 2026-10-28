---
name: multica-plugins
description: "Use when a person wants to see, install, configure, enable, disable or uninstall a workspace Plugin, rotate its callback token, or approve the MCP tools one of its hooks exposes."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Plugins

A Plugin is third-party code the workspace installs: it contributes surfaces,
hooks, MCP tools and resources. Everything here is workspace-scoped and gated by
a server feature flag — when the flag is off every command answers 404/501, which
means "not enabled on this deployment", **not** "you lack permission". Say that
instead of asking for a role change.

## Reading

```bash
multica plugin list                 # ID, KEY, NAME, VERSION, ENABLED, SCOPES, SECRETS
multica plugin invocations <id>     # recent hook runs: status, attempt, latency, error
multica plugin package list         # published versions in this workspace
multica plugin mcp tools <id> <hook-key>
```

`plugin list --output json` is the only place that shows `config_schema`,
`granted_scopes`, `configured_secrets`, `surfaces` and `hooks` — use it before
configuring, because `--values` keys must match `config_schema` entries.

## Installing

```bash
multica plugin package list                                  # find a version id
multica plugin preview --version <version-id>                # read-only: manifest + scopes
multica plugin install --version <version-id> [--scope s]    # the consent
```

Install is two steps on purpose. `preview` writes nothing and returns the scopes
the Plugin asks for (`scopes`) plus the ones this upgrade adds (`added_scopes`);
`install` is what actually grants them. Never skip the preview — it is the only
moment a person can see what the Plugin will be able to do.

`--scope` narrows the grant. Omitting it grants everything the manifest declares.
A refusal at install means the Plugin requires a scope you did not grant.

## Configuring, enabling, removing

```bash
multica plugin config <id> --values-file ./values.json     # or --values-stdin
multica plugin enable <id>
multica plugin disable <id>                                # keeps it installed
multica plugin uninstall <id> --yes
```

- Config values replace what is stored for the keys you name; other keys are
  untouched. Secret fields belong in `--values-file` / `--values-stdin` — an
  inline value lands in shell history.
- `disable` is the reversible switch: hooks stop firing, the installation and its
  configuration stay. Prefer it over `uninstall` when someone just wants it quiet.
- `uninstall` revokes the token and drops the configuration. The bundle stays in
  `plugin package list`, so reinstalling is possible — but the configuration does
  not come back.

## Callback tokens

```bash
multica plugin token rotate <id>          # prints the new token + signing secret, once
multica plugin token revoke <id> --yes
```

The token is returned **exactly once**. There is no read endpoint: an admin who
loses it rotates. Print it to the person who asked, and never paste it into an
issue, a comment, or a document others can read. `signing_secret` is what the
Plugin author configures on their own server to verify our signature.

## MCP tools

```bash
multica plugin mcp tools <id> <hook-key>
multica plugin mcp approve <id> <hook-key> --tools search,fetch
multica plugin mcp approve <id> <hook-key> --tools-file approved.json
```

- `approve` takes the **complete** set, not a delta: a tool you omit is revoked.
- Each approval pins the tool by schema digest. A provider that later changes a
  tool's schema shows as `DRIFTED: yes` — re-approve deliberately, do not
  blanket-approve to clear the flag.
- Approving grants the Plugin the ability to call that tool with the caller's
  authority. Ask before widening the set.

## Surfaces

```bash
multica plugin surface <id> <surface-key>
```

Returns the launch payload for a hosted surface (executable bytes plus a
short-lived token). Hand the payload to the client that opens it; do not paste it
into chat.

## Publishing

```bash
multica plugin package publish-local --name <dir>    # server-host development only
multica plugin package delete <package-id> --yes
```

Shipping a bundle (multipart zip) has no CLI surface — that is the authoring
flow in the app. `publish-local` only works when the directory already exists on
the server host; it is not a way to ship to a shared workspace.

## Approval levels

- **Level A**: `plugin list`, `plugin invocations`, `plugin package list`,
  `plugin mcp tools`, `plugin surface`.
- **Level B**: `plugin enable`, `plugin disable`, `plugin config`,
  `plugin preview` + `plugin install` (grants scopes), `plugin mcp approve`,
  `plugin token rotate` (breaks the Plugin's current callback until it adopts the
  new token), `plugin package publish-local`.
- **Level C**: `plugin uninstall`, `plugin token revoke`,
  `plugin package delete`. These break a running integration for everyone.
  Present the command and the effect; get an explicit yes.
