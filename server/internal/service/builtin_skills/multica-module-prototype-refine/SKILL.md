---
name: multica-module-prototype-refine
description: "Use when a person asks to refine or accept one feature module's prototype (原型图), e.g. 'only change FP-03'. Loads that module's features and live prototype HTML, bounds the edit, proves the diff stayed inside it, then confirms acceptance."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Refining ONE feature module's prototype

This skill exists because "顺手把别的也改一下" is the failure mode people
actually hit: a prototype is one big HTML file, so an unconstrained edit silently
moves every screen it happens to touch. The contract below is mechanical — read
it as a checklist, not as advice.

Four guarantees this skill owes the person:

1. **The module's own detail is in context** — brief, every feature point, their
   acceptance items — before a single byte is edited.
2. **The current prototype source is on disk** — pulled from the server, not
   guessed from `html_path`, because that path is a coordinate and often has no
   file behind it.
3. **The edit is bounded** to the named module and, when named, to the named
   feature points.
4. **The boundary is proved, then acceptance is confirmed with numbers** — a
   version number, a coverage delta and per-item acceptance, never "应该没问题".

## Step 0 — Name the target before reading anything

Resolve two things:

- **the module**: its name, its UUID, or a UUID prefix. `--project <project-id>`
  when the same module name exists in more than one project.
- **the scope**: the whole module (default when the person says "优化 XX 模块")
  or specific feature points (when they name `FP-03` / a feature title).

If the person named a feature point that does not exist in the spec, stop and
quote the real codes from Step 1 — do not invent one, and do not quietly widen
the scope to the whole module.

## Step 1 — One read that carries the whole module into context

```bash
mkdir -p .refine
multica module context <module> --output json > .refine/module-context.json
```

That single call answers: `spec_version`, `brief_version`, the canonical
prototype version **and where its bytes live**, every feature point with how many
of its four detail sections are filled and how many acceptance items are already
ticked, the blank `brief.*` fields, and the coverage numbers. Read the file you
just wrote — do not re-derive it with five separate `get` calls.

Fallback when `context` is unavailable — either the CLI answers
`unknown command "context"` (the subcommand is newer than this build) or the
server answers 404 (feature flag off / older deployment):

```bash
multica module get <module> --output json
multica module brief get <module> --output json
multica module coverage <module> --output json
multica module reconcile <module> --output json
```

Then state, in the reply, what you loaded: module name, `spec_version`,
`brief_version`, feature-point count, prototype version + byte size, and the
target codes. This is the "模块详细信息带上" requirement — a person must be able
to see that the edit was scoped from data, not from memory.

## Step 2 — Pull the current prototype source onto disk

```bash
multica module prototype read <module> --json                 # source: local | server | unreadable
multica module prototype read <module> --version <n> --out .refine/prototype-v<n>.html
cp .refine/prototype-v<n>.html .refine/prototype-v<n>.before.html   # the pristine copy Step 5 diffs against
```

If this build has no `--out` (`unknown flag`), write the body yourself — same
bytes, one fewer feature:

```bash
multica module prototype read <module> --version <n> --raw > .refine/prototype-v<n>.html
```

- **This file is the only editable source.** Never `ls` / `find` / `mdfind` for
  a prototype: `html_path` resolves under archive roots only sometimes, and a
  UI-uploaded prototype keeps its bytes in attachment storage — no file exists
  on disk, ever. `prototype read` pulls it from the server when needed.
- `-` without `--version` picks the **confirmed** version, then the newest. A
  newer pending draft is not "the module's prototype".
- If it answers `unreadable` / "neither on this machine nor readable from the
  server", the version has no bytes anywhere. Repair it with the person's file:
  `multica module prototype upload <module> --file <html> --version <n> --replace`.

## Step 3 — Map feature points onto the HTML before editing

```bash
grep -o 'data-fp="[^"]*"' .refine/prototype-v<n>.html | sort | uniq -c
```

`data-fp="<code>"` is how the server ties a region of the screen to a spec
feature point; `reconcile` and `coverage` read that **anchor cache**, never the
HTML. A prototype with no anchors reports every feature point as `missing` —
that is a true result, not a bug, and it also means nobody can prove later which
region an edit belonged to.

So when the target feature point has no anchor yet:

1. locate the region that actually renders it (heading text, surrounding copy,
   the component it holds),
2. add `data-fp="<code>" data-title="<feature title>"` on that region's wrapper,
3. say so explicitly — adding anchors is a structural change, and it is the only
   way the acceptance numbers become meaningful for this screen.

If you cannot find the region at all, report it as "该功能点当前原型未呈现"
instead of drawing something new under the person's nose.

## Step 4 — Lock the boundary

While editing, all of these hold:

- Only `.refine/prototype-v<n>.html` is edited. No other module's prototype, ever.
- Only the target codes' regions (and their descendants) change. Text, structure
  and classes outside them stay byte-identical.
- Shared CSS variables / root-level styles change **only** when the target
  feature point cannot be satisfied otherwise, and the report names what else
  they touch.
- Keep every existing `data-fp` on the region it already belongs to. Removing or
  re-numbering an anchor is a spec change, not a prototype refinement.
- No new external CDN dependency: these prototypes are rendered through a
  server-side allowlist proxy, so an unknown host simply fails to load. Reuse the
  already-allowed Tailwind / Google Fonts entry points.
- Edit minimally. Do not reformat the whole file — a whitespace reformat makes
  the proof in Step 6 unreadable.

## Step 5 — Upload as a NEW version, then prove the diff stayed inside scope

