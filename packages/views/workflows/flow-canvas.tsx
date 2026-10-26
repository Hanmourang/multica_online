"use client";

import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowRight, Bot, GitBranch, GripVertical, Minus, Plus, Repeat, ShieldCheck, Target, Workflow as WorkflowIcon } from "lucide-react";
import type { DefinitionNode, WorkflowDefinition } from "@multica/core/types";
import { useT } from "../i18n";
import { addStageInput, isRequiredAsset, moveNodeTo, stageNameById } from "./coco";

/**
 * 工作流可视化画布（对标 CoCo 编辑区，plan 20261024 §6）。
 *
 * 是「只读阶段流」的可交互版：块卡片渲染在一张可平移 / 可缩放的画布上，
 * 拖拽卡片即可在同列表内重排或跨容器（迭代 / 并行 / 分支）移动，拖某阶段右侧
 * 的输出口到目标阶段即可连一条输入依赖。
 *
 * 与 JSON 配置严格一致：所有结构改写都经不可变纯函数（moveNodeTo / addStageInput）
 * 产出新 definition 后由父级 `onChange` 回灌单一 JSON 文本缓冲；平移量与缩放只是
 * 临时视图态，绝不写入 definition。只读时不挂载 DndContext，退化为纯展示。
 */
export function FlowCanvas({
  def,
  readOnly = false,
  onChange,
  selectedId,
  onSelect,
  toolbar,
}: {
  def: WorkflowDefinition;
  readOnly?: boolean;
  onChange: (next: WorkflowDefinition) => void;
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** 画布头部左侧工具槽（添加块按钮组）；只读时忽略。 */
  toolbar?: ReactNode;
}) {
  const { t } = useT("workflow");
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ kind: "move" | "wire"; node: DefinitionNode } | null>(null);

  const nodes = useMemo(() => def.nodes ?? [], [def]);
  const roleNames = def.roleNames ?? {};

  // 每个节点的 {parentId, index}——拖拽落点解析的唯一坐标源（含任意深度）。
  const posMap = useMemo(() => {
    const map: Record<string, { parentId: string | null; index: number }> = {};
    const collect = (list: DefinitionNode[], parentId: string | null) => {
      list.forEach((n, i) => {
        if (!n.id) return;
        map[n.id] = { parentId, index: i };
        if (n.children?.length) collect(n.children, n.id);
      });
    };
    collect(nodes, null);
    return map;
  }, [nodes]);

  // 阶段序号（对齐原型 ①②③）：按渲染序在每个直接列表内计数，迭代块/分支内重置。
  const seqMap = useMemo(() => {
    const map: Record<string, number> = {};
    const walk = (list: DefinitionNode[]) => {
      let sc = 0;
      list.forEach((n) => {
        if (n.kind === "stage") {
          sc += 1;
          if (n.id) map[n.id] = sc;
        } else if (n.kind === "iteration") {
          walk(n.children ?? []);
        } else if (n.kind === "parallel") {
          (n.children ?? []).forEach((br) => walk(br.children ?? []));
        } else if (n.kind === "branch") {
          walk(n.children ?? []);
        }
      });
    };
    walk(nodes);
    return map;
  }, [nodes]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleStart = useCallback(
    (e: DragStartEvent) => {
      const data = e.active.data.current as { type?: string; fromStageId?: string } | undefined;
      const fromId = data?.type === "wire" ? data.fromStageId : (e.active.id as string);
      const node = fromId ? posMap[fromId] ? findNode(nodes, fromId) : null : null;
      if (node) setDrag({ kind: data?.type === "wire" ? "wire" : "move", node });
    },
    [nodes, posMap],
  );

  const handleEnd = useCallback(
    (e: DragEndEvent) => {
      setDrag(null);
      const { active, over } = e;
      if (!over) return;
      const data = active.data.current as { type?: string; fromStageId?: string } | undefined;
      const overData = over.data.current as { accept?: string; stageId?: string } | undefined;

      // 连线：把某阶段输口拖到另一阶段 → 追加一条 inputs 依赖。
      if (data?.type === "wire" && data.fromStageId) {
        const target = overData?.accept === "wire" ? overData.stageId : (posMap[over.id as string]?.parentId !== undefined ? (over.id as string) : null);
        const tid = target && findNode(nodes, target)?.kind === "stage" ? target : null;
        if (tid && tid !== data.fromStageId) {
          const src = findNode(nodes, data.fromStageId);
          const firstOut = src?.outputs?.[0];
          onChange(
            addStageInput(def, tid, {
              fromStageId: data.fromStageId,
              outputId: firstOut?.id,
              outputName: firstOut?.name,
            }),
          );
        }
        return;
      }

      // 移动：落到某块 → 插到它前面；落到容器 / 背景 → 追加到末尾。
      const activeId = active.id as string;
      const overId = over.id as string;
      if (activeId === overId) return;
      let target: { parentId: string | null; index: number } | null = posMap[overId] ?? null;
      if (!target && overId === "root-box") target = { parentId: null, index: Number.MAX_SAFE_INTEGER };
      if (!target && overId.startsWith("box-")) target = { parentId: overId.slice(4), index: Number.MAX_SAFE_INTEGER };
      if (!target) return;
      const a = posMap[activeId];
      let index = target.index;
      if (a && (target.parentId ?? null) === (a.parentId ?? null) && a.index < target.index) index = target.index - 1;
      onChange(moveNodeTo(def, activeId, target.parentId ?? null, index));
    },
    [def, nodes, onChange, posMap],
  );

  const body = (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        {toolbar ?? (
          <p className="text-xs font-medium text-muted-foreground">{t(($) => $.editor.flow_title)}</p>
        )}
        {!readOnly ? <ZoomControls zoom={zoom} setZoom={setZoom} /> : null}
      </div>
      <div className="overflow-auto" style={{ maxHeight: 420 }}>
        <div
          className="inline-flex min-w-full origin-top-left gap-2 p-3"
          style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
        >
          {nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t(($) => $.editor.empty_definition)}</p>
          ) : readOnly ? (
            nodes.map((n, i) => (
              <Fragment key={n.id ?? i}>
                {i > 0 ? <ArrowSep /> : null}
                <StaticBlock node={n} def={def} roleNames={roleNames} seqMap={seqMap} />
              </Fragment>
            ))
          ) : (
            <>
              <SortableList
                def={def}
                nodes={nodes}
                parentId={null}
                roleNames={roleNames}
                selectedId={selectedId}
                onSelect={onSelect}
                seqMap={seqMap}
              />
              <RootDropBox />
            </>
          )}
        </div>
      </div>
      {!readOnly ? (
        <p className="px-3 text-2xs text-muted-foreground">{t(($) => $.editor.canvas_hint)}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-emerald-500" />
          {t(($) => $.editor.legend_human)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-violet-500" />
          {t(($) => $.editor.legend_iteration)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-sky-500" />
          {t(($) => $.editor.legend_parallel)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-amber-500" />
          {t(($) => $.editor.legend_goal)}
        </span>
      </div>
    </div>
  );

  if (readOnly) return body;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleStart} onDragEnd={handleEnd}>
      {body}
      <DragOverlay dropAnimation={null}>
        {drag ? <OverlayChip node={drag.node} agent={roleNames[drag.node.roleId ?? ""] ?? ""} wiring={drag.kind === "wire"} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** 一个可排序列表：顶层（parentId=null）或某容器的 children。 */
function SortableList({
  def,
  nodes,
  parentId,
  roleNames,
  selectedId,
  onSelect,
  seqMap,
}: {
  def: WorkflowDefinition;
  nodes: DefinitionNode[];
  parentId: string | null;
  roleNames: Record<string, string>;
  selectedId?: string;
  onSelect?: (id: string) => void;
  seqMap: Record<string, number>;
}) {
  const ids = nodes.map((n, i) => n.id ?? `${parentId}-${i}`);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <div className="flex items-center gap-1.5">
        {nodes.map((node, i) => (
          <Fragment key={node.id ?? i}>
            {i > 0 ? <ArrowSep /> : null}
            <SortableBlock
              def={def}
              node={node}
              roleNames={roleNames}
              selectedId={selectedId}
              onSelect={onSelect}
              seqMap={seqMap}
            />
          </Fragment>
        ))}
      </div>
    </SortableContext>
  );
}

/** 单个可拖拽块：stage 卡片或容器（迭代 / 并行 / 分支）。 */
function SortableBlock({
  def,
  node,
  roleNames,
  selectedId,
  onSelect,
  seqMap,
}: {
  def: WorkflowDefinition;
  node: DefinitionNode;
  roleNames: Record<string, string>;
  selectedId?: string;
  onSelect?: (id: string) => void;
  seqMap: Record<string, number>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
    data: { type: "move" },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const selected = selectedId === node.id;

  if (node.kind === "stage") {
    return (
      <div ref={setNodeRef} style={style} className="shrink-0" {...attributes}>
        <StageChip
          node={node}
          agent={roleNames[node.roleId ?? ""] ?? ""}
          selected={selected}
          onSelect={onSelect}
          dragListeners={listeners}
          def={def}
          seq={node.id ? seqMap[node.id] : undefined}
        />
      </div>
    );
  }

  const containerKind = node.kind; // iteration | parallel | branch
  const children = node.children ?? [];
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={
        containerKind === "iteration"
          ? "flex shrink-0 flex-col rounded-lg border-2 border-dashed border-violet-400/60 bg-violet-500/5 p-2 dark:border-violet-500/40"
          : containerKind === "parallel"
            ? "flex shrink-0 flex-col rounded-lg border-2 border-dashed border-sky-400/60 bg-sky-500/5 p-2 dark:border-sky-500/40"
            : "flex shrink-0 flex-col gap-1 rounded-lg border border-sky-300/60 bg-background/60 p-1.5 dark:border-sky-500/30"
      }
    >
      <div
        {...listeners}
        className="mb-1 flex cursor-grab items-center gap-1.5 text-xs font-medium text-muted-foreground active:cursor-grabbing"
      >
        {containerKind === "iteration" ? <Repeat className="size-3.5" /> : <GitBranch className="size-3.5" />}
        <span>{node.name || node.id}</span>
      </div>
      <SortableList
        def={def}
        nodes={children}
        parentId={node.id}
        roleNames={roleNames}
        selectedId={selectedId}
        onSelect={onSelect}
        seqMap={seqMap}
      />
      <ContainerDropBox containerId={node.id} />
      {containerKind === "iteration" && node.gate ? (
        <div className="mt-1 flex items-center gap-1 rounded border border-amber-400/60 bg-amber-50 px-2 py-1 text-2xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-500">
          <ShieldCheck className="size-3" />
          <span>{node.gate.loopLabel ?? node.gate.exitLabel ?? "GATE"}</span>
        </div>
      ) : null}
    </div>
  );
}

/** 阶段卡片：带拖拽把手、连线输出口、作为连线落点。 */
function StageChip({
  node,
  agent,
  selected,
  onSelect,
  dragListeners,
  def,
  seq,
}: {
  node: DefinitionNode;
  agent: string;
  selected: boolean;
  onSelect?: (id: string) => void;
  dragListeners?: Record<string, unknown>;
  def: WorkflowDefinition;
  seq?: number;
}) {
  const { t } = useT("workflow");
  const human = node.mode === "human_loop";
  const wire = useDroppable({ id: `wire-${node.id}`, data: { accept: "wire", stageId: node.id } });
  return (
    <div
      ref={wire.setNodeRef}
      onClick={() => onSelect?.(node.id)}
      className={
        [
          "relative min-w-40 rounded-md border bg-background px-2.5 py-1.5 transition",
          wire.isOver ? "ring-2 ring-sky-400/70" : "",
          selected ? "border-emerald-500 ring-1 ring-emerald-500/50" : human ? "border-2 border-emerald-400/70 dark:border-emerald-500/50" : "border-border",
        ].join(" ")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1 text-sm">
          <span
            {...dragListeners}
            className="cursor-grab touch-none text-muted-foreground/60 active:cursor-grabbing"
            aria-label={t(($) => $.editor.canvas_hint)}
          >
            <GripVertical className="size-3.5 shrink-0" />
          </span>
          {seq ? (
            <span className="shrink-0 text-2xs font-bold text-muted-foreground/60">{circledSeq(seq)}</span>
          ) : null}
          <span className="truncate">{node.name || node.id}</span>
        </span>
        <ModeBadge human={human} />
      </div>
      <StageDetailRows node={node} def={def} agent={agent} />
      <WirePort stageId={node.id} />
    </div>
  );
}

/** 输出口：按住拖到别的阶段即可建立依赖连线。 */
function WirePort({ stageId }: { stageId: string }) {
  const { t } = useT("workflow");
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `wire-src-${stageId}`,
    data: { type: "wire", fromStageId: stageId },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={t(($) => $.editor.canvas_hint)}
      title={t(($) => $.editor.canvas_hint)}
      className={
        "absolute -right-2 top-1/2 size-3.5 -translate-y-1/2 rounded-full border-2 border-background bg-sky-500 shadow transition " +
        (isDragging ? "scale-125 opacity-40" : "hover:scale-125")
      }
    />
  );
}

/** 空容器的追加落点。 */
function ContainerDropBox({ containerId }: { containerId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `box-${containerId}`, data: { parentId: containerId } });
  return <div ref={setNodeRef} className={"h-6 shrink-0 rounded " + (isOver ? "bg-sky-500/15" : "")} />;
}

/** 顶层末尾的追加落点。 */
function RootDropBox() {
  const { setNodeRef, isOver } = useDroppable({ id: "root-box" });
  return <div ref={setNodeRef} className={"my-2 w-1 self-stretch rounded " + (isOver ? "bg-sky-500/20" : "")} />;
}

/** 拖拽跟随层。 */
function OverlayChip({ node, agent, wiring }: { node: DefinitionNode; agent: string; wiring: boolean }) {
  return (
    <div className="pointer-events-none flex items-center gap-1 rounded-md border border-sky-400 bg-background px-2.5 py-1.5 text-sm shadow-lg">
      {wiring ? <span className="size-2 rounded-full bg-sky-500" /> : <WorkflowIcon className="size-3.5 text-muted-foreground" />}
      <span className="truncate">{node.name || node.id}</span>
      {agent ? <span className="truncate text-2xs text-muted-foreground">{agent}</span> : null}
    </div>
  );
}

/** 兄弟块之间的流程箭头（对齐原型 →）。 */
function ArrowSep() {
  return <ArrowRight className="size-4 shrink-0 text-muted-foreground/40" aria-hidden />;
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
function circledSeq(n: number): string {
  return CIRCLED[n - 1] ?? `#${n}`;
}

/** 人工/自动模式 chip（可编辑与只读形态共用）。 */
function ModeBadge({ human }: { human: boolean }) {
  const { t } = useT("workflow");
  return (
    <span
      className={
        human
          ? "shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs font-medium text-emerald-600"
          : "shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground"
      }
    >
      {human ? t(($) => $.editor.mode_human) : t(($) => $.editor.mode_auto)}
    </span>
  );
}

/** 卡片明细行：智能体 / 阶段目标 / 上游依赖 / 输出产物 chips / 准入必检数。 */
function StageDetailRows({ node, def, agent }: { node: DefinitionNode; def: WorkflowDefinition; agent: string }) {
  const { t } = useT("workflow");
  const incoming = (node.inputs ?? []).filter((inp) => inp.fromStageId);
  const requiredCount = (node.inputs ?? []).filter(isRequiredAsset).length;
  const outputs = node.outputs ?? [];
  const shown = outputs.slice(0, 3);
  return (
    <>
      {agent ? (
        <p className="mt-0.5 flex items-center gap-1 truncate text-2xs text-muted-foreground">
          <Bot className="size-3 shrink-0" />
          <span className="truncate">{agent}</span>
        </p>
      ) : null}
      {node.goal ? (
        <p className="mt-0.5 flex items-center gap-1 text-2xs text-amber-700 dark:text-amber-500">
          <Target className="size-3 shrink-0" />
          <span className="truncate">{node.goal}</span>
        </p>
      ) : null}
      {incoming.length > 0 ? (
        <p className="mt-0.5 truncate text-2xs text-muted-foreground/70">
          {incoming.map((inp) => stageNameById(def, inp.fromStageId ?? "")).filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <p className="mt-1 flex flex-wrap items-center gap-1">
          {shown.map((o) => (
            <span key={o.id} className={outputChipClass(o.type)}>
              {o.name}
            </span>
          ))}
          {outputs.length > shown.length ? (
            <span className="text-2xs text-muted-foreground/70">+{outputs.length - shown.length}</span>
          ) : null}
        </p>
      ) : null}
      {requiredCount > 0 ? (
        <p className="mt-0.5 flex items-center gap-1 text-2xs text-amber-600 dark:text-amber-500">
          <ShieldCheck className="size-3 shrink-0" />
          <span>{t(($) => $.editor.admission_badge, { n: requiredCount })}</span>
        </p>
      ) : null}
    </>
  );
}

/** 产物 chip 按类型着色（对齐原型：json=绿 / markdown=紫 / 其他=中性）。 */
function outputChipClass(type?: string): string {
  const base = "max-w-28 truncate rounded px-1 py-px text-2xs ";
  if (type === "json") return base + "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500";
  if (type === "markdown") return base + "bg-violet-500/10 text-violet-700 dark:text-violet-400";
  return base + "bg-muted text-muted-foreground";
}

/** 只读块（已发布/官方模板形态）：与可编辑画布同构的完整卡片，仅去掉拖拽与连线交互。 */
function StaticBlock({
  node,
  def,
  roleNames,
  seqMap,
}: {
  node: DefinitionNode;
  def: WorkflowDefinition;
  roleNames: Record<string, string>;
  seqMap: Record<string, number>;
}) {
  if (node.kind === "stage") {
    const seq = node.id ? seqMap[node.id] : undefined;
    return (
      <div className="relative min-w-40 rounded-md border border-border bg-background px-2.5 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 text-sm">
            {seq ? (
              <span className="shrink-0 text-2xs font-bold text-muted-foreground/60">{circledSeq(seq)}</span>
            ) : null}
            <span className="truncate">{node.name || node.id}</span>
          </span>
          <ModeBadge human={node.mode === "human_loop"} />
        </div>
        <StageDetailRows node={node} def={def} agent={roleNames[node.roleId ?? ""] ?? ""} />
      </div>
    );
  }
  const children = node.children ?? [];
  return (
    <div
      className={
        node.kind === "iteration"
          ? "flex min-w-0 shrink-0 flex-col rounded-lg border-2 border-dashed border-violet-400/60 bg-violet-500/5 p-2 dark:border-violet-500/40"
          : node.kind === "parallel"
            ? "flex min-w-0 shrink-0 flex-col rounded-lg border-2 border-dashed border-sky-400/60 bg-sky-500/5 p-2 dark:border-sky-500/40"
            : "flex min-w-0 shrink-0 flex-col gap-1 rounded-lg border border-sky-300/60 bg-background/60 p-1.5 dark:border-sky-500/30"
      }
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {node.kind === "iteration" ? <Repeat className="size-3.5" /> : <GitBranch className="size-3.5" />}
        <span>{node.name || node.id}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children.map((c, i) => (
          <Fragment key={c.id ?? i}>
            {i > 0 ? <ArrowSep /> : null}
            <StaticBlock node={c} def={def} roleNames={roleNames} seqMap={seqMap} />
          </Fragment>
        ))}
      </div>
      {node.kind === "iteration" && node.gate ? (
        <div className="mt-1 flex items-center gap-1 self-center rounded border border-amber-400/60 bg-amber-50 px-2 py-1 text-2xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-500">
          <ShieldCheck className="size-3" />
          <span>{node.gate.loopLabel ?? node.gate.exitLabel ?? "GATE"}</span>
        </div>
      ) : null}
    </div>
  );
}

function ZoomControls({ zoom, setZoom }: { zoom: number; setZoom: (n: number) => void }) {
  const { t } = useT("workflow");
  const clamp = (n: number) => Math.min(1.5, Math.max(0.6, Number(n.toFixed(2))));
  const pct = Math.round(zoom * 100);
  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label={t(($) => $.editor.zoom_out)} title={t(($) => $.editor.zoom_out)} onClick={() => setZoom(clamp(zoom - 0.1))} className="inline-flex size-6 items-center justify-center rounded hover:bg-accent/60">
        <Minus className="size-3.5" />
      </button>
      <span className="w-10 text-center text-2xs tabular-nums text-muted-foreground">{`${pct}%`}</span>
      <button type="button" aria-label={t(($) => $.editor.zoom_in)} title={t(($) => $.editor.zoom_in)} onClick={() => setZoom(clamp(zoom + 0.1))} className="inline-flex size-6 items-center justify-center rounded hover:bg-accent/60">
        <Plus className="size-3.5" />
      </button>
      <button type="button" aria-label={t(($) => $.editor.reset_view)} title={t(($) => $.editor.reset_view)} onClick={() => setZoom(1)} className="ml-1 text-2xs text-muted-foreground hover:text-foreground">
        {t(($) => $.editor.reset_view)}
      </button>
    </div>
  );
}

// 在 definition 树任意深度查找节点。
function findNode(list: DefinitionNode[], id: string): DefinitionNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    const hit = n.children ? findNode(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}
