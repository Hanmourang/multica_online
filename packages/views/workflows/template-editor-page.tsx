"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, Copy, GitBranch, Lock, Plus, Repeat, ShieldCheck, Trash2, Workflow as WorkflowIcon, X } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import { projectListOptions } from "@multica/core/projects";
import {
  useCreateWorkflowTemplate,
  usePublishWorkflowTemplate,
  useSetWorkflowTemplateEnforce,
  useUpdateWorkflowTemplateDefinition,
  workflowKeys,
  workspaceTemplatesOptions,
} from "@multica/core/workflow";
import type {
  DefinitionGate,
  DefinitionInput,
  DefinitionNode,
  DefinitionOutput,
  WorkflowDefinition,
  WorkflowTemplate,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../i18n";
import { AppLink, useNavigation } from "../navigation";
import { QueryError, QueryLoading } from "../projects/components/archive/query-states";
import {
  TemplateStatusBadge,
  formatDateTime,
} from "../projects/components/workflows/workflow-shared";
import {
  addChildNode,
  addRequiredAsset,
  addStageInput,
  addTopNode,
  countBlocks,
  definitionFromTemplate,
  isRequiredAsset,
  listStageOutputs,
  moveNode,
  parseDefinition,
  removeInputAt,
  removeNode,
  roleName,
  setInputRequired,
  setRoleName,
  setStageField,
  stageNameById,
  validateCocoDefinition,
} from "./coco";
import { FlowCanvas } from "./flow-canvas";
import { TemplateControlTab } from "./template-control-tab";
import { TemplateDryRunPanel } from "./template-dryrun-panel";

/**
 * 工作区级模板编辑器（对标 CoCo /workflows/templates/:tid，plan 20261024 §6）。
 *
 * 单一权威缓冲是 JSON 文本：JSON TAB 直接编辑它，可视化 TAB 的表单以结构化方式
 * 改写同一文本（不可变克隆 → 重新序列化），二者永不漂移。保存只提交已解析且
 * 前端校验通过的 definition；服务端 ValidateWorkflowDefinition + 展平是最终事实源。
 * 官方 / 已归档模板只读（对齐 handler 409）。enforce 与 publish 复用既有 mutation。
 */
export function WorkflowTemplateEditorPage({ templateId }: { templateId: string }) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { getActorName } = useActorName();

  const galleryQuery = useQuery(workspaceTemplatesOptions(wsId));
  const archivedQuery = useQuery(workspaceTemplatesOptions(wsId, { status: "archived" }));

  const template = useMemo<WorkflowTemplate | undefined>(() => {
    const all = [
      ...(galleryQuery.data?.templates ?? []),
      ...(archivedQuery.data?.templates ?? []),
    ];
    return all.find((tpl) => tpl.id === templateId);
  }, [galleryQuery.data, archivedQuery.data, templateId]);

  const isLoading = galleryQuery.isPending && archivedQuery.isPending;

  const [text, setText] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  useEffect(() => {
    if (!template || loadedId === template.id) return;
    setText(seedText(template));
    setLoadedId(template.id);
    setSelectedId("");
  }, [template, loadedId]);

  const parsed = useMemo(() => {
    try {
      const def = parseDefinition(text);
      return { def, errors: validateCocoDefinition(def), ok: true as const };
    } catch {
      return { def: null, errors: [t(($) => $.editor.invalid_json)], ok: false as const };
    }
  }, [text, t]);

  const readOnly = Boolean(template?.official) || template?.status === "archived";
  const canSave = !readOnly && parsed.ok && parsed.errors.length === 0;

  const defMutation = useUpdateWorkflowTemplateDefinition();
  const handleSave = async () => {
    if (!template || !parsed.ok || parsed.errors.length > 0) return;
    try {
      await defMutation.mutateAsync({
        templateId: template.id,
        data: { definition: parsed.def },
      });
      toast.success(t(($) => $.editor.saved));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.editor.invalid_json));
    }
  };

  // 可视化 TAB 的一切改写都产出新 definition 回灌单一 JSON 文本缓冲（不可变）。
  const commit = (next: WorkflowDefinition) => setText(JSON.stringify(next, null, 2));
  const patchField = (id: string, patch: Partial<DefinitionNode>) => {
    if (parsed.def) commit(patchNode(parsed.def, id, patch));
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <QueryLoading rows={4} />
      </div>
    );
  }

  if (!template) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <AppLink href={p.workflows()} className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:underline">
          <ArrowLeft className="size-3.5" />
          {t(($) => $.editor.back)}
        </AppLink>
        <QueryError onRetry={() => void galleryQuery.refetch()} message={String(galleryQuery.error ?? "not found")} />
      </div>
    );
  }

  const visualDef = parsed.def;
  // 模板归属项目：驱动 inspector 的「去资产模块」链接（§C5）。
  const projectId = template.project_id ?? "";
  const blocks = visualDef
    ? countBlocks(visualDef)
    : { stages: 0, gates: 0, iterations: 0, parallels: 0 };

  // inspector 数据源：选中块在其父列表中的位置（供 NodeEditor 的上移/下移/删除）。
  // 组件上方存在早退分支，此处不用 useMemo 以免违反 hooks 顺序规则；递归开销可忽略。
  const selectedPos = visualDef ? findNodePos(visualDef, selectedId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6" data-testid="workflow-template-editor">
      <Header
        template={template}
        creator={getActorName(template.created_by_type, template.created_by_id)}
        onBack={p.workflows()}
      />

      {readOnly ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Banner tone="muted">
            {template.official
              ? t(($) => $.editor.readonly_official)
              : t(($) => $.editor.readonly_archived)}
          </Banner>
          <CloneAsDraftButton template={template} definition={visualDef} />
        </div>
      ) : template.status === "published" ? (
        <Banner tone="muted">{t(($) => $.editor.published_hint)}</Banner>
      ) : null}

      <Tabs defaultValue="visual" className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line">
          <TabsTrigger value="visual">{t(($) => $.editor.tab_visual)}</TabsTrigger>
          <TabsTrigger value="json">{t(($) => $.editor.tab_json)}</TabsTrigger>
          <TabsTrigger value="control">{t(($) => $.editor.tab_control)}</TabsTrigger>
        </TabsList>

        {/* 流程把控：原型把「这条模板跑到哪些需求上了」放在编辑器的第三页，而不是另开
            路由——复用 WorkflowInstanceDetail，运行视图保持单一事实源（§A2）。 */}
        <TabsContent value="control" className="mt-3 flex min-h-0 flex-1 flex-col">
          <TemplateControlTab template={template} />
        </TabsContent>

        <TabsContent value="json" className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
          <p className="text-caption text-muted-foreground">{t(($) => $.editor.json_label)}</p>
          <Textarea
            value={text}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            className="min-h-0 flex-1 resize-none font-mono text-micro"
            aria-label={t(($) => $.editor.json_label)}
          />
          <ValidationPanel errors={parsed.errors} />
            <div className="flex items-center justify-end gap-2">
              <SaveButton
                saving={defMutation.isPending}
                disabled={!canSave}
                onSave={() => void handleSave()}
              />
            </div>
        </TabsContent>

        <TabsContent value="visual" className="mt-3 min-h-0 flex-1 overflow-auto">
          {visualDef ? (
            // 原型式布局：左=工具栏+画布+图例，右=420px 级 inspector（选中阶段配置）。
            <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_400px]">
              <div className="flex min-w-0 flex-col gap-2">
                <FlowCanvas
                  def={visualDef}
                  readOnly={readOnly}
                  onChange={commit}
                  selectedId={selectedId || undefined}
                  onSelect={setSelectedId}
                  toolbar={
                    !readOnly ? (
                      <BlockToolbar onAdd={(kind) => commit(addTopNode(visualDef, kind))} />
                    ) : undefined
                  }
                />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
                  <span>{t(($) => $.editor.seg_stages)}: {blocks.stages}</span>
                  <span>{t(($) => $.editor.seg_parallel)}: {blocks.parallels}</span>
                  <span>{t(($) => $.editor.seg_iteration)}: {blocks.iterations}</span>
                </div>
              </div>
              <aside className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-0">
                {selectedPos ? (
                  <NodeEditor
                    def={visualDef}
                    projectId={projectId}
                    node={selectedPos.node}
                    index={selectedPos.index}
                    total={selectedPos.total}
                    isTop={selectedPos.isTop}
                    readOnly={readOnly}
                    commit={commit}
                    patchField={patchField}
                    selectedId={selectedId}
                  />
                ) : (
                  <div className="rounded-lg border border-surface-border bg-card p-3 text-caption text-muted-foreground">
                    {t(($) => $.editor.inspector_hint)}
                  </div>
                )}
                <details className="rounded-lg border border-surface-border bg-card p-3">
                  <summary className="cursor-pointer text-caption font-medium">
                    {t(($) => $.editor.block_tree)}
                  </summary>
                  <div className="mt-2 flex flex-col gap-3">
                    <NodeTree
                      def={visualDef}
                      projectId={projectId}
                      readOnly={readOnly}
                      commit={commit}
                      patchField={patchField}
                      selectedId={selectedId}
                    />
                  </div>
                </details>
                {/* 「测试运行」＝同源渲染链的零副作用预览（§C7）：不建实例/任务/评论，
                    所以编辑态随时可跑，产物只有渲染后的 prompt 与未解析变量告警。 */}
                <TemplateDryRunPanel
                  templateId={template.id}
                  def={visualDef}
                  selectedNodeId={selectedId}
                />
                <div className="flex items-center justify-end gap-2">
                  <SaveButton
                    saving={defMutation.isPending}
                    disabled={!canSave}
                    onSave={() => void handleSave()}
                  />
                </div>
              </aside>
            </div>
          ) : (
            <Banner tone="warn">{t(($) => $.editor.fix_json_first)}</Banner>
          )}
        </TabsContent>
      </Tabs>

      <BottomBar template={template} />
    </div>
  );
}