```bash
multica module prototype upload <module> --file .refine/prototype-v<n>.html \
  --prompt "FP-03: 补齐空态与二次确认" --output json
# -> version n+1, status pending, anchors cached automatically

diff -u .refine/prototype-v<n>.before.html .refine/prototype-v<n>.html
```

Hard checks before you report anything:

- every hunk in that `diff -u` output falls inside a target code's region. A hunk
  anywhere else means the edit leaked — fix it and upload again
  (`--version <n+1> --replace`) rather than explaining it away;
- the anchors added by the edit are a **subset** of the target codes:
  `comm -13 <(grep -o 'data-fp="[^"]*"' .refine/prototype-v<n>.before.html | sort -u) <(grep -o 'data-fp="[^"]*"' .refine/prototype-v<n>.html | sort -u)`
  must be empty when the scope was "no new anchors" and must list only target
  codes otherwise;
- the grep from Step 3 still lists every previously existing `data-fp` — removing
  one is a spec change, not a refinement.

`multica module prototype diff <module> --from <n> --to <n+1>` is a useful
second opinion, but only when both versions' HTML is readable on this machine:
`upload` stores bytes server-side, so a freshly uploaded version often has no
local file and `diff` will say so instead of comparing. Never let that replace
the local `diff -u` proof.

`upload` never moves the canonical pointer by default. Do **not** pass
`--set-canonical` unless the person said "这版就是现在这版"; that is a product
decision, and `--set-canonical` also needs `--status confirmed`.

## Step 6 — Confirm acceptance with numbers

Three kinds of evidence, all quotable:

**6.1 Coverage / reconcile (server-computed — quote, never recompute)**

```bash
multica module coverage <module> --output json     # covered / changed / missing / unregistered
multica module reconcile <module> --output json    # four-state matrix per feature point
```

Report the before → after delta from Step 1. `covered` going up is the proof the
anchors and the spec now agree; `changed` means an anchor exists but no longer
matches; `missing` means the screen still does not show it.

**6.2 Per-item acceptance (the part people forget)**

Each feature point carries `fp.<code>.acceptance` as `[{"text": "...", "ok": true|false}]`.
After the edit you walk that list item by item:

```bash
multica module brief get <module> --output json     # base_version + current acceptance rows
multica module brief patch <module> --base-version <v> --source agent \
  --fields '{"fp.FP-03.acceptance":[{"text":"空态有插画与引导文案","ok":true},{"text":"删除需二次确认","ok":true}]}' \
  --note "FP-03 验收：2/2"
```

- Set `ok: true` **only** for items the new prototype actually demonstrates.
- An item the screen does not cover stays `false` and is reported as 未通过 — do
  not delete it, and do not relabel it into something the screen does show.
- `--base-version` is required; a 409 `base_stale` means someone wrote first —
  re-read, merge, retry. `--source agent` so 版本记录 shows who wrote it.
- One patch = one brief version. Group the target codes into a single patch.

**6.3 Visual regression**

Render the new version and compare it against the previous one: layout still
holds, no clipped text, icons still resolve, no console errors. When a browser is
not available, list the exact manual checks instead of claiming they passed.

Finish with a table — 功能点 | 验收项 | 结果 | 证据 — and a one-line verdict per
feature point. "改完了" is not a verdict.

## Step 7 — What the report must contain

- **加载的上下文**: module, `spec_version`, `brief_version`, prototype version +
  bytes, target codes (the Step 1 statement).
- **改了什么**: per target code, the concrete change.
- **没动什么**: the other codes, with the diff/anchor evidence that they are
  untouched.
- **新版本**: version number + status (`pending`), and that canonical is still
  `<n>` unless changed.
- **覆盖数字**: before → after, four numbers each side.
- **验收表** + verdict.
- **Next, for the person to decide**: `module prototype confirm <module> <n+1>`
  (approve in place), `--canonical` / `module release publish` (pin brief ×
  prototype), `module plan create|apply` (when the spec changed with it). None of
  these are yours to do unasked.

## Optional: Stitch as a design source

When the workspace has a `stitch` MCP server bound, its tools show up as
`mcp__stitch__*` (or `stitch.*`, depending on the runtime). They may be used to
explore variants or pull a reference screen, under two rules:

- the design that lands is still a local HTML file, edited and uploaded through
  Step 5 — never "tell Stitch and hope";
- the scope lock and the acceptance evidence in Steps 4–6 apply unchanged.

When those tools are absent or every call fails (server not bound to this agent,
or the machine has no route to `stitch.googleapis.com` — a saved MCP entry
proves nothing about reachability), do not block and do not retry in a loop:
refine locally and state in the report that the design tool was unavailable and
why.

## When something fails

- `module context` → `unknown command` or 404: it is newer than the installed
  CLI or gated off; use the Step 1 fallback set.
- `base_stale` on `brief patch`: re-read `brief get`, use the `current_version`
  it prints, re-send the same fields.
- `feature_not_found`: the `fp.<code>` is not in the spec yet — add the feature
  point first (`module spec feature add`), then patch prose.
- `no data-fp anchor and no h2/h3 heading found`: the page has no structure to
  import; add anchors to the blocks you mean (Step 3).
- coverage unchanged after an edit made outside `upload`:
  `multica module prototype parse <module> <version>` — reconcile reads the
  uploaded anchor cache, not the file.
- `prototype_owned_by_requirement`: that version came out of a requirement's
  stage; `confirm`/`delete` belong to `multica requirement prototype …`, and a
  module-owned version is the right vehicle for a module-wide refinement.
