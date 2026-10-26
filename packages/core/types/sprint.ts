// 迭代（Sprint）类型（对标 CoCo 工作流迭代资产；migration 470）。
// spec: change_logs/multica/plans/20261024-coco对标-工作流迭代资产/02_迭代模块.md
//
// 线格式与 server/internal/handler/sprint.go 的 SprintResponse JSON tag 严格
// 对齐。状态机 planned→active→completed 全部走后端 CAS（WHERE 带期望状态），
// 非法迁移 409；issue 通过 issue.sprint_id 归属迭代，未归属 = backlog。

/** 迭代状态机三态（对齐 sprint_status CHECK）。 */
export type SprintStatus = "planned" | "active" | "completed";

export const SPRINT_STATUSES: readonly SprintStatus[] = [
  "planned",
  "active",
  "completed",
];

/** sprint 行的 JSON 形态。IssueCount / DoneCount 仅列表查询聚合（LEFT JOIN
 * issue）；单条 GET 与完成后的列表同形，但两列为 0——需要精确进度读
 * `sprintProgressOptions`。 */
export interface Sprint {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  goal: string | null;
  status: SprintStatus;
  /** 日历日 "YYYY-MM-DD"（无时区）；null = 未排期。 */
  start_date: string | null;
  end_date: string | null;
  /** 容量点数；null = 未设容量。 */
  capacity: number | null;
  created_by_type: "member" | "agent";
  created_by_id: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  issue_count: number;
  /** 已完成成员数（`issue_effective_status = 'done'` 归一口径）。 */
  done_count: number;
}

/** GET /sprints 信封。 */
export interface ListSprintsResponse {
  sprints: Sprint[];
  total: number;
}

/** POST /sprints 请求体（日期为 "YYYY-MM-DD" 或省略）。 */
export interface CreateSprintRequest {
  name: string;
  goal?: string;
  start_date?: string;
  end_date?: string;
  capacity?: number | null;
}

/** PATCH /sprints/{sprintId} 请求体：省略字段保持原值；goal "" = 清空。 */
export interface UpdateSprintRequest {
  name?: string;
  goal?: string;
  start_date?: string;
  end_date?: string;
  capacity?: number | null;
}

/** GET /sprints/{sprintId}/progress 响应（完成度派生不落列）。 */
export interface SprintProgress {
  done_count: number;
  cancelled_count: number;
  total_count: number;
  capacity: number | null;
  sprint_id: string;
  sprint_status: SprintStatus;
}

/** POST/DELETE /sprints/{sprintId}/issues 请求体。 */
export interface SprintIssuesRequest {
  issue_ids: string[];
}

/** sprint:updated WS 载荷（created/updated/started/completed/reopened/deleted）。
 *  deleted 只携带 sprint_id，无整行；前端 updater 仅做整片 invalidate。 */
export interface SprintUpdatedPayload {
  sprint?: Sprint;
  sprint_id?: string;
  action: string;
  project_id: string;
}

/** sprint:issues_changed WS 载荷。 */
export interface SprintIssuesChangedPayload {
  sprint_id: string;
  project_id: string;
  action: "assigned" | "removed";
  issue_ids: number;
}
