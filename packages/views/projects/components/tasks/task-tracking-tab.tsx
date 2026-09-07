"use client";

import { ExternalLink } from "lucide-react";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";

/** C7 任务追踪：复用项目 IssueSurface，仅加「在工作区任务中查看」。 */
export function TaskTrackingToolbar() {
  const { t } = useT("archive");
  const paths = useWorkspacePaths();
  return (
    <div className="flex justify-end border-b border-surface-border px-4 py-1.5">
      <AppLink href={paths.issues()}>
        <Button size="xs" variant="ghost">
          <ExternalLink className="size-3.5" />
          {t(($) => $.tasks.view_in_workspace)}
        </Button>
      </AppLink>
    </div>
  );
}
