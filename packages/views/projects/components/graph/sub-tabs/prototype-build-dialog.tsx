"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { api } from "@multica/core/api";
import { isAgentRuntimeBound } from "@multica/core/agents";
import { useCreateChatSession } from "@multica/core/chat/mutations";
import { useChatStore } from "@multica/core/chat";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { Agent } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../../../../common/actor-avatar";
import { useT } from "../../../../i18n";
import {
  buildPrototypeAgentPrompt,
  preparePageSurfaceSend,
  usePageSurfaceContext,
} from "../../../../chat/lib/page-surface-context";

export function PrototypeBuildDialog({
  open,
  onOpenChange,
  projectId,
  moduleName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  moduleName?: string;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const agentsQuery = useQuery(agentListOptions(wsId));
  const createSession = useCreateChatSession();
  const pageContext = usePageSurfaceContext((state) => state.context);
  const [picked, setPicked] = useState<string[]>([]);
  const [append, setAppend] = useState("");
  const [busy, setBusy] = useState(false);

  const agents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => !agent.archived_at && isAgentRuntimeBound(agent)),
    [agentsQuery.data],
  );

  const toggle = (id: string) => {
    setPicked((current) =>
      current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
    );
  };

  const start = async () => {
    if (picked.length === 0) {
      toast.error(t(($) => $.features.build_pick_agent));
      return;
    }
    setBusy(true);
    const prompt = buildPrototypeAgentPrompt(append);
    const sessions: string[] = [];
    try {
      for (const agentId of picked) {
        const agent = agents.find((row) => row.id === agentId);
        const session = await createSession.mutateAsync({
          agent_id: agentId,
          project_id: projectId,
          title: t(($) => $.features.build_session_title, {
            agent: agent?.name ?? "agent",
            module: moduleName ?? "module",
          }),
        });
        const prepared = await preparePageSurfaceSend(api, prompt, pageContext, session.id);
        await api.sendChatMessage(
          session.id,
          prepared.content,
          prepared.attachmentIds.length > 0 ? prepared.attachmentIds : undefined,
        );
        sessions.push(session.id);
      }
      const first = sessions[0];
      if (first) {
        useChatStore.getState().setActiveSession(first);
        useChatStore.getState().setOpen(true);
      }
      toast.success(t(($) => $.features.build_ok, { count: sessions.length }));
      onOpenChange(false);
      setPicked([]);
      setAppend("");
    } catch {
      toast.error(t(($) => $.features.build_failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.features.build_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.features.build_hint)}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-56 space-y-1 overflow-auto">
          {agents.length === 0 ? (
            <li className="px-1 py-6 text-center text-[12px] text-muted-foreground">
              {t(($) => $.features.build_no_agent)}
            </li>
          ) : (
            agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={picked.includes(agent.id)}
                onToggle={() => toggle(agent.id)}
              />
            ))
          )}
        </ul>
        <textarea
          value={append}
          onChange={(event) => setAppend(event.target.value)}
          placeholder={t(($) => $.features.build_append)}
          className="min-h-16 w-full rounded-md border border-surface-border bg-surface px-2.5 py-2 text-[12px]"
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t(($) => $.features.build_cancel)}
          </Button>
          <Button type="button" disabled={busy || picked.length === 0} onClick={() => void start()}>
            {t(($) => $.features.build_start, { count: picked.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({
  agent,
  selected,
  onToggle,
}: {
  agent: Agent;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[12px]",
          selected ? "border-primary bg-primary/8" : "border-transparent hover:bg-muted/40",
        )}
      >
        <ActorAvatar actorType="agent" actorId={agent.id} size="sm" />
        <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
        {selected ? <span className="text-[10px] font-bold text-primary">✓</span> : null}
      </button>
    </li>
  );
}
