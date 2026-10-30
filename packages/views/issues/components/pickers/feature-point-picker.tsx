"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  isModuleWorkspaceGated,
  moduleWorkspaceOptions,
} from "@multica/core/projects";
import type { ModuleWorkspaceFeature } from "@multica/core/types";
import {
  PropertyPicker,
  PickerItem,
  PickerEmpty,
} from "./property-picker";
import { PropRow } from "../../../common/prop-row";
import { useT } from "../../../i18n";

/** 功能点编号的小方块（等宽，读起来像句柄而不是标题）。 */
export function FeatureCodeChip({ code }: { code: string }) {
  return (
    <span className="shrink-0 rounded border border-border/70 bg-muted/40 px-1 font-mono text-micro leading-4 text-foreground/80">
      {code}
    </span>
  );
}

interface FeaturePointPickerProps {
  projectId: string;
  /** 模块 id：功能点编号只在模块内唯一，所以没有模块就没有可选清单。 */
  moduleId?: string | null;
  /** 当前绑定的编号；null/undefined = 未绑定。 */
  value?: string | null;
  onChange: (code: string | null) => void;
  align?: "start" | "center" | "end";
  /** 测试用：直接展开候选列表（与 SprintPicker 同款）。 */
  defaultOpen?: boolean;
  disabled?: boolean;
}

/**
 * 功能点选择器 —— 归属链的最后一跳（项目 → 模块 → 原型图 → 功能点）。
 *
 * 候选项来自模块工作区（GET /modules/{id}/workspace 的 features），与「项目 →
 * 功能模块」右栏是同一份投影，不另起一套功能点元数据。flag 关闭时该端点 404，
 * 选择器整行消失（与模块其它子能力同款门控）。
 *
 * 一个任务对应一个功能点：这里只做单选。任务如果真的横跨多个功能点，应该拆成
 * 多条任务 —— 那样每条的「目标 + 四段详情」才有唯一答案。
 */
export function FeaturePointPicker({
  projectId,
  moduleId,
  value,
  onChange,
  align = "start",
  defaultOpen = false,
  disabled = false,
}: FeaturePointPickerProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState("");

  // 没有模块时不发请求：编号只在模块内唯一，空模块的工作区没有可读的东西。
  const workspaceQuery = useQuery({
    ...moduleWorkspaceOptions(wsId, projectId, moduleId ?? undefined),
    enabled: Boolean(moduleId),
  });
  const gated = workspaceQuery.isError && isModuleWorkspaceGated(workspaceQuery.error);

  // 没有模块，或者门控关着：功能点这一行不成立。hooks 已全部调用，这里提前
  // 返回是安全的。
  if (!moduleId || gated) return null;

  const features = workspaceQuery.data?.features ?? [];
  const selected = features.find((f) => f.code === value) ?? null;
  const query = filter.trim().toLowerCase();
  const filtered = query
    ? features.filter(
        (f) =>
          f.code.toLowerCase().includes(query) ||
          f.title.toLowerCase().includes(query),
      )
    : features;

  const choose = (code: string | null) => {
    onChange(code);
    setOpen(false);
  };

  return (
    <PropertyPicker
      open={open}
      onOpenChange={(v: boolean) => {
        if (disabled) return;
        setOpen(v);
        if (!v) setFilter("");
      }}
      width="w-80"
      align={align}
      searchable
      searchPlaceholder={t(($) => $.module.fp_picker_search)}
      onSearchChange={setFilter}
      trigger={
        value ? (
          <span className="flex min-w-0 items-center gap-1">
            <FeatureCodeChip code={selected?.code ?? value} />
            {selected ? (
              <span className="min-w-0 truncate">{selected.title}</span>
            ) : (
              // 编号还在、规格里没有了：照实显示句柄，别假装它还有标题。
              <span className="text-muted-foreground">
                {t(($) => $.module.fp_missing_short)}
              </span>
            )}
          </span>
        ) : (
          <>
            <Target className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              {t(($) => $.module.fp_label)}
            </span>
          </>
        )
      }
    >
      <PickerItem
        selected={!value}
        emptyValue
        onClick={() => choose(null)}
        tooltip={t(($) => $.module.fp_picker_none_hint)}
      >
        <span className="inline-block h-3 w-3 shrink-0 rounded-full border border-dashed border-muted-foreground/50" />
        <span className="truncate text-muted-foreground">
          {t(($) => $.module.fp_picker_none)}
        </span>
      </PickerItem>
      {filtered.map((feature) => (
        <PickerItem
          key={feature.code}
          selected={feature.code === value}
          onClick={() => choose(feature.code)}
          tooltip={<FeatureTooltip feature={feature} />}
        >
          <FeatureCodeChip code={feature.code} />
          <span className="truncate">{feature.title}</span>
          <span className="ml-auto shrink-0 text-micro text-muted-foreground">
            {t(($) => $.module.fp_filled, {
              filled: feature.filled,
              total: feature.total,
            })}
          </span>
        </PickerItem>
      ))}
      {filtered.length === 0 &&
        (features.length === 0 ? (
          <div className="px-2 py-3 text-center text-body text-muted-foreground">
            {workspaceQuery.isLoading
              ? t(($) => $.module.fp_picker_loading)
              : t(($) => $.module.fp_picker_empty)}
          </div>
        ) : (
          <PickerEmpty />
        ))}
    </PropertyPicker>
  );
}

/**
 * 属性栏里的一整行（标签 + 选择器）。门控关着时整行不存在 —— 门控判断放在
 * 这里，调用方就不必先探一次模块工作区才能决定要不要渲染这行标签。
 */
export function FeaturePointPropRow({
  projectId,
  moduleId,
  value,
  onChange,
}: {
  projectId?: string | null;
  moduleId?: string | null;
  value?: string | null;
  onChange: (code: string | null) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const workspaceQuery = useQuery({
    ...moduleWorkspaceOptions(wsId, projectId ?? "", moduleId ?? undefined),
    enabled: Boolean(projectId && moduleId),
  });
  const gated = workspaceQuery.isError && isModuleWorkspaceGated(workspaceQuery.error);
  if (!projectId || !moduleId || gated) return null;
  return (
    <PropRow label={t(($) => $.module.fp_label)}>
      <FeaturePointPicker
        projectId={projectId}
        moduleId={moduleId}
        value={value}
        onChange={onChange}
        align="start"
      />
    </PropRow>
  );
}

/** 行内塞不下的元信息（分组、优先级、验收进度）放悬停里。 */
function FeatureTooltip({ feature }: { feature: ModuleWorkspaceFeature }) {
  const { t } = useT("issues");
  const meta = [
    feature.group,
    feature.priority,
    feature.kind === "edge" ? t(($) => $.module.fp_kind_edge) : null,
    feature.acceptance_total > 0
      ? t(($) => $.module.fp_accept_ok, {
          ok: feature.acceptance_ok,
          n: feature.acceptance_total,
        })
      : null,
  ].filter(Boolean);
  return (
    <span className="block space-y-1">
      <span className="block">
        {feature.code} · {feature.title}
      </span>
      {meta.length > 0 && (
        <span className="block text-muted-foreground">{meta.join(" · ")}</span>
      )}
    </span>
  );
}
