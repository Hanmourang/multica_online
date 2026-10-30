"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  Check,
  ChevronRight,
  Link2,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Shrink,
  Sparkles,
  X,
} from "lucide-react";
import {
  isModuleWorkspaceGated,
  modulePrototypeVersionsOptions,
  moduleSpecOptions,
  moduleWorkspaceOptions,
  usePatchModuleWorkspace,
  usePublishModuleRelease,
  usePublishModuleSpec,
  useRegisterModulePrototype,
  useRollbackModuleRelease,
} from "@multica/core/projects";
import { useWorkspaceId } from "@multica/core/hooks";
import { graphKeys } from "@multica/core/graph/queries";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import type { Issue } from "@multica/core/types";
import type {
  ModuleAcceptanceItem,
  ModuleBriefFields,
  ModuleFieldDef,
  ModuleSpecFeature,
  ModuleWorkspace,
  ModuleWorkspaceFeature,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../../i18n";
import { isTopLevelRequirement } from "../../requirements/requirement-helpers";
import { FeaturePill, featurePillTone } from "../feature-chrome";
import {
  extractPrototypeModules,
  issueShortLabel,
  type PrototypeModule,
} from "../module-feature-stats";
import {
  INSPECTOR_COLLAPSED_WIDTH,
  INSPECTOR_WIDTH_DEFAULT,
  INSPECTOR_WIDTH_NARROW,
  useInspectorShortcuts,
  usePrototypeInspector,
} from "../use-prototype-inspector";

/**
 * 原型图右侧「功能点详解」（原型图 TAB v2 · 画面 3）。
 *
 * 三段，顺序固定，系统信息整块不出现：
 *   ① 模块说明   —— 字段字典驱动，一段一行；值旁标来源与版本，未填是虚线「待填写」
 *   ② 功能点清单 —— 按原型区块分组；选中行的四段详情就地可编辑
 *   ③ 版本记录   —— 一行一版，append-only；顶部一条配对条负责成对发布
 *
 * 三段的数据同源 module_brief_version：一次 patch 产一个版本，填充度与版本记录
 * 一起变，所以它们共用一个 query key。
 */
export function PrototypeInspector({
  projectId,
  moduleId,
  moduleName,
  issue,
  allIssues,
  preview,
  html,
  points,
  selectedFp,
  onSelectFp,
  extra,
}: {
  projectId: string;
  moduleId?: string;
  moduleName?: string;
  issue?: Issue;
  allIssues: Issue[];
  /** 当前预览中的原型：模块还没登记原型版本时，一键把它登记成模块原型。 */
  preview?: { version: number; htmlPath: string; issueId?: string | null };
  /** 当前预览原型的 HTML：空模块靠它一键导入功能点与说明结构。 */
  html?: string;
  points: PrototypeModule[];
  selectedFp: string | null;
  onSelectFp: (id: string) => void;
  extra?: ReactNode;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { open, setOpen, width, setWidth, startResize } = usePrototypeInspector();

  useInspectorShortcuts({
    onToggle: () => setOpen(!open),
    onNarrow: () => setWidth(INSPECTOR_WIDTH_NARROW),
    onWide: () => setWidth(INSPECTOR_WIDTH_DEFAULT),
  });

  // 画布上点中一个热点 → 右栏必须展开，否则用户看不到联动结果。
  useEffect(() => {
    if (selectedFp) setOpen(true);
  }, [selectedFp, setOpen]);

  const workspaceQuery = useQuery({
    ...moduleWorkspaceOptions(wsId, projectId, moduleId),
    retry: false,
  });
  const workspace = workspaceQuery.data;
  const gated = workspaceQuery.isError && isModuleWorkspaceGated(workspaceQuery.error);
  // 成对发布的原型轴只能取「模块自己登记过的原型版本」：预览里的版本可能属于别的
  // 需求/模块，拿去配对会被后端按 prototype_version_not_found 拒掉。
  const moduleProtosQuery = useQuery({
    ...modulePrototypeVersionsOptions(wsId, projectId, moduleId),
    retry: false,
  });
  // 「＋ 编辑」在锚点条上，但输入框在说明段里：状态抬到这里才能跨两段触发。
  const [addingField, setAddingField] = useState(false);
  // 空模块的第一版内容不靠人手打：把当前原型里真实存在的区块/锚点搬成功能点。
  const importer = useImportFromPrototype({
    projectId,
    moduleId,
    html,
    workspace: workspaceQuery.data,
    onSelectFp,
  });
  // 本版改动过的功能点：行内「变更」标签用它，与版本记录的 changes 同源。
  const briefVersions = workspaceQuery.data?.versions;
  const changedCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const change of briefVersions?.[0]?.changes ?? []) {
      const match = /^fp\.([^.]+)\./.exec(change.key);
      if (match?.[1]) codes.add(match[1]);
    }
    return codes;
  }, [briefVersions]);

  if (!open) {
    return (
      <div
        className="flex h-full shrink-0 flex-col items-center border-l border-surface-border bg-muted/20"
        style={{ width: INSPECTOR_COLLAPSED_WIDTH }}
        data-testid="prototype-inspector-rail"
      >
        <button
          type="button"
          aria-expanded={false}
          aria-label={t(($) => $.features.inspector_expand)}
          onClick={() => setOpen(true)}
          className="flex w-full flex-1 flex-col items-center gap-2 px-0.5 py-3 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <PanelRightOpen className="size-3.5 shrink-0" />
          <span
            className="whitespace-nowrap text-[10px] font-semibold tracking-wide"
            style={{ writingMode: "vertical-rl" }}
          >
            {t(($) => $.features.inspector_open)}
          </span>
          <ChevronRight className="mt-0.5 size-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </div>
    );
  }

  const briefVersion = workspace?.brief.version ?? 0;
  const moduleProtoVersions = moduleProtosQuery.data?.versions ?? [];
  const ownedProtoVersion = workspace?.canonical_prototype_version
    ?? (moduleProtoVersions.length
        ? Math.max(...moduleProtoVersions.map((row) => row.version))
        : null);
  const release = workspace?.releases.find((row) => row.brief_version === briefVersion);
  const nextRelease = (workspace?.release_version ?? 0) + 1;

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-surface-border bg-[oklch(0.988_0_0)] max-[1120px]:absolute max-[1120px]:inset-y-0 max-[1120px]:right-0 max-[1120px]:z-20 max-[1120px]:shadow-2xl dark:bg-muted/10"
      style={{ width }}
      data-testid="prototype-inspector"
    >
      <button
        type="button"
        aria-label={t(($) => $.features.inspector_width)}
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/25"
      />

      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-surface-border px-2.5">
        <span className="text-[11px] font-bold">{t(($) => $.features.inspector_open)}</span>
        {workspace ? (
          <span className="rounded-full bg-primary/10 px-1.5 py-px text-[9.5px] font-semibold text-primary">
            {t(($) => $.features.inspector_brief_version, { version: briefVersion })}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <IconAction
            label={t(($) => $.features.inspector_narrow_btn)}
            onClick={() => setWidth(INSPECTOR_WIDTH_NARROW)}
          >
            <Shrink className="size-3.5" aria-hidden />
          </IconAction>
          <IconAction
            label={t(($) => $.features.inspector_default_btn)}
            onClick={() => setWidth(INSPECTOR_WIDTH_DEFAULT)}
          >
            <ArrowLeftRight className="size-3.5" aria-hidden />
          </IconAction>
          <IconAction
            label={t(($) => $.features.inspector_collapse)}
            onClick={() => setOpen(false)}
          >
            <PanelRightClose className="size-3.5" />
          </IconAction>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {gated ? (
          <p className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
            {t(($) => $.features.inspector_gated)}
          </p>
        ) : workspaceQuery.isError ? (
          <p className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
            {t(($) => $.features.inspector_brief_failed)}
          </p>
        ) : !moduleId ? (
          <p className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
            {t(($) => $.features.inspector_no_module)}
          </p>
        ) : !workspace ? (
          <div className="space-y-2 px-3 py-3">
            <div className="h-14 animate-pulse rounded-lg bg-muted/50" />
            <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
            <div className="h-16 animate-pulse rounded-lg bg-muted/30" />
          </div>
        ) : (
          <>
            <InspectorNav
              featureCount={workspace.features.length}
              onEdit={() => {
                setAddingField(true);
                scrollToSection("brief-section");
              }}
            />
            <PairBar
              release={release}
              briefVersion={briefVersion}
              protoVersion={ownedProtoVersion}
              nextRelease={nextRelease}
            />
            <BriefSection
              projectId={projectId}
              moduleId={moduleId!}
              workspace={workspace}
              adding={addingField}
              onAddingChange={setAddingField}
              onImport={() => void importer.run()}
              importPending={importer.pending}
              canImport={importer.canImport}
            />
            <FeatureSection
              projectId={projectId}
              moduleId={moduleId!}
              features={workspace.features}
              points={points}
              currentVersion={briefVersion}
              changedCodes={changedCodes}
              selectedFp={selectedFp}
              onSelectFp={onSelectFp}
              onClearFp={() => onSelectFp("")}
              onImport={() => void importer.run()}
              importPending={importer.pending}
              canImport={importer.canImport}
              importableCount={importer.importableCount}
              hasPrototype={Boolean(html?.trim())}
            />
            <VersionsSection
              projectId={projectId}
              moduleId={moduleId!}
              protoVersion={ownedProtoVersion}
              preview={preview}
              workspace={workspace}
            />
          </>
        )}
        {extra}
        {moduleId ? (
          <details className="border-t border-surface-border px-3 py-2">
            <summary className="cursor-pointer list-none text-[10.5px] font-semibold text-muted-foreground hover:text-foreground">
              {t(($) => $.features.inspector_bind_toggle)}
            </summary>
            <BindSection
              projectId={projectId}
              moduleId={moduleId}
              moduleName={moduleName}
              issue={issue}
              allIssues={allIssues}
            />
          </details>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * 「从原型导入」：把当前原型里真实存在的区块 / data-fp 锚点搬成功能点清单，
 * 并把区块清单写进「范围」、导航顺序写进「关键流程」。
 *
 * 这不是猜内容：只搬原型上已经画出来的东西；搬不出来的字段仍然留空待填写
 * （画面 3 的空值规则：缺就是缺，不合并成「暂无」）。
 * 写入沿用既有两条链路：spec 是功能点的唯一真源（先 publish），四段详情与
 * 说明字段再 patch（source=extract，版本记录里显示为「从需求抽取」）。
 */
function useImportFromPrototype({
  projectId,
  moduleId,
  html,
  workspace,
  onSelectFp,
}: {
  projectId: string;
  moduleId?: string;
  html?: string;
  workspace?: ModuleWorkspace;
  onSelectFp: (code: string) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const publish = usePublishModuleSpec(wsId, projectId, moduleId ?? "");
  const patch = usePatchModuleWorkspace(wsId, projectId, moduleId ?? "");
  const specQuery = useQuery({ ...moduleSpecOptions(wsId, projectId, moduleId), retry: false });
  const [pending, setPending] = useState(false);

  // 文档标题与页面主标题不是功能点：fp 锚点优先，其次 h2–h3 区块标题，最后才是导航项。
  const points = useMemo(() => {
    if (!html) return [];
    const extracted = extractPrototypeModules(html);
    const anchors = extracted.filter((point) => point.source === "fp");
    if (anchors.length > 0) return anchors;
    const headings = extracted.filter(
      (point) =>
        point.source === "heading" &&
        !point.id.startsWith("doc.title") &&
        !point.id.startsWith("h1."),
    );
    return headings.length > 0
      ? headings
      : extracted.filter((point) => point.source === "nav");
  }, [html]);

  const canImport = Boolean(workspace && moduleId) && points.length > 0;

  const run = async (): Promise<void> => {
    if (!workspace || !moduleId || points.length === 0) return;
    setPending(true);
    try {
      const features: ModuleSpecFeature[] = workspace.features.map((feature) => ({
        code: feature.code,
        title: feature.title,
        kind: feature.kind === "edge" ? "edge" : "core",
        priority: feature.priority,
        group: feature.group,
      }));
      const takenTitles = new Set(features.map((feature) => feature.title.trim()));
      const fields: Record<string, unknown> = {};
      const added: string[] = [];
      let seq = maxFeatureNumber(features);
      // 原型里 h2 是区块标题、h3 是块内条目：条目归到最近的 h2 分组，右栏就按原型分组呈现。
      let group = "";
      for (const point of points) {
        const title = point.title.trim();
        const isSection = point.id.startsWith("h2.");
        if (isSection) group = title;
        if (!title || takenTitles.has(title)) continue;
        takenTitles.add(title);
        const code = `FP-${String(++seq).padStart(2, "0")}`;
        features.push({ code, title, kind: "core", group: isSection ? "" : group });
        const desc = (point.text ?? "").trim();
        if (desc && desc !== title) fields[`fp.${code}.desc`] = desc.slice(0, 400);
        fields[`fp.${code}.loc`] = t(($) => $.features.inspector_import_loc, { title });
        added.push(code);
      }
      if (added.length === 0) {
        toast.info(t(($) => $.features.inspector_import_nothing));
        return;
      }
      // 说明段只补能从原型读出来的结构字段（区块清单 / 导航顺序），其余留给人工。
      const sections = points
        .filter((point) => point.source !== "nav")
        .map((point) => point.title.trim())
        .filter(Boolean);
      const navFlow = points
        .filter((point) => point.source === "nav")
        .map((point) => point.title.trim())
        .filter(Boolean);
      if (!hasFieldText(workspace.brief.fields["brief.scope"]) && sections.length > 1) {
        fields["brief.scope"] = sections.slice(0, 12).join(" · ");
      }
      if (!hasFieldText(workspace.brief.fields["brief.flow"]) && navFlow.length > 1) {
        fields["brief.flow"] = navFlow.slice(0, 12).join(" → ");
      }

      const spec = specQuery.data?.spec ?? null;
      await publish.mutateAsync({
        spec: { schema: spec?.schema || "module_spec/v1", summary: spec?.summary, features },
        expected_version: specQuery.data?.spec_version,
      });
      await patch.mutateAsync({
        base_version: workspace.brief.version,
        fields,
        source: "extract",
      });
      const first = added[0];
      if (first) onSelectFp(first);
      toast.success(t(($) => $.features.inspector_import_ok, { n: added.length }));
    } catch (error) {
      const status = (error as { status?: number }).status;
      toast.error(
        status === 409
          ? t(($) => $.features.inspector_brief_stale)
          : t(($) => $.features.inspector_import_failed),
      );
    } finally {
      setPending(false);
    }
  };

  return { run, pending, canImport, importableCount: points.length };
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md px-1 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function scrollToSection(testId: string) {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  node?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** 锚点条（画面 3 第 2 项）：说明 / 功能点 n / 版本 / ＋ 编辑。 */
function InspectorNav({
  featureCount,
  onEdit,
}: {
  featureCount: number;
  onEdit: () => void;
}) {
  const { t } = useT("archive");
  const anchorClass =
    "rounded px-1 py-0.5 hover:bg-muted/60 hover:text-foreground transition-colors";
  return (
    <nav
      className="flex shrink-0 items-center gap-1 border-b border-surface-border px-2 py-1 text-[9.5px] text-muted-foreground"
      data-testid="inspector-nav"
    >
      <button type="button" className={anchorClass} onClick={() => scrollToSection("brief-section")}>
        {t(($) => $.features.inspector_anchor_brief)}
      </button>
      <button
        type="button"
        className={anchorClass}
        onClick={() => scrollToSection("feature-section")}
      >
        {t(($) => $.features.inspector_anchor_fp, { n: featureCount })}
      </button>
      <button
        type="button"
        className={anchorClass}
        onClick={() => scrollToSection("versions-section")}
      >
        {t(($) => $.features.inspector_anchor_versions)}
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="ml-auto rounded px-1 py-0.5 font-semibold text-primary transition-colors hover:bg-primary/10"
      >
        {t(($) => $.features.inspector_anchor_edit)}
      </button>
    </nav>
  );
}

/** 配对条：说明轴 ⨯ 原型轴。发布是唯一移动两个指针的动作，所以按钮只在这里。 */
function PairBar({
  release,
  briefVersion,
  protoVersion,
  nextRelease,
}: {
  release?: { version: number; prototype_version: number };
  briefVersion: number;
  protoVersion: number | null;
  nextRelease: number;
}) {
  const { t } = useT("archive");

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 border-b px-2.5 py-1.5 text-[10px]",
        release
          ? "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400"
          : "border-amber-500/25 bg-amber-500/[0.07] text-amber-700 dark:text-amber-400",
      )}
      data-testid="prototype-inspector-pair"
    >
      <Link2 className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {release
          ? t(($) => $.features.inspector_pair_ok, {
              brief: briefVersion,
              proto: release.prototype_version,
              release: release.version,
            })
          : protoVersion == null
            ? t(($) => $.features.inspector_pair_no_proto)
            : t(($) => $.features.inspector_pair_pending, {
                brief: briefVersion,
                proto: protoVersion,
              })}
      </span>
      <button
        type="button"
        onClick={() => scrollToSection("versions-section")}
        className="flex shrink-0 items-center gap-px font-semibold hover:underline"
      >
        {t(($) => $.features.inspector_release_label, {
          version: release?.version ?? nextRelease,
        })}
        <ChevronRight className="size-2.5" aria-hidden />
      </button>
    </div>
  );
}

// ── ① 模块说明 ────────────────────────────────────────────────────────

function BriefSection({
  projectId,
  moduleId,
  workspace,
  adding,
  onAddingChange,
  onImport,
  importPending,
  canImport,
}: {
  projectId: string;
  moduleId: string;
  workspace: ModuleWorkspace;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onImport: () => void;
  importPending: boolean;
  canImport: boolean;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const patch = usePatchModuleWorkspace(wsId, projectId, moduleId);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const rows = useMemo(() => {
    const defs = workspace.field_defs.filter(
      (def) => def.scope === "module" && def.owner === "user",
    );
    const known = new Set(defs.map((def) => def.key));
    const custom: ModuleFieldDef[] = Object.keys(workspace.brief.fields)
      .filter((key) => key.startsWith("brief.") && !known.has(key))
      .map((key, index) => ({
        key,
        scope: "module",
        label: key,
        ord: 500 + index,
        kind: "text",
        owner: "user",
        writable_by: ["human", "agent"],
        versioned: true,
      }));
    return [...defs, ...custom].sort((a, b) => a.ord - b.ord);
  }, [workspace.brief.fields, workspace.field_defs]);
  const filledCount = rows.filter(
    (def) => renderScalar(workspace.brief.fields[def.key]?.value).trim().length > 0,
  ).length;

  const save = (key: string, value: string) => {
    patch.mutate(
      {
        base_version: workspace.brief.version,
        fields: { [key]: value },
        source: "manual",
      },
      {
        onSuccess: (result) => {
          setEditingKey(null);
          toast.success(
            t(($) => $.features.inspector_brief_saved, { version: result.version }),
          );
        },
        onError: (error: unknown) => {
          const status = (error as { status?: number }).status;
          if (status === 409) {
            toast.error(t(($) => $.features.inspector_brief_stale));
            return;
          }
          if (status === 422) {
            toast.error(t(($) => $.features.inspector_brief_readonly));
            return;
          }
          toast.error(t(($) => $.features.inspector_brief_failed));
        },
      },
    );
  };

  return (
    <section className="border-b border-surface-border px-2.5 py-2.5" data-testid="brief-section">
      <div className="mb-1.5 flex items-center gap-1.5">
        <h3 className="text-[11px] font-bold">{t(($) => $.features.inspector_brief)}</h3>
        {canImport && filledCount === 0 ? (
          <button
            type="button"
            disabled={importPending}
            onClick={onImport}
            className="ml-auto flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9.5px] font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          >
            <Sparkles className="size-2.5" aria-hidden />
            {t(($) => $.features.inspector_import)}
          </button>
        ) : (
          <span className="ml-auto text-[9.5px] text-muted-foreground">
            {t(($) => $.features.inspector_brief_meta, {
              version: workspace.brief.version,
              fields: rows.length,
              todo: rows.length - filledCount,
            })}
          </span>
        )}
      </div>
      <ul className="space-y-px">
        {rows.map((def) => (
          <BriefRow
            key={def.key}
            def={def}
            fields={workspace.brief.fields}
            editing={editingKey === def.key}
            pending={patch.isPending}
            onEdit={() => setEditingKey(def.key)}
            onCancel={() => setEditingKey(null)}
            onSave={(value) => save(def.key, value)}
          />
        ))}
      </ul>
      {adding ? (
        <AddFieldRow
          pending={patch.isPending}
          onCancel={() => onAddingChange(false)}
          onSave={(key, value) => save(key, value)}
        />
      ) : (
        <button
          type="button"
          onClick={() => onAddingChange(true)}
          className="mt-1.5 flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline"
        >
          <Plus className="size-3" />
          {t(($) => $.features.inspector_brief_add)}
        </button>
      )}
      {filledCount === 0 ? (
        <p className="mt-1.5 text-[9.5px] leading-relaxed text-muted-foreground">
          {canImport
            ? t(($) => $.features.inspector_brief_empty_hint)
            : t(($) => $.features.inspector_brief_empty_manual)}
        </p>
      ) : null}
    </section>
  );
}

function BriefRow({
  def,
  fields,
  editing,
  pending,
  onEdit,
  onCancel,
  onSave,
}: {
  def: ModuleFieldDef;
  fields: ModuleBriefFields;
  editing: boolean;
  pending: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const { t } = useT("archive");
  const entry = fields[def.key];
  const text = renderScalar(entry?.value);
  const filled = text.trim().length > 0;

  if (editing) {
    return (
      <li className="py-1">
        <FieldEditor
          label={def.label}
          initial={text}
          multiline={def.kind === "longtext" || def.kind === "list"}
          pending={pending}
          onCancel={onCancel}
          onSave={onSave}
        />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-1.5 rounded px-1 py-[3px] hover:bg-muted/40">
      <span className="w-[56px] shrink-0 text-[10px] leading-4 text-muted-foreground">
        {def.label}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-[11px] leading-4",
          filled
            ? "whitespace-pre-wrap break-words text-foreground"
            : "border-b border-dashed border-amber-500/50 text-[10.5px] text-amber-600 dark:text-amber-400",
        )}
      >
        {filled ? text : t(($) => $.features.inspector_brief_placeholder)}
      </span>
      <SourceChip entry={entry} />
      <button
        type="button"
        aria-label={t(($) => $.features.inspector_edit)}
        onClick={onEdit}
        className="mt-px shrink-0 rounded p-px text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        <Pencil className="size-2.5" />
      </button>
    </li>
  );
}

function AddFieldRow({
  pending,
  onCancel,
  onSave,
}: {
  pending: boolean;
  onCancel: () => void;
  onSave: (key: string, value: string) => void;
}) {
  const { t } = useT("archive");
  const [key, setKey] = useState("brief.");
  const [value, setValue] = useState("");
  return (
    <div className="mt-1.5 space-y-1 rounded-md border border-dashed border-primary/40 bg-primary/[0.03] p-1.5">
      <input
        autoFocus
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder={t(($) => $.features.inspector_brief_add_key)}
        className="w-full rounded border border-surface-border bg-surface px-1.5 py-1 font-mono text-[10px] outline-none focus:border-primary/50"
      />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t(($) => $.features.inspector_brief_add_value)}
        className="w-full rounded border border-surface-border bg-surface px-1.5 py-1 text-[11px] outline-none focus:border-primary/50"
      />
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="xs"
          disabled={pending || !key.trim() || !value.trim()}
          onClick={() => onSave(key.trim(), value)}
        >
          {t(($) => $.features.inspector_brief_save)}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          {t(($) => $.features.inspector_brief_cancel)}
        </Button>
      </div>
    </div>
  );
}

/** 字段来源 chip（画面 3）：明写「人工 / AI」+ 写入时的版本号；未写过的字段不挂 chip。 */
function SourceChip({ entry }: { entry?: { v: number; by: "human" | "agent" } }) {
  const { t } = useT("archive");
  if (!entry || entry.v === 0) return null;
  const who =
    entry.by === "agent"
      ? t(($) => $.features.inspector_source_agent)
      : t(($) => $.features.inspector_source_human);
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[8.5px] font-semibold",
        entry.by === "agent"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      {t(($) => $.features.inspector_source_chip, { who, version: entry.v })}
    </span>
  );
}

// ── ② 功能点清单 + 四段详情 ───────────────────────────────────────────

function FeatureSection({
  projectId,
  moduleId,
  features,
  points,
  currentVersion,
  changedCodes,
  selectedFp,
  onSelectFp,
  onClearFp,
  onImport,
  importPending,
  canImport,
  importableCount,
  hasPrototype,
}: {
  projectId: string;
  moduleId: string;
  features: ModuleWorkspaceFeature[];
  points: PrototypeModule[];
  currentVersion: number;
  /** 当前说明版本里改过的功能点编号：行内「变更」标签与版本记录同源。 */
  changedCodes: Set<string>;
  selectedFp: string | null;
  onSelectFp: (code: string) => void;
  onClearFp: () => void;
  onImport: () => void;
  importPending: boolean;
  canImport: boolean;
  importableCount: number;
  /** 模块是否已有可读的原型：空态文案据此区分「没原型」与「原型里没区块」。 */
  hasPrototype: boolean;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const patch = usePatchModuleWorkspace(wsId, projectId, moduleId);

  // 「＋ 功能点」写的是模块规格：spec 是功能点的唯一真源，追加一条后发布，
  // 后端在同一事务里重建投影，右栏的行与四段详情随之出现。
  const specQuery = useQuery({ ...moduleSpecOptions(wsId, projectId, moduleId), retry: false });
  const publish = usePublishModuleSpec(wsId, projectId, moduleId);
  const [addingFeature, setAddingFeature] = useState(false);

  // 原型点的 id 是锚点/标题 slug，功能点的 code 是 FP-xx，两者只能按标题对齐。
  const anchored = useMemo(() => {
    const titles = new Set(points.map((point) => point.title.trim()));
    const codes = new Set<string>();
    for (const feature of features) {
      if (feature.detail.loc || titles.has(feature.title.trim())) codes.add(feature.code);
    }
    return codes;
  }, [features, points]);
  const groups = useMemo(() => {
    const map = new Map<string, ModuleWorkspaceFeature[]>();
    for (const feature of features) {
      const group = (feature.group ?? "").trim() || t(($) => $.features.inspector_fp_ungrouped);
      const bucket = map.get(group);
      if (bucket) bucket.push(feature);
      else map.set(group, [feature]);
    }
    return [...map.entries()];
  }, [features, t]);

  const selected = features.find((feature) => feature.code === selectedFp) ?? null;
  const anchoredCount = anchored.size;

  const addFeature = (draft: { code: string; title: string; group: string }) => {
    const spec = specQuery.data?.spec ?? null;
    const existing: ModuleSpecFeature[] = spec?.features?.length
      ? spec.features
      : features.map((feature) => ({
          code: feature.code,
          title: feature.title,
          kind: feature.kind === "edge" ? ("edge" as const) : ("core" as const),
          priority: feature.priority,
          group: feature.group,
        }));
    if (existing.some((feature) => feature.code === draft.code)) {
      toast.error(t(($) => $.features.inspector_fp_add_dup, { code: draft.code }));
      return;
    }
    publish.mutate(
      {
        spec: {
          schema: spec?.schema || "module_spec/v1",
          summary: spec?.summary,
          features: [
            ...existing,
            {
              code: draft.code,
              title: draft.title,
              kind: "core",
              group: draft.group.trim() || undefined,
            },
          ],
        },
        expected_version: specQuery.data?.spec_version,
      },
      {
        onSuccess: (result) => {
          setAddingFeature(false);
          onSelectFp(draft.code);
          toast.success(
            t(($) => $.features.inspector_fp_added, {
              code: draft.code,
              version: result.spec_version,
            }),
          );
        },
        onError: (error: unknown) => {
          const status = (error as { status?: number }).status;
          toast.error(
            status === 409
              ? t(($) => $.features.inspector_brief_stale)
              : t(($) => $.features.inspector_fp_add_failed),
          );
        },
      },
    );
  };

  const saveDetail = (key: string, value: unknown) => {
    patch.mutate(
      {
        base_version: currentVersion,
        fields: { [key]: value },
        source: "manual",
      },
      {
        onSuccess: () => toast.success(t(($) => $.features.inspector_brief_saved, { version: currentVersion })),
        onError: (error: unknown) => {
          const status = (error as { status?: number }).status;
          toast.error(
            status === 409
              ? t(($) => $.features.inspector_brief_stale)
              : t(($) => $.features.inspector_brief_failed),
          );
        },
      },
    );
  };

  return (
    <section className="border-b border-surface-border px-2.5 py-2.5" data-testid="feature-section">
      <div className="mb-1.5 flex items-center gap-1.5">
        <h3 className="text-[11px] font-bold">{t(($) => $.features.inspector_fp)}</h3>
        <span className="ml-auto text-[9.5px] text-muted-foreground">
          {t(($) => $.features.inspector_fp_meta, {
            n: features.length,
            anchored: anchoredCount,
          })}
        </span>
        {canImport ? (
          <button
            type="button"
            disabled={importPending}
            onClick={onImport}
            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9.5px] font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
            title={t(($) => $.features.inspector_import_hint, { n: importableCount })}
          >
            <Sparkles className="size-2.5" aria-hidden />
            {t(($) => $.features.inspector_import)}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setAddingFeature(true)}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9.5px] font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          <Plus className="size-2.5" aria-hidden />
          {t(($) => $.features.inspector_fp_add)}
        </button>
      </div>
      {features.length === 0 ? (
        <div className="space-y-1.5">
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {t(($) => $.features.inspector_fp_empty)}
          </p>
          {canImport ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="h-6 gap-1 px-2 text-[10px]"
              disabled={importPending}
              onClick={onImport}
            >
              <Sparkles className="size-3" aria-hidden />
              {t(($) => $.features.inspector_import_hint, { n: importableCount })}
            </Button>
          ) : (
            <p className="text-[10px] leading-relaxed text-muted-foreground/80">
              {hasPrototype
                ? t(($) => $.features.inspector_import_no_blocks)
                : t(($) => $.features.inspector_import_no_proto)}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map(([group, rows]) => (
            <div key={group}>
              <p className="mb-1 text-[9.5px] font-semibold tracking-wide text-muted-foreground">
                {group}
              </p>
              <ul className="space-y-1">
                {rows.map((feature) => {
                  const active = feature.code === selectedFp;
                  return (
                    <li key={feature.code}>
                      <button
                        type="button"
                        onClick={() => onSelectFp(feature.code)}
                        className={cn(
                          "flex w-full items-start gap-1.5 rounded-lg border px-1.5 py-1.5 text-left transition-colors",
                          active
                            ? "border-primary bg-primary/[0.08]"
                            : "border-surface-border bg-surface hover:border-primary/30 hover:bg-muted/30",
                        )}
                        data-testid={`feature-row-${feature.code}`}
                      >
                        <span className="mt-px shrink-0 font-mono text-[9px] text-muted-foreground">
                          {feature.code}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1">
                            <span className="truncate text-[11px] font-semibold">
                              {feature.title}
                            </span>
                            <FeatureTag
                              feature={feature}
                              currentVersion={currentVersion}
                              changed={changedCodes.has(feature.code)}
                            />
                          </span>
                          <span className="mt-px block truncate text-[10px] text-muted-foreground">
                            {featureSubtitle(feature, points, t(($) => $.features.inspector_seg_empty))}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-muted-foreground">
                            <FillMeter filled={feature.filled} total={feature.total} />
                            <span>
                              {t(($) => $.features.accept_avg)}{" "}
                              {feature.acceptance_ok}/{feature.acceptance_total}
                            </span>
                            {(anchored.has(feature.code) || feature.detail.loc) && (
                              <Link2 className="size-2.5 text-primary/70" aria-hidden />
                            )}
                          </span>
                        </span>
                        <ChevronRight
                          className={cn(
                            "mt-0.5 size-3 shrink-0 text-muted-foreground",
                            active && "rotate-90 text-primary",
                          )}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {addingFeature ? (
        <AddFeatureRow
          pending={publish.isPending}
          defaultCode={nextFeatureCode(features)}
          onCancel={() => setAddingFeature(false)}
          onSave={addFeature}
        />
      ) : null}
      {selected ? (
        <FeatureDetail
          key={selected.code}
          feature={selected}
          currentVersion={currentVersion}
          changed={changedCodes.has(selected.code)}
          pending={patch.isPending}
          onSave={saveDetail}
          onClose={onClearFp}
        />
      ) : null}
    </section>
  );
}

/**
 * 功能点行的副标题：先看四段里的描述，再看原型同名区块的正文，最后退到锚点位置。
 * 三者都没有才显示「待填写」——缺就是缺，不编。
 */
function featureSubtitle(
  feature: ModuleWorkspaceFeature,
  points: PrototypeModule[],
  empty: string,
): string {
  const desc = feature.detail.desc?.trim();
  if (desc) return desc;
  const title = feature.title.trim();
  const anchor = points.find((point) => point.title.trim() === title);
  const text = anchor?.text.trim();
  if (text && text !== title) return text;
  return feature.detail.loc?.trim() || empty;
}

/**
 * 功能点标签：新增（since == 当前说明版本）/ 变更（本版改过）/ 边缘（kind=edge）/ 无变化「—」。
 * 原型的行右侧总有一个标签位，无变化也占位（「—」），避免行宽跳动。
 */
function FeatureTag({
  feature,
  currentVersion,
  changed,
}: {
  feature: ModuleWorkspaceFeature;
  currentVersion: number;
  changed: boolean;
}) {
  const { t } = useT("archive");
  const addedSince = (feature.detail as { since?: unknown }).since;
  const isNew = typeof addedSince === "number" && addedSince === currentVersion;
  const base = "shrink-0 rounded px-1 py-px text-[8.5px] font-bold";
  if (isNew) {
    return (
      <span className={cn(base, "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400")}>
        {t(($) => $.features.inspector_fp_tag_new)}
      </span>
    );
  }
  if (changed) {
    return (
      <span className={cn(base, "bg-primary/12 text-primary")}>
        {t(($) => $.features.inspector_fp_tag_changed)}
      </span>
    );
  }
  if (feature.kind === "edge") {
    return (
      <span className={cn(base, "bg-muted text-muted-foreground")}>
        {t(($) => $.features.inspector_fp_tag_edge)}
      </span>
    );
  }
  return (
    <span className={cn(base, "text-muted-foreground/60")}>
      {t(($) => $.features.inspector_fp_tag_same)}
    </span>
  );
}

function nextFeatureCode(features: ModuleWorkspaceFeature[]): string {
  return `FP-${String(maxFeatureNumber(features) + 1).padStart(2, "0")}`;
}

/** 现有功能点编号的最大尾号：新增与导入都从这里往后接，不重号。 */
function maxFeatureNumber(features: Array<{ code: string }>): number {
  let max = 0;
  for (const feature of features) {
    const match = /(\d+)\s*$/.exec(feature.code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** 新建功能点：追加到模块规格并发布（spec 是功能点的唯一真源）。 */
function AddFeatureRow({
  pending,
  defaultCode,
  onCancel,
  onSave,
}: {
  pending: boolean;
  defaultCode: string;
  onCancel: () => void;
  onSave: (draft: { code: string; title: string; group: string }) => void;
}) {
  const { t } = useT("archive");
  const [code, setCode] = useState(defaultCode);
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  return (
    <div className="mt-1.5 space-y-1 rounded-md border border-dashed border-primary/40 bg-primary/[0.03] p-1.5">
      <div className="flex items-center gap-1">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t(($) => $.features.inspector_fp_add_code)}
          className="w-[72px] rounded border border-surface-border bg-surface px-1.5 py-1 font-mono text-[10px] outline-none focus:border-primary/50"
        />
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t(($) => $.features.inspector_fp_add_title)}
          className="min-w-0 flex-1 rounded border border-surface-border bg-surface px-1.5 py-1 text-[11px] outline-none focus:border-primary/50"
        />
      </div>
      <input
        value={group}
        onChange={(event) => setGroup(event.target.value)}
        placeholder={t(($) => $.features.inspector_fp_add_group)}
        className="w-full rounded border border-surface-border bg-surface px-1.5 py-1 text-[10.5px] outline-none focus:border-primary/50"
      />
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="xs"
          disabled={pending || !code.trim() || !title.trim()}
          onClick={() => onSave({ code: code.trim(), title: title.trim(), group: group.trim() })}
        >
          {t(($) => $.features.inspector_brief_save)}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          {t(($) => $.features.inspector_brief_cancel)}
        </Button>
      </div>
    </div>
  );
}

function completionTone(filled: number, total: number): string {
  if (total === 0 || filled === 0) return "text-muted-foreground/70";
  if (filled >= total) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

/** ◍filled/total：四段填充度用一排小点表示，数字走 i18n（JSX 里不写裸字面量）。 */
function FillMeter({
  filled,
  total,
  className,
}: {
  filled: number;
  total: number;
  className?: string;
}) {
  const { t } = useT("archive");
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className ?? completionTone(filled, total))}>
      <span className="inline-flex items-center gap-px" aria-hidden>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-1 rounded-full",
              index < filled ? "bg-current" : "bg-current/25",
            )}
          />
        ))}
      </span>
      {t(($) => $.features.inspector_fill_ratio, { filled, total })}
    </span>
  );
}

/** 四段详情：1 描述与定位 · 2 细节要求 · 3 交互与依赖 · 4 验收标准。 */
function FeatureDetail({
  feature,
  currentVersion,
  changed,
  pending,
  onSave,
  onClose,
}: {
  feature: ModuleWorkspaceFeature;
  currentVersion: number;
  changed: boolean;
  pending: boolean;
  onSave: (key: string, value: unknown) => void;
  onClose: () => void;
}) {
  const { t } = useT("archive");
  const [editing, setEditing] = useState<string | null>(null);
  const base = `fp.${feature.code}`;
  const detail = feature.detail;
  const reqLines = toLines(detail.req);
  const acceptanceItems = toAcceptance(detail.acceptance);

  const segments: Array<{
    id: string;
    title: string;
    note?: string;
    body: ReactNode;
    editValue: string;
    multiline: boolean;
    parse: (raw: string) => unknown;
  }> = [
    {
      id: "desc",
      title: t(($) => $.features.inspector_seg_desc),
      note: detail.loc?.trim()
        ? t(($) => $.features.inspector_seg_loc_value, { loc: detail.loc.trim() })
        : undefined,
      body: (
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed">
          {detail.desc?.trim() || t(($) => $.features.inspector_seg_empty)}
        </p>
      ),
      editValue: detail.desc ?? "",
      multiline: true,
      parse: (raw) => raw,
    },
    {
      id: "req",
      title: t(($) => $.features.inspector_seg_req),
      note: reqLines.length
        ? t(($) => $.features.inspector_seg_req_count, { n: reqLines.length })
        : undefined,
      body:
        reqLines.length > 0 ? (
          <ol className="list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed">
            {reqLines.map((item, index) => (
              <li key={`${feature.code}-req-${index}`}>{item}</li>
            ))}
          </ol>
        ) : (
          <p className="text-[10.5px] text-muted-foreground">
            {t(($) => $.features.inspector_seg_empty)}
          </p>
        ),
      editValue: reqLines.join("\n"),
      multiline: true,
      parse: (raw) =>
        raw
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
    },
    {
      id: "interaction",
      title: t(($) => $.features.inspector_seg_inter),
      body: (
        <div className="space-y-1">
          <p className="text-[11px] leading-relaxed">
            <span className="font-semibold text-muted-foreground">
              {t(($) => $.features.inspector_seg_inter_label)}
            </span>{" "}
            {detail.interaction?.trim() || t(($) => $.features.inspector_seg_empty)}
          </p>
          <p className="text-[10px] leading-relaxed">
            <span className="font-semibold text-muted-foreground">
              {t(($) => $.features.inspector_seg_deps_label)}
            </span>{" "}
            {detail.deps?.trim() || t(($) => $.features.inspector_seg_empty)}
          </p>
        </div>
      ),
      editValue: detail.interaction ?? "",
      multiline: true,
      parse: (raw) => raw,
    },
    {
      id: "acceptance",
      title: t(($) => $.features.inspector_seg_accept),
      note: acceptanceItems.length
        ? t(($) => $.features.inspector_seg_accept_note, {
            ok: feature.acceptance_ok,
            n: feature.acceptance_total,
          })
        : undefined,
      body: <AcceptanceList feature={feature} onSave={onSave} />,
      editValue: acceptanceItems.map((item) => item.text ?? "").join("\n"),
      multiline: true,
      parse: (raw) =>
        raw
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((text) => ({ text, ok: false })),
    },
  ];

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-primary/25 bg-primary/[0.03] p-1.5"
      data-testid="feature-detail"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9px] text-muted-foreground">{feature.code}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold">{feature.title}</span>
        <FeatureTag feature={feature} currentVersion={currentVersion} changed={changed} />
        <FillMeter
          filled={feature.filled}
          total={feature.total}
          className={cn("text-[9.5px] font-semibold", completionTone(feature.filled, feature.total))}
        />
        <button
          type="button"
          aria-label={t(($) => $.features.inspector_collapse_detail)}
          onClick={onClose}
          className="rounded p-px text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      {segments.map((segment) => (
        <div key={segment.id} className="group/seg rounded-md bg-surface/70 px-1.5 py-1">
          <div className="flex items-center gap-1">
            <p className="flex-1 text-[9.5px] font-semibold text-muted-foreground">
              {segment.title}
              {segment.note ? (
                <span className="ml-1 font-normal opacity-75">{segment.note}</span>
              ) : null}
            </p>
            {segment.id === "acceptance" ? null : (
              <button
                type="button"
                aria-label={t(($) => $.features.inspector_edit)}
                onClick={() => setEditing(segment.id)}
                className="rounded p-px text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover/seg:opacity-100"
              >
                <Pencil className="size-2.5" />
              </button>
            )}
          </div>
          {editing === segment.id ? (
            <FieldEditor
              label={segment.title}
              initial={segment.editValue}
              multiline={segment.multiline}
              pending={pending}
              onCancel={() => setEditing(null)}
              onSave={(raw) => {
                onSave(`${base}.${segment.id}`, segment.parse(raw));
                setEditing(null);
              }}
            />
          ) : (
            segment.body
          )}
        </div>
      ))}
    </div>
  );
}

function AcceptanceList({
  feature,
  onSave,
}: {
  feature: ModuleWorkspaceFeature;
  onSave: (key: string, value: unknown) => void;
}) {
  const { t } = useT("archive");
  const items = toAcceptance(feature.detail.acceptance);
  if (items.length === 0) {
    return (
      <p className="text-[10.5px] text-muted-foreground">
        {t(($) => $.features.inspector_seg_empty)}
      </p>
    );
  }
  return (
    <ul className="space-y-0.5">
      {items.map((item, index) => (
        <li key={`${feature.code}-ac-${index}`} className="flex items-start gap-1">
          <button
            type="button"
            aria-label={t(($) => $.features.inspector_accept_toggle)}
            onClick={() => {
              const next: ModuleAcceptanceItem[] = items.map((row, rowIndex) =>
                rowIndex === index ? { ...row, ok: !row.ok } : row,
              );
              onSave(`fp.${feature.code}.acceptance`, next);
            }}
            className={cn(
              "mt-px flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[8px]",
              item.ok
                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "border-muted-foreground/30 text-transparent hover:border-muted-foreground/60",
            )}
          >
            <Check className="size-2" />
          </button>
          <span className="text-[10.5px] leading-relaxed">{item.text ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

// ── ③ 版本记录 ────────────────────────────────────────────────────────

function VersionsSection({
  projectId,
  moduleId,
  protoVersion,
  preview,
  workspace,
}: {
  projectId: string;
  moduleId: string;
  protoVersion: number | null;
  preview?: { version: number; htmlPath: string; issueId?: string | null };
  workspace: ModuleWorkspace;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const publish = usePublishModuleRelease(wsId, projectId, moduleId);
  const rollback = useRollbackModuleRelease(wsId, projectId, moduleId);
  const register = useRegisterModulePrototype(wsId, projectId, moduleId);
  const latest = workspace.versions[0];
  const released = latest
    ? workspace.releases.some((row) => row.brief_version === latest.version)
    : false;
  const nextRelease = (workspace.release_version ?? 0) + 1;
  const pairProto = workspace.canonical_prototype_version ?? protoVersion ?? undefined;

  return (
    <section className="px-2.5 py-2.5" data-testid="versions-section">
      <div className="mb-1.5 flex items-center gap-1.5">
        <h3 className="text-[11px] font-bold">{t(($) => $.features.inspector_versions)}</h3>
        <span className="ml-auto text-[9.5px] text-muted-foreground">
          {t(($) => $.features.inspector_versions_meta, { n: workspace.versions.length })}
        </span>
        {latest && !released && pairProto == null && preview ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-5 px-1.5 text-[9.5px]"
            disabled={register.isPending}
            onClick={() =>
              register.mutate(
                {
                  version: preview.version,
                  html_path: preview.htmlPath,
                  status: "confirmed",
                  issue_id: preview.issueId ?? undefined,
                  set_canonical: true,
                },
                {
                  onSuccess: () =>
                    toast.success(
                      t(($) => $.features.inspector_register_ok, { version: preview.version }),
                    ),
                  onError: () => toast.error(t(($) => $.features.inspector_register_failed)),
                },
              )
            }
          >
            {t(($) => $.features.inspector_register_proto, { version: preview.version })}
          </Button>
        ) : latest && !released ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-5 px-1.5 text-[9.5px]"
            disabled={publish.isPending || pairProto == null}
            title={pairProto == null ? t(($) => $.features.inspector_release_need_proto) : undefined}
            onClick={() =>
              publish.mutate(
                { brief_version: latest.version, prototype_version: pairProto },
                {
                  onSuccess: (result) =>
                    toast.success(
                      t(($) => $.features.inspector_release_ok, {
                        version: result.release.version,
                      }),
                    ),
                  onError: () => toast.error(t(($) => $.features.inspector_release_failed)),
                },
              )
            }
          >
            {t(($) => $.features.inspector_release_now, { version: nextRelease })}
          </Button>
        ) : null}
      </div>
      {workspace.versions.length === 0 ? (
        <p className="text-[10.5px] text-muted-foreground">
          {t(($) => $.features.inspector_seg_empty)}
        </p>
      ) : (
        <ul className="space-y-1">
          {workspace.versions.map((row) => {
            const release = workspace.releases.find(
              (item) => item.brief_version === row.version,
            );
            const added = row.changes.filter((change) => change.op === "set").length;
            const removed = row.changes.filter((change) => change.op === "clear").length;
            return (
              <li
                key={row.version}
                className="flex items-start gap-1.5 rounded border border-surface-border bg-surface px-1.5 py-1"
              >
                <span className="shrink-0 font-mono text-[9.5px] font-semibold">
                  {t(($) => $.features.inspector_version_label, { version: row.version })}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className={cn("rounded px-1 py-px text-[8.5px] font-semibold", sourceTone(row.source))}>
                      {sourceLabel(row.source, t)}
                    </span>
                    {release ? (
                      <span className="rounded bg-emerald-500/15 px-1 py-px text-[8.5px] font-bold text-emerald-700 dark:text-emerald-400">
                        {t(($) => $.features.inspector_release_label, { version: release.version })}
                      </span>
                    ) : null}
                    <span className="truncate text-[10px] text-foreground">
                      {row.diff_summary || t(($) => $.features.inspector_version_first)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-muted-foreground">
                    <span>{t(($) => $.features.inspector_diff_added, { n: added })}</span>
                    <span>{t(($) => $.features.inspector_diff_removed, { n: removed })}</span>
                    <span>{formatWhen(row.created_at)}</span>
                    {release ? (
                      <button
                        type="button"
                        disabled={rollback.isPending}
                        onClick={() =>
                          rollback.mutate(release.version, {
                            onSuccess: (result) =>
                              toast.success(
                                t(($) => $.features.inspector_rollback_ok, {
                                  version: result.release.version,
                                }),
                              ),
                            onError: () =>
                              toast.error(t(($) => $.features.inspector_rollback_failed)),
                          })
                        }
                        className="ml-auto rounded px-1 py-px font-semibold text-primary/80 hover:bg-primary/10 hover:text-primary"
                      >
                        {t(($) => $.features.inspector_version_rollback)}
                      </button>
                    ) : null}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function sourceLabel(
  source: string,
  t: ReturnType<typeof useT<"archive">>["t"],
): string {
  switch (source) {
    case "agent":
      return t(($) => $.features.inspector_version_source_agent);
    case "mcp":
      return t(($) => $.features.inspector_version_source_mcp);
    case "extract":
      return t(($) => $.features.inspector_version_source_extract);
    case "rollback":
      return t(($) => $.features.inspector_version_source_rollback);
    default:
      return t(($) => $.features.inspector_version_source_manual);
  }
}

function sourceTone(source: string): string {
  switch (source) {
    case "agent":
    case "mcp":
      return "bg-primary/10 text-primary";
    case "rollback":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

// ── 编辑基础件与工具 ──────────────────────────────────────────────────

function FieldEditor({
  label,
  initial,
  multiline,
  pending,
  onCancel,
  onSave,
}: {
  label: string;
  initial: string;
  multiline: boolean;
  pending: boolean;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const { t } = useT("archive");
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const inputClass =
    "w-full rounded border border-surface-border bg-surface px-1.5 py-1 text-[11px] leading-relaxed outline-none focus:border-primary/50";
  return (
    <div className="space-y-1">
      <p className="text-[9.5px] font-semibold text-muted-foreground">{label}</p>
      {multiline ? (
        <textarea
          ref={(node) => {
            ref.current = node;
          }}
          rows={3}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className={cn(inputClass, "resize-y")}
        />
      ) : (
        <input
          ref={(node) => {
            ref.current = node;
          }}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSave(value);
            if (event.key === "Escape") onCancel();
          }}
          className={inputClass}
        />
      )}
      <div className="flex items-center gap-1">
        <Button type="button" size="xs" disabled={pending} onClick={() => onSave(value)}>
          {t(($) => $.features.inspector_brief_save)}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          {t(($) => $.features.inspector_brief_cancel)}
        </Button>
      </div>
    </div>
  );
}

/** fields 里某个 key 是否已有内容：导入时只补空的，已有值一律不动。 */
function hasFieldText(entry?: { value: unknown }): boolean {
  return renderScalar(entry?.value).trim().length > 0;
}

/** 后端 fields 的 value 是任意 JSON；文本行只渲染标量，数组/对象压成一行。 */
function renderScalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : renderScalar(item)))
      .filter(Boolean)
      .join("、");
  }
  if (typeof value === "object") {
    const obj = value as { text?: unknown };
    if (typeof obj.text === "string") return obj.text;
    return JSON.stringify(value);
  }
  return String(value);
}

/** req 存的是写入时的原始 JSON：历史数据可能是裸字符串，统一压成行数组。 */
function toLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => renderScalar(item).trim()).filter(Boolean);
  }
  const single = renderScalar(value).trim();
  return single ? [single] : [];
}

/** 验收条目可能是 {text, ok}，也可能是 “✓ xxx” 裸字符串（早先的提取器产物）。 */
function toAcceptance(value: unknown): ModuleAcceptanceItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === "object") {
      const row = item as ModuleAcceptanceItem;
      return { text: row.text ?? "", ok: row.ok === true };
    }
    const text = renderScalar(item);
    return { text: text.replace(/^\s*[✓○]\s*/, ""), ok: text.trimStart().startsWith("✓") };
  });
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── 需求与任务绑定（保留原有能力，收进折叠块） ──────────────────────

function BindSection({
  projectId,
  moduleId,
  moduleName,
  issue,
  allIssues,
}: {
  projectId: string;
  moduleId?: string;
  moduleName?: string;
  issue?: Issue;
  allIssues: Issue[];
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const updateIssue = useUpdateIssue();

  const childTasks = useMemo(
    () => (issue ? allIssues.filter((row) => row.parent_issue_id === issue.id) : []),
    [allIssues, issue],
  );
  const unboundChildren = childTasks.filter((row) => row.module_id !== moduleId);
  const unboundPool = useMemo(
    () =>
      allIssues
        .filter(
          (row) => row.project_id === projectId && !row.module_id && row.id !== issue?.id,
        )
        .slice(0, 8),
    [allIssues, issue?.id, projectId],
  );

  const bind = (issueId: string) => {
    if (!moduleId) return;
    updateIssue.mutate(
      { id: issueId, module_id: moduleId },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: graphKeys.projectIssues(wsId, projectId) });
          toast.success(t(($) => $.features.inspector_bind_ok));
        },
        onError: () => toast.error(t(($) => $.features.inspector_bind_failed)),
      },
    );
  };

  const bindChildren = async () => {
    if (!moduleId || unboundChildren.length === 0) return;
    try {
      await Promise.all(
        unboundChildren.map((row) => updateIssue.mutateAsync({ id: row.id, module_id: moduleId })),
      );
      void qc.invalidateQueries({ queryKey: graphKeys.projectIssues(wsId, projectId) });
      toast.success(t(($) => $.features.inspector_bind_ok));
    } catch {
      toast.error(t(($) => $.features.inspector_bind_failed));
    }
  };

  return (
    <div className="mt-1.5">
      {issue ? (
        <div className="rounded-lg border border-surface-border bg-surface px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">
              {issueShortLabel(issue)}
            </span>
            <FeaturePill tone={featurePillTone(issue.requirement_status || issue.status)}>
              {issue.requirement_status || issue.status}
            </FeaturePill>
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {moduleName
              ? t(($) => $.features.inspector_bound_module, { name: moduleName })
              : t(($) => $.features.inspector_unbound)}
          </p>
          {childTasks.length > 0 && (
            <p className="mt-0.5 text-[9.5px] text-muted-foreground">
              {t(($) => $.features.inspector_task_count, {
                bound: childTasks.length - unboundChildren.length,
                total: childTasks.length,
              })}
            </p>
          )}
          {unboundChildren.length > 0 && moduleId && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="mt-1.5"
              disabled={updateIssue.isPending}
              onClick={() => void bindChildren()}
            >
              {t(($) => $.features.inspector_bind_tasks)}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[10.5px] text-muted-foreground">
          {t(($) => $.features.prototypes_empty)}
        </p>
      )}
      {moduleId && unboundPool.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {unboundPool.map((row) => (
            <li key={row.id} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[10.5px]">
                {isTopLevelRequirement(row)
                  ? t(($) => $.features.req_filter)
                  : t(($) => $.features.inspector_task)}
                {" · "}
                {issueShortLabel(row)}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={updateIssue.isPending}
                onClick={() => bind(row.id)}
              >
                {t(($) => $.features.inspector_bind_here)}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
