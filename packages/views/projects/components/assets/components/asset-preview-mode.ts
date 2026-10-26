import type { AssetBinding } from "@multica/core/types";

/**
 * binding 预览能力判定（从 asset-preview-dialog 抽出为轻量纯函数模块，
 * 供共享表格/卡片在不引入富文本渲染依赖的情况下复用）。
 */

export type AssetPreviewMode = "artifact" | "attachment" | null;

/** binding 是否可预览以及走哪条数据链路。 */
export function assetPreviewMode(binding: AssetBinding): AssetPreviewMode {
  const ref = binding.external_ref;
  if (!ref) return null;
  if (typeof ref.artifact_id === "string" && ref.artifact_id) return "artifact";
  if (typeof ref.attachment_id === "string" && ref.attachment_id) return "attachment";
  return null;
}
