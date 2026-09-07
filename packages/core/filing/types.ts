/**
 * Filing types owned by the filing module itself.
 *
 * `../types/filing` holds the Wave-1 contract (items, readiness aggregate,
 * check outcomes, export request/response) and is re-exported through the
 * shared `@multica/core/types` barrel. These are the additions from the f12
 * completion wave — cross-project comparison, the export checklist selection
 * and the READINESS.md writeback. They live here so the filing module can
 * evolve without a second owner touching the shared barrel, and so
 * `api/client.ts` can import them type-only (erased at runtime, no cycle).
 */
import type { FilingExportRequest, FilingTrack } from "../types";

/**
 * One project × track must-tier aggregate from
 * GET /projects/{id}/filing/cross-project.
 *
 * 原型 f12 标注 4：跨项目对比只算必备件 —— 辅助件齐不齐不影响能不能递交.
 * The server returns one row per project × track, most-ready first; the
 * client folds the two tracks together to draw one bar per project.
 */
export interface CrossProjectReadiness {
  project_id: string;
  project_title: string;
  track: FilingTrack;
  must_ready: number;
  must_total: number;
  /** must_ready / must_total as a percentage (one decimal); 0 when must_total is 0. */
  readiness_pct: number;
}

/**
 * POST /projects/{id}/filing/export with the checklist selection attached
 * (原型 f12 标注 5：包按档位分目录，勾选决定哪些档案进包).
 *
 * `artifact_ids` carries the bound artifacts of the ticked items. An absent or
 * empty list means "no selection sent" and the server packages every bound
 * artifact, so older callers keep working unchanged.
 */
export interface FilingExportSelectionRequest extends FilingExportRequest {
  artifact_ids?: string[];
}

/**
 * POST /projects/{id}/filing/writeback — the READINESS.md pointer the server
 * just upserted into project_artifact.
 *
 * Design §5.4 names the response `{ commitSha: string }`; `commit_sha` stays
 * empty because the server never touches the filesystem (design decision 3 —
 * Git is the only source of truth and the CLI owns writes). An empty string is
 * reported rather than a fabricated sha.
 */
export interface FilingWritebackResponse {
  success: boolean;
  artifact_id: string;
  rel_path: string;
  doc_type: string;
  /** "created" on first writeback, "updated" on every subsequent one. */
  action: "created" | "updated";
  blob_sha: string;
  size_bytes: number;
  generated_at: string;
  commit_sha: string;
}
