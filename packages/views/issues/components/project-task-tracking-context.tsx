"use client";

import { createContext, useContext, type ReactNode } from "react";

const ProjectTaskTrackingContext = createContext<string | null>(null);

/** C7 任务追踪挂载时提供 projectId，看板卡片据此显示需求归属行。 */
export function ProjectTaskTrackingProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  return (
    <ProjectTaskTrackingContext.Provider value={projectId}>
      {children}
    </ProjectTaskTrackingContext.Provider>
  );
}

export function useProjectTaskTrackingId(): string | null {
  return useContext(ProjectTaskTrackingContext);
}
