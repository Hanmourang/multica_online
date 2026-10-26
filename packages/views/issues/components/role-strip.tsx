/**
 * RoleStrip — five role cards (pm / prototyper / developer / data / tester)
 * rendered in a horizontal strip. Each card shows the role name, a mini
 * toggle, assigned agents/members as removable tags, and a short note.
 *
 * PM and Developer are required — their toggles are locked on (cannot be
 * disabled) but assignees can still be picked. Developer supports multiple
 * assignees. Disabled optional roles render dimmed with a dashed border.
 *
 * Used in the create-requirement dialog and the requirement detail panel.
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { Switch } from "@multica/ui/components/ui/switch";
import { Lock, Plus, Settings2, X as XIcon } from "lucide-react";
import type { RoleAssignment, RolePlaybook, RolePlaybookBundle } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { useT } from "../../i18n";
import { ActorAvatar } from "../../common/actor-avatar";
import { useActorName } from "@multica/core/workspace/hooks";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import {
  PropertyPicker,
  PickerItem,
  PickerSection,
} from "./pickers/property-picker";
import { RolePlaybookDialog } from "./role-playbook-dialog";
import {
  emptyRolePlaybook,
  overridePlaybook,
  playbookHasOverride,
  resolvedPlaybook,
  type RolePlaybookKey,
} from "./role-playbook";

/** The five canonical roles in display order. */
const ROLE_ORDER = ["pm", "prototyper", "developer", "data", "tester"] as const;
type RoleKey = (typeof ROLE_ORDER)[number];

/** Roles that must stay enabled (cannot be disabled). */
const REQUIRED_ROLES = new Set<string>(["pm", "developer"]);

interface RoleStripProps {
  entries: RoleAssignment[];
  onChange: (entries: RoleAssignment[]) => void;
  /** Extra class name on the outer strip container. */
  className?: string;
  /** 角色执行标准；提供时每张卡可打开编辑器。 */
  playbooks?: RolePlaybookBundle;
  onPlaybookChange?: (role: RolePlaybookKey, override: RolePlaybook) => void;
}

export function RoleStrip({
  entries,
  onChange,
  className,
  playbooks,
  onPlaybookChange,
}: RoleStripProps) {
  // Optional roles with no assignees yet still need an "on" visual so the
  // user can pick someone after flipping the toggle.
  const [armedRoles, setArmedRoles] = useState<Set<string>>(new Set());

  const toggleRole = useCallback(
    (role: string) => {
      if (REQUIRED_ROLES.has(role)) return;
      const roleEntries = entries.filter((e) => e.role === role);
      const currentlyOn =
        roleEntries.some((e) => e.enabled) || armedRoles.has(role);
      if (currentlyOn) {
        setArmedRoles((prev) => {
          const next = new Set(prev);
          next.delete(role);
          return next;
        });
        onChange(
          entries.map((e) => (e.role === role ? { ...e, enabled: false } : e)),
        );
        return;
      }
      if (roleEntries.length > 0) {
        onChange(
          entries.map((e) => (e.role === role ? { ...e, enabled: true } : e)),
        );
      } else {
        setArmedRoles((prev) => new Set(prev).add(role));
      }
    },
    [armedRoles, entries, onChange],
  );

  const addAssignee = useCallback(
    (role: RoleKey, type: "member" | "agent", id: string) => {
      const roleEntries = entries.filter((e) => e.role === role);
      if (roleEntries.some((e) => e.assignee_id === id)) return;
      const multi = role === "developer";
      const kept = multi ? entries : entries.filter((e) => e.role !== role);
      const next: RoleAssignment = {
        id: `draft-${role}-${id}`,
        role,
        assignee_type: type,
        assignee_id: id,
        enabled: true,
        ordinal: roleEntries.length,
      };
      onChange([...kept, next]);
      setArmedRoles((prev) => {
        if (!prev.has(role)) return prev;
        const copy = new Set(prev);
        copy.delete(role);
        return copy;
      });
    },
    [entries, onChange],
  );

  const removeAssignee = useCallback(
    (role: RoleKey, id: string) => {
      const remaining = entries.filter(
        (e) => !(e.role === role && e.assignee_id === id),
      );
      onChange(remaining);
      if (
        !REQUIRED_ROLES.has(role) &&
        !remaining.some((e) => e.role === role)
      ) {
        setArmedRoles((prev) => new Set(prev).add(role));
      }
    },
    [entries, onChange],
  );

  return (
    <div className={cn("flex gap-1.5", className)} data-testid="role-strip">
      {ROLE_ORDER.map((role) => {
        const roleEntries = entries.filter((e) => e.role === role);
        const required = REQUIRED_ROLES.has(role);
        const isEnabled =
          required ||
          roleEntries.some((e) => e.enabled) ||
          armedRoles.has(role);
        return (
          <RoleCard
            key={role}
            role={role}
            entries={roleEntries}
            required={required}
            enabled={isEnabled}
            onToggle={() => toggleRole(role)}
            onAdd={(type, id) => addAssignee(role, type, id)}
            onRemove={(id) => removeAssignee(role, id)}
            playbooks={playbooks}
            onPlaybookChange={onPlaybookChange}
          />
        );
      })}
    </div>
  );
}

