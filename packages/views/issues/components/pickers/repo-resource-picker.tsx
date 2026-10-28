"use client";

/**
 * Git repo picker for requirements and tasks.
 *
 * Both kinds of repo answer the same question — "where does this work happen?"
 * — so they live in one field:
 *   - `local_directory`: a folder on one daemon machine. The agent edits it in
 *     place (or in a worktree), and the path only resolves on that machine.
 *   - `github_repo`: an http(s)/ssh URL. The runtime clones it, which is what
 *     makes public open-source repos (not owned by the project) usable.
 *
 * Entering a URL is inline rather than a detour through project settings:
 * binding a repo to one requirement should not mean leaving the dialog, adding
 * a resource elsewhere, and coming back. Attaching a `github_repo` resource is
 * also what makes the URL reach the agent — a claim lifts every project
 * `github_repo` into the task's repo list — so the two paths converge on the
 * same row instead of inventing an issue-level URL field.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  projectResourcesOptions,
  useCreateProjectResource,
} from "@multica/core/projects";
import type { GithubRepoResourceRef, ProjectResource } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

/** Sentinel option value that flips the picker into "paste a URL" mode. */
const URL_MODE = "__repo_url__";

/**
 * Canonical form of what a user can paste for a hosted repo, or null when the
 * input is not something `git clone` could use.
 *
 * Accepts the four shapes people actually paste: a full URL, a host without a
 * scheme (`github.com/owner/repo`), the `owner/repo` shorthand used in chat,
 * and the scp-like `git@host:owner/repo.git` from GitHub's clone menu. Anything
 * else is rejected here rather than at clone time, where the failure surfaces
 * long after the requirement was filed.
 */
