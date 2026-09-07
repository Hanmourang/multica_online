"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import type { RoleAssignment } from "@multica/core/types";
import { useT } from "../../i18n";
import { RoleStrip } from "../../issues/components/role-strip";
import { toRosterPutBody } from "../../issues/components/role-roster";
import { withOverride } from "../../issues/components/role-playbook";

export function ProjectRoleDefaultsSection({ projectId }: { projectId: string }) {
  const { t } = useT("projects");
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const { data: roster } = useQuery({
    queryKey: issueKeys.projectRoleDefaults(projectId),
    queryFn: () => api.listProjectRoleDefaults(projectId),
  });
  const { data: playbooks } = useQuery({
    queryKey: issueKeys.projectRolePlaybooks(projectId),
    queryFn: () => api.listProjectRolePlaybooks(projectId),
  });
  const [entries, setEntries] = useState<RoleAssignment[]>(roster?.roles ?? []);

  useEffect(() => {
    setEntries(roster?.roles ?? []);
  }, [roster?.roles]);

  const save = async (next: RoleAssignment[]) => {
    setEntries(next);
    try {
      await api.replaceProjectRoleDefaults(projectId, toRosterPutBody(next));
      await qc.invalidateQueries({
        queryKey: issueKeys.projectRoleDefaults(projectId),
      });
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.role_defaults.save_failed),
      );
    }
  };

  return (
    <div data-testid="project-role-defaults">
      <button
        type="button"
        className={`mb-2 flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.role_defaults.section_header)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-1 pl-2">
          <p className="px-2 text-micro text-muted-foreground">
            {t(($) => $.role_defaults.hint)}
          </p>
          <RoleStrip
            entries={entries}
            onChange={(next) => void save(next)}
            className="flex-col"
            playbooks={playbooks}
            onPlaybookChange={(role, override) => {
              if (!playbooks) return;
              void (async () => {
                try {
                  const next = withOverride(playbooks, role, override);
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
              })();
            }}
          />
        </div>
      )}
    </div>
  );
}
