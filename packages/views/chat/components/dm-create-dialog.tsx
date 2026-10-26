"use client";

import { useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { useWorkspaceId } from "@multica/core/hooks";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useCreateDMChatSession } from "@multica/core/chat/dm";
import { ActorAvatar } from "../../common/actor-avatar";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { toast } from "sonner";
import { useT } from "../../i18n";

/**
 * "Start a DM" entry (plan 20261025 §6.2). A searchable member picker that
 * creates (or resumes) a 1:1 conversation with the chosen peer, then reports
 * the resulting session id so the surface can navigate to it. Rendered only
 * when the `chat_conversations` flag is on — the caller gates it so a flag-off
 * build shows the exact same chat header as before (zero regression).
 *
 * The server is idempotent on the member pair, so re-DMing the same peer
 * returns the existing session rather than duplicating the row: we always
 * navigate to whatever `id` comes back and never synthesize one client-side.
 */
export function DmCreateDialog({
  userId,
  onCreated,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  userId: string | undefined;
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
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const createDM = useCreateDMChatSession();

  // Exclude the current user — you cannot DM yourself (the server rejects it
  // with a 400, but hiding the row up front avoids a guaranteed failure).
  const candidates = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return members
      .filter((m) => m.user_id !== userId)
      .filter((m) => {
        if (!query) return true;
        const name = m.name ?? "";
        const email = m.email ?? "";
        return (
          name.toLowerCase().includes(query) ||
          email.toLowerCase().includes(query) ||
          matchesPinyin(name, query)
        );
      });
  }, [members, userId, filter]);

  const handlePick = (memberId: string) => {
    if (createDM.isPending) return;
    createDM.mutate(memberId, {
      onSuccess: (session) => {
        setOpen(false);
        onCreated(session.id);
      },
      onError: () => {
        toast.error(t(($) => $.dm.create_failed));
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter("");
      }}
    >
      {!hideTrigger && (
      <DialogTrigger render={<Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-muted-foreground"
        aria-label={t(($) => $.dm.trigger_tooltip)}
      />}>
        <MessageSquarePlus />
      </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.dm.title)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <Input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t(($) => $.dm.search_placeholder)}
          />
          <div className="max-h-72 overflow-y-auto">
            {candidates.length === 0 ? (
              <div className="px-2 py-6 text-center text-caption text-muted-foreground">
                {t(($) => $.dm.empty)}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {candidates.map((member) => (
                  <li key={member.user_id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-body hover:bg-muted disabled:opacity-60"
                      disabled={createDM.isPending}
                      onClick={() => handlePick(member.user_id)}
                    >
                      <ActorAvatar
                        actorType="member"
                        actorId={member.user_id}
                        size="md"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{member.name}</span>
                        <span className="block truncate text-micro text-muted-foreground">
                          {member.email}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
