"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Plus } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  projectModulesOptions,
  useCreateProjectModule,
} from "@multica/core/modules";
import {
  PropertyPicker,
  PickerItem,
  PickerEmpty,
} from "./property-picker";
import { useT } from "../../../i18n";
import { ModuleBadge } from "../module-badge";

/**
 * Palette for modules created inline from the picker. Same hash-by-name
 * approach as the label picker, so the same name always lands on the same
 * color; the project modules section can recolor afterwards. Exported for
 * the modules section, which reuses both the palette (recolor popover) and
 * the hash (create form).
 */
export const INLINE_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#64748b",
] as const;

export function pickInlineColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return INLINE_COLORS[hash % INLINE_COLORS.length] ?? INLINE_COLORS[0]!;
}

interface ModulePickerProps {
  /** Project whose modules are listed. Empty disables the picker content. */
  projectId: string;
  /** Currently selected module id; null/undefined = no module. */
  value?: string | null;
  onChange: (moduleId: string | null) => void;
  /** Optional controlled open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  defaultOpen?: boolean;
  disabled?: boolean;
  /** Custom trigger element (e.g. a `PillButton` for the create toolbar). */
  triggerRender?: React.ReactElement;
}

/**
 * Single-select module picker (spec §3): lists the project's modules as
 * color-dot rows, pins a "No module (no locking)" empty-value row on top, and
 * offers inline creation when the search term has no exact match.
 *
 * Module-less is a first-class value here — a task without a module joins no
 * lock at all, so the row spells that out instead of reading as "missing
 * data".
 */
export function ModulePicker({
  projectId,
  value,
  onChange,
  open: controlledOpen,
  onOpenChange,
  align = "start",
  defaultOpen = false,
  disabled = false,
  triggerRender,
}: ModulePickerProps) {
  const { t } = useT("issues");
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [filter, setFilter] = useState("");
  // Same double-submit guard as the label picker: React state lags a tick
  // behind rapid Enter/click pairs.
  const creatingRef = useRef(false);

  const wsId = useWorkspaceId();
  const { data: modules = [] } = useQuery(
    projectModulesOptions(wsId, projectId),
  );
  const create = useCreateProjectModule(projectId);

  const selected = useMemo(
    () => modules.find((m) => m.id === value) ?? null,
    [modules, value],
  );

  const query = filter.trim();
  const queryLower = query.toLowerCase();
  const filtered = modules.filter((m) =>
    m.name.toLowerCase().includes(queryLower),
  );
  const exactMatch = modules.some((m) => m.name.toLowerCase() === queryLower);
  const canCreate =
    query.length > 0 && !exactMatch && !create.isPending && Boolean(projectId);

  const choose = (moduleId: string | null) => {
    onChange(moduleId);
    setOpen(false);
  };

  const createAndSelect = () => {
    if (!canCreate || creatingRef.current) return;
    creatingRef.current = true;
    const name = query;
    create.mutate(
      { name, color: pickInlineColor(name) },
      {
        onSuccess: (mod) => {
          onChange(mod.id);
          setFilter("");
          setOpen(false);
        },
        onError: () => {
          toast.error(t(($) => $.pickers.label.create_failed));
        },
        onSettled: () => {
          creatingRef.current = false;
        },
      },
    );
  };

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
      searchPlaceholder={t(($) => $.module.picker_search)}
      onSearchChange={setFilter}
      triggerRender={triggerRender}
      trigger={
        selected ? (
          <ModuleBadge name={selected.name} color={selected.color} />
        ) : (
          <>
            <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              {t(($) => $.module.picker_label)}
            </span>
          </>
        )
      }
    >
      <PickerItem
        selected={!selected}
        emptyValue
        onClick={() => choose(null)}
        tooltip={t(($) => $.module.picker_none_hint)}
      >
        <span className="inline-block h-3 w-3 shrink-0 rounded-full border border-dashed border-muted-foreground/50" />
        <span className="truncate text-muted-foreground">
          {t(($) => $.module.picker_none)}
        </span>
      </PickerItem>
      {filtered.map((mod) => (
        <PickerItem
          key={mod.id}
          selected={selected?.id === mod.id}
          onClick={() => choose(mod.id)}
        >
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: mod.color }}
            aria-hidden
          />
          <span className="truncate">{mod.name}</span>
        </PickerItem>
      ))}
      {filtered.length === 0 && !canCreate && <PickerEmpty />}
      {canCreate && (
        <PickerItem selected={false} onClick={createAndSelect}>
          <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {t(($) => $.module.picker_create)}{" "}
            <span className="font-medium">&ldquo;{query}&rdquo;</span>
          </span>
          <span
            className="ml-auto inline-block h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: pickInlineColor(query) }}
            aria-hidden
          />
        </PickerItem>
      )}
    </PropertyPicker>
  );
}
