"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { useT } from "../../../i18n";
import { DeliverablesOverview } from "./deliverables-overview";
import { ProgressTracker } from "./progress-tracker";
import { RequirementDynamics } from "./requirement-dynamics";

/**
 * 需求下钻 Tab 容器 — the cohesion point for f7/f8/f9.
 *
 * issue-detail.tsx is a single-scroll surface (title → description →
 * sub-issues → timeline), not a tab host, so the drill views live in this
 * self-contained section instead of restructuring the page. It renders above
 * the existing Activity timeline and leaves every existing block untouched;
 * each tab owns its queries and its loading / error / empty states.
 */
export function IssueRequirementDrill({
  issueId,
  projectId,
}: {
  issueId: string;
  projectId?: string | null;
}) {
  const { t } = useT("archive");

  return (
    <section aria-label={t(($) => $.drill.section_label)} className="mt-8">
      <Tabs defaultValue="dynamics">
        <TabsList variant="line">
          <TabsTrigger value="dynamics">
            {t(($) => $.tabs.dynamics)}
          </TabsTrigger>
          <TabsTrigger value="progress">
            {t(($) => $.tabs.progress)}
          </TabsTrigger>
          <TabsTrigger value="deliverables">
            {t(($) => $.tabs.deliverables)}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="dynamics" className="mt-3">
          <RequirementDynamics issueId={issueId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="progress" className="mt-3">
          <ProgressTracker issueId={issueId} />
        </TabsContent>
        <TabsContent value="deliverables" className="mt-3">
          <DeliverablesOverview issueId={issueId} projectId={projectId} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