/**
 * 克隆为草稿：官方/已归档模板只读，一键在当前工作区选定的项目下建一份同
 * definition 的草稿副本（对齐 CoCo「克隆为新草稿」）。创建走项目级端点。
 */
function CloneAsDraftButton({
  template,
  definition,
}: {
  template: WorkflowTemplate;
  definition: WorkflowDefinition | null;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const navigate = useNavigation();
  const projectsQuery = useQuery(projectListOptions(wsId));
  const projects = projectsQuery.data ?? [];
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const createMutation = useCreateWorkflowTemplate(projectId);

  const effective = projectId || template.project_id || projects[0]?.id || "";
  const canSubmit = Boolean(effective) && name.trim().length > 0 && Boolean(definition) && !createMutation.isPending;

  const openDialog = () => {
    setName(`${template.name}（副本）`);
    setProjectId(template.project_id ?? "");
    setOpen(true);
  };

  const submit = async () => {
    if (!definition || !effective || !name.trim()) return;
    try {
      const created = await createMutation.mutateAsync({
        name: name.trim(),
        description: template.description ?? null,
        nodes: [],
        definition: { ...definition, name: name.trim() },
        enforce: false,
      });
      toast.success(t(($) => $.toast.template_created));
      setOpen(false);
      navigate.push(p.workflowTemplate(created.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.toast.action_failed));
    }
  };

  return (
    <>
      <Button type="button" size="xs" variant="outline" disabled={!definition} onClick={openDialog}>
        <Copy />
        {t(($) => $.editor.clone_draft)}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.editor.clone_draft)}</DialogTitle>
            <DialogDescription>{t(($) => $.gallery.pick_project)}</DialogDescription>
          </DialogHeader>
          {projects.length === 0 && !projectsQuery.isPending ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.gallery.no_projects)}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-caption">
                <span className="text-muted-foreground">{t(($) => $.gallery.project)}</span>
                <select
                  value={effective}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="h-9 rounded-md border border-surface-border bg-background px-2 text-caption"
                >
                  {projects.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-caption">
                <span className="text-muted-foreground">{t(($) => $.gallery.name_label)}</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t(($) => $.actions.cancel)}
            </Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
              {t(($) => $.gallery.create)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Header({
  template,
  creator,
  onBack,
}: {
  template: WorkflowTemplate;
  creator: string;
  onBack: string;
}) {
  const { t } = useT("workflow");
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <AppLink href={onBack} className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:underline">
          <ArrowLeft className="size-3.5" />
          {t(($) => $.editor.back)}
        </AppLink>
        <h1 className="mt-1 flex items-center gap-2 text-title font-semibold">
          <span className="truncate">{template.name}</span>
          <TemplateStatusBadge status={template.status} />
          {template.official ? (
            <Badge variant="secondary">{t(($) => $.badges.official)}</Badge>
          ) : null}
          {template.enforce ? (
            <Badge variant="default" className="gap-1">
              <Lock className="size-3" />
              {t(($) => $.gallery.enforced)}
            </Badge>
          ) : null}
        </h1>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.editor.created_by)} {creator} · {t(($) => $.editor.updated)} {formatDateTime(template.updated_at)}
        </p>
      </div>
    </div>
  );
}

