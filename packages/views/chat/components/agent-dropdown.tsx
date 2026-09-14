"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ActorAvatar } from "../../common/actor-avatar";
import {
  PickerEmpty,
  PickerItem,
  PickerSection,
  PropertyPicker,
} from "../../issues/components/pickers/property-picker";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import type { Agent } from "@multica/core/types";
import { isAgentRuntimeBound } from "@multica/core/agents";
import { useChatStore } from "@multica/core/chat";
import { useT } from "../../i18n";
import { selectedSendAgentIds, useChatFanout } from "../lib/fanout-agents";

/**
 * 会话输入栏智能体选择：可多选。当前会话主智能体锁定勾选；
 * 其余勾选的智能体在发送时各开独立会话，不离开当前对话。
 */
export function AgentDropdown({
  agents,
  activeAgent,
  userId,
}: {
  agents: Agent[];
  activeAgent: Agent | null;
  userId: string | undefined;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const extraAgentIds = useChatFanout((state) => state.extraAgentIds);
  const toggle = useChatFanout((state) => state.toggle);
  const reset = useChatFanout((state) => state.reset);
  const activeSessionId = useChatStore((state) => state.activeSessionId);

  useEffect(() => {
    reset();
  }, [activeAgent?.id, activeSessionId, reset]);

  const selectedIds = selectedSendAgentIds(activeAgent?.id, extraAgentIds);

  const { mine, others } = useMemo(() => {
    const mine: Agent[] = [];
    const others: Agent[] = [];
    for (const agent of agents) {
      if (agent.owner_id === userId) mine.push(agent);
      else others.push(agent);
    }
    return { mine, others };
  }, [agents, userId]);

  const query = filter.trim().toLowerCase();
  const matches = (name: string) =>
    !query || name.toLowerCase().includes(query) || matchesPinyin(name, query);
  const filteredMine = mine.filter((agent) => matches(agent.name));
  const filteredOthers = others.filter((agent) => matches(agent.name));

  if (!activeAgent) {
    return <span className="text-caption text-muted-foreground">{t(($) => $.window.no_agents)}</span>;
  }

  const extraCount = selectedIds.length - 1;

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      width="w-64"
      align="start"
      side="top"
      searchable
      searchPlaceholder={t(($) => $.window.agent_filter_placeholder)}
      onSearchChange={setFilter}
      footer={
        <p className="px-2 py-1.5 text-micro text-muted-foreground">
          {t(($) => $.window.agent_multi_hint)}
        </p>
      }
      triggerRender={
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1 cursor-pointer outline-none transition-colors hover:bg-accent aria-expanded:bg-accent"
        />
      }
      trigger={
        <>
          <ActorAvatar
            actorType="agent"
            actorId={activeAgent.id}
            size="md"
            enableHoverCard
            showStatusDot
          />
          <span className="text-caption font-medium max-w-28 truncate">{activeAgent.name}</span>
          {extraCount > 0 ? (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-micro font-medium text-primary">
              +{extraCount}
            </span>
          ) : null}
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        </>
      }
    >
      {filteredMine.length === 0 && filteredOthers.length === 0 ? (
        <PickerEmpty />
      ) : (
        <>
          {filteredMine.length > 0 && (
            <PickerSection label={t(($) => $.window.my_agents)}>
              {filteredMine.map((agent) => (
                <AgentPickerItem
                  key={agent.id}
                  agent={agent}
                  isPrimary={agent.id === activeAgent.id}
                  isSelected={selectedIds.includes(agent.id)}
                  onToggle={() => toggle(agent.id, activeAgent.id)}
                />
              ))}
            </PickerSection>
          )}
          {filteredOthers.length > 0 && (
            <PickerSection label={t(($) => $.window.others)}>
              {filteredOthers.map((agent) => (
                <AgentPickerItem
                  key={agent.id}
                  agent={agent}
                  isPrimary={agent.id === activeAgent.id}
                  isSelected={selectedIds.includes(agent.id)}
                  onToggle={() => toggle(agent.id, activeAgent.id)}
                />
              ))}
            </PickerSection>
          )}
        </>
      )}
    </PropertyPicker>
  );
}

function AgentPickerItem({
  agent,
  isPrimary,
  isSelected,
  onToggle,
}: {
  agent: Agent;
  isPrimary: boolean;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const { t } = useT("chat");
  const runtimeBound = isAgentRuntimeBound(agent);
  return (
    <PickerItem
      selected={isSelected}
      disabled={!runtimeBound || isPrimary}
      tooltip={
        !runtimeBound
          ? t(($) => $.window.agent_needs_runtime_hint)
          : isPrimary
            ? t(($) => $.window.agent_primary_hint)
            : undefined
      }
      onClick={() => {
        if (!isPrimary) onToggle();
      }}
    >
      <ActorAvatar
        actorType="agent"
        actorId={agent.id}
        size="md"
        enableHoverCard
        showStatusDot
      />
      <span className="truncate flex-1">{agent.name}</span>
      {!runtimeBound && (
        <span className="shrink-0 text-micro text-amber-600 dark:text-amber-400">
          {t(($) => $.window.agent_needs_runtime)}
        </span>
      )}
    </PickerItem>
  );
}
