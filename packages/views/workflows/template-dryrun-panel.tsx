"use client";

/**
 * 模板「测试运行」第一版＝渲染预览（plan 20261025 §C7 / 验收 C-4）。
 *
 * 刻意不叫"试跑"：服务端走的是与 dispatchStage 同源的 Flatten→spec→render 链，
 * 但**不创建实例 / 任务 / 评论**（零副作用，验收用三表计数不变断言）。真正的
 * 单阶段试跑要引入沙箱上下文，属于后续可选项，不混在这一版里。
 */
import { useState } from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { useDryRunWorkflowTemplate } from "@multica/core/workflow";
import type {
  DefinitionNode,
  WorkflowDefinition,
  WorkflowTemplateDryRunResponse,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../i18n";

/** 展平出所有 stage 节点（含迭代/并行块内层），作为「预览哪个阶段」的选项源。 */
function collectStages(def: WorkflowDefinition): DefinitionNode[] {
  const out: DefinitionNode[] = [];
  const walk = (list: DefinitionNode[]): void => {
    for (const node of list) {
      if (node.kind === "stage") out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(def.nodes ?? []);
  return out;
}

export function TemplateDryRunPanel({
  templateId,
  def,
  selectedNodeId,
}: {
  templateId: string;
  def: WorkflowDefinition;
  /** 画布选中块：非空且是 stage 时默认预览它，否则预览首个 stage。 */
  selectedNodeId: string;
}) {
  const { t } = useT("workflow");
  const dryRunMutation = useDryRunWorkflowTemplate();
  const stages = collectStages(def);
  // 受控值 + "选中项已不在当前 definition 里"的兜底：不回写 definition，避免编辑缓冲抖动。
  const [nodeId, setNodeId] = useState("");
  const defaultNodeId =
    nodeId ||
    (stages.some((s) => s.id === selectedNodeId) ? selectedNodeId : "") ||
    stages[0]?.id ||
    "";
  const [workitemTitle, setWorkitemTitle] = useState("");
  const [workitemGoal, setWorkitemGoal] = useState("");
  const [result, setResult] = useState<WorkflowTemplateDryRunResponse | null>(null);

  const run = async () => {
    const workitem: Record<string, string> = {};
    if (workitemTitle.trim()) workitem.title = workitemTitle.trim();
    if (workitemGoal.trim()) workitem.goal = workitemGoal.trim();
    try {
      const next = await dryRunMutation.mutateAsync({
        templateId,
        nodeId: defaultNodeId || undefined,
        workitem: Object.keys(workitem).length > 0 ? workitem : undefined,
      });
      setResult(next);
    } catch {
      // 预览失败不影响编辑缓冲：只提示，不抛（onClick 走 void run）。
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  if (stages.length === 0) return null;

  return (
    <section
      className="rounded-lg border border-surface-border bg-card p-3 space-y-2"
      data-testid="workflow-dryrun-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-caption font-semibold">{t(($) => $.editor.dry_run)}</h3>
        <Badge variant="outline" className="text-2xs">
          {t(($) => $.editor.dry_run_title)}
        </Badge>
      </div>
      <p className="text-2xs text-muted-foreground">{t(($) => $.editor.dry_run_hint)}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          {t(($) => $.editor.dry_run_node)}
          <select
            value={defaultNodeId}
            onChange={(e) => setNodeId(e.target.value)}
            className="h-7 rounded-md border border-surface-border bg-background px-1.5 text-2xs"
            aria-label={t(($) => $.editor.dry_run_node)}
            data-testid="workflow-dryrun-node"
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name || stage.id}
              </option>
            ))}
          </select>
        </label>
        <Input
          value={workitemTitle}
          placeholder={t(($) => $.detail.context_workitem)}
          onChange={(e) => setWorkitemTitle(e.target.value)}
          className="h-7 max-w-40"
          aria-label={t(($) => $.detail.context_workitem)}
          data-testid="workflow-dryrun-workitem"
        />
        <Input
          value={workitemGoal}
          placeholder={t(($) => $.editor.field_goal)}
          onChange={(e) => setWorkitemGoal(e.target.value)}
          className="h-7 max-w-40"
          aria-label={t(($) => $.editor.field_goal)}
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={dryRunMutation.isPending || !defaultNodeId}
          onClick={() => void run()}
          data-testid="workflow-dryrun-run"
        >
          <Play />
          {t(($) => $.editor.dry_run)}
        </Button>
      </div>

      {result ? (
        <div className="space-y-1.5" data-testid="workflow-dryrun-result">
          <p className="text-2xs font-medium text-muted-foreground">
            {t(($) => $.editor.dry_run_prompt)}
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-2xs">
            {result.prompt || t(($) => $.editor.dry_run_empty)}
          </pre>
          {result.warnings.length > 0 ? (
            <div className="space-y-0.5" data-testid="workflow-dryrun-warnings">
              <p className="text-2xs font-medium text-muted-foreground">
                {t(($) => $.editor.dry_run_warnings)}
              </p>
              <ul className="list-outside list-disc pl-5 text-2xs text-destructive">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
