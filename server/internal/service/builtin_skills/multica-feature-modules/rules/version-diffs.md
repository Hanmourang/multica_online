# Reading a version diff

Supporting file for `multica-feature-modules`. Load it when someone asks
"这一版和上一版差在哪", "说明改了哪些字段", or wants a release note drafted from a
prototype/brief diff.

## `module prototype diff` — three layers

`prototype diff` reads BOTH stored HTML files and reports:

- **sections** — added / removed / reordered `h1–h3` headings, i.e. page structure
- **anchors** — added / removed / retitled `data-fp` codes, i.e. feature points
- **text** — `+N −M` visible lines with a collapsed `-`/`+` preview

Its one-line headline is the sentence to quote ("新增 2 个区块、删除 1 个区块；新增
3 个功能点锚点；正文 +18 −6 行"). `--max-lines 0` drops the preview; `--output json`
gives the same three layers as data.

A version whose file is missing on this machine is reported as a missing side
rather than compared against nothing — do not describe it as "no changes".

## `module brief diff` — the stored change log

`brief diff` replays the per-version change log and reports, per field, the value
at `--from` and at `--to`. It answers "说明改了哪些字段" from the rows the right
pane renders, not from memory. `brief versions` is the audit list behind the
版本记录 section: version, source, actor, field count, note, timestamp.

## How to write the summary

- Name the versions you compared (`v3 → v4`) and the two counters involved:
  `spec_version` (feature list) and `brief_version` (版本记录). They move
  independently; a diff that only moved one is not a defect.
- Name the sections that appeared/disappeared, the anchor codes that
  appeared/disappeared/got retitled, and the `brief.*` / `fp.<code>.*` keys
  whose values changed.
- Quote the headline rather than inventing a number, and never estimate the
  line counts.
- "Several things changed" is a failure. If the diff is genuinely empty, say
  so and give both version numbers to prove it.
