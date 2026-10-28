"use client";

import { useRef, useState, type ReactNode } from "react";
import { Check, FolderKanban, Image as ImageIcon, Layers, Paperclip, Plus, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import type { Project, ProjectModule } from "@multica/core/types";
import { ProjectIcon } from "../../projects/components/project-icon";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";
import { ChatModuleMenu } from "./chat-module-menu";

interface ChatAddMenuProps {
  /** Called with each selected file — the caller routes it through the
   *  editor's upload extension, same path as paste / drag-drop. */
  onSelectFile?: (file: File) => void;
  onSelectResource?: () => void;
  projects?: Project[];
  projectsLoading?: boolean;
  projectsError?: boolean;
  projectId?: string | null;
  onSelectProject?: (projectId: string | null) => void;
  /** Soft warning: the active agent's daemon is too old to receive the
   *  project description. Selection stays enabled; the submenu only appends
   *  an explanatory hint so the user knows before choosing. */
  projectContextUnsupported?: boolean;
  /** 第 4 组「功能模块」：模块列表由 ChatModuleMenu 在子菜单展开时才拉取。 */
  onSelectModule?: (module: ProjectModule) => void;
  disabled?: boolean;
}

/**
 * The "+" affordance at the bottom-left of the chat composer. Replaces the
 * standalone paperclip button: file upload now lives here as a submenu entry,
 * leaving room for future add-actions (agents, skills, tools) under one entry
 * point without crowding the input bar.
 */
function MenuGlyph({
  tone,
  children,
}: {
  tone: "sky" | "amber" | "violet" | "emerald";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg",
        tone === "sky" && "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200",
        tone === "amber" && "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
        tone === "violet" && "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200",
        tone === "emerald" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200",
      )}
    >
      {children}
    </span>
  );
}

function MenuCopy({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="block text-[13px] font-semibold leading-4">{title}</span>
      <span className="mt-0.5 block text-[11px] font-normal leading-4 text-muted-foreground">{hint}</span>
    </span>
  );
}

