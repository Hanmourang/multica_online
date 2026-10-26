"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Repeat } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectSprintsOptions } from "@multica/core/sprints";
import {
  PropertyPicker,
  PickerItem,
  PickerEmpty,
} from "./property-picker";
import { useT } from "../../../i18n";

interface SprintPickerProps {
  /** Project whose sprints are listed. Empty disables the picker content. */
  projectId: string;
  /** Currently selected sprint id; null/undefined = backlog (no sprint). */
  value?: string | null;
  onChange: (sprintId: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  defaultOpen?: boolean;
  disabled?: boolean;
  triggerRender?: React.ReactElement;
}

/**
 * Single-select sprint picker (CoCo 对标 02 §F — the issue-side reverse
 * attach). Lists the project's sprints; a completed sprint is shown but not
 * selectable (the server freezes completed scopes and rejects new members with
 * 409/404), so the row reads as disabled rather than a dead click. "No sprint"
 * is a first-class value — an issue without a sprint is backlog and can be
 * attached later from the sprint TAB too.
 */
export function SprintPicker({
  projectId,
  value,
  onChange,
  open: controlledOpen,
  onOpenChange,
  align = "start",
  defaultOpen = false,
  disabled = false,
  triggerRender,
}: SprintPickerProps) {
  const { t } = useT("issues");
  // Status wording belongs to the sprint TAB's namespace; reusing it here keeps
  // one translation for "Active" rather than teaching issues.json a synonym.
  const { t: tSprints } = useT("sprints");
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [filter, setFilter] = useState("");

  const wsId = useWorkspaceId();
  const { data: sprintPage } = useQuery(projectSprintsOptions(wsId, projectId));
  // Memoised on the query data, not rebuilt per render: `selected` below keys
  // its own memo off this array, and a fresh `[]` each pass would invalidate it
  // every render (same idiom as the sprint TAB).
  const sprints = useMemo(() => sprintPage?.sprints ?? [], [sprintPage]);

  const selected = useMemo(
    () => sprints.find((s) => s.id === value) ?? null,
    [sprints, value],
  );

  const query = filter.trim().toLowerCase();
  const filtered = sprints.filter((s) => s.name.toLowerCase().includes(query));

  const choose = (sprintId: string | null) => {
    onChange(sprintId);
    setOpen(false);
  };

  // The row itself carries the status signal (completed rows are disabled,
  // the active row gets a suffix), so the trigger only needs the name.

  return (
    <PropertyPicker
      open={open}
      onOpenChange={(v: boolean) => {
        if (disabled) return;
        setOpen(v);
        if (!v) setFilter("");
      }}
      width="w-72"
      align={align}
      searchable
      searchPlaceholder={t(($) => $.sprint.picker_search)}
      onSearchChange={setFilter}
      triggerRender={triggerRender}
      trigger={
        selected ? (
          <>
            <Repeat className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{selected.name}</span>
          </>
        ) : (
          <>
            <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              {t(($) => $.sprint.picker_label)}
            </span>
          </>
        )
      }
    >
      <PickerItem
        selected={!selected}
        emptyValue
        onClick={() => choose(null)}
        tooltip={t(($) => $.sprint.picker_none_hint)}
      >
        <span className="truncate text-muted-foreground">
          {t(($) => $.sprint.picker_none)}
        </span>
      </PickerItem>
      {filtered.map((sprint) => {
        const isCompleted = sprint.status === "completed";
        return (
          <PickerItem
            key={sprint.id}
            selected={selected?.id === sprint.id}
            disabled={isCompleted}
            onClick={() => choose(sprint.id)}
            tooltip={
              isCompleted ? t(($) => $.sprint.picker_completed_hint) : undefined
            }
          >
            <span className="truncate">{sprint.name}</span>
            {sprint.status === "active" && (
              <span className="ml-auto shrink-0 text-caption text-muted-foreground">
                {tSprints(($) => $.status.active)}
              </span>
            )}
          </PickerItem>
        );
      })}
      {filtered.length === 0 && <PickerEmpty />}
    </PropertyPicker>
  );
}
