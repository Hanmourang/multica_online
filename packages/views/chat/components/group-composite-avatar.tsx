"use client";

import { Users } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import type { AvatarSize } from "@multica/ui/lib/avatar-size";
import { ActorAvatar } from "../../common/actor-avatar";

export type GroupAvatarFace = {
  type: "member" | "agent";
  id: string;
};

/**
 * Up to four faces for a group mosaic. Members lead; when the room also has
 * agents, the last cell stays an agent so adding either kind changes the
 * picture instead of pushing agents off a member-only grid.
 */
export function composeGroupFaces(
  members: GroupAvatarFace[],
  agents: GroupAvatarFace[] = [],
): GroupAvatarFace[] {
  const people = members.filter((face) => face.id);
  const bots = agents.filter((face) => face.id);
  if (bots.length === 0) return people.slice(0, 4);
  if (people.length === 0) return bots.slice(0, 4);
  const memberSlots = Math.min(people.length, 3);
  return [...people.slice(0, memberSlots), ...bots.slice(0, 4 - memberSlots)];
}

export function GroupCompositeAvatar({
  faces,
  className,
  label,
  variant = "inline",
}: {
  faces: GroupAvatarFace[];
  className?: string;
  label?: string;
  /** inline matches a list/header avatar; preview is the larger create-dialog mosaic. */
  variant?: "inline" | "preview";
}) {
  const shown = faces.slice(0, 4);
  const box = variant === "preview" ? "size-12" : "size-8";
  if (shown.length === 0) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-inset ring-border",
          box,
          className,
        )}
        role="img"
        aria-label={label}
      >
        <Users className={variant === "preview" ? "size-5" : "size-4"} />
      </span>
    );
  }
  const avatarSize: AvatarSize = shown.length === 1
    ? (variant === "preview" ? "xl" : "lg")
    : (variant === "preview" ? "md" : "xs");
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center gap-px overflow-hidden rounded-lg bg-muted ring-1 ring-inset ring-border",
        box,
        shown.length === 1 ? "grid-cols-1" : "grid-cols-2",
        className,
      )}
      role="img"
      aria-label={label}
    >
      {shown.map((face) => (
        <span key={`${face.type}:${face.id}`} className="flex items-center justify-center">
          <ActorAvatar
            actorType={face.type}
            actorId={face.id}
            size={avatarSize}
            profileLink={false}
          />
        </span>
      ))}
    </span>
  );
}
