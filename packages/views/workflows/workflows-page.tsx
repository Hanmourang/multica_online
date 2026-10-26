"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Lock, Plus, Workflow } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { projectListOptions } from "@multica/core/projects";
import {
  useCreateWorkflowTemplate,
  workspaceTemplatesOptions,
} from "@multica/core/workflow";
import type {
  ListWorkspaceWorkflowTemplatesParams,
  WorkflowTemplate,
  WorkflowTemplateStatus,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../i18n";
import { useNavigation } from "../navigation";
import { QueryError, QueryLoading } from "../projects/components/archive/query-states";
import {
  TemplateStatusBadge,
  formatDate,
} from "../projects/components/workflows/workflow-shared";
import { blankDefinition, parseDefinition, validateCocoDefinition } from "./coco";

type StatusTab = WorkflowTemplateStatus | "all";

const STATUS_TABS: StatusTab[] = ["all", "published", "draft", "archived"];

// Technical CoCo JSON shape hint (not translatable prose) — kept out of JSX so
// the i18n literal-string rule doesn't treat it as user-facing copy.
const COCO_PLACEHOLDER = '{"schemaVersion": 2, "kind": "coco.workflow.template", ...}';

/**
 * 工作区级「工作流」画廊（对标 CoCo /workflows，plan 20261024 §6）。
 *
 * 跨项目聚合展示模板卡片：状态过滤 chip（带 status_counts）+ 只看我的 + 卡片网格
 * （名称 / 状态 / 官方 / enforce 徽标 / stage-flow chips / 创建人）。新建与导入合流
 * 到同一对话框——导入即把粘贴的 CoCo JSON 作为 definition 提交；留空则生成空白
 * definition。创建仍走项目级端点（enforce 需要项目归属），故先选项目。
 */
export function WorkflowsPage() {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();

  const [status, setStatus] = useState<StatusTab>("all");
  const [scopeMine, setScopeMine] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const filters = useMemo<ListWorkspaceWorkflowTemplatesParams>(
    () => ({
      ...(status !== "all" ? { status } : {}),
      ...(scopeMine ? { scope: "mine" as const } : {}),
    }),
    [status, scopeMine],
  );

  const galleryQuery = useQuery(workspaceTemplatesOptions(wsId, filters));
  const templates = galleryQuery.data?.templates ?? [];
  const counts = galleryQuery.data?.status_counts;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6" data-testid="workflows-page">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-title font-semibold">
            <Workflow className="size-5 text-muted-foreground" />
            {t(($) => $.gallery.title)}
          </h1>
          <p className="text-caption text-muted-foreground">{t(($) => $.gallery.subtitle)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <Download />
            {t(($) => $.gallery.import)}
          </Button>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            {t(($) => $.gallery.new)}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {STATUS_TABS.map((tab) => (
          <Button
            key={tab}
            type="button"
            size="xs"
            variant={status === tab ? "default" : "outline"}
            aria-pressed={status === tab}
            onClick={() => setStatus(tab)}
          >
            {tab === "all" ? t(($) => $.filters.all) : t(($) => $.template_statuses[tab])}
            {counts?.[tab] ? ` · ${counts[tab]}` : ""}
          </Button>
        ))}
        <Button
          type="button"
          size="xs"
          variant={scopeMine ? "default" : "outline"}
          aria-pressed={scopeMine}
          className="ml-1"
          onClick={() => setScopeMine((v) => !v)}
        >
          {t(($) => $.filters.mine)}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {galleryQuery.isPending ? (
          <div className="p-3">
            <QueryLoading rows={4} />
          </div>
        ) : galleryQuery.isError ? (
          <div className="p-3">
            <QueryError onRetry={() => void galleryQuery.refetch()} message={String(galleryQuery.error)} />
          </div>
        ) : templates.length === 0 ? (
          <div className="p-8 text-center text-caption text-muted-foreground">
            {t(($) => $.empty.templates)}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((tpl) => (
              <TemplateCard key={tpl.id} tpl={tpl} />
            ))}
          </div>
        )}
      </div>

      <CreateTemplateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function TemplateCard({ tpl }: { tpl: WorkflowTemplate }) {
  const { t } = useT("workflow");
  const p = useWorkspacePaths();
  const navigate = useNavigation();
  const { getActorName } = useActorName();
  const href = p.workflowTemplate(tpl.id);
  return (
    <a
      href={href}
      onClick={(e) => {
        // 桌面端是 memory router：原生锚点会触发真实浏览器导航而绕过路由，
        // 表现为「点击无反应」；统一走 navigate.push（web 端也避免整页刷新）。
        e.preventDefault();
        navigate.push(href);
      }}
      className="flex flex-col gap-2 rounded-lg border border-surface-border bg-card p-3 transition-colors hover:bg-accent/40"
      data-testid={`workflow-template-card-${tpl.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-body font-semibold" title={tpl.name}>
          {tpl.name}
        </span>
        <TemplateStatusBadge status={tpl.status} />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {tpl.official ? (
          <Badge variant="secondary">{t(($) => $.badges.official)}</Badge>
        ) : null}
        {tpl.enforce ? (
          <Badge variant="default" className="gap-1">
            <Lock className="size-3" />
            {t(($) => $.gallery.enforced)}
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {tpl.stage_flow.length === 0 ? (
          <span className="text-micro text-muted-foreground">{t(($) => $.gallery.stage_flow)}</span>
        ) : (
          tpl.stage_flow.map((s) => (
            <span
              key={s.id}
              className={
                s.mode === "human"
                  ? "rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs text-amber-600"
                  : "rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
              }
              title={s.name}
            >
              {s.name}
            </span>
          ))
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-micro text-muted-foreground">
        <span className="truncate">
          {t(($) => $.gallery.created_by)} {getActorName(tpl.created_by_type, tpl.created_by_id)}
        </span>
        <span className="shrink-0">{formatDate(tpl.updated_at)}</span>
      </div>
    </a>
  );
}

function CreateTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const navigate = useNavigation();
  const p = useWorkspacePaths();

  const projectsQuery = useQuery(projectListOptions(wsId));
  const projects = projectsQuery.data ?? [];

  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [rawDef, setRawDef] = useState("");

  const createMutation = useCreateWorkflowTemplate(projectId);

  // 导入即把粘贴文本当作 CoCo definition；空白走新建空白骨架。两者都前端预校验。
  const validation = useMemo(() => {
    if (!rawDef.trim()) return { errors: [] as string[], def: null };
    try {
      const def = parseDefinition(rawDef);
      return { errors: validateCocoDefinition(def), def };
    } catch {
      return { errors: [t(($) => $.editor.invalid_json)], def: null };
    }
  }, [rawDef, t]);

  const effectiveProject = projectId || projects[0]?.id || "";
  const canSubmit =
    Boolean(effectiveProject) &&
    name.trim().length > 0 &&
    validation.errors.length === 0 &&
    !createMutation.isPending;

  const submit = async () => {
    if (!effectiveProject || !name.trim() || validation.errors.length > 0) return;
    const definition = validation.def ?? blankDefinition(name.trim());
    try {
      const created = await createMutation.mutateAsync({
        name: name.trim(),
        description: null,
        nodes: [],
        definition,
        enforce: false,
      });
      toast.success(t(($) => $.toast.template_created));
      onOpenChange(false);
      setName("");
      setRawDef("");
      navigate.push(p.workflowTemplate(created.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.toast.action_failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.gallery.new)}</DialogTitle>
          <DialogDescription>{t(($) => $.gallery.pick_project)}</DialogDescription>
        </DialogHeader>

        {projects.length === 0 && !projectsQuery.isPending ? (
          <p className="text-caption text-muted-foreground">{t(($) => $.gallery.no_projects)}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.gallery.project)}</span>
              <select
                value={effectiveProject}
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

            <label className="flex flex-col gap-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.editor.json_label)}</span>
              <Textarea
                value={rawDef}
                spellCheck={false}
                onChange={(e) => setRawDef(e.target.value)}
                placeholder={COCO_PLACEHOLDER}
                className="max-h-56 min-h-32 resize-y overflow-auto font-mono text-micro"
              />
            </label>

            {validation.errors.length > 0 ? (
              <ul className="flex max-h-24 list-disc flex-col gap-0.5 overflow-auto pl-4 text-micro text-destructive">
                {validation.errors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.actions.cancel)}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {t(($) => $.gallery.create)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
