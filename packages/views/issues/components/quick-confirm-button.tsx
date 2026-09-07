"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { QuickConfirmError, quickConfirmIssue } from "./quick-confirm";

export function QuickConfirmButton({
  issueId,
  onDone,
  className,
}: {
  issueId: string;
  onDone?: () => void;
  className?: string;
}) {
  const { t } = useT("archive");
  const [pending, setPending] = useState(false);

  const handleClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    setPending(true);
    try {
      const kind = await quickConfirmIssue(issueId);
      toast.success(
        kind === "decompose"
          ? t(($) => $.quick_confirm.ok_decompose)
          : kind === "prototype"
            ? t(($) => $.quick_confirm.ok_prototype)
            : t(($) => $.quick_confirm.ok_review),
      );
      onDone?.();
    } catch (error) {
      if (error instanceof QuickConfirmError && error.code === "incomplete") {
        toast.error(t(($) => $.quick_confirm.incomplete));
      } else if (error instanceof QuickConfirmError && error.code === "empty") {
        toast.error(t(($) => $.quick_confirm.empty));
      } else {
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : t(($) => $.quick_confirm.failed),
        );
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      type="button"
      size="xs"
      variant="default"
      data-testid="quick-confirm"
      disabled={pending}
      className={className}
      onClick={(event) => void handleClick(event)}
    >
      <Check className="size-3" />
      {pending
        ? t(($) => $.quick_confirm.confirming)
        : t(($) => $.quick_confirm.action)}
    </Button>
  );
}
