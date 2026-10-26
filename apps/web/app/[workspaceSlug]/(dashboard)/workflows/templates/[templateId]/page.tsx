"use client";

import { use } from "react";
import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
import { WorkflowTemplateEditorPage } from "@multica/views/workflows";

export default function Page({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = use(params);
  return (
    <ErrorBoundary>
      <WorkflowTemplateEditorPage templateId={templateId} />
    </ErrorBoundary>
  );
}