function RoleCard({
  role,
  entries,
  required,
  enabled,
  onToggle,
  onAdd,
  onRemove,
  playbooks,
  onPlaybookChange,
}: {
  role: RoleKey;
  entries: RoleAssignment[];
  required: boolean;
  enabled: boolean;
  onToggle: () => void;
  onAdd: (type: "member" | "agent", id: string) => void;
  onRemove: (id: string) => void;
  playbooks?: RolePlaybookBundle;
  onPlaybookChange?: (role: RolePlaybookKey, override: RolePlaybook) => void;
}) {
  const { t } = useT("issues");
  const enabledEntries = entries.filter((e) => e.enabled);
  const multi = role === "developer";
  const [playbookOpen, setPlaybookOpen] = useState(false);
  const customized = playbookHasOverride(overridePlaybook(playbooks, role));

  return (
    <div
      data-testid={`role-card-${role}`}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 rounded-md border px-2 py-1.5",
        enabled
          ? "on border-primary/45 bg-primary/5"
          : "off border-dashed bg-muted/50",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-2xs font-medium",
            !enabled && "text-muted-foreground",
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
            checked={enabled}
            disabled={required}
            onCheckedChange={() => onToggle()}
            aria-label={t(($) => $.role_strip.toggle_aria, { role: t(($) => $.role_strip[role]) })}
          />
          {required && (
            <Lock className="pointer-events-none absolute -right-1 -top-1 size-2.5 text-muted-foreground" />
          )}
        </span>
      </div>

      <div className="flex min-h-[18px] flex-wrap items-center gap-0.5">
        {enabled && enabledEntries.length > 0 ? (
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
              <button
                type="button"
                data-testid={`role-remove-${role}-${e.assignee_id}`}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={t(($) => $.role_strip.remove_assignee_aria, {
                  name: e.assignee_id,
                })}
                onClick={() => onRemove(e.assignee_id)}
              >
                <XIcon className="size-2.5" />
              </button>
            </span>
          ))
        ) : !enabled ? (
          <span className="text-2xs text-muted-foreground">
            {t(($) => $.role_strip.not_enabled)}
          </span>
        ) : (
          <span className="text-2xs text-amber-700 dark:text-amber-400">
            {t(($) => $.role_strip.unassigned)}
          </span>
        )}
        {enabled && (
          <RoleAssigneePicker
            role={role}
            multi={multi}
            selectedIds={enabledEntries.map((e) => e.assignee_id)}
            onPick={onAdd}
          />
        )}
      </div>

      <div className="flex items-start justify-between gap-1">
        <div
          className={cn(
            "text-[9px] leading-tight text-muted-foreground",
            !enabled && "text-faint-foreground",
          )}
        >
          {t(($) => $.role_strip[`${role}_note`])}
        </div>
        {playbooks && onPlaybookChange && (
          <button
            type="button"
            data-testid={`role-playbook-${role}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 text-[9px] hover:bg-accent/70",
              customized ? "text-primary" : "text-muted-foreground",
            )}
            aria-label={t(($) => $.role_playbook.open_aria, {
              role: t(($) => $.role_strip[role]),
            })}
            onClick={() => setPlaybookOpen(true)}
          >
            <Settings2 className="size-2.5" />
            {customized
              ? t(($) => $.role_playbook.badge_custom)
              : t(($) => $.role_playbook.badge_std)}
          </button>
        )}
      </div>
      {playbooks && onPlaybookChange && (
        <RolePlaybookDialog
          role={role}
          open={playbookOpen}
          onOpenChange={setPlaybookOpen}
          resolved={resolvedPlaybook(playbooks, role)}
          override={overridePlaybook(playbooks, role)}
          builtin={playbooks.builtins[role] ?? emptyRolePlaybook(role)}
          onSave={(next) => onPlaybookChange(role, next)}
        />
      )}
    </div>
  );
}

function RoleAssigneePicker({
  role,
  multi,
  selectedIds,
  onPick,
}: {
  role: RoleKey;
  multi: boolean;
  selectedIds: string[];
  onPick: (type: "member" | "agent", id: string) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const query = filter.trim().toLowerCase();
  const filteredMembers = members.filter(
    (m) =>
      !selectedIds.includes(m.user_id) &&
      (m.name.toLowerCase().includes(query) || matchesPinyin(m.name, query)),
  );
  const filteredAgents = agents.filter(
    (a) =>
      !a.archived_at &&
      !selectedIds.includes(a.id) &&
      (a.name.toLowerCase().includes(query) || matchesPinyin(a.name, query)),
  );

  return (
    <PropertyPicker
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setFilter("");
      }}
      width="w-56"
      align="start"
      searchable
      searchPlaceholder={t(($) => $.role_strip.search_assignee)}
      onSearchChange={setFilter}
      trigger={
        <span
          data-testid={`role-add-${role}`}
          className="inline-flex cursor-pointer items-center gap-0.5 rounded-full border border-dashed px-1 py-0 text-2xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="size-2.5" />
          {multi
            ? t(($) => $.role_strip.add_multi)
            : t(($) => $.role_strip.add)}
        </span>
      }
    >
      {filteredAgents.length > 0 && (
        <PickerSection label={t(($) => $.pickers.assignee.agents_group)}>
          {filteredAgents.map((a) => (
            <PickerItem
              key={a.id}
              selected={false}
              onClick={() => {
                onPick("agent", a.id);
                if (!multi) setOpen(false);
              }}
            >
              <ActorAvatar actorType="agent" actorId={a.id} size="sm" profileLink={false} />
              <span className="truncate">{a.name}</span>
            </PickerItem>
          ))}
        </PickerSection>
      )}
      {filteredMembers.length > 0 && (
        <PickerSection label={t(($) => $.pickers.assignee.members_group)}>
          {filteredMembers.map((m) => (
            <PickerItem
              key={m.user_id}
              selected={false}
              onClick={() => {
                onPick("member", m.user_id);
                if (!multi) setOpen(false);
              }}
            >
              <ActorAvatar actorType="member" actorId={m.user_id} size="sm" profileLink={false} />
              <span className="truncate">{m.name}</span>
            </PickerItem>
          ))}
        </PickerSection>
      )}
      {filteredAgents.length === 0 && filteredMembers.length === 0 && (
        <div className="px-2 py-3 text-center text-2xs text-muted-foreground">
          {t(($) => $.role_strip.empty_assignees)}
        </div>
      )}
    </PropertyPicker>
  );
}

/** Renders the assignee display name via the workspace actor-name hook. */
function AssigneeName({ entry }: { entry: RoleAssignment }) {
  const { getActorName } = useActorName();
  return <span>{getActorName(entry.assignee_type, entry.assignee_id)}</span>;
}
