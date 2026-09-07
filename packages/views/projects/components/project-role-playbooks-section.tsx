"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { RolePlaybookDialog } from "../../issues/components/role-playbook-dialog";
import {
  ROLE_PLAYBOOK_ORDER,
  emptyRolePlaybook,
  overridePlaybook,
  playbookHasOverride,
  resolvedPlaybook,
  withOverride,
  type RolePlaybookKey,
} from "../../issues/components/role-playbook";

export function ProjectRolePlaybooksSection({ projectId }: { projectId: string }) {
  const { t } = useT("projects");
  const { t: ti } = useT("issues");
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<RolePlaybookKey | null>(null);
  const { data: bundle } = useQuery({
    queryKey: issueKeys.projectRolePlaybooks(projectId),
    queryFn: () => api.listProjectRolePlaybooks(projectId),
  });

  const save = async (role: RolePlaybookKey, override: ReturnType<typeof emptyRolePlaybook>) => {
    if (!bundle) return;
    const next = withOverride(bundle, role, override);
    try {
      await api.replaceProjectRolePlaybooks(projectId, next.overrides);
      await qc.invalidateQueries({
        queryKey: issueKeys.projectRolePlaybooks(projectId),
      });
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.role_playbooks.save_failed),
      );
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.role_playbooks.section_header)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-1 pl-2">
          <p className="px-2 text-micro text-muted-foreground">
            {t(($) => $.role_playbooks.hint)}
          </p>
          {ROLE_PLAYBOOK_ORDER.map((role) => {
            const customized = playbookHasOverride(overridePlaybook(bundle, role));
            return (
              <button
                key={role}
                type="button"
                data-testid={`project-playbook-${role}`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
                onClick={() => setEditing(role)}
              >
                <span className="min-w-0 flex-1 truncate text-caption">
                  {ti(($) => $.role_strip[role])}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 text-micro",
                    customized ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <Settings2 className="size-3" />
                  {customized
                    ? t(($) => $.role_playbooks.customized)
                    : t(($) => $.role_playbooks.builtin)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {editing && bundle && (
        <RolePlaybookDialog
          role={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          resolved={resolvedPlaybook(bundle, editing)}
          override={overridePlaybook(bundle, editing)}
          builtin={bundle.builtins[editing] ?? emptyRolePlaybook(editing)}
          onSave={(next) => void save(editing, next)}
        />
      )}
    </div>
  );
}
