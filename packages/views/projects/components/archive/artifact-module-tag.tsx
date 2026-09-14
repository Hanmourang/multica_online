"use client";

import { useEffect, useState } from "react";
import type { ProjectArtifact } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import {
  artifactModuleTag,
  artifactModuleTagToneClass,
  artifactParentDir,
} from "./archive-display";

export const ARTIFACT_MODULE_BADGE_CLASS = "max-w-28 truncate font-medium";

export function ArtifactModuleBadge({
  tag,
  title,
  className,
}: {
  tag?: string | null;
  title?: string;
  className?: string;
}) {
  if (!tag) return null;
  return (
    <Badge
      variant="outline"
      className={cn(ARTIFACT_MODULE_BADGE_CLASS, artifactModuleTagToneClass(tag), className)}
      title={title}
    >
      {tag}
    </Badge>
  );
}

export function ArtifactModuleChipControl({
  artifact,
  onSave,
  busy,
}: {
  artifact: ProjectArtifact;
  onSave?: (value: string) => Promise<void> | void;
  busy?: boolean;
}) {
  const { t } = useT("archive");
  const tag = artifactModuleTag(artifact.rel_path, artifact.doc_module);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag ?? "");

  useEffect(() => {
    if (!editing) setDraft(tag ?? "");
  }, [editing, tag]);

  if (!onSave) {
    return <ArtifactModuleBadge tag={tag} title={t(($) => $.browser.module)} />;
  }

  if (editing) {
    return (
      <Input
        value={draft}
        autoFocus
        disabled={busy}
        aria-label={t(($) => $.browser.tag_edit)}
        className="h-6 max-w-32 px-1.5 text-[11px]"
        placeholder={
          artifactParentDir(artifact.rel_path) ?? t(($) => $.browser.tag_placeholder)
        }
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void Promise.resolve(onSave(draft)).then(() => setEditing(false));
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
            setDraft(tag ?? "");
          }
        }}
        onBlur={() => {
          void Promise.resolve(onSave(draft)).then(() => setEditing(false));
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="shrink-0"
      title={t(($) => $.browser.tag_edit)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        setEditing(true);
      }}
    >
      {tag ? (
        <ArtifactModuleBadge tag={tag} title={t(($) => $.browser.tag_edit)} />
      ) : (
        <span className="rounded-full border border-dashed border-amber-500/50 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-100">
          {t(($) => $.browser.tag_add)}
        </span>
      )}
    </button>
  );
}

export function ArtifactModuleField({
  artifact,
  onSave,
  busy,
}: {
  artifact: ProjectArtifact;
  onSave: (value: string) => Promise<void> | void;
  busy?: boolean;
}) {
  const { t } = useT("archive");
  const tag = artifactModuleTag(artifact.rel_path, artifact.doc_module) ?? "";
  const parent = artifactParentDir(artifact.rel_path) ?? "";
  const [draft, setDraft] = useState(tag);

  useEffect(() => {
    setDraft(tag);
  }, [artifact.id, tag]);

  const commit = () => {
    if (draft.trim() === tag) return;
    void onSave(draft);
  };

  return (
    <div className="space-y-1">
      <Input
        value={draft}
        disabled={busy}
        aria-label={t(($) => $.browser.module)}
        placeholder={parent || t(($) => $.browser.tag_placeholder)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <p className="text-[10px] leading-snug text-muted-foreground">
        {t(($) => $.browser.tag_clear)}
      </p>
    </div>
  );
}