interface TreeProps {
  def: WorkflowDefinition;
  /**
   * 模板归属项目：inspector 的必检项要据此生成「去资产模块」链接（§C5）。
   * 工作区级官方模板没有 project_id，此时传空串，链接退到工作区资产聚合页。
   */
  projectId: string;
  readOnly: boolean;
  commit: (next: WorkflowDefinition) => void;
  patchField: (id: string, patch: Partial<DefinitionNode>) => void;
  selectedId?: string;
}

/** 定位选中块：返回节点及其在父列表中的 index/total（顶层 isTop=true）。 */
function findNodePos(
  def: WorkflowDefinition,
  id: string,
): { node: DefinitionNode; index: number; total: number; isTop: boolean } | null {
  if (!id) return null;
  const top = def.nodes ?? [];
  const ti = top.findIndex((n) => n.id === id);
  const tn = ti >= 0 ? top[ti] : undefined;
  if (tn) return { node: tn, index: ti, total: top.length, isTop: true };
  const walk = (
    list: DefinitionNode[],
  ): { node: DefinitionNode; index: number; total: number; isTop: boolean } | null => {
    for (const n of list) {
      const ch = n.children ?? [];
      const ci = ch.findIndex((c) => c.id === id);
      const cn = ci >= 0 ? ch[ci] : undefined;
      if (cn) return { node: cn, index: ci, total: ch.length, isTop: false };
      const hit = walk(ch);
      if (hit) return hit;
    }
    return null;
  };
  return walk(top);
}

