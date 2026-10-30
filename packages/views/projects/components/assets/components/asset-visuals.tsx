"use client";

// 资产展示视觉系统：六类分类的图标/配色、生命周期阶段与输入-产物角色徽标、
// 标签 chips。项目 TAB 列表 / 卡片 / 统计条共用，配色全部用字面 tailwind 类
// （避免动态拼接被 JIT purge）。

import {
  BookOpen,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  GitBranch,
  Globe,
  Layers,
  Package,
  type LucideIcon,
} from "lucide-react";
import type {
  AssetCategory,
  AssetLifecycleStage,
  AssetRole,
} from "@multica/core/types";
import { useT } from "../../../../i18n";

/** 分类 → 图标 + 色板（tile = 图标底色块，dot = 占比条/图例点）。 */
export const CATEGORY_VISUALS: Record<
  AssetCategory,
  { icon: LucideIcon; tile: string; dot: string }
> = {
  code_repository: { icon: GitBranch, tile: "bg-violet-500/10 text-violet-600 dark:text-violet-400", dot: "bg-violet-500" },
  application: { icon: Globe, tile: "bg-blue-500/10 text-blue-600 dark:text-blue-400", dot: "bg-blue-500" },
  package: { icon: Package, tile: "bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  knowledge_repo: { icon: BookOpen, tile: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  knowledge_group: { icon: Layers, tile: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400", dot: "bg-cyan-500" },
  other: { icon: FileText, tile: "bg-slate-500/10 text-slate-600 dark:text-slate-400", dot: "bg-slate-500" },
};

/** 知识 / 文档类资产按扩展名换文件图标，让 150+ 篇文档不再千篇一律。 */
const SUBTYPE_ICONS: Record<string, LucideIcon> = {
  md: FileText,
  markdown: FileText,
  txt: FileText,
  doc: FileText,
  docx: FileText,
  pdf: FileText,
  html: FileCode,
  htm: FileCode,
  json: FileCode,
  yaml: FileCode,
  yml: FileCode,
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  py: FileCode,
  go: FileCode,
  java: FileCode,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
};

export function AssetCategoryIcon({
  category,
  subtype,
  className = "size-4",
}: {
  category: AssetCategory;
  subtype?: string | null;
  className?: string;
}) {
  const base = CATEGORY_VISUALS[category]?.icon ?? FileText;
  let Icon = base;
  const isDocument =
    category === "knowledge_repo" || category === "knowledge_group" || category === "other";
  if (isDocument && subtype) {
    Icon = SUBTYPE_ICONS[subtype.toLowerCase().replace(/^\./, "")] ?? base;
  }
  return <Icon className={className} aria-hidden />;
}