export function ChatAddMenu({
  onSelectFile,
  onSelectResource,
  projects = [],
  projectsLoading,
  projectsError,
  projectId,
  onSelectProject,
  projectContextUnsupported,
  onSelectModule,
  disabled,
}: ChatAddMenuProps) {
  const { t } = useT("chat");
  const inputRef = useRef<HTMLInputElement>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const query = projectQuery.trim().toLowerCase();
  const visibleProjects = [...projects]
    .sort((a, b) => {
      const rank = (status: Project["status"]) =>
        ({ in_progress: 0, planned: 1, paused: 2, completed: 3, cancelled: 4 })[status] ?? 5;
      const byStatus = rank(a.status) - rank(b.status);
      if (byStatus !== 0) return byStatus;
      return a.title.localeCompare(b.title, "zh");
    })
    .filter(
      (project) =>
        !query ||
        project.title.toLowerCase().includes(query) ||
        matchesPinyin(project.title, query),
    );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = "";
    for (const file of files) onSelectFile?.(file);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="brandSubtle"
              size="icon-sm"
              disabled={disabled}
              aria-label={t(($) => $.input.add_tooltip)}
              title={t(($) => $.input.add_tooltip)}
              className="rounded-lg"
            >
              <Plus />
            </Button>
          }
        />
        <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-72 p-1.5">
          {onSelectFile && (
            <DropdownMenuItem className="gap-2.5 rounded-lg px-2 py-2" onClick={() => inputRef.current?.click()}>
              <MenuGlyph tone="sky"><ImageIcon className="size-4" /></MenuGlyph>
              <MenuCopy title={t(($) => $.input.upload_file)} hint={t(($) => $.input.upload_file_hint)} />
            </DropdownMenuItem>
          )}
          {onSelectResource && (
            <DropdownMenuItem className="gap-2.5 rounded-lg px-2 py-2" onClick={onSelectResource}>
              <MenuGlyph tone="amber"><Paperclip className="size-4" /></MenuGlyph>
              <MenuCopy title={t(($) => $.resources.add)} hint={t(($) => $.resources.add_hint)} />
            </DropdownMenuItem>
          )}
          {onSelectProject && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2.5 rounded-lg px-2 py-2">
                <MenuGlyph tone="violet"><FolderKanban className="size-4" /></MenuGlyph>
                <MenuCopy title={t(($) => $.input.project_context)} hint={t(($) => $.input.project_context_hint)} />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto">
                {projects.length > 0 && (
                  <div className="px-1 pb-1">
                    <input
                      value={projectQuery}
                      onChange={(event) => setProjectQuery(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      placeholder={t(($) => $.input.project_search)}
                      aria-label={t(($) => $.input.project_search)}
                      className="h-7 w-full rounded-md border border-border bg-background px-2 text-caption outline-none focus:border-ring"
                    />
                  </div>
                )}
                {visibleProjects.map((project) => {
                  const openCount = Math.max(0, (project.issue_count ?? 0) - (project.done_count ?? 0));
                  return (
                    <DropdownMenuItem
                      key={project.id}
                      className="items-start"
                      onClick={() => onSelectProject(project.id)}
                    >
                      <ProjectIcon project={project} size="md" className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{project.title}</span>
                        <span className="block truncate text-caption text-muted-foreground">
                          {t(($) => $.input.project_menu_meta, {
                            open: openCount,
                            resources: project.resource_count ?? 0,
                          })}
                        </span>
                      </span>
                      {project.id === projectId && <Check className="mt-0.5 ml-auto" />}
                    </DropdownMenuItem>
                  );
                })}
                {projectsLoading && (
                  <div className="px-2 py-1.5 text-caption text-muted-foreground">
                    {t(($) => $.input.projects_loading)}
                  </div>
                )}
                {!projectsLoading && projectsError && projects.length === 0 && (
                  <div className="px-2 py-1.5 text-caption text-muted-foreground">
                    {t(($) => $.input.projects_error)}
                  </div>
                )}
                {!projectsLoading && !projectsError && projects.length === 0 && (
                  <div className="px-2 py-1.5 text-caption text-muted-foreground">
                    {t(($) => $.input.no_projects)}
                  </div>
                )}
                {!projectsLoading && projects.length > 0 && visibleProjects.length === 0 && (
                  <div className="px-2 py-1.5 text-caption text-muted-foreground">
                    {t(($) => $.input.project_no_match)}
                  </div>
                )}
                {projectId && <DropdownMenuSeparator />}
                {projectId && (
                  <DropdownMenuItem onClick={() => onSelectProject(null)}>
                    <X />
                    {t(($) => $.input.remove_project_context)}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <div className="max-w-64 px-2 py-1.5 text-caption text-muted-foreground">
                  {t(($) => $.input.project_menu_hint)}
                </div>
                {projectContextUnsupported && (
                  <div className="max-w-64 px-2 py-1.5 text-caption text-muted-foreground">
                    {t(($) => $.input.project_context_unsupported)}
                  </div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {onSelectModule && (
            projectId ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2.5 rounded-lg px-2 py-2">
                  <MenuGlyph tone="emerald"><Layers className="size-4" /></MenuGlyph>
                  <MenuCopy title={t(($) => $.input.module_group)} hint={t(($) => $.input.module_group_hint)} />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto">
                  <ChatModuleMenu projectId={projectId} onSelect={onSelectModule} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              // 没有项目就没有模块可列：保留入口但提示前置条件（不隐藏，避免用户以为功能没了）。
              <DropdownMenuItem className="gap-2.5 rounded-lg px-2 py-2" disabled>
                <MenuGlyph tone="emerald"><Layers className="size-4" /></MenuGlyph>
                <MenuCopy title={t(($) => $.input.module_group)} hint={t(($) => $.input.module_group_needs_project)} />
              </DropdownMenuItem>
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onSelectFile && (
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleChange}
        />
      )}
    </>
  );
}
