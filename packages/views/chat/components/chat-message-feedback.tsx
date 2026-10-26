"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SmilePlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { patchChatMessageFeedback } from "@multica/core/chat/message-cache";
import type { ChatMessage, ChatParticipant } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

const REACTION_EMOJIS = [
  "👍", "👎", "👏", "🙏", "🤝", "💪", "🙌", "👌",
  "😄", "😂", "🤣", "😊", "😍", "😎", "🤔", "😮",
  "😅", "😢", "😭", "😡", "😱", "😴", "🥳", "🤗",
  "❤️", "🎉", "🔥", "👀", "✅", "⭐", "💯", "🚀",
  "💡", "✨", "📌", "❓", "💬", "📝", "⏰", "☕",
] as const;

function actorLabel(
  actorId: string,
  currentUserId: string | undefined,
  participants: ChatParticipant[] | undefined,
  youLabel: string,
): string {
  const named = participants?.find((participant) => participant.participant_id === actorId)?.display_name;
  if (named) return named;
  if (currentUserId && actorId === currentUserId) return youLabel;
  return "";
}

/**
 * Emoji reactions and short replies on a received message. Both are stored
 * with the message, so they survive leaving the thread and restarting.
 */
export function ChatMessageFeedback({
  message,
  currentUserId,
  participants,
  allowCompose,
}: {
  message: ChatMessage;
  currentUserId?: string;
  participants?: ChatParticipant[];
  allowCompose: boolean;
}) {
  const { t } = useT("chat");
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const reactions = message.reactions ?? [];
  const replies = message.replies ?? [];
  const youLabel = t(($) => $.message_list.feedback.you);

  const react = useMutation({
    mutationFn: (emoji: string) =>
      api.toggleChatMessageReaction(message.chat_session_id, message.id, emoji),
    onSuccess: (result) => {
      patchChatMessageFeedback(queryClient, message.chat_session_id, message.id, {
        reactions: result.reactions,
      });
      setPickerOpen(false);
    },
    onError: () => toast.error(t(($) => $.message_list.feedback.react_failed)),
  });

  const reply = useMutation({
    mutationFn: (content: string) =>
      api.createChatMessageReply(message.chat_session_id, message.id, content),
    onSuccess: (result) => {
      patchChatMessageFeedback(queryClient, message.chat_session_id, message.id, {
        replies: result.replies,
      });
      setDraft("");
      setReplying(false);
    },
    onError: () => toast.error(t(($) => $.message_list.feedback.reply_failed)),
  });

  if (!allowCompose && reactions.length === 0 && replies.length === 0) return null;

  const grouped = new Map<string, { actors: string[]; mine: boolean }>();
  for (const reaction of reactions) {
    const current = grouped.get(reaction.emoji) ?? { actors: [], mine: false };
    const label = actorLabel(reaction.actor_id, currentUserId, participants, youLabel);
    if (label) current.actors.push(label);
    if (currentUserId && reaction.actor_id === currentUserId) current.mine = true;
    grouped.set(reaction.emoji, current);
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      {grouped.size > 0 && (
        <div className="flex flex-wrap gap-1">
          {[...grouped.entries()].map(([emoji, group]) => (
            <button
              key={emoji}
              type="button"
              disabled={react.isPending}
              onClick={() => react.mutate(emoji)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
                group.mine
                  ? "border-sky-300 bg-sky-50 text-sky-950"
                  : "border-border bg-card text-foreground",
              )}
            >
              <span className="text-xl leading-none">{emoji}</span>
              {group.actors.length > 0 && (
                <span className="max-w-40 truncate text-caption text-muted-foreground">{group.actors.join("、")}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {replies.length > 0 && (
        <div className="space-y-1">
          {replies.map((item) => {
            const name = actorLabel(item.author_id, currentUserId, participants, youLabel);
            return (
              <div key={item.id} className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-caption">
                {name && <span className="mr-1.5 font-medium text-foreground">{name}</span>}
                <span className="whitespace-pre-wrap text-foreground">{item.content}</span>
              </div>
            );
          })}
        </div>
      )}
      {allowCompose && (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-muted-foreground"
            aria-label={t(($) => $.message_list.feedback.react)}
            onClick={() => {
              setPickerOpen((open) => !open);
              setReplying(false);
            }}
          >
            <SmilePlus className="size-5" />
            {t(($) => $.message_list.feedback.react)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2.5 text-muted-foreground"
            onClick={() => {
              setReplying((open) => !open);
              setPickerOpen(false);
            }}
          >
            {t(($) => $.message_list.feedback.reply)}
          </Button>
        </div>
      )}
      {allowCompose && pickerOpen && (
        <div className="grid w-fit grid-cols-8 gap-1 rounded-2xl border border-border bg-card px-2 py-1.5 shadow-sm">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="grid size-11 place-items-center rounded-xl text-2xl leading-none hover:bg-muted"
              onClick={() => react.mutate(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {allowCompose && replying && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const content = draft.trim();
            if (!content || reply.isPending) return;
            reply.mutate(content);
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(($) => $.message_list.feedback.reply_placeholder)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 text-caption outline-none focus:border-brand"
            maxLength={1000}
          />
          <Button type="submit" size="sm" className="h-8" disabled={!draft.trim() || reply.isPending}>
            {t(($) => $.message_list.feedback.reply_send)}
          </Button>
        </form>
      )}
    </div>
  );
}
