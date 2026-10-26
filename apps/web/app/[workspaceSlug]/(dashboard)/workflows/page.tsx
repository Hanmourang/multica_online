"use client";

import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
import { WorkflowsPage } from "@multica/views/workflows";

export default function Page() {
  return (
    <ErrorBoundary>
      <WorkflowsPage />
    </ErrorBoundary>
  );
}