export function AssetCategoryTile({
  category,
  subtype,
}: {
  category: AssetCategory;
  subtype?: string | null;
}) {
  const visual = CATEGORY_VISUALS[category] ?? CATEGORY_VISUALS.other;
  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${visual.tile}`}
    >
      <AssetCategoryIcon category={category} subtype={subtype} className="size-4" />
    </span>
  );
}

/**
 * 徽标统一度量：11px（text-micro）字号 + 4px 垂直内边距 + 上下各 1px 描边，
 * 实际高度 22px。此前用 text-[10px]/py-px，在高分屏与网页端 100% 缩放下
 * 中文阶段名（“S1 项目规划”）辨识度明显偏低。
 */
export const ASSET_BADGE_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-micro font-medium leading-none";

// 阶段主色带 ring 描边 + 稍深底色，让表格列扫读时阶段分组一眼可辨。
const STAGE_TONES: Record<AssetLifecycleStage, string> = {
  S0: "bg-fuchsia-500/15 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-500/30 dark:text-fuchsia-300",
  S1: "bg-violet-500/15 text-violet-700 ring-1 ring-inset ring-violet-500/30 dark:text-violet-300",
  S2: "bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/30 dark:text-sky-300",
  S3: "bg-amber-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300",
  S4: "bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300",
  S5: "bg-teal-500/15 text-teal-700 ring-1 ring-inset ring-teal-500/30 dark:text-teal-300",
  general: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
};

// 标签语义组 → 高亮色（与后端 assetStageRules 关键词同源）：原型=violet、
// 规划需求=sky、执行设计=amber、验收申报=emerald。字面类名避免 JIT purge。
const TAG_TONE_GROUPS: Array<{ keywords: string[]; tone: string }> = [
  { keywords: ["prototype", "原型", "mockup", "prototype-html"], tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  { keywords: ["acceptance", "验收", "test", "retrospective", "复盘", "filing", "patent", "copyright", "申报"], tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  { keywords: ["mrd", "prd", "brd", "requirement", "需求", "roadmap", "work-plan", "plan", "计划", "规划", "research", "调研", "schedule", "decomposition"], tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  { keywords: ["design", "架构", "architecture", "change-log", "report", "评估", "本体", "图谱", "实现", "execution", "scan"], tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
];

// 未命中语义组的标签按字符哈希稳定落进扩展调色板，同标签永远同色。
const TAG_FALLBACK_TONES = [
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  "bg-lime-600/15 text-lime-700 dark:text-lime-300",
];

export function tagTone(tag: string): string {
  const lower = tag.toLowerCase();
  for (const group of TAG_TONE_GROUPS) {
    if (group.keywords.some((kw) => lower.includes(kw))) return group.tone;
  }
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  }
  return (
    TAG_FALLBACK_TONES[hash % TAG_FALLBACK_TONES.length] ??
    "bg-slate-500/10 text-slate-600 dark:text-slate-300"
  );
}

export function AssetStageBadge({ stage }: { stage: AssetLifecycleStage }) {
  const { t } = useT("assets");
  const labels: Record<AssetLifecycleStage, string> = {
    S0: t(($) => $.stages.S0),
    S1: t(($) => $.stages.S1),
    S2: t(($) => $.stages.S2),
    S3: t(($) => $.stages.S3),
    S4: t(($) => $.stages.S4),
    S5: t(($) => $.stages.S5),
    general: t(($) => $.stages.general),
  };
  return (
    <span className={`${ASSET_BADGE_CLASS} font-semibold ${STAGE_TONES[stage] ?? STAGE_TONES.general}`}>
      {labels[stage] ?? stage}
    </span>
  );
}

export function AssetRoleBadge({ role }: { role: AssetRole }) {
  const { t } = useT("assets");
  return role === "input" ? (
    <span className={`${ASSET_BADGE_CLASS} font-semibold bg-blue-500/15 text-blue-700 ring-1 ring-inset ring-blue-500/30 dark:text-blue-300`}>
      {t(($) => $.roles.input)}
    </span>
  ) : (
    <span className={`${ASSET_BADGE_CLASS} font-semibold bg-green-500/15 text-green-700 ring-1 ring-inset ring-green-500/30 dark:text-green-300`}>
      {t(($) => $.roles.output)}
    </span>
  );
}

/** 阶段 + 角色组合徽标；未打标时渲染一个弱化占位，提示可补标。 */
export function AssetStageRoleBadges({
  stage,
  role,
}: {
  stage?: AssetLifecycleStage | null;
  role?: AssetRole | null;
}) {
  const { t } = useT("assets");
  if (!stage && !role) {
    return (
      <span className={`${ASSET_BADGE_CLASS} border border-dashed border-surface-border text-muted-foreground`}>
        {t(($) => $.stages.none)}
      </span>
    );
  }
  return (
    <>
      {stage ? <AssetStageBadge stage={stage} /> : null}
      {role ? <AssetRoleBadge role={role} /> : null}
    </>
  );
}

export function AssetTagChips({ tags, max = 3 }: { tags?: string[]; max?: number }) {
  if (!tags?.length) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {shown.map((tag) => (
        <span
          key={tag}
          className={`max-w-32 shrink-0 truncate rounded-md px-1.5 py-0.5 text-micro font-medium leading-none ${tagTone(tag)}`}
          title={tag}
        >
          {tag}
        </span>
      ))}
      {rest > 0 ? (
        <span className="shrink-0 text-micro text-muted-foreground">{`+${rest}`}</span>
      ) : null}
    </span>
  );
}
