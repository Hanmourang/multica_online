"use client";

/**
 * 需求工作台开关状态。?req= 是唯一真相；Web/Desktop adapter 每次
 * render 都会 new URLSearchParams，不能依赖 searchParams 对象本身。
 *
 * 点 × 后本地先关、router.replace 还在 startTransition 里时，日历页
 * 可能带着旧 ?req= 再挂一次。模块级 suppress 跨这次 remount，避免
 * 抽屉被立刻拉回来——拆解按钮和关闭都像点了没反应。
 *
 * 从需求详情 / 项目页 push 进来时 URL 带 from=issue|project。关闭走
 * back（有站内历史）或 replace 到来源，而不是把人扔在空日历上。
 */
import { useEffect, useState } from "react";
import { useNavigation } from "../navigation";
import type { FlowStage } from "../issues/components/requirement-flow-section";

let suppressReq: string | null = null;

export function resetRequirementWorkbenchSuppress() {
  suppressReq = null;
}

export function useRequirementWorkbench() {
  const { pathname, searchParams, replace, back, canGoBack } = useNavigation();
  const urlReq = searchParams.get("req");
  const urlFrom = searchParams.get("from");
  const [issueId, setIssueId] = useState<string | null>(() =>
    urlReq && urlReq !== suppressReq ? urlReq : null,
  );

  useEffect(() => {
    if (urlReq && urlReq === suppressReq) return;
    if (!urlReq) suppressReq = null;
    setIssueId(urlReq);
  }, [urlReq]);

  const writeParams = (id: string | null, stage?: FlowStage | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (id) {
      next.set("req", id);
      if (stage != null) next.set("stage", String(stage));
      next.delete("from");
    } else {
      next.delete("req");
      next.delete("stage");
      next.delete("from");
    }
    const q = next.toString();
    replace(q ? `${pathname}?${q}` : pathname);
  };

  const open = (id: string, stage?: FlowStage | null) => {
    suppressReq = null;
    setIssueId(id);
    writeParams(id, stage);
  };

  const close = (fallbacks?: { issue?: string; project?: string }) => {
    if (issueId) suppressReq = issueId;
    setIssueId(null);
    const dest =
      urlFrom === "issue"
        ? fallbacks?.issue
        : urlFrom === "project"
          ? fallbacks?.project
          : undefined;
    writeParams(null);
    if (dest && canGoBack?.() === true) back();
    else if (dest) replace(dest);
  };

  return { issueId, open, close };
}
