"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Sparkles, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { type AssetBinding, type AssetCategory } from "@multica/core/types";
import { assetListOptions } from "@multica/core/assets/queries";
import { useUnbindIssueAsset } from "@multica/core/assets/mutations";
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
import { useT } from "../../../i18n";
import { QueryLoading } from "../archive/query-states";
import { BindAssetDialog } from "./asset-tab";

/**
 * 独立工作项详情（IssueDetail）右栏的紧凑资产块 —— 补全「日历 → 任务」动线
 * （spec 03_资产管理模块.md §F3 工作项级「绑定资产」）。主 AssetTab 是宽面板
 * （5 列表格 + 筛选 chips），塞进 ~320px 侧栏会溢出，故这里用纵向紧凑清单复用
 * 同一组 issue 作用域 endpoint（assetListOptions + useUnbindIssueAsset）与同一个
 * BindAssetDialog。解绑只删 binding 不动 resource，二次确认。Feature-flag 门控在
 * 挂载点（issue-detail）完成，flag off 时本组件不渲染。
 */
export function IssueAssetSection({
  projectId,
  issueId,
}: {
  projectId: string;
  issueId: string;
}) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const [bindOpen, setBindOpen] = useState(false);
  const [unbindTarget, setUnbindTarget] = useState<AssetBinding | null>(null);

  const listQuery = useQuery(
    assetListOptions(wsId, projectId, { page: 1, pageSize: 50 }, issueId),
  );
  const rows = listQuery.data?.items ?? [];

  const categoryLabels = useMemo<Record<AssetCategory, string>>(
    () => ({
      code_repository: t(($) => $.categories.code_repository),
      application: t(($) => $.categories.application),
      package: t(($) => $.categories.package),
      knowledge_repo: t(($) => $.categories.knowledge_repo),
      knowledge_group: t(($) => $.categories.knowledge_group),
      other: t(($) => $.categories.other),
    }),
    [t],
  );

  const unbindMutation = useUnbindIssueAsset(wsId, issueId);
  const handleUnbind = async () => {
    if (!unbindTarget) return;
    try {
      await unbindMutation.mutateAsync(unbindTarget.id);
      toast.success(t(($) => $.toast.unbound));
    } catch {
      toast.error(t(($) => $.toast.unbind_failed));
    } finally {
      setUnbindTarget(null);
    }
  };

  return (
    <div data-testid="issue-asset-section">
      <div className="mb-2 flex items-center justify-between gap-2 px-2 py-1">
        <span className="text-caption font-medium">{t(($) => $.title)}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => setBindOpen(true)}
        >
          <Plus />
          {t(($) => $.actions.bind)}
        </Button>
      </div>

      <div className="space-y-1 pl-2">
        {listQuery.isPending ? (
          <QueryLoading rows={1} />
        ) : rows.length === 0 ? (
          <div className="py-1 text-micro text-muted-foreground">
            {t(($) => $.empty.no_assets)}
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="group flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1">
                  <span
                    className="min-w-0 truncate text-caption"
                    title={row.asset_name}
                  >
                    {row.asset_name}
                  </span>
                  {row.recommended ? (
                    <Sparkles className="size-3 shrink-0 text-muted-foreground" />
                  ) : null}
                </div>
                <div className="truncate text-micro text-muted-foreground">
                  {categoryLabels[row.asset_category] ?? row.asset_category}
                  {row.asset_subtype ? ` · ${row.asset_subtype}` : ""}
                </div>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t(($) => $.actions.unbind)}
                disabled={unbindMutation.isPending && unbindTarget?.id === row.id}
                onClick={() => setUnbindTarget(row)}
              >
                <Unlink />
              </Button>
            </div>
          ))
        )}
      </div>

      <BindAssetDialog
        projectId={projectId}
        issueId={issueId}
        open={bindOpen}
        onOpenChange={setBindOpen}
        defaultCategory="code_repository"
      />

      <AlertDialog
        open={unbindTarget !== null}
        onOpenChange={(open) => !open && setUnbindTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.confirm_unbind.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.confirm_unbind.desc)}
              {unbindTarget ? (
                <span className="mt-1 block font-medium text-foreground">
                  {unbindTarget.asset_name}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.confirm_unbind.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleUnbind();
              }}
            >
              {t(($) => $.confirm_unbind.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
