import { useParams } from "react-router-dom";
import { WorkflowTemplateEditorPage as WorkflowTemplateEditor } from "@multica/views/workflows";

export function WorkflowTemplateEditorPage() {
  const { templateId } = useParams<{ templateId: string }>();
  if (!templateId) return null;
  return <WorkflowTemplateEditor templateId={templateId} />;
}
