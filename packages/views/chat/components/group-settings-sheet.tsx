"use client";

import { useMemo, useState } from "react";
import { Crown, Loader2, LogOut, Settings2, UserMinus, UserPlus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@multica/ui/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Input } from "@multica/ui/components/ui/input";
import { useWorkspaceId } from "@multica/core/hooks";
import { useAuthStore } from "@multica/core/auth";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { chatParticipantsOptions } from "@multica/core/chat/dm";
import { isAgentRuntimeBound } from "@multica/core/agents";
import {
  useAddGroupParticipants,
  useLeaveGroupChatSession,
  useRemoveGroupParticipant,
  useSetGroupParticipantAdmin,
} from "@multica/core/chat/group";
import type { ChatParticipant } from "@multica/core/types";
import { ApiError } from "@multica/core/api";
import { ActorAvatar } from "../../common/actor-avatar";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";

/**
 * Group management sheet (plan 20261025 §6.2, product prototype 群设置).
 * Roster with admin badges, add/remove members and agents, promote/dismiss
 * admin, and leave — all wired to the server's admin-gated endpoints which
 * answer with the FULL fresh roster (cache write in the core mutations, so no
 * refetch races here).
 *
 * Permission model mirrors the server rather than re-implementing it: the
 * management section renders only when the LOCAL roster says the viewer is an
 * admin; a stale local view simply gets a 403 toast and the roster
 * invalidation re-converges it. The zero-admin invariant (last admin can't be
 * removed or leave) is guarded here for UX and enforced under the session row
 * lock server-side — 409s map to a specific hint, not a generic failure.
 */
export function GroupSettingsSheet({
  sessionId,
  disabled,
  onLeft,
}: {
  sessionId: string;
  disabled?: boolean;
  /** Viewer left (or was removed) — caller closes the conversation view. */
  onLeft?: () => void;
}) {
  const { t } = useT("conversations");
  const user = useAuthStore((s) => s.user);
  const { data: participants } = useQuery(chatParticipantsOptions(sessionId));

  const roster = participants ?? [];
  const isAdmin = roster.some(
    (p) => p.participant_type === "member" && p.participant_id === user?.id && p.admin,
  );
  const humanCount = roster.filter((p) => p.participant_type === "member").length;
  const adminCount = roster.filter((p) => p.participant_type === "member" && p.admin).length;
  // Roster-keyed reason hints (server-side invariants mirrored for labels):
  // removing/leaving must never zero out the admins, so the LAST admin's
  // self-demotion / removal / leave rows read as blocked-with-explanation.
  const isLastAdmin = isAdmin && adminCount === 1;

  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ChatParticipant | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const settle = <T,>(action: Promise<T>) => {
    setBusy(true);
    void action.finally(() => setBusy(false));
  };

  const removeParticipant = useRemoveGroupParticipant();
  const setAdmin = useSetGroupParticipantAdmin();
  const leaveGroup = useLeaveGroupChatSession();

  const handleRemove = (p: ChatParticipant) => {
    if (p.participant_type === "member" && p.participant_id === user?.id) {
      // Removing yourself from the sheet is a leave — route through the
      // dedicated endpoint so the navigation semantics match the Leave button.
      handleLeave();
      return;
    }
    settle(
      removeParticipant
        .mutateAsync({ sessionId, participantType: p.participant_type, participantId: p.participant_id })
        .then(() => {
          toast.success(t(($) => $.group.removed));
        })
        .catch((err) => {
          toast.error(lastAdminError(err) ? t(($) => $.group.remove_last_admin) : t(($) => $.group.remove_failed));
        }),
    );
  };

  const handleToggleAdmin = (p: ChatParticipant) => {
    settle(
      setAdmin
        .mutateAsync({ sessionId, participantId: p.participant_id, admin: !p.admin })
        .then(() => {
          toast.success(t(($) => $.group.admin_updated));
        })
        .catch((err) => {
          toast.error(lastAdminError(err) ? t(($) => $.group.remove_last_admin) : t(($) => $.group.admin_failed));
        }),
    );
  };

  const handleLeave = () => {
    settle(
      leaveGroup
        .mutateAsync(sessionId)
        .then(() => {
          toast.success(t(($) => $.group.leaving));
          onLeft?.();
        })
        .catch((err) => {
          toast.error(lastAdminError(err) ? t(($) => $.group.leave_last_admin) : t(($) => $.group.leave_failed));
        }),
    );
  };

  return (
    <Sheet>
      <SheetTrigger
        render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
        disabled={disabled}
      >
        <Settings2 className="h-4 w-4" />
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:w-[380px] sm:max-w-[380px] p-0">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-body font-semibold">{t(($) => $.group.settings)}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="pb-2 text-caption text-muted-foreground">
            {t(($) => $.group.members_count, { count: humanCount })}
          </div>
          <ul className="space-y-0.5">
            {[...roster.filter((p) => p.participant_type === "member"), ...roster.filter((p) => p.participant_type === "agent")].map((p, index, ordered) => {
              const isSelf = p.participant_type === "member" && p.participant_id === user?.id;
              const showAgentHeading = p.participant_type === "agent" && ordered[index - 1]?.participant_type !== "agent";
              return (
                <li
                  key={`${p.participant_type}:${p.participant_id}`}
                  className="group flex flex-wrap items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-muted"
                >
                  {showAgentHeading && (
                    <div className="basis-full pt-2 text-micro text-muted-foreground">{t(($) => $.group.section_agents)}</div>
                  )}
                  <ActorAvatar
                    actorType={p.participant_type}
                    actorId={p.participant_id}
                    size="md"
                  />
                  <span className="min-w-0 flex-1 truncate text-body">{p.display_name}</span>
                  {p.admin && (
                    <span className="shrink-0 rounded-full bg-brand/10 px-1.5 py-0.5 text-micro text-brand">
                      {t(($) => $.group.admin_badge)}
                    </span>
                  )}
                  {isSelf && (
                    <span className="shrink-0 text-micro text-muted-foreground">
                      {t(($) => $.group.you_badge)}
                    </span>
                  )}
                  {isAdmin && !isSelf && (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {p.participant_type === "member" && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy || (p.admin && isLastAdmin)}
                        aria-label={p.admin ? t(($) => $.group.dismiss_admin) : t(($) => $.group.make_admin)}
                        onClick={() => handleToggleAdmin(p)}
                      >
                        <Crown className={p.admin ? "h-3.5 w-3.5 text-muted-foreground" : "h-3.5 w-3.5"} />
                      </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={t(($) => $.group.remove)}
                        onClick={() => setConfirmRemove(p)}
                      >
                        <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="space-y-1 border-t px-4 py-3">
          {isAdmin && (
            <Button variant="outline" className="w-full justify-start gap-2" disabled={busy} onClick={() => setAddOpen(true)}>
              <UserPlus className="h-4 w-4" />
              {t(($) => $.group.add_participants)}
            </Button>
          )}
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-destructive hover:text-destructive"
            disabled={busy || isLastAdmin}
            title={isLastAdmin ? t(($) => $.group.leave_last_admin) : undefined}
            onClick={() => setConfirmLeave(true)}
          >
            <LogOut className="h-4 w-4" />
            {t(($) => $.group.leave)}
          </Button>
        </div>
        <GroupAddParticipantsDialog
          sessionId={sessionId}
          open={addOpen}
          onOpenChange={setAddOpen}
          existingIds={useMemo(() => new Set(roster.map((p) => p.participant_id)), [roster])}
          busy={busy}
          withBusy={settle}
        />
        <AlertDialog open={confirmRemove != null} onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmRemove?.participant_type === "agent"
                  ? t(($) => $.group.confirm_remove_agent)
                  : t(($) => $.group.confirm_remove_member)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmRemove?.display_name}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t(($) => $.group.confirm_cancel)}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const target = confirmRemove;
                  setConfirmRemove(null);
                  if (target) handleRemove(target);
                }}
              >
                {t(($) => $.group.confirm_action)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(($) => $.group.confirm_leave)}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t(($) => $.group.confirm_cancel)}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmLeave(false);
                  handleLeave();
                }}
              >
                {t(($) => $.group.confirm_action)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );

  // The zero-admin invariant answers 409 with a stable marker; anything else
  // (network, permissions) falls through to the generic failure copy.
  function lastAdminError(err: unknown): boolean {
    return err instanceof ApiError && err.status === 409;
  }
}

