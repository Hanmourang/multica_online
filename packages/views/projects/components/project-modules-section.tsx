"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  projectModulesOptions,
  useCreateProjectModule,
  useUpdateProjectModule,
  useDeleteProjectModule,
} from "@multica/core/modules";
import { useWorkspaceId } from "@multica/core/hooks";
import { ApiError } from "@multica/core/api";
import type { ProjectModule } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import {
  INLINE_COLORS,
  pickInlineColor,
} from "../../issues/components/pickers/module-picker";
import { useT } from "../../i18n";

// Project Modules sidebar section (spec §3): the manage surface for a
// project's modules — color dot, name (inline rename), task count, and
// hover actions for recolor/delete, plus an inline create form. Mirrors the
// project-resources-section row patterns so the two sidebar lists read as
// one surface.
//
// Delete goes through a confirm dialog because it is lossy in effect, not
// in data: issues pointing at the module fall back to "no module" (FK
// ON DELETE SET NULL) and silently leave every module lock.

/** A duplicate module name is the only 409 this API returns. */
function isDuplicateName(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

export function ProjectModulesSection({ projectId }: { projectId: string }) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectModule | null>(null);

  const { data: modules = [] } = useQuery(
    projectModulesOptions(wsId, projectId),
  );
  const createModule = useCreateProjectModule(projectId);
  const updateModule = useUpdateProjectModule(projectId);
  const deleteModule = useDeleteProjectModule(projectId);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createModule.isPending) return;
    try {
      await createModule.mutateAsync({
        name: trimmed,
        color: pickInlineColor(trimmed),
      });
      setName("");
    } catch (err) {
      toast.error(
        isDuplicateName(err)
          ? t(($) => $.modules.duplicate_name)
          : t(($) => $.modules.create_failed),
      );
    }
  };

  const handleRename = async (module: ProjectModule, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === module.name) return;
    try {
      await updateModule.mutateAsync({ moduleId: module.id, name: trimmed });
    } catch (err) {
      toast.error(
        isDuplicateName(err)
          ? t(($) => $.modules.duplicate_name)
          : t(($) => $.modules.update_failed),
      );
    }
  };

  const handleRecolor = async (module: ProjectModule, color: string) => {
    if (color === module.color) return;
    try {
      await updateModule.mutateAsync({ moduleId: module.id, color });
    } catch {
      toast.error(t(($) => $.modules.update_failed));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteModule.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      toast.error(t(($) => $.modules.delete_failed));
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.modules.title)}
        <span className="tabular-nums text-muted-foreground">
          · {modules.length}
        </span>
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="pl-2 space-y-1.5">
          <p className="text-caption text-muted-foreground">
            {t(($) => $.modules.description)}
          </p>
          {modules.length === 0 && (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.modules.empty)}
            </p>
          )}
          {modules.length > 0 && (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {modules.map((module) => (
                <ModuleRow
                  key={module.id}
                  module={module}
                  onRename={handleRename}
                  onRecolor={handleRecolor}
                  onDelete={() => setDeleteTarget(module)}
                />
              ))}
            </div>
          )}
          <form
            onSubmit={handleCreate}
            className="flex items-center gap-1.5 pt-1 border-t"
          >
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(($) => $.modules.name_placeholder)}
              aria-label={t(($) => $.modules.name_placeholder)}
              className="flex-1 bg-transparent text-caption px-2 py-1 outline-none placeholder:text-muted-foreground"
            />
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-caption"
              disabled={!name.trim() || createModule.isPending}
            >
              <Plus className="size-3" />
              {t(($) => $.modules.add)}
            </Button>
          </form>
        </div>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.modules.delete_confirm_title, {
                name: deleteTarget?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.modules.delete_confirm_body)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t(($) => $.modules.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t(($) => $.modules.delete)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ModuleRowProps {
  module: ProjectModule;
  onRename: (module: ProjectModule, nextName: string) => Promise<void>;
  onRecolor: (module: ProjectModule, color: string) => Promise<void>;
  onDelete: () => void;
}

function ModuleRow({ module, onRename, onRecolor, onDelete }: ModuleRowProps) {
  const { t } = useT("projects");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(module.name);
  const [colorOpen, setColorOpen] = useState(false);

  const startEdit = () => {
    setDraft(module.name);
    setEditing(true);
  };
  const commit = async () => {
    setEditing(false);
    await onRename(module, draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(module.name);
  };

  return (
    <div className="flex items-center gap-2 text-caption group">
      {/* The dot doubles as the recolor entry point — color is the module's
          whole visual identity, so the swatch is where a recolor belongs. */}
      <Popover open={colorOpen} onOpenChange={setColorOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              title={t(($) => $.modules.change_color)}
              aria-label={t(($) => $.modules.change_color)}
              className="shrink-0 rounded-full"
            >
              <span
                className="block size-3 rounded-full"
                style={{ backgroundColor: module.color }}
              />
            </button>
          }
        />
        <PopoverContent align="start" className="w-auto p-2">
          <div className="grid grid-cols-5 gap-1.5">
            {INLINE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                onClick={() => {
                  void onRecolor(module, color);
                  setColorOpen(false);
                }}
                className={`size-5 rounded-full transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring ${color === module.color ? "ring-2 ring-ring" : ""}`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="flex-1 min-w-0 rounded-sm border bg-transparent px-1 py-0.5 text-caption outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t(($) => $.modules.rename)}
        />
      ) : (
        <span className="truncate flex-1">{module.name}</span>
      )}
      <span
        className="shrink-0 tabular-nums text-muted-foreground"
        title={t(($) => $.modules.col_tasks)}
      >
        {module.task_count ?? 0}
      </span>
      {!editing && (
        <button
          type="button"
          onClick={startEdit}
          title={t(($) => $.modules.rename)}
          className="opacity-0 group-hover:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
        >
          <Pencil className="size-3 text-muted-foreground" />
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        title={t(($) => $.modules.delete)}
        className="opacity-0 group-hover:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
      >
        <Trash2 className="size-3 text-muted-foreground" />
      </button>
    </div>
  );
}
