"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { AgentAvailability } from "@multica/core/agents";
import type { ChatPendingTask, TaskMessagePayload } from "@multica/core/types";
import { UnicodeSpinner } from "@multica/ui/components/common/unicode-spinner";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { formatElapsedMs } from "../lib/format";
import { buildRunProgress, type RunProgressStep } from "../lib/run-progress";
import { TaskStatusPill } from "./task-status-pill";

/** 展开时默认只给最近几步：长跑任务的步骤数可以上百，全量铺开会把消息流挤走。 */
const VISIBLE_STEPS = 6;

/**
 * 执行中的进展面板：单行状态 pill 之外，把「跑到第几步、这一步在做什么、
 * 走的是哪个 skill」摊开给用户看。摘要行只放目标（命令/路径/技能名）——
 * 动作词已经在 pill 里，重复一遍只是噪音。
 *
 * 数据来自与 live 消息行同一个 task:message 缓存，不额外请求。完成后
 * footer 整体消失，回看细节走消息行里的「N 步」折叠，两处不重复。
 */
export function RunProgressPanel({
  pendingTask,
  taskMessages,
  availability,
}: {
  pendingTask: ChatPendingTask;
  taskMessages: readonly TaskMessagePayload[];
  availability: AgentAvailability | undefined;
}) {
  const { t } = useT("chat");
  const progress = useMemo(() => buildRunProgress(taskMessages), [taskMessages]);
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  // footer 在会话里常驻，不随任务卸载：新任务要重新展开，否则用户上次收起后
  // 永远看不到进展。
  const taskId = pendingTask.task_id ?? "";
  useEffect(() => {
    setExpanded(true);
    setShowAll(false);
  }, [taskId]);

  const steps = progress.steps;
  if (steps.length === 0) {
    return (
      <TaskStatusPill
        pendingTask={pendingTask}
        taskMessages={taskMessages}
        availability={availability}
      />
    );
  }

  const current = progress.active ?? progress.latest ?? null;
  const hidden = Math.max(0, steps.length - VISIBLE_STEPS);
  const visible = showAll || hidden === 0 ? steps : steps.slice(-VISIBLE_STEPS);

  return (
    <div className="space-y-1">
      <TaskStatusPill
        pendingTask={pendingTask}
        taskMessages={taskMessages}
        availability={availability}
      />
      <div className="rounded-lg border border-surface-border bg-muted/20">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-caption text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
          <span className="shrink-0 tabular-nums">
            {t(($) => $.status_pill.progress.steps, {
              finished: progress.finished,
              total: progress.total,
            })}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {current
              ? current.target ||
                t(($) => $.status_pill.progress.kinds[current.kind])
              : t(($) => $.status_pill.progress.thinking)}
          </span>
          {progress.currentSkill ? (
            <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium text-foreground/70">
              {t(($) => $.status_pill.progress.skill_badge, {
                name: progress.currentSkill,
              })}
            </span>
          ) : null}
          {progress.errors > 0 ? (
            <span className="shrink-0 text-[10px] text-destructive">
              {t(($) => $.status_pill.progress.errors, { count: progress.errors })}
            </span>
          ) : null}
        </button>
        {expanded ? (
          <div className="max-h-44 overflow-y-auto pb-1">
            {hidden > 0 ? (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="w-full px-2 py-0.5 text-left text-[10px] text-muted-foreground hover:text-foreground"
              >
                {showAll
                  ? t(($) => $.status_pill.progress.less)
                  : t(($) => $.status_pill.progress.more, { count: hidden })}
              </button>
            ) : null}
            {visible.map((step, index) => {
              const previous = visible[index - 1];
              const startsSkill =
                !!step.skillName && step.skillName !== previous?.skillName;
              return (
                <div key={step.key}>
                  {startsSkill ? (
                    <div className="px-2 pt-1 text-[10px] text-muted-foreground/80">
                      {t(($) => $.status_pill.progress.skill_badge, {
                        name: step.skillName,
                      })}
                    </div>
                  ) : null}
                  <StepRow step={step} />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StepRow({ step }: { step: RunProgressStep }) {
  const { t } = useT("chat");
  const running = step.status === "running";
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 px-2 py-0.5 text-[11px]",
        running ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="mt-[3px] shrink-0">
        {running ? (
          <UnicodeSpinner name="breathe" className="text-[9px] opacity-70" />
        ) : (
          <Check className="size-3" />
        )}
      </span>
      <span className="shrink-0">{t(($) => $.status_pill.progress.kinds[step.kind])}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/75">
        {step.target || step.tool}
      </span>
      {step.durationMs !== undefined ? (
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
          {formatElapsedMs(step.durationMs)}
        </span>
      ) : null}
    </div>
  );
}
