"use client";

import { useMemo } from "react";
import { parseFrontmatter } from "@multica/core/skills/frontmatter";
import { RichContent } from "../../rich-content";
import { useT } from "../../i18n";
import { isMarkdownPath, type FileMode } from "./file-viewer";

/**
 * Read-only body of a skill file.
 *
 * Sibling of `FileViewer`, which owns the editable pane: this one never
 * accepts a keystroke, so it can do the two things an editor cannot — render
 * line numbers that stay put under horizontal scroll, and keep the whole file
 * selectable as one block instead of a textarea value.
 */
export function SkillSourceView({
  path,
  content,
  mode,
}: {
  path: string;
  content: string;
  mode: FileMode;
}) {
  const { t } = useT("skills");
  const isMd = isMarkdownPath(path);

  // Frontmatter is the skill's metadata, already shown above the viewer; a
  // second copy at the top of the document is noise.
  const body = useMemo(
    () => (isMd ? parseFrontmatter(content).body : content),
    [content, isMd],
  );

  if (isMd && mode === "preview") {
    if (!body.trim()) {
      return <EmptyFile />;
    }
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[72ch] px-6 py-6 sm:px-8">
          <RichContent content={body} density="document" phase="settled" />
        </div>
      </div>
    );
  }

  if (!content) return <EmptyFile />;

  // A separate <span> per line is what makes the gutter align with soft-wrapped
  // content: the number and the text live in the same flex row, so a line that
  // wraps pushes only its own number's row. `whitespace-pre` keeps the source
  // column-exact, and the gutter is sticky so horizontal scrolling never
  // scrolls the numbers away.
  const lines = content.split("\n");
  return (
    <div
      role="region"
      aria-label={t(($) => $.source_sheet.mode_source)}
      className="h-full overflow-auto"
    >
      <pre className="w-max min-w-full py-3 font-mono text-caption leading-[1.7] text-foreground">
        <code>
          {lines.map((line, index) => (
            <div key={index} className="flex">
              <span
                aria-hidden="true"
                className="sticky left-0 w-11 shrink-0 select-none border-r bg-surface pr-2 text-right text-faint-foreground"
              >
                {index + 1}
              </span>
              <span className="whitespace-pre px-3">{line || " "}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

function EmptyFile() {
  const { t } = useT("skills");
  return (
    <div className="flex h-full items-center justify-center p-8 text-caption text-muted-foreground">
      {t(($) => $.source_sheet.empty_file)}
    </div>
  );
}
