/**
 * RoleStrip — five role cards (pm / prototyper / developer / data / tester)
 * rendered in a horizontal strip. Each card shows the role name, a mini
 * toggle, assigned agents as removable tags, and a short note.
 *
 * PM and Developer are required — their toggles are locked (disabled).
 * Developer supports multiple assignees. Disabled roles render dimmed
 * with a dashed border.
 *
 * Used in the create-requirement dialog and the requirement detail panel.
 */
import { useCallback } from "react";
import { cn } from "@multica/ui/lib/utils";
import { Switch } from "@multica/ui/components/ui/switch";
import { Lock } from "lucide-react";
import type { RoleAssignment } from "@multica/core/types";
import { useT } from "../../i18n";
import { ActorAvatar } from "../../common/actor-avatar";
import { useActorName } from "@multica/core/workspace/hooks";

/** The five canonical roles in display order. */
const ROLE_ORDER = ["pm", "prototyper", "developer", "data", "tester"] as const;
type RoleKey = (typeof ROLE_ORDER)[number];

/** Roles that must have at least one enabled assignee (cannot be disabled). */
const REQUIRED_ROLES = new Set<string>(["pm", "developer"]);

interface RoleStripProps {
  entries: RoleAssignment[];
  onChange: (entries: RoleAssignment[]) => void;
  /** Extra class name on the outer strip container. */
  className?: string;
}

export function RoleStrip({ entries, onChange, className }: RoleStripProps) {
  const { t } = useT("issues");

  const toggleRole = useCallback(
    (role: string) => {
      if (REQUIRED_ROLES.has(role)) return;
      const updated = entries.map((e) =>
        e.role === role ? { ...e, enabled: !e.enabled } : e,
      );
      onChange(updated);
    },
    [entries, onChange],
  );

  return (
    <div className={cn("flex gap-1.5", className)} data-testid="role-strip">
      {ROLE_ORDER.map((role) => (
        <RoleCard
          key={role}
          role={role}
          entries={entries.filter((e) => e.role === role)}
          required={REQUIRED_ROLES.has(role)}
          onToggle={() => toggleRole(role)}
          t={t}
        />
      ))}
    </div>
  );
}

function RoleCard({
  role,
  entries,
  required,
  onToggle,
  t,
}: {
  role: RoleKey;
  entries: RoleAssignment[];
  required: boolean;
  onToggle: () => void;
  t: ReturnType<typeof useT>["t"];
}) {
  const isEnabled = entries.some((e) => e.enabled);
  const enabledEntries = entries.filter((e) => e.enabled);

  return (
    <div
      data-testid={`role-card-${role}`}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 rounded-md border px-2 py-1.5",
        isEnabled
          ? "on border-primary/45 bg-primary/5"
          : "off border-dashed bg-muted/50",
      )}
    >
      {/* Header: role name + toggle */}
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-2xs font-medium",
            !isEnabled && "text-muted-foreground",
          )}
        >
          {t(($) => $.role_strip[role])}
          {required && (
            <span className="ml-0.5 text-destructive" title={t(($) => $.role_strip.required)}>
              *
            </span>
          )}
        </span>
        <span className="relative inline-flex items-center">
          <Switch
            data-testid={`role-toggle-${role}`}
            size="sm"
            checked={isEnabled}
            disabled={required}
            onCheckedChange={() => onToggle()}
            aria-label={t(($) => $.role_strip.toggle_aria, { role: t(($) => $.role_strip[role]) })}
          />
          {required && (
            <Lock className="pointer-events-none absolute -right-1 -top-1 size-2.5 text-muted-foreground" />
          )}
        </span>
      </div>

      {/* Assignee tags */}
      <div className="flex min-h-[18px] flex-wrap items-center gap-0.5">
        {isEnabled && enabledEntries.length > 0 ? (
          enabledEntries.map((e) => (
            <span
              key={e.assignee_id}
              className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1 py-0 text-2xs"
            >
              <ActorAvatar
                actorType={e.assignee_type}
                actorId={e.assignee_id}
                size="sm"
                profileLink={false}
              />
              <AssigneeName entry={e} />
            </span>
          ))
        ) : !isEnabled ? (
          <span className="text-2xs text-muted-foreground">
            {t(($) => $.role_strip.not_enabled)}
          </span>
        ) : null}
      </div>

      {/* Note */}
      <div
        className={cn(
          "text-[9px] leading-tight text-muted-foreground",
          !isEnabled && "opacity-60",
        )}
      >
        {t(($) => $.role_strip[`${role}_note`])}
      </div>
    </div>
  );
}

/** Renders the assignee display name via the workspace actor-name hook. */
function AssigneeName({ entry }: { entry: RoleAssignment }) {
  const { getActorName } = useActorName();
  return <span>{getActorName(entry.assignee_type, entry.assignee_id)}</span>;
}
