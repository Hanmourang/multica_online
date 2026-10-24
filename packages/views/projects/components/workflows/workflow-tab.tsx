"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Workflow } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  workflowInstancesOptions,
  workflowTemplatesOptions,
  useCreateWorkflowInstance,
  useCreateWorkflowTemplate,
  useArchiveWorkflowTemplate,
  useDuplicateWorkflowTemplate,
  usePublishWorkflowTemplate,
} from "@multica/core/workflow";
import type {
  ListWorkflowInstancesParams,
  WorkflowInstance,
  WorkflowInstanceStatus,
  WorkflowTemplate,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { useT } from "../../../i18n";
import { QueryError, QueryLoading } from "../archive/query-states";
import { WorkflowInstanceDetail } from "./workflow-instance-detail";
import {
  INSTANCE_STATUSES,
  InstanceStatusBadge,
  TemplateStatusBadge,
  formatDate,
} from "./workflow-shared";

/**
 * 工作流 TAB（CoCo 对标 plan 20261024 §01 F3，Agent-W）。
 *
 * 双视图对照 CoCo /projects/:id/workflows?tab=tpl：运行列表（实例 + 状态计数
 * 过滤）与模板列表（发布/归档/复制）。服务端态全部走 core/workflow 的 React
 * Query options/mutations；本地只有选中的实例 id 与对话框开关。Feature-flag
 * 门控在容器侧完成（flag off 时本 TAB 不渲染，路由侧 404 兜底）。
 */
export function WorkflowTab({ projectId }: { projectId: string }) {
  const { t } = useT("workflow");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="workflow-tab">
      <div>
        <h2 className="text-body font-semibold">{t(($) => $.title)}</h2>
        <p className="text-caption text-muted-foreground">{t(($) => $.subtitle)}</p>
      </div>
      <Tabs defaultValue="runs">
        <TabsList variant="line">
          <TabsTrigger value="runs">{t(($) => $.tabs.runs)}</TabsTrigger>
          <TabsTrigger value="templates">{t(($) => $.tabs.templates)}</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="mt-3">
          <RunsPanel projectId={projectId} />
        </TabsContent>
        <TabsContent value="templates" className="mt-3">
          <TemplatesPanel projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 运行（实例）面板
// ---------------------------------------------------------------------------

function RunsPanel({ projectId }: { projectId: string }) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const [statusFilter, setStatusFilter] = useState<WorkflowInstanceStatus | null>(
    null,
  );
  const [scopeMine, setScopeMine] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const filters = useMemo<ListWorkflowInstancesParams>(
    () => ({
      ...(scopeMine ? { scope: "mine" as const } : {}),
      ...(statusFilter ? { status: [statusFilter] } : {}),
    }),
    [scopeMine, statusFilter],
  );
  const instancesQuery = useQuery(workflowInstancesOptions(wsId, projectId, filters));
  const instances = instancesQuery.data?.instances ?? [];
  const statusCounts = instancesQuery.data?.status_counts ?? {};

  if (selectedInstanceId) {
    return (
      <WorkflowInstanceDetail
        projectId={projectId}
        instanceId={selectedInstanceId}
        onBack={() => setSelectedInstanceId(null)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant={statusFilter === null ? "default" : "outline"}
          onClick={() => setStatusFilter(null)}
        >
          {t(($) => $.filters.all)}
        </Button>
        {INSTANCE_STATUSES.map((status) => (
          <Button
            key={status}
            type="button"
            size="xs"
            variant={statusFilter === status ? "default" : "outline"}
            onClick={() => setStatusFilter(statusFilter === status ? null : status)}
          >
            {t(($) => $.statuses[status])}
            {statusCounts[status] ? ` · ${statusCounts[status]}` : ""}
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
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => setCreateOpen(true)}
        >
          <Plus />
          {t(($) => $.actions.new_instance)}
        </Button>
      </div>

      <div className="min-h-0 overflow-y-auto rounded-lg border border-surface-border">
        {instancesQuery.isPending ? (
          <div className="p-3">
            <QueryLoading rows={4} />
          </div>
        ) : instancesQuery.isError ? (
          <div className="p-3">
            <QueryError
              onRetry={() => void instancesQuery.refetch()}
              message={String(instancesQuery.error)}
            />
          </div>
        ) : instances.length === 0 ? (
          <div className="p-8 text-center text-caption text-muted-foreground">
            {t(($) => $.empty.instances)}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.columns.status)}</TableHead>
                <TableHead>{t(($) => $.columns.template)}</TableHead>
                <TableHead>{t(($) => $.columns.created_at)}</TableHead>
                <TableHead className="text-right">{t(($) => $.columns.actions)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.map((row) => (
                <InstanceRow
                  key={row.id}
                  row={row}
                  onOpen={() => setSelectedInstanceId(row.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <CreateInstanceDialog
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(instance) => {
          setCreateOpen(false);
          setSelectedInstanceId(instance.id);
        }}
      />
    </div>
  );
}

function InstanceRow({
  row,
  onOpen,
}: {
  row: WorkflowInstance;
  onOpen: () => void;
}) {
  const { t } = useT("workflow");
  return (
    <TableRow>
      <TableCell>
        <InstanceStatusBadge status={row.status} />
      </TableCell>
      <TableCell className="text-caption">
        <span className="mr-1 font-mono text-micro text-muted-foreground">{row.id.slice(0, 8)}</span>
        {`v${row.template_version}`}
      </TableCell>
      <TableCell className="text-caption text-muted-foreground">
        {formatDate(row.created_at)}
      </TableCell>
      <TableCell className="text-right">
        <Button type="button" size="xs" variant="ghost" onClick={onOpen}>
          {t(($) => $.actions.detail)}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CreateInstanceDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (instance: WorkflowInstance) => void;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const templatesQuery = useQuery({
    ...workflowTemplatesOptions(wsId, projectId),
    enabled: open,
  });
  const publishable = (templatesQuery.data?.templates ?? []).filter(
    (tpl) => tpl.status === "published",
  );
  const [templateId, setTemplateId] = useState("");
  const createMutation = useCreateWorkflowInstance(projectId);

  const submit = async () => {
    if (!templateId) return;
    try {
      const instance = await createMutation.mutateAsync({ template_id: templateId });
      toast.success(t(($) => $.toast.instance_created));
      onCreated(instance);
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.actions.new_instance)}</DialogTitle>
          <DialogDescription>{t(($) => $.dialog.pick_template)}</DialogDescription>
        </DialogHeader>
        {publishable.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.empty.no_published_templates)}
          </p>
        ) : (
          <ul className="max-h-72 divide-y divide-surface-border overflow-y-auto rounded-md border border-surface-border">
            {publishable.map((tpl) => (
              <li key={tpl.id}>
                <button
                  type="button"
                  className={
                    templateId === tpl.id
                      ? "flex w-full items-center justify-between gap-2 bg-muted px-3 py-2 text-left"
                      : "flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50"
                  }
                  onClick={() => setTemplateId(tpl.id)}
                >
                  <span className="min-w-0 truncate text-caption font-medium">{tpl.name}</span>
                  <Badge variant="secondary" className="shrink-0">
                    {`v${tpl.version}`}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.actions.cancel)}
          </Button>
          <Button type="button" disabled={!templateId || createMutation.isPending} onClick={() => void submit()}>
            {t(($) => $.actions.create)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 模板面板
// ---------------------------------------------------------------------------

function TemplatesPanel({ projectId }: { projectId: string }) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const templatesQuery = useQuery(workflowTemplatesOptions(wsId, projectId));
  const templates = templatesQuery.data?.templates ?? [];

  const publishMutation = usePublishWorkflowTemplate(projectId);
  const archiveMutation = useArchiveWorkflowTemplate(projectId);
  const duplicateMutation = useDuplicateWorkflowTemplate(projectId);
  const [createOpen, setCreateOpen] = useState(false);

  const runAction = async (
    action: Promise<unknown>,
    okKey: "published" | "archived" | "duplicated",
  ) => {
    try {
      await action;
      toast.success(t(($) => $.toast[okKey]));
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          {t(($) => $.actions.new_template)}
        </Button>
      </div>

      <div className="min-h-0 overflow-y-auto rounded-lg border border-surface-border">
        {templatesQuery.isPending ? (
          <div className="p-3">
            <QueryLoading rows={4} />
          </div>
        ) : templatesQuery.isError ? (
          <div className="p-3">
            <QueryError
              onRetry={() => void templatesQuery.refetch()}
              message={String(templatesQuery.error)}
            />
          </div>
        ) : templates.length === 0 ? (
          <div className="p-8 text-center text-caption text-muted-foreground">
            {t(($) => $.empty.templates)}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.columns.name)}</TableHead>
                <TableHead>{t(($) => $.columns.status)}</TableHead>
                <TableHead>{t(($) => $.columns.version)}</TableHead>
                <TableHead>{t(($) => $.columns.nodes)}</TableHead>
                <TableHead>{t(($) => $.columns.updated_at)}</TableHead>
                <TableHead className="text-right">{t(($) => $.columns.actions)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((tpl) => (
                <TemplateRow
                  key={tpl.id}
                  tpl={tpl}
                  busy={
                    (publishMutation.isPending && publishMutation.variables === tpl.id) ||
                    (archiveMutation.isPending && archiveMutation.variables === tpl.id) ||
                    (duplicateMutation.isPending &&
                      duplicateMutation.variables?.templateId === tpl.id)
                  }
                  onPublish={() => void runAction(publishMutation.mutateAsync(tpl.id), "published")}
                  onArchive={() => void runAction(archiveMutation.mutateAsync(tpl.id), "archived")}
                  onDuplicate={() =>
                    void runAction(duplicateMutation.mutateAsync({ templateId: tpl.id }), "duplicated")
                  }
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <CreateTemplateDialog
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}

function TemplateRow({
  tpl,
  busy,
  onPublish,
  onArchive,
  onDuplicate,
}: {
  tpl: WorkflowTemplate;
  busy: boolean;
  onPublish: () => void;
  onArchive: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useT("workflow");
  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-0 items-center gap-1.5">
          <Workflow className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium" title={tpl.name}>
            {tpl.name}
          </span>
          {tpl.official ? (
            <Badge variant="secondary" className="shrink-0">
              {t(($) => $.badges.official)}
            </Badge>
          ) : null}
        </div>
        {tpl.description ? (
          <div className="truncate text-micro text-muted-foreground" title={tpl.description}>
            {tpl.description}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <TemplateStatusBadge status={tpl.status} />
      </TableCell>
      <TableCell className="text-caption tabular-nums">{`v${tpl.version}`}</TableCell>
      <TableCell className="text-caption tabular-nums">{tpl.nodes.length}</TableCell>
      <TableCell className="text-caption text-muted-foreground">
        {formatDate(tpl.updated_at)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {tpl.status === "draft" ? (
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onPublish}>
              {t(($) => $.actions.publish)}
            </Button>
          ) : null}
          {tpl.status !== "archived" ? (
            <Button type="button" size="xs" variant="ghost" disabled={busy || tpl.official} onClick={onArchive}>
              {t(($) => $.actions.archive)}
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onDuplicate}>
            {t(($) => $.actions.duplicate)}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreateTemplateDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("workflow");
  const createMutation = useCreateWorkflowTemplate(projectId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodesText, setNodesText] = useState("");
  const [nodesError, setNodesError] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // 后端 ValidateWorkflowNodes：节点数 1..50，空数组直接拒绝——前端同规则先拦截。
    let nodes: unknown[] = [];
    const text = nodesText.trim();
    if (!text) {
      setNodesError(true);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("nodes must be a non-empty array");
      nodes = parsed;
    } catch {
      setNodesError(true);
      return;
    }
    try {
      await createMutation.mutateAsync({
        name: trimmed,
        description: description.trim() || null,
        nodes: nodes as import("@multica/core/types").WorkflowNode[],
      });
      toast.success(t(($) => $.toast.template_created));
      setName("");
      setDescription("");
      setNodesText("");
      onOpenChange(false);
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.actions.new_template)}</DialogTitle>
          <DialogDescription>{t(($) => $.dialog.template_hint)}</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">{t(($) => $.form.name)}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">{t(($) => $.form.description)}</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">{t(($) => $.form.nodes)}</span>
          <Textarea
            value={nodesText}
            onChange={(e) => {
              setNodesText(e.target.value);
              setNodesError(false);
            }}
            rows={8}
            className="font-mono text-micro"
            placeholder={t(($) => $.form.nodes_placeholder)}
          />
          {nodesError ? (
            <span className="text-micro text-destructive">{t(($) => $.form.nodes_invalid)}</span>
          ) : (
            <span className="text-micro text-muted-foreground">{t(($) => $.form.nodes_help)}</span>
          )}
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.actions.cancel)}
          </Button>
          <Button
            type="button"
            disabled={!name.trim() || createMutation.isPending}
            onClick={() => void submit()}
          >
            {t(($) => $.actions.create)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
