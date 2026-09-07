"use client";

import { useEffect, useState } from "react";
import type { RolePlaybook, RolePlaybookInitMode } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";
import {
  emptyRolePlaybook,
  playbookHasOverride,
  type RolePlaybookKey,
} from "./role-playbook";

export function RolePlaybookDialog({
  role,
  open,
  onOpenChange,
  resolved,
  override,
  builtin,
  onSave,
}: {
  role: RolePlaybookKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resolved: RolePlaybook;
  override: RolePlaybook;
  builtin: RolePlaybook;
  onSave: (override: RolePlaybook) => void;
}) {
  const { t } = useT("issues");
  const [draft, setDraft] = useState<RolePlaybook>(resolved);

  useEffect(() => {
    if (open) setDraft(resolved);
  }, [open, resolved]);

  const setField = <K extends keyof RolePlaybook>(key: K, value: RolePlaybook[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const customized = playbookHasOverride(override);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        data-testid={`role-playbook-dialog-${role}`}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => $.role_playbook.title, { role: t(($) => $.role_strip[role]) })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => $.role_playbook.description)}
            {customized
              ? ` · ${t(($) => $.role_playbook.customized)}`
              : ` · ${t(($) => $.role_playbook.builtin)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <PlaybookField
            label={t(($) => $.role_playbook.background)}
            hint={t(($) => $.role_playbook.background_hint)}
            value={draft.background}
            onChange={(v) => setField("background", v)}
            testId={`role-playbook-background-${role}`}
          />
          <PlaybookField
            label={t(($) => $.role_playbook.standards)}
            hint={t(($) => $.role_playbook.standards_hint)}
            value={draft.standards}
            onChange={(v) => setField("standards", v)}
            testId={`role-playbook-standards-${role}`}
          />
          <PlaybookField
            label={t(($) => $.role_playbook.process)}
            hint={t(($) => $.role_playbook.process_hint)}
            value={draft.process}
            onChange={(v) => setField("process", v)}
            testId={`role-playbook-process-${role}`}
          />
          <div className="space-y-1">
            <label className="text-caption font-medium">
              {t(($) => $.role_playbook.init_mode)}
            </label>
            <p className="text-micro text-muted-foreground">
              {t(($) => $.role_playbook.init_mode_hint)}
            </p>
            <div className="flex gap-2">
              {(["brief", "checklist"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`role-playbook-init-mode-${mode}`}
                  className={
                    draft.init_mode === mode
                      ? "flex-1 rounded-md border border-primary bg-primary/5 px-2 py-1.5 text-left text-caption"
                      : "flex-1 rounded-md border px-2 py-1.5 text-left text-caption hover:bg-accent/50"
                  }
                  onClick={() => setField("init_mode", mode as RolePlaybookInitMode)}
                >
                  <div className="font-medium">
                    {t(($) => $.role_playbook.init_mode_label[mode])}
                  </div>
                  <div className="text-micro text-muted-foreground">
                    {t(($) => $.role_playbook.init_mode_desc[mode])}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <PlaybookField
            label={t(($) => $.role_playbook.init_content)}
            hint={t(($) => $.role_playbook.init_content_hint)}
            value={draft.init_content}
            onChange={(v) => setField("init_content", v)}
            testId={`role-playbook-init-${role}`}
          />
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            data-testid="role-playbook-reset"
            onClick={() => setDraft({ ...builtin, role, source: "builtin" })}
          >
            {t(($) => $.role_playbook.reset)}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t(($) => $.role_playbook.cancel)}
            </Button>
            <Button
              type="button"
              data-testid="role-playbook-save"
              onClick={() => {
                const sameAsBuiltin =
                  draft.background.trim() === (builtin.background ?? "").trim() &&
                  draft.standards.trim() === (builtin.standards ?? "").trim() &&
                  draft.process.trim() === (builtin.process ?? "").trim() &&
                  draft.init_content.trim() === (builtin.init_content ?? "").trim() &&
                  (draft.init_mode || "brief") === (builtin.init_mode || "brief");
                onSave(
                  sameAsBuiltin
                    ? emptyRolePlaybook(role)
                    : {
                        role,
                        background: draft.background,
                        standards: draft.standards,
                        process: draft.process,
                        init_mode: draft.init_mode || "brief",
                        init_content: draft.init_content,
                      },
                );
                onOpenChange(false);
              }}
            >
              {t(($) => $.role_playbook.save)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlaybookField({
  label,
  hint,
  value,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-caption font-medium">{label}</label>
      <p className="text-micro text-muted-foreground">{hint}</p>
      <Textarea
        data-testid={testId}
        className="min-h-24 text-caption"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
