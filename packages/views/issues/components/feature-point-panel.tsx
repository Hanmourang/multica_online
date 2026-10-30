"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  isModuleWorkspaceGated,
  moduleWorkspaceOptions,
} from "@multica/core/projects";
import type { ModuleAcceptanceItem, ModuleWorkspaceFeature } from "@multica/core/types";
import { useT } from "../../i18n";
import { FeatureCodeChip } from "./pickers/feature-point-picker";

const asText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** req/acceptance 存的是写入时的原始 JSON，历史行可能是裸字符串。 */
const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === "string"
          ? entry.trim()
          : asText((entry as { text?: unknown } | null)?.text),
      )
      .filter((entry) => entry.length > 0);
  }
  const text = asText(value);
  return text ? [text] : [];
};

const asAcceptance = (
  value: unknown,
): Array<{ text: string; ok: boolean }> => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return { text: entry.trim(), ok: false };
        const item = entry as ModuleAcceptanceItem | null;
        return { text: asText(item?.text), ok: item?.ok === true };
      })
      .filter((entry) => entry.text.length > 0);
  }
  const text = asText(value);
  return text ? [{ text, ok: false }] : [];
};

interface FeaturePointPanelProps {
  projectId?: string | null;
  moduleId?: string | null;
  /** 绑定的功能点编号；空 = 不渲染。 */
  code?: string | null;
}

/**
 * 功能点信息面板 —— 任务右栏里回答「这个功能点到底要做什么」。
 *
 * 数据来自模块工作区（GET /modules/{id}/workspace），与外面对同一功能点的
 * 展示是同一份投影：模块目标（brief.goal）+ 功能点四段详情（desc/loc/req/
 * interaction/deps/acceptance）与填充度。这里只读 —— 编辑仍然落在「项目 →
 * 功能模块」，避免同一份内容出现第二个写入面。
 *
 * 空段落照实写「尚未填写」而不是隐藏：缺口本身就是 agent 需要补的信息。
 */
export function FeaturePointPanel({
  projectId,
  moduleId,
  code,
}: FeaturePointPanelProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(true);

  const workspaceQuery = useQuery({
    ...moduleWorkspaceOptions(wsId, projectId ?? "", moduleId ?? undefined),
    enabled: Boolean(projectId && moduleId),
  });
  const gated = workspaceQuery.isError && isModuleWorkspaceGated(workspaceQuery.error);

  if (!code || !moduleId || gated) return null;

  const workspace = workspaceQuery.data;
  // 还没拿到（或拿不到）就不占位：行本身已经把编号和标题显示出来了。
  if (!workspace) return null;

  const feature: ModuleWorkspaceFeature | undefined = workspace.features.find(
    (item) => item.code === code,
  );
  if (!feature) {
    return (
      <div className="-mx-1 mb-1 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-caption text-muted-foreground">
        <FeatureCodeChip code={code} />
        <span className="ml-1">{t(($) => $.module.fp_missing)}</span>
      </div>
    );
  }

  const goal = asText(workspace.brief.fields["brief.goal"]?.value);
  const detail = feature.detail ?? {};
  const req = asList(detail.req);
  const acceptance = asAcceptance(detail.acceptance);

  return (
    <div className="mb-1 overflow-hidden rounded-md border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent/40"
      >
        <ChevronRight
          className={`size-3 shrink-0 stroke-[2.5] transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 truncate">
          {open
            ? t(($) => $.module.fp_collapse)
            : t(($) => $.module.fp_expand)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-micro">
          <span>
            {t(($) => $.module.fp_filled, {
              filled: feature.filled,
              total: feature.total,
            })}
          </span>
          {feature.acceptance_total > 0 && (
            <span>
              {t(($) => $.module.fp_accept_ok, {
                ok: feature.acceptance_ok,
                n: feature.acceptance_total,
              })}
            </span>
          )}
          <span>{t(($) => $.module.fp_spec_version, { version: feature.spec_version })}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/60 px-2 py-1.5">
          <Section label={t(($) => $.module.fp_goal)}>
            {goal ? (
              <span className="whitespace-pre-wrap break-words">{goal}</span>
            ) : (
              <Empty />
            )}
          </Section>
          <Section label={t(($) => $.module.fp_seg_desc)}>
            {asText(detail.desc) ? (
              <span className="whitespace-pre-wrap break-words">
                {asText(detail.desc)}
              </span>
            ) : (
              <Empty />
            )}
          </Section>
          <Section label={t(($) => $.module.fp_seg_loc)}>
            {asText(detail.loc) ? (
              <span className="break-all font-mono text-micro">
                {asText(detail.loc)}
              </span>
            ) : (
              <Empty />
            )}
          </Section>
          <Section label={t(($) => $.module.fp_seg_req)}>
            {req.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4">
                {req.map((line, index) => (
                  <li key={index} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <Section label={t(($) => $.module.fp_seg_interaction)}>
            {asText(detail.interaction) ? (
              <span className="whitespace-pre-wrap break-words">
                {asText(detail.interaction)}
              </span>
            ) : (
              <Empty />
            )}
          </Section>
          <Section label={t(($) => $.module.fp_seg_deps)}>
            {asText(detail.deps) ? (
              <span className="whitespace-pre-wrap break-words">
                {asText(detail.deps)}
              </span>
            ) : (
              <Empty />
            )}
          </Section>
          <Section label={t(($) => $.module.fp_seg_acceptance)}>
            {acceptance.length > 0 ? (
              <ul className="space-y-0.5">
                {acceptance.map((item, index) => (
                  <li key={index} className="flex gap-1.5 break-words">
                    <span
                      className={
                        item.ok
                          ? "shrink-0 text-emerald-600 dark:text-emerald-400"
                          : "shrink-0 text-muted-foreground"
                      }
                    >
                      {item.ok ? "✓" : "○"}
                    </span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <p className="pt-0.5 text-micro text-muted-foreground">
            {t(($) => $.module.fp_edit_hint)}
          </p>
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-micro font-medium text-muted-foreground">{label}</div>
      <div className="text-caption text-foreground/90">{children}</div>
    </div>
  );
}

function Empty() {
  const { t } = useT("issues");
  return (
    <span className="text-muted-foreground">{t(($) => $.module.fp_empty)}</span>
  );
}
