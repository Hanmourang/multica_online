/**
 * Shared editor for requirement / task pipeline fields that were previously
 * create-only: goal, git repo, start_at, due_date, decompose_mode, auto_trigger.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import { projectResourcesOptions } from "@multica/core/projects";
import type { Issue, ProjectResource, UpdateIssueRequest } from "@multica/core/types";
import { Switch } from "@multica/ui/components/ui/switch";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

const DECOMPOSE_MODES = ["auto", "confirm", "manual"] as const;

export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function repoOptionLabel(resource: ProjectResource): string {
  return resource.label || resource.id.slice(0, 8);
}

export function RequirementConfigEditor({
  issue,
  showTitle = false,
  compact = false,
}: {
  issue: Issue;
  showTitle?: boolean;
  compact?: boolean;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const updateIssue = useUpdateIssue();
  const { data: resources = [] } = useQuery({
    ...projectResourcesOptions(wsId, issue.project_id ?? ""),
    enabled: Boolean(issue.project_id),
  });

  const [title, setTitle] = useState(issue.title);
  const [goal, setGoal] = useState(issue.goal ?? "");
  const [repoId, setRepoId] = useState(issue.repo_resource_id ?? "");
  const [startAt, setStartAt] = useState(toDatetimeLocal(issue.start_at));
  const [dueDate, setDueDate] = useState(issue.due_date ?? "");

  useEffect(() => {
    setTitle(issue.title);
    setGoal(issue.goal ?? "");
    setRepoId(issue.repo_resource_id ?? "");
    setStartAt(toDatetimeLocal(issue.start_at));
    setDueDate(issue.due_date ?? "");
  }, [issue.id, issue.title, issue.goal, issue.repo_resource_id, issue.start_at, issue.due_date]);

  const triggered = Boolean(issue.triggered_at);
  const onlineRepos = resources.filter((r) => r.resource_type === "github_repo");
  const localRepos = resources.filter((r) => r.resource_type === "local_directory");

  const save = async (patch: UpdateIssueRequest) => {
    try {
      await updateIssue.mutateAsync({ id: issue.id, ...patch });
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.requirement_config.save_failed),
      );
    }
  };

  return (
    <div
      data-testid="requirement-config-editor"
      className={cn("space-y-2", compact && "text-caption")}
    >
      {showTitle && (
        <Field label={t(($) => $.requirement_config.title)}>
          <input
            data-testid="requirement-config-title"
            className="w-full rounded-md border bg-transparent px-2 py-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              const next = title.trim();
              if (next && next !== issue.title) void save({ title: next });
            }}
          />
        </Field>
      )}
      <Field label={t(($) => $.requirement_config.goal)}>
        <textarea
          data-testid="requirement-config-goal"
          rows={compact ? 2 : 3}
          className="w-full rounded-md border bg-transparent px-2 py-1"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onBlur={() => {
            const next = goal.trim();
            if (next !== (issue.goal ?? "").trim()) {
              void save({ goal: next || null });
            }
          }}
        />
      </Field>
      <Field label={t(($) => $.requirement_config.repo)}>
        <select
          data-testid="requirement-config-repo"
          className="w-full rounded-md border bg-transparent px-2 py-1"
          value={repoId}
          onChange={(e) => {
            const next = e.target.value;
            setRepoId(next);
            if (next !== (issue.repo_resource_id ?? "")) {
              void save({ repo_resource_id: next || null });
            }
          }}
        >
          <option value="">{t(($) => $.requirement_config.repo_none)}</option>
          {onlineRepos.length > 0 && (
            <optgroup label={t(($) => $.requirement_config.repo_online)}>
              {onlineRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {repoOptionLabel(r)}
                </option>
              ))}
            </optgroup>
          )}
          {localRepos.length > 0 && (
            <optgroup label={t(($) => $.requirement_config.repo_local)}>
              {localRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {repoOptionLabel(r)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>
      <div className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-2")}>
        <Field label={t(($) => $.requirement_config.start_at)}>
          <input
            type="datetime-local"
            step={60}
            data-testid="requirement-config-start-at"
            className="w-full rounded-md border bg-transparent px-2 py-1 disabled:opacity-50"
            value={startAt}
            disabled={triggered}
            onChange={(e) => {
              const nextValue = e.target.value;
              setStartAt(nextValue);
              if (triggered) return;
              const next = nextValue ? new Date(nextValue).toISOString() : null;
              if (
                next !== (issue.start_at ?? null) &&
                (nextValue || issue.start_at)
              ) {
                void save({ start_at: next });
              }
            }}
          />
          {triggered && (
            <p className="mt-0.5 text-micro text-muted-foreground">
              {t(($) => $.requirement_config.start_at_locked)}
            </p>
          )}
        </Field>
        <Field label={t(($) => $.requirement_config.due_date)}>
          <input
            type="date"
            data-testid="requirement-config-due-date"
            className="w-full rounded-md border bg-transparent px-2 py-1"
            value={dueDate}
            onChange={(e) => {
              const next = e.target.value;
              setDueDate(next);
              if (next !== (issue.due_date ?? "")) {
                void save({ due_date: next || null });
              }
            }}
          />
        </Field>
      </div>
      <Field label={t(($) => $.requirement_config.decompose_mode)}>
        <div className="flex flex-col gap-1">
          {DECOMPOSE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`requirement-config-mode-${mode}`}
              onClick={() => {
                if (mode !== (issue.decompose_mode ?? "confirm")) {
                  void save({ decompose_mode: mode });
                }
              }}
              className={cn(
                "rounded-md border px-2 py-1 text-left",
                (issue.decompose_mode ?? "confirm") === mode
                  ? "border-primary bg-primary/5"
                  : "hover:bg-accent/50",
              )}
            >
              {t(($) => $.requirement_config.mode[mode])}
            </button>
          ))}
        </div>
      </Field>
      <label className="flex cursor-pointer items-center gap-2">
        <Switch
          size="sm"
          checked={issue.auto_trigger ?? false}
          disabled={triggered}
          onCheckedChange={(checked) => {
            if (checked !== (issue.auto_trigger ?? false)) {
              void save({ auto_trigger: checked });
            }
          }}
        />
        <span>
          {t(($) => $.requirement_config.auto_trigger)}
          <span className="block text-micro text-muted-foreground">
            {t(($) => $.requirement_config.auto_trigger_hint)}
          </span>
        </span>
      </label>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