export function normalizeGitRepoUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;

  if (/^(https?|ssh|git):\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!parsed.hostname) return null;
      // owner/repo at minimum: a bare host or a host plus one segment (e.g.
      // `https://github.com/facebook`) has no repository to clone.
      if (parsed.pathname.split("/").filter(Boolean).length < 2) return null;
      return raw;
    } catch {
      return null;
    }
  }
  // scp-like ssh shorthand: [user@]host:path
  if (/^[^\s@:]+@[^\s:]+:.+$/.test(raw)) return raw;
  // Host without a scheme: any dotted first segment is read as a host.
  if (/^[\w.-]+\.[a-z]{2,}\//i.test(raw)) return `https://${raw}`;
  // owner/repo shorthand — no dots allowed in the owner here, so a hostname
  // like `github.com/owner` is never mistaken for one.
  const shorthand = /^([\w-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  return null;
}

/**
 * Comparison key that treats the same repo written four ways as one repo, so
 * pasting `git@github.com:acme/app.git` reuses the existing
 * `https://github.com/acme/app` row instead of attaching a duplicate that the
 * daemon would happily clone twice.
 */
export function repoKey(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (/^(https?|ssh|git):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    } catch {
      // Fall through to the string forms below.
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  return trimmed.toLowerCase();
}

function githubUrlOf(resource: ProjectResource): string | null {
  if (resource.resource_type !== "github_repo") return null;
  const ref = resource.resource_ref as GithubRepoResourceRef;
  return typeof ref.url === "string" && ref.url.trim() ? ref.url : null;
}

function optionLabel(resource: ProjectResource): string {
  if (resource.label) return resource.label;
  const ref = resource.resource_ref as Record<string, unknown>;
  if (typeof ref.url === "string") return ref.url;
  if (typeof ref.local_path === "string") return ref.local_path;
  return resource.id;
}

/** Where the selected repo actually points — the label alone can be renamed. */
function targetHint(resource: ProjectResource): string | null {
  const ref = resource.resource_ref as Record<string, unknown>;
  if (typeof ref.url === "string" && ref.url.trim()) {
    const revision = typeof ref.ref === "string" && ref.ref.trim() ? ` @ ${ref.ref}` : "";
    return `${ref.url}${revision}`;
  }
  if (typeof ref.local_path === "string" && ref.local_path.trim()) {
    return ref.local_path;
  }
  return null;
}

export function RepoResourcePicker({
  projectId,
  value,
  onChange,
  disabled = false,
  className,
  testId = "repo-resource-picker",
}: {
  projectId: string;
  /** Selected `repo_resource_id`; "" means "not bound". */
  value: string;
  onChange: (resourceId: string) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { data: resources = [] } = useQuery({
    ...projectResourcesOptions(wsId, projectId),
    enabled: Boolean(projectId),
  });
  const createResource = useCreateProjectResource(wsId, projectId);

  const [urlMode, setUrlMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const repos = resources.filter(
    (r) => r.resource_type === "github_repo" || r.resource_type === "local_directory",
  );
  const onlineRepos = repos.filter((r) => r.resource_type === "github_repo");
  const localRepos = repos.filter((r) => r.resource_type === "local_directory");
  const selected = repos.find((r) => r.id === value) ?? null;
  const hint = selected ? targetHint(selected) : null;

  const closeUrlMode = () => {
    setUrlMode(false);
    setDraft("");
    setError(null);
  };

  const bindUrl = async () => {
    if (saving) return;
    const url = normalizeGitRepoUrl(draft);
    if (!url) {
      setError(t(($) => $.repo_picker.url_invalid));
      return;
    }
    // Reuse the project's existing row for the same repo before creating a
    // second one: two rows for one URL would make "which one is bound" a
    // question with no answer.
    const key = repoKey(url);
    const existing = onlineRepos.find((r) => {
      const known = githubUrlOf(r);
      return known !== null && repoKey(known) === key;
    });
    if (existing) {
      onChange(existing.id);
      toast.success(t(($) => $.repo_picker.url_reused));
      closeUrlMode();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createResource.mutateAsync({
        resource_type: "github_repo",
        resource_ref: { url },
        label: url.split("/").filter(Boolean).pop() ?? url,
      });
      onChange(created.id);
      toast.success(t(($) => $.repo_picker.url_bound));
      closeUrlMode();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.repo_picker.url_failed),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("space-y-1", className)}>
      <select
        data-testid={testId}
        disabled={disabled || !projectId}
        className="w-full rounded-md border bg-transparent px-2 py-1.5 text-body focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        value={urlMode ? URL_MODE : value}
        onChange={(e) => {
          const next = e.target.value;
          if (next === URL_MODE) {
            setUrlMode(true);
            setError(null);
            return;
          }
          setUrlMode(false);
          onChange(next);
        }}
      >
        <option value="">{t(($) => $.repo_picker.none)}</option>
        {onlineRepos.length > 0 && (
          <optgroup label={t(($) => $.repo_picker.online)}>
            {onlineRepos.map((r) => (
              <option key={r.id} value={r.id}>
                {optionLabel(r)}
              </option>
            ))}
          </optgroup>
        )}
        {localRepos.length > 0 && (
          <optgroup label={t(($) => $.repo_picker.local)}>
            {localRepos.map((r) => (
              <option key={r.id} value={r.id}>
                {optionLabel(r)}
              </option>
            ))}
          </optgroup>
        )}
        <option value={URL_MODE}>{t(($) => $.repo_picker.url_mode)}</option>
      </select>

      {urlMode ? (
        <div className="rounded-md border border-dashed p-2">
          <div className="flex items-center gap-1.5">
            <input
              data-testid={`${testId}-url`}
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void bindUrl();
                } else if (e.key === "Escape") {
                  closeUrlMode();
                }
              }}
              placeholder={t(($) => $.repo_picker.url_placeholder)}
              className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono text-caption focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => void bindUrl()}
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                t(($) => $.repo_picker.url_submit)
              )}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={closeUrlMode}
            >
              {t(($) => $.repo_picker.url_cancel)}
            </Button>
          </div>
          <p
            data-testid={`${testId}-url-message`}
            className={cn(
              "mt-1 text-micro",
              error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {error ?? t(($) => $.repo_picker.url_hint)}
          </p>
        </div>
      ) : (
        hint && (
          <p
            data-testid={`${testId}-hint`}
            className="truncate font-mono text-micro text-muted-foreground"
            title={hint}
          >
            {hint}
          </p>
        )
      )}
    </div>
  );
}
