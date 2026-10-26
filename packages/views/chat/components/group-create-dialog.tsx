"use client";

import { useMemo, useState } from "react";
import { UsersRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { useCreateGroupChatSession } from "@multica/core/chat/group";
import { isAgentRuntimeBound } from "@multica/core/agents";
import { canAssignAgent } from "@multica/views/issues/components";
import { ActorAvatar } from "../../common/actor-avatar";
import { composeGroupFaces, GroupCompositeAvatar, type GroupAvatarFace } from "./group-composite-avatar";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { toast } from "sonner";
import { useT } from "../../i18n";

/**
 * "Start a group" entry (plan 20261025 §6.2, sibling of DmCreateDialog).
 * A searchable multi-picker over workspace members and invocable agents plus
 * an optional title; the create call is NOT idempotent (unlike DM), so one
 * confirm opens exactly one room and reports its id for the surface to open.
 *
 * Agent rows reuse the invocation gate the server's validateGroupAgents
 * applies (canAssignAgent) so a pick that would 403 is never offered; agents
 * without a bound runtime stay visible but disabled — fan-out to them would
 * fail at dispatch (the server rejects the whole send), so they are not
 * selectable. The creator is implicitly the first member and admin and is
 * excluded from the picker.
 */
export function GroupCreateDialog({
  userId,
  memberRole,
  onCreated,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  userId: string | undefined;
  memberRole: string | undefined;
  onCreated: (sessionId: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const { t } = useT("conversations");
  const wsId = useWorkspaceId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setUncontrolledOpen(next);
  };
  const [filter, setFilter] = useState("");
  const [title, setTitle] = useState("");
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState("");
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const createGroup = useCreateGroupChatSession();

  const query = filter.trim().toLowerCase();
  const matches = (name: string) =>
    !query || name.toLowerCase().includes(query) || matchesPinyin(name, query);

  const memberCandidates = useMemo(
    () => members.filter((m) => m.user_id !== userId && matches(m.name ?? "")),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `matches` closes over `query`, recompute with it
    [members, userId, query],
  );
  const agentCandidates = useMemo(
    () =>
      agents.filter(
        (a) => !a.archived_at && canAssignAgent(a, userId, memberRole) && matches(a.name),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `matches` closes over `query`, recompute with it
    [agents, userId, memberRole, query],
  );

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const reset = () => {
    setFilter("");
    setTitle("");
    setMemberIds(new Set());
    setAgentIds(new Set());
    setProjectId("");
  };

  // The server requires ≥2 humans (creator + picks); disable confirm until
  // then so a "group" of one is never a guaranteed 400.
  const canCreate = memberIds.size >= 1 && !createGroup.isPending;
  const previewFaces = useMemo(() => {
    const people: GroupAvatarFace[] = [
      ...(userId ? [{ type: "member" as const, id: userId }] : []),
      ...[...memberIds].map((id) => ({ type: "member" as const, id })),
    ];
    const bots: GroupAvatarFace[] = [...agentIds].map((id) => ({ type: "agent" as const, id }));
    return composeGroupFaces(people, bots);
  }, [userId, memberIds, agentIds]);

  const handleCreate = () => {
    if (!canCreate) return;
    createGroup.mutate(
      {
        title: title.trim() || undefined,
        member_ids: [...memberIds],
        agent_ids: agentIds.size > 0 ? [...agentIds] : undefined,
        project_id: projectId || undefined,
      },
      {
        onSuccess: (session) => {
          setOpen(false);
          reset();
          onCreated(session.id);
        },
        onError: () => {
          toast.error(t(($) => $.group.create_failed));
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {!hideTrigger && (
      <DialogTrigger render={<Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-muted-foreground"
        aria-label={t(($) => $.group.trigger_tooltip)}
      />}>
        <UsersRound />
      </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.group.title)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="flex items-center gap-3">
            <GroupCompositeAvatar
              faces={previewFaces}
              variant="preview"
              label={t(($) => $.group.composite_avatar)}
            />
            <Input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t(($) => $.group.name_placeholder)}
            />
          </div>
          <Input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t(($) => $.group.search_placeholder)}
          />
          <div className="max-h-72 overflow-y-auto">
            {memberCandidates.length === 0 && agentCandidates.length === 0 ? (
              <div className="px-2 py-6 text-center text-caption text-muted-foreground">
                {t(($) => $.group.empty)}
              </div>
            ) : (
              <ul className="space-y-0.5">
                <li className="px-2 pb-1 pt-2 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                  {t(($) => $.group.section_members)}
                </li>
                {memberCandidates.map((member) => (
                  <li key={member.user_id}>
                    <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-body hover:bg-muted">
                      <Checkbox
                        checked={memberIds.has(member.user_id)}
                        onCheckedChange={() => setMemberIds((prev) => {
                          if (prev.has(member.user_id)) return toggle(prev, member.user_id);
                          if (prev.size >= 49) {
                            toast.error(t(($) => $.group.member_limit));
                            return prev;
                          }
                          return toggle(prev, member.user_id);
                        })}
                      />
                      <ActorAvatar actorType="member" actorId={member.user_id} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{member.name}</span>
                        <span className="block truncate text-micro text-muted-foreground">
                          {member.email}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
                {agentCandidates.length > 0 && (
                  <li className="px-2 pb-1 pt-2 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                    {t(($) => $.group.section_agents)}
                  </li>
                )}
                {agentCandidates.map((agent) => {
                  const runtimeBound = isAgentRuntimeBound(agent);
                  return (
                    <li key={agent.id}>
                      <label
                        className={
                          runtimeBound
                            ? "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-body hover:bg-muted"
                            : "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-body opacity-60"
                        }
                      >
                        <Checkbox
                          checked={agentIds.has(agent.id)}
                          onCheckedChange={() => setAgentIds((prev) => {
                            if (prev.has(agent.id)) return toggle(prev, agent.id);
                            if (prev.size >= 10) {
                              toast.error(t(($) => $.group.agent_limit));
                              return prev;
                            }
                            return toggle(prev, agent.id);
                          })}
                        />
                        <ActorAvatar actorType="agent" actorId={agent.id} size="md" showStatusDot />
                        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                        {!runtimeBound && (
                          <span className="shrink-0 text-micro text-amber-600 dark:text-amber-400">
                            {t(($) => $.group.will_queue)}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <p className="text-caption text-muted-foreground">{t(($) => $.group.private_agent_note)}</p>
          {projects.length > 0 && (
            <label className="flex flex-col gap-1 text-caption text-muted-foreground">
              {t(($) => $.group.project_label)}
              <select
                className="h-8 rounded-md border bg-background px-2 text-body text-foreground"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">{t(($) => $.group.project_none)}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.title || project.id}</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-caption text-muted-foreground">
              {t(($) => $.group.selected_summary, {
                members: memberIds.size + 1,
                agents: agentIds.size,
              })}
            </span>
            <Button onClick={handleCreate} disabled={!canCreate}>
              {createGroup.isPending
                ? t(($) => $.group.creating)
                : t(($) => $.group.create)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
