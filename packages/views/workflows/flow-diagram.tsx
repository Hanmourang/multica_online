"use client";

import { ArrowRight, Bot, GitBranch, Repeat, ShieldCheck, Workflow as WorkflowIcon } from "lucide-react";
import type { DefinitionNode, WorkflowDefinition } from "@multica/core/types";
import { useT } from "../i18n";

/**
 * 只读阶段流（plan 20261024 §6 P1，对标 CoCo 编辑器「阶段流」条）。
 *
 * 把 CoCo 嵌套 definition 递归渲染成横向流程：顶层块以 → 串联；iteration 画成
 * 紫色虚线框（子阶段横排 + 末尾 GATE 门），parallel 画成蓝色虚线框（各 branch 纵向
 * 堆叠、分支内子阶段横排），stage 画成带模式徽标与智能体的卡片。纯展示、无拖拽，
 * 避免引入画布重依赖；编辑在下方逐阶段表单里进行。
 */
export function WorkflowFlowDiagram({ definition }: { definition: WorkflowDefinition }) {
  const { t } = useT("workflow");
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const roleNames = definition?.roleNames ?? {};

  if (nodes.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <p className="text-sm text-muted-foreground">{t(($) => $.editor.empty_definition)}</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3">
      <p className="text-xs font-medium text-muted-foreground">{t(($) => $.editor.flow_title)}</p>
      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        {nodes.map((node, i) => (
          <div key={node.id ?? i} className="flex shrink-0 items-center gap-1">
            <FlowBlock node={node} roleNames={roleNames} />
            {i < nodes.length - 1 ? <ArrowRight className="size-4 shrink-0 text-muted-foreground" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowBlock({ node, roleNames }: { node: DefinitionNode; roleNames: Record<string, string> }) {
  const { t } = useT("workflow");

  if (node.kind === "stage") {
    return <StageCard node={node} agent={roleNames[node.roleId ?? ""] ?? ""} />;
  }

  if (node.kind === "iteration") {
    return (
      <div className="flex flex-col rounded-lg border-2 border-dashed border-violet-400/60 bg-violet-500/5 p-2 dark:border-violet-500/40">
        <BlockHeader icon={<Repeat className="size-3.5" />} kind={t(($) => $.editor.kind_iteration)} name={node.name} />
        <div className="flex items-center gap-1">
          {(node.children ?? []).map((child, i, arr) => (
            <div key={child.id ?? i} className="flex items-center gap-1">
              <FlowBlock node={child} roleNames={roleNames} />
              {i < arr.length - 1 ? <ArrowRight className="size-3.5 shrink-0 text-faint-foreground" /> : null}
            </div>
          ))}
          {node.gate ? (
            <div className="flex items-center gap-1">
              <ArrowRight className="size-3.5 shrink-0 text-faint-foreground" />
              <GateChip
                loop={node.gate.loopLabel}
                exit={node.gate.exitLabel}
                label={t(($) => $.editor.gate_label)}
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // parallel / branch：容器纵向堆叠子块（并行降级为视觉分组，语义仍是汇聚）。
  const isParallel = node.kind === "parallel";
  return (
    <div
      className={
        isParallel
          ? "flex flex-col rounded-lg border-2 border-dashed border-sky-400/60 bg-sky-500/5 p-2 dark:border-sky-500/40"
          : "flex flex-col gap-1 rounded-lg border border-sky-300/60 bg-background/60 p-1.5 dark:border-sky-500/30"
      }
    >
      {isParallel ? (
        <BlockHeader icon={<GitBranch className="size-3.5" />} kind={t(($) => $.editor.kind_parallel)} name={node.name} />
      ) : (
        <span className="mb-0.5 truncate text-2xs text-muted-foreground">{node.name}</span>
      )}
      <div className="flex flex-col gap-1">
        {(node.children ?? []).map((child, i) => (
          <div key={child.id ?? i}>
            <FlowBlock node={child} roleNames={roleNames} />
          </div>
        ))}
      </div>
    </div>
  );
}

function BlockHeader({ icon, kind, name }: { icon: React.ReactNode; kind: string; name?: string }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {icon}
      <span>{kind}</span>
      {name ? <span className="truncate">· {name}</span> : null}
    </div>
  );
}

function StageCard({ node, agent }: { node: DefinitionNode; agent: string }) {
  const { t } = useT("workflow");
  const human = node.mode === "human_loop";
  return (
    <div
      className={
        human
          ? "min-w-40 rounded-md border-2 border-emerald-400/70 bg-background px-2.5 py-1.5 dark:border-emerald-500/50"
          : "min-w-40 rounded-md border border-border bg-background px-2.5 py-1.5"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 truncate text-sm">
          <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name || node.id}</span>
        </span>
        <span
          className={
            human
              ? "shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs font-medium text-emerald-600"
              : "shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground"
          }
        >
          {human ? t(($) => $.editor.mode_human) : t(($) => $.editor.mode_auto)}
        </span>
      </div>
      {agent ? (
        <p className="mt-0.5 flex items-center gap-1 truncate text-2xs text-muted-foreground">
          <Bot className="size-3 shrink-0" />
          <span className="truncate">{agent}</span>
        </p>
      ) : null}
    </div>
  );
}

function GateChip({ loop, exit, label }: { loop?: string; exit?: string; label: string }) {
  return (
    <div className="min-w-36 rounded-md border border-amber-400/70 bg-amber-50 px-2.5 py-1.5 dark:border-amber-500/40 dark:bg-amber-500/10">
      <div className="flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-500">
        <ShieldCheck className="size-3.5" />
        <span>{label}</span>
      </div>
      <p className="mt-0.5 truncate text-2xs text-muted-foreground">
        {loop}
        {exit ? ` / ${exit}` : ""}
      </p>
    </div>
  );
}