/** 顶层块列表（可视化块树的根）。 */
function NodeTree({ def, projectId, readOnly, commit, patchField, selectedId }: TreeProps) {
  const arr = def.nodes ?? [];
  return (
    <div className="flex flex-col gap-3">
      {arr.map((node, i) => (
        <NodeEditor
          key={node.id ?? i}
          def={def}
          projectId={projectId}
          node={node}
          index={i}
          total={arr.length}
          isTop
          readOnly={readOnly}
          commit={commit}
          patchField={patchField}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}

function NodeEditor({
  def,
  projectId,
  node,
  index,
  total,
  isTop,
  readOnly,
  commit,
  patchField,
  selectedId,
}: TreeProps & { node: DefinitionNode; index: number; total: number; isTop: boolean }) {
  const { t } = useT("workflow");
  const canDelete = !isTop || total > 1;
  const ring = selectedId && node.id === selectedId ? " ring-1 ring-emerald-500/50" : "";
  const nameInput = (
    <Input
      value={node.name ?? ""}
      readOnly={readOnly}
      placeholder={t(($) => $.editor.field_name)}
      onChange={(e) => patchField(node.id, { name: e.target.value })}
      className="h-8 max-w-64 font-medium"
      aria-label={t(($) => $.editor.field_name)}
    />
  );
  const actions = !readOnly ? (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <IconBtn disabled={index === 0} onClick={() => commit(moveNode(def, node.id, "up"))} label={t(($) => $.editor.move_up)}>
        <ArrowUp className="size-3.5" />
      </IconBtn>
      <IconBtn disabled={index === total - 1} onClick={() => commit(moveNode(def, node.id, "down"))} label={t(($) => $.editor.move_down)}>
        <ArrowDown className="size-3.5" />
      </IconBtn>
      <IconBtn disabled={!canDelete} danger onClick={() => commit(removeNode(def, node.id))} label={t(($) => $.editor.delete_node)}>
        <Trash2 className="size-3.5" />
      </IconBtn>
    </div>
  ) : null;

  if (node.kind === "stage") {
    return (
      <div className={"rounded-lg border border-surface-border bg-card p-3" + ring}>
        <div className="mb-2 flex items-center gap-2">
          <KindIcon kind="stage" />
          {nameInput}
          {actions}
        </div>
        <StageBody
          def={def}
          projectId={projectId}
          node={node}
          readOnly={readOnly}
          commit={commit}
          patchField={patchField}
        />
      </div>
    );
  }

  const wrapCls =
    node.kind === "iteration"
      ? "rounded-lg border-2 border-dashed border-violet-400/60 bg-violet-500/5 p-3 dark:border-violet-500/40"
      : node.kind === "parallel"
        ? "rounded-lg border-2 border-dashed border-sky-400/60 bg-sky-500/5 p-3 dark:border-sky-500/40"
        : "rounded-lg border border-sky-300/60 bg-background/60 p-3 dark:border-sky-500/30";
  const addKind: DefinitionNode["kind"] = node.kind === "parallel" ? "branch" : "stage";
  const addLabel = node.kind === "parallel" ? t(($) => $.editor.add_branch) : t(($) => $.editor.add_stage);
  return (
    <div className={wrapCls + ring}>
      <div className="mb-2 flex items-center gap-2">
        <KindIcon kind={node.kind} />
        {nameInput}
        {actions}
      </div>
      <ChildList
        def={def}
        projectId={projectId}
        parent={node}
        readOnly={readOnly}
        commit={commit}
        patchField={patchField}
      />
      {!readOnly ? (
        <div className="mt-2">
          <Button type="button" size="xs" variant="outline" onClick={() => commit(addChildNode(def, node.id, addKind))}>
            <Plus />
            {addLabel}
          </Button>
        </div>
      ) : null}
      {node.kind === "iteration" && node.gate ? (
        <div className="mt-2">
          <GateForm
            iterationName={node.name}
            gate={node.gate}
            readOnly={readOnly}
            onPatch={(next) => patchField(node.id, { gate: next })}
          />
        </div>
      ) : null}
    </div>
  );
}

function ChildList({ def, projectId, parent, readOnly, commit, patchField, selectedId }: TreeProps & { parent: DefinitionNode }) {
  const arr = parent.children ?? [];
  if (arr.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {arr.map((c, i) => (
        <NodeEditor
          key={c.id ?? i}
          def={def}
          projectId={projectId}
          node={c}
          index={i}
          total={arr.length}
          isTop={false}
          readOnly={readOnly}
          commit={commit}
          patchField={patchField}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}

function StageBody({
  def,
  projectId,
  node,
  readOnly,
  commit,
  patchField,
}: {
  def: WorkflowDefinition;
  projectId: string;
  node: DefinitionNode;
  readOnly: boolean;
  commit: (next: WorkflowDefinition) => void;
  patchField: (id: string, patch: Partial<DefinitionNode>) => void;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const mode = node.mode === "human_loop" ? "human_loop" : "auto";
  const agent = roleName(def, node.roleId);
  // 只列未归档智能体：归档的不可被新阶段引用（已选中的旧值仍由兼容 option 回显）。
  const agents = (useQuery(agentListOptions(wsId)).data ?? []).filter(
    (item) => !item.archived_at,
  );
  return (
    <div className="flex flex-col gap-3" data-testid={`workflow-editor-stage-${node.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-surface-border">
          <ModeButton active={mode === "auto"} disabled={readOnly} onClick={() => patchField(node.id, { mode: "auto" })}>
            {t(($) => $.editor.mode_auto)}
          </ModeButton>
          <ModeButton active={mode === "human_loop"} disabled={readOnly} onClick={() => patchField(node.id, { mode: "human_loop" })}>
            {t(($) => $.editor.mode_human)}
          </ModeButton>
        </div>
        <p className="text-2xs text-muted-foreground">{t(($) => $.editor.mode_hint)}</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-caption font-medium">{t(($) => $.editor.field_agent)}</span>
          {/* 执行智能体改为目录下拉（plan 20261025 §C6）：旧模板的自由文本 roleId
              不在目录中时保留一个可回显 option，避免下拉把已有值静默清掉。 */}
          <select
            value={node.roleId ?? ""}
            disabled={readOnly}
            onChange={(e) => {
              const nextId = e.target.value;
              const picked = agents.find((item) => item.id === nextId);
              // 一次 commit 写完：两次基于同一 parsed.def 的改写会互相覆盖。
              let next = patchNode(def, node.id, { roleId: nextId });
              // 显示名自动带出（仍可编辑）：只在模板尚未自定义时写入。
              if (picked && !roleName(next, nextId)) next = setRoleName(next, nextId, picked.name);
              commit(next);
            }}
            className="h-8 rounded-md border border-surface-border bg-background px-2 text-caption disabled:opacity-60"
            aria-label={t(($) => $.editor.field_agent)}
            data-testid={`workflow-editor-agent-${node.id}`}
          >
            <option value="">{t(($) => $.editor.agent_none)}</option>
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            {node.roleId && !agents.some((item) => item.id === node.roleId) ? (
              <option value={node.roleId}>{node.roleId}</option>
            ) : null}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-caption font-medium">{t(($) => $.editor.agent_name)}</span>
          <Input
            value={agent}
            readOnly={readOnly || !node.roleId}
            placeholder={t(($) => $.editor.agent_name_hint)}
            onChange={(e) => {
              if (node.roleId) commit(setRoleName(def, node.roleId, e.target.value));
            }}
            className="h-8"
            aria-label={t(($) => $.editor.agent_name)}
            data-testid={`workflow-editor-agent-name-${node.id}`}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-caption font-medium">{t(($) => $.editor.field_prompt)}</span>
        <Textarea
          value={node.prompt ?? ""}
          readOnly={readOnly}
          placeholder={t(($) => $.editor.field_prompt)}
          onChange={(e) => patchField(node.id, { prompt: e.target.value })}
          className="min-h-20 resize-y text-micro"
          aria-label={t(($) => $.editor.field_prompt)}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-caption font-medium">{t(($) => $.editor.field_goal)}</span>
          <Textarea
            value={node.goal ?? ""}
            readOnly={readOnly}
            placeholder={t(($) => $.editor.field_goal_placeholder)}
            onChange={(e) => commit(setStageField(def, node.id, { goal: e.target.value }))}
            className="min-h-16 resize-y text-micro"
            aria-label={t(($) => $.editor.field_goal)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-caption font-medium">{t(($) => $.editor.field_criteria)}</span>
          <Textarea
            value={node.criteria ?? ""}
            readOnly={readOnly}
            placeholder={t(($) => $.editor.field_criteria_placeholder)}
            onChange={(e) => commit(setStageField(def, node.id, { criteria: e.target.value }))}
            className="min-h-16 resize-y text-micro"
            aria-label={t(($) => $.editor.field_criteria)}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-caption font-medium">{t(($) => $.editor.field_input_tpl)}</span>
          <Textarea
            value={node.inputTpl ?? ""}
            readOnly={readOnly}
            placeholder={t(($) => $.editor.field_tpl_placeholder)}
            onChange={(e) => commit(setStageField(def, node.id, { inputTpl: e.target.value }))}
            className="min-h-16 resize-y text-micro"
            aria-label={t(($) => $.editor.field_input_tpl)}
          />
          <p className="text-2xs text-muted-foreground">{t(($) => $.editor.var_hint_input)}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-caption font-medium">{t(($) => $.editor.field_output_tpl)}</span>
          <Textarea
            value={node.outputTpl ?? ""}
            readOnly={readOnly}
            placeholder={t(($) => $.editor.field_tpl_placeholder)}
            onChange={(e) => commit(setStageField(def, node.id, { outputTpl: e.target.value }))}
            className="min-h-16 resize-y text-micro"
            aria-label={t(($) => $.editor.field_output_tpl)}
          />
          <p className="text-2xs text-muted-foreground">{t(($) => $.editor.var_hint_output)}</p>
        </div>
      </div>

      <InputsEditor def={def} node={node} readOnly={readOnly} commit={commit} />
      <OutputsEditor node={node} readOnly={readOnly} patchField={patchField} />
      <AdmissionEditor def={def} projectId={projectId} node={node} readOnly={readOnly} commit={commit} />
    </div>
  );
}

function InputsEditor({
  def,
  node,
  readOnly,
  commit,
}: {
  def: WorkflowDefinition;
  node: DefinitionNode;
  readOnly: boolean;
  commit: (next: WorkflowDefinition) => void;
}) {
  const { t } = useT("workflow");
  const inputs = node.inputs ?? [];
  const removeInput = (i: number) =>
    commit(patchNode(def, node.id, { inputs: inputs.filter((_, idx) => idx !== i) }));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-caption font-medium">{t(($) => $.editor.inputs_title)}</span>
        <span className="text-2xs text-muted-foreground">{t(($) => $.editor.inputs_hint)}</span>
      </div>
      {inputs.length === 0 ? (
        <p className="text-2xs text-muted-foreground">{t(($) => $.editor.inputs_empty)}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {inputs.map((inp, i) => (
            <span
              key={`${inp.fromStageId ?? "x"}-${i}`}
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-2xs"
            >
              <span>{inp.fromStageId ? stageNameById(def, inp.fromStageId) : ""}</span>
              {inp.outputName ? <span className="text-muted-foreground">{inp.outputName}</span> : null}
              {!readOnly ? (
                <button
                  type="button"
                  onClick={() => removeInput(i)}
                  aria-label={t(($) => $.editor.remove)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      )}
      {!readOnly ? <InputWiring def={def} node={node} commit={commit} /> : null}
    </div>
  );
}

/** 连线下拉：选一个上游 stage（及其产物）作为当前节点的输入依赖。 */
function InputWiring({
  def,
  node,
  commit,
}: {
  def: WorkflowDefinition;
  node: DefinitionNode;
  commit: (next: WorkflowDefinition) => void;
}) {
  const { t } = useT("workflow");
  const [stageId, setStageId] = useState("");
  const [outputId, setOutputId] = useState("");
  const upstream = listStageOutputs(def, node.id);
  const sel = upstream.find((u) => u.stageId === stageId);
  const add = () => {
    if (!stageId) return;
    const out = sel?.outputs.find((o) => o.id === outputId);
    const input: DefinitionInput = { fromStageId: stageId, outputId: outputId || undefined, outputName: out?.name };
    commit(addStageInput(def, node.id, input));
    setStageId("");
    setOutputId("");
  };
  const selectCls = "h-7 rounded-md border border-surface-border bg-background px-1.5 text-2xs";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={stageId}
        onChange={(e) => {
          setStageId(e.target.value);
          setOutputId("");
        }}
        className={selectCls}
        aria-label={t(($) => $.editor.wire_from)}
      >
        <option value="">{t(($) => $.editor.wire_from)}</option>
        {upstream.map((u) => (
          <option key={u.stageId} value={u.stageId}>
            {u.stageName}
          </option>
        ))}
      </select>
      <select
        value={outputId}
        onChange={(e) => setOutputId(e.target.value)}
        disabled={!sel || (sel.outputs.length ?? 0) === 0}
        className={selectCls}
        aria-label={t(($) => $.editor.wire_output)}
      >
        <option value="">{t(($) => $.editor.wire_output)}</option>
        {sel?.outputs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name || o.id}
          </option>
        ))}
      </select>
      <Button type="button" size="xs" variant="ghost" disabled={!stageId} onClick={add}>
        <Plus />
        {t(($) => $.editor.wire_add)}
      </Button>
    </div>
  );
}

function OutputsEditor({
  node,
  readOnly,
  patchField,
}: {
  node: DefinitionNode;
  readOnly: boolean;
  patchField: (id: string, patch: Partial<DefinitionNode>) => void;
}) {
  const { t } = useT("workflow");
  const outputs = node.outputs ?? [];
  const setAt = (i: number, patch: Partial<DefinitionOutput>) =>
    patchField(node.id, { outputs: outputs.map((o, idx) => (idx === i ? { ...o, ...patch } : o)) });
  const add = () =>
    patchField(node.id, {
      outputs: [
        ...outputs,
        { id: `out-${Date.now().toString(36)}-${outputs.length}`, name: "", type: "markdown", description: "" },
      ],
    });
  const remove = (i: number) => patchField(node.id, { outputs: outputs.filter((_, idx) => idx !== i) });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-caption font-medium">{t(($) => $.editor.outputs_title)}</span>
          <span className="text-2xs text-muted-foreground">{t(($) => $.editor.outputs_hint)}</span>
        </div>
        {!readOnly ? (
          <Button type="button" size="xs" variant="ghost" onClick={add}>
            <Plus />
            {t(($) => $.editor.outputs_add)}
          </Button>
        ) : null}
      </div>
      {outputs.length === 0 ? (
        <p className="text-2xs text-muted-foreground">{t(($) => $.editor.outputs_empty)}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {outputs.map((o, i) => (
            <div key={o.id ?? i} className="flex flex-wrap items-center gap-1.5">
              <Input
                value={o.name ?? ""}
                readOnly={readOnly}
                placeholder={t(($) => $.editor.outputs_name)}
                onChange={(e) => setAt(i, { name: e.target.value })}
                className="h-7 max-w-48"
                aria-label={t(($) => $.editor.outputs_name)}
              />
              <Input
                value={o.type ?? ""}
                readOnly={readOnly}
                placeholder={t(($) => $.editor.outputs_type)}
                onChange={(e) => setAt(i, { type: e.target.value })}
                className="h-7 w-24"
                aria-label={t(($) => $.editor.outputs_type)}
              />
              <Input
                value={o.description ?? ""}
                readOnly={readOnly}
                placeholder={t(($) => $.editor.outputs_desc)}
                onChange={(e) => setAt(i, { description: e.target.value })}
                className="h-7 min-w-0 flex-1"
                aria-label={t(($) => $.editor.outputs_desc)}
              />
              {!readOnly ? (
                <Button type="button" size="xs" variant="ghost" onClick={() => remove(i)} aria-label={t(($) => $.editor.remove)}>
                  <X />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 阶段资产准入门禁（plan 101 C3）：将必检输入展平到引擎 gate_doc_types。
 * 模板态只能回答「这项从哪来」（§C5）：fromStageId → 上游阶段名；空→外部必检，
 * 事实存在资产模块，因此给一个直达链接；运行态的缺件清单在实例详情（A1）。
 */
function AdmissionEditor({
  def,
  projectId,
  node,
  readOnly,
  commit,
}: {
  def: WorkflowDefinition;
  projectId: string;
  node: DefinitionNode;
  readOnly: boolean;
  commit: (next: WorkflowDefinition) => void;
}) {
  const { t } = useT("workflow");
  const paths = useWorkspacePaths();
  // 项目级模板跳项目资产 TAB，工作区级（无 project_id）退到跨项目资产聚合页。
  const assetsHref = projectId ? paths.projectView(projectId, "assets") : paths.assets();
  const [name, setName] = useState("");
  const inputs = node.inputs ?? [];
  const requiredCount = inputs.filter(isRequiredAsset).length;
  const add = () => {
    if (!name.trim()) return;
    commit(addRequiredAsset(def, node.id, name));
    setName("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-3.5 text-muted-foreground" />
          <span className="text-caption font-medium">{t(($) => $.editor.admission_title)}</span>
          <span className="text-2xs text-muted-foreground">{t(($) => $.editor.admission_hint)}</span>
        </div>
        {requiredCount > 0 ? (
          <Badge variant="secondary" className="text-2xs">
            {t(($) => $.editor.admission_count, { n: requiredCount })}
          </Badge>
        ) : null}
      </div>
      {inputs.length === 0 ? (
        <p className="text-2xs text-muted-foreground">{t(($) => $.editor.admission_empty)}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {inputs.map((inp, i) => (
            <div key={`${inp.fromStageId ?? "x"}-${inp.outputName ?? i}`} className="flex flex-wrap items-center gap-1.5 text-2xs">
              {!readOnly ? (
                <input
                  type="checkbox"
                  checked={isRequiredAsset(inp)}
                  onChange={(e) => commit(setInputRequired(def, node.id, i, e.target.checked))}
                  aria-label={t(($) => $.editor.admission_required)}
                  className="size-3.5 accent-current"
                />
              ) : (
                <span className="inline-block size-3.5 text-center">{isRequiredAsset(inp) ? "✓" : ""}</span>
              )}
              <span className="font-medium">{inp.outputName || inp.outputId || inp.fromStageId || t(($) => $.editor.admission_unnamed)}</span>
              {inp.fromStageId ? (
                <span className="text-muted-foreground">
                  {t(($) => $.editor.admission_source_upstream, {
                    stage: stageNameById(def, inp.fromStageId),
                  })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Badge variant="outline" className="text-2xs">
                    {t(($) => $.editor.admission_source_external)}
                  </Badge>
                  {isRequiredAsset(inp) ? (
                    <AppLink
                      href={assetsHref}
                      className="underline-offset-2 hover:underline"
                      data-testid={`workflow-admission-assets-${i}`}
                    >
                      {t(($) => $.editor.admission_go_assets)}
                    </AppLink>
                  ) : null}
                </span>
              )}
              {isRequiredAsset(inp) ? (
                <Badge variant="outline" className="text-2xs">{t(($) => $.editor.admission_required)}</Badge>
              ) : null}
              {!readOnly ? (
                <Button type="button" size="xs" variant="ghost" onClick={() => commit(removeInputAt(def, node.id, i))} aria-label={t(($) => $.editor.remove)}>
                  <X />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            value={name}
            placeholder={t(($) => $.editor.admission_add_placeholder)}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            className="h-7 max-w-48"
            aria-label={t(($) => $.editor.admission_title)}
          />
          <Button type="button" size="xs" variant="ghost" disabled={!name.trim()} onClick={add}>
            <Plus />
            {t(($) => $.editor.admission_add)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** 顶层新增块工具栏（阶段 / 迭代块 / 并行块）。 */
function BlockToolbar({ onAdd }: { onAdd: (kind: DefinitionNode["kind"]) => void }) {
  const { t } = useT("workflow");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-caption text-muted-foreground">{t(($) => $.editor.add_block)}</span>
      <Button type="button" size="xs" variant="outline" onClick={() => onAdd("stage")}>
        <Plus />
        {t(($) => $.editor.add_stage)}
      </Button>
      <Button type="button" size="xs" variant="outline" onClick={() => onAdd("iteration")}>
        <Repeat />
        {t(($) => $.editor.add_iteration)}
      </Button>
      <Button type="button" size="xs" variant="outline" onClick={() => onAdd("parallel")}>
        <GitBranch />
        {t(($) => $.editor.add_parallel)}
      </Button>
    </div>
  );
}

function KindIcon({ kind }: { kind: DefinitionNode["kind"] }) {
  if (kind === "iteration") return <Repeat className="size-3.5 shrink-0 text-violet-500" />;
  if (kind === "parallel") return <GitBranch className="size-3.5 shrink-0 text-sky-500" />;
  if (kind === "branch") return <GitBranch className="size-3.5 shrink-0 text-sky-400" />;
  return <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function IconBtn({
  disabled,
  danger,
  onClick,
  label,
  children,
}: {
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        danger
          ? "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
          : "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      }
    >
      {children}
    </button>
  );
}

function GateForm({
  iterationName,
  gate,
  readOnly,
  onPatch,
}: {
  iterationName: string;
  gate: DefinitionGate;
  readOnly: boolean;
  onPatch: (next: DefinitionGate) => void;
}) {
  const { t } = useT("workflow");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-400/50 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-amber-700 dark:text-amber-500">
        <ShieldCheck className="size-3.5" />
        <span>{t(($) => $.editor.gate_title)}</span>
        {iterationName ? <Badge variant="secondary" className="ml-1">{iterationName}</Badge> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">{t(($) => $.editor.gate_loop)}</span>
          <Input
            value={gate.loopLabel ?? ""}
            readOnly={readOnly}
            onChange={(e) => onPatch({ ...gate, loopLabel: e.target.value })}
            className="h-8"
            aria-label={t(($) => $.editor.gate_loop)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">{t(($) => $.editor.gate_exit)}</span>
          <Input
            value={gate.exitLabel ?? ""}
            readOnly={readOnly}
            onChange={(e) => onPatch({ ...gate, exitLabel: e.target.value })}
            className="h-8"
            aria-label={t(($) => $.editor.gate_exit)}
          />
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "bg-muted px-2.5 py-1 text-caption font-medium disabled:opacity-50"
          : "px-2.5 py-1 text-caption text-muted-foreground hover:bg-accent/60 disabled:opacity-50"
      }
    >
      {children}
    </button>
  );
}

function BottomBar({ template }: { template: WorkflowTemplate }) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const enforceMutation = useSetWorkflowTemplateEnforce();
  const publishMutation = usePublishWorkflowTemplate(template.project_id ?? "");

  const canEnforce = Boolean(template.project_id) && template.status === "published";
  const enforceDisabled = template.enforce ? false : !canEnforce;

  const toggleEnforce = async () => {
    const next = !template.enforce;
    try {
      await enforceMutation.mutateAsync({ templateId: template.id, enforce: next });
      toast.success(t(($) => $.toast.action_ok));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t(($) => $.toast.action_failed);
      toast.error(msg === "workflow_enforce_conflict" ? t(($) => $.editor.enforce_conflict) : msg);
    }
  };

  const publish = async () => {
    if (!template.project_id) return;
    try {
      await publishMutation.mutateAsync(template.id);
      toast.success(t(($) => $.toast.published));
      // 项目级 publish mutation 只失效项目切片；编辑器读的是工作区画廊键，
      // 补失效整片 workflow 键以刷新 status/enforce 前提。
      qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) });
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant={template.enforce ? "default" : "outline"}
          disabled={enforceDisabled || enforceMutation.isPending}
          onClick={() => void toggleEnforce()}
        >
          <Lock />
          {t(($) => $.editor.enforce)}
        </Button>
        {!canEnforce && !template.enforce ? (
          <span className="text-micro text-muted-foreground">
            {template.project_id ? t(($) => $.editor.enforce_needs_published) : t(($) => $.editor.enforce_needs_project)}
          </span>
        ) : (
          <span className="text-micro text-muted-foreground">{t(($) => $.editor.enforce_help)}</span>
        )}
      </div>
      {template.project_id && template.status === "draft" && !template.official ? (
        <Button type="button" size="xs" disabled={publishMutation.isPending} onClick={() => void publish()}>
          <Plus />
          {t(($) => $.editor.publish)}
        </Button>
      ) : null}
    </div>
  );
}

function SaveButton({
  saving,
  disabled,
  onSave,
}: {
  saving: boolean;
  disabled: boolean;
  onSave: () => void;
}) {
  const { t } = useT("workflow");
  return (
    <Button type="button" size="sm" disabled={disabled || saving} onClick={onSave}>
      {saving ? t(($) => $.editor.saving) : t(($) => $.editor.save)}
    </Button>
  );
}

function ValidationPanel({ errors }: { errors: string[] }) {
  const { t } = useT("workflow");
  if (errors.length === 0) return null;
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
      <p className="mb-1 text-2xs font-medium text-destructive">{t(($) => $.editor.validation_errors)}</p>
      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-micro text-destructive">
        {errors.map((err) => (
          <li key={err}>{err}</li>
        ))}
      </ul>
    </div>
  );
}

function Banner({ tone, children }: { tone: "muted" | "warn"; children: React.ReactNode }) {
  return (
    <p
      className={
        tone === "warn"
          ? "rounded-md bg-amber-500/10 px-2.5 py-1.5 text-caption text-amber-600"
          : "rounded-md bg-muted/40 px-2.5 py-1.5 text-caption text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// definition helpers（不可变克隆，供可视化表单回灌 JSON 缓冲）
// ---------------------------------------------------------------------------

function seedText(template: WorkflowTemplate): string {
  // definition 列为空但 nodes 列有旧版线性流程时（如需求日历 official 模板），
  // 从 nodes 展开成 CoCo 嵌套态，否则编辑器会退化成空白骨架、看不到真实流程。
  return JSON.stringify(definitionFromTemplate(template), null, 2);
}

function patchNode(def: WorkflowDefinition, id: string, patch: Partial<DefinitionNode>): WorkflowDefinition {
  const walk = (list: DefinitionNode[]): DefinitionNode[] =>
    list.map((n) => {
      if (n.id === id) return { ...n, ...patch };
      if (n.children?.length) return { ...n, children: walk(n.children) };
      return n;
    });
  return { ...def, nodes: walk(def.nodes ?? []) };
}