/**
 * Incremental add picker: workspace members and invocable agents not already
 * in the room. Mirrors GroupCreateDialog's gating (runtime-bound agents only)
 * so a pick can never fail the server's fan-out precheck later.
 */
function GroupAddParticipantsDialog({
  sessionId,
  open,
  onOpenChange,
  existingIds,
  busy,
  withBusy,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  existingIds: Set<string>;
  busy: boolean;
  withBusy: <T>(action: Promise<T>) => void;
}) {
  const { t } = useT("conversations");
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const addParticipants = useAddGroupParticipants();

  const [filter, setFilter] = useState("");
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());

  const query = filter.trim().toLowerCase();
  const matches = (name: string) =>
    !query || name.toLowerCase().includes(query) || matchesPinyin(name, query);

  const memberCandidates = members
    .filter((m) => m.user_id !== user?.id && !existingIds.has(m.user_id) && matches(m.name ?? ""));
  const agentCandidates = agents.filter(
    (a) => !a.archived_at && !existingIds.has(a.id) && matches(a.name),
  );

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const canAdd = (memberIds.size > 0 || agentIds.size > 0) && !busy;

  const handleAdd = () => {
    if (!canAdd) return;
    const count = memberIds.size + agentIds.size;
    withBusy(
      addParticipants
        .mutateAsync({
          sessionId,
          memberIds: memberIds.size > 0 ? [...memberIds] : undefined,
          agentIds: agentIds.size > 0 ? [...agentIds] : undefined,
        })
        .then(() => {
          toast.success(t(($) => $.group.added, { count }));
          onOpenChange(false);
          setFilter("");
          setMemberIds(new Set());
          setAgentIds(new Set());
        })
        .catch(() => {
          toast.error(t(($) => $.group.add_failed));
        }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.group.add_participants)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
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
                {memberCandidates.map((member) => (
                  <li key={member.user_id}>
                    <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-body hover:bg-muted">
                      <Checkbox
                        checked={memberIds.has(member.user_id)}
                        onCheckedChange={() => setMemberIds((prev) => toggle(prev, member.user_id))}
                      />
                      <ActorAvatar actorType="member" actorId={member.user_id} size="md" />
                      <span className="min-w-0 flex-1 truncate">{member.name}</span>
                    </label>
                  </li>
                ))}
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
                          disabled={!runtimeBound}
                          onCheckedChange={() => setAgentIds((prev) => toggle(prev, agent.id))}
                        />
                        <ActorAvatar actorType="agent" actorId={agent.id} size="md" showStatusDot />
                        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="flex justify-end pt-1">
            <Button onClick={handleAdd} disabled={!canAdd}>
              {addParticipants.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t(($) => $.group.add)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
