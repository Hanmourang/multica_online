// 档案产物类型（migration 455 project_artifact；含 project.archive_resource_id 扩展列）

import type { GraphSyncPayload } from "./graph";

/** 档案作用域：由目录契约推导 —— overview/ → project，requirements/ → requirement，_shared/ → shared。 */
export type ArtifactScope = "shared" | "project" | "requirement";

/** 写入通道：sync = CLI 同步，agent = 交付物归档动作，server = 原型投影，manual = 手动关联。 */
export type ArtifactSource = "sync" | "agent" | "server" | "manual";

/** 需求日历阶段（由 s<N>-<slug>/ 路径片段解析，N ∈ 1..4，越界拒绝入库）。 */
export type ArtifactStage = 1 | 2 | 3 | 4;

/** 文档类型：开放式字符串，常见值 research / product-design / architecture / tech-spec / test-report 等。 */
export type ArtifactDocType = string;

/** 档案条目：Git 是唯一事实源，DB 只存指针（rel_path + blob_sha）与元数据；
 *  UNIQUE(resource_id, rel_path, version) 保证同一文件同一版本只有一行。 */
export interface ProjectArtifact {
  id: string;
  workspace_id: string;
  project_id: string;
  resource_id: string;
  /** 绑定的需求；null = 未绑定（进待绑定列表）。 */
  issue_id?: string | null;
  /** 产出该档案的任务（agent_task_queue.task_id）；null = 非任务产出。 */
  task_id?: string | null;
  scope: ArtifactScope;
  stage?: ArtifactStage | null;
  doc_type: ArtifactDocType;
  version: number;
  rel_path: string;
  requirement_key?: string | null;
  blob_sha: string;
  /** 渲染快照（attachment/content）；null = 仅索引未上传（>100MB 只索引）。 */
  attachment_id?: string | null;
  size_bytes: number;
  source: ArtifactSource;
  synced_at: string;
  created_at: string;
  updated_at: string;
  /** 软删标记：sync 全量清单 diff 时缺席行置 deleted_at，不物理删除。 */
  deleted_at?: string | null;
}

/** GET /projects/{id}/artifacts 查询参数（scope/stage/doc_type/issue_id 筛选）。 */
export interface ListArtifactsParams {
  scope?: ArtifactScope;
  stage?: ArtifactStage;
  doc_type?: ArtifactDocType;
  issue_id?: string;
}

/** GET /projects/{id}/artifacts 响应。 */
export interface ListProjectArtifactsResponse {
  artifacts: ProjectArtifact[];
  total: number;
}

/** GET /projects/{id}/artifacts/{artifactId}/content 响应：attachment 存在且
 *  有 url 时 content_unavailable=false；否则前端降级到 git rel_path。 */
export interface GetArtifactContentResponse {
  artifact: ProjectArtifact;
  content_unavailable: boolean;
  attachment_url?: string;
}

/** POST /projects/{id}/artifacts/{artifactId}/archive 请求：从交付卡重新归档。 */
export interface ArchiveDeliverableRequest {
  scope: ArtifactScope;
  stage?: ArtifactStage;
  doc_type: ArtifactDocType;
  issue_id?: string;
}

/** 矩阵单元格：issue × stage 聚合计数（issue_id/stage 可为 null = 项目级/未分阶）。 */
export interface ArtifactMatrixCell {
  issue_id?: string | null;
  stage?: ArtifactStage | null;
  count: number;
}

/** GET /projects/{id}/artifacts/matrix 响应。 */
export interface ArtifactMatrixResponse {
  matrix: ArtifactMatrixCell[];
  total: number;
}

/** CLI 提交的全量清单条目（ArtifactSyncPayload.artifacts 元素；server 事务内 diff）。 */
export interface ArtifactSyncItem {
  rel_path: string;
  blob_sha: string;
  scope: ArtifactScope;
  stage?: ArtifactStage;
  doc_type: ArtifactDocType;
  version: number;
  requirement_key?: string;
  issue_id?: string;
  size_bytes: number;
  attachment_id?: string;
}

/** POST /projects/{id}/artifacts/sync 请求：全量清单 diff —— upsert 命中行、
 *  软删缺席行，不维护批次状态，重跑幂等。 */
export interface ArtifactSyncPayload {
  artifacts: ArtifactSyncItem[];
  /** 同批提交的图谱快照（按 git_sha 判重）；缺省 = 本次不更新图谱。 */
  graph_snapshot?: GraphSyncPayload;
  /**
   * 空清单 purge 的显式确认标志。缺省 / false 时 `{ artifacts: [] }` 是惰性的
   * no-op（服务端不软删任何行，返回 skipped_soft_delete=true、
   * skip_reason="empty_manifest"）；仅当调用方置 true 才允许把「未列出的行」
   * 软删。它永不解除 source='manual' 行的豁免 —— purge 只清同步指针，不动人工
   * 决策（原型 anno④「写回优先于改库」/ anno⑤）。对齐服务端
   * ArtifactSyncPayload.allow_empty_manifest。
   */
  allow_empty_manifest?: boolean;
}

/** sync 拒绝条目（越界 stage / 契约外路径等）。 */
export interface ArtifactSyncError {
  path: string;
  reason: string;
}

/** POST /projects/{id}/artifacts/sync 响应：事务内 diff 计数。
 *  preserved_manual / skipped_soft_delete / skip_reason 均建为可选，与服务端
 *  ArtifactSyncResult 对齐且不破坏只读既有字段的消费者。 */
export interface ArtifactSyncResult {
  created_count: number;
  updated_count: number;
  deleted_count: number;
  /**
   * 本次 diff 拒绝改动的人工行数：冲突时保留原 manual issue_id 的清单行，加上
   * 缺席于清单却被豁免软删的存量 manual 行。让 CLI / UI 如实汇报「保护了多少」
   * 而非猜测。服务端恒序列化（缺省 0）。
   */
  preserved_manual?: number;
  /**
   * true = diff 的软删步骤整段未执行；原因见 skip_reason（empty_manifest /
   * no_valid_items）。此时 deleted_count 恒为 0 —— 调用方绝不能把 0 读成「没有
   * 缺席行」。服务端恒序列化（缺省 false）。
   */
  skipped_soft_delete?: boolean;
  /** 跳过软删的原因（如 "empty_manifest" / "no_valid_items"）；服务端 omitempty，仅 skipped 时出现。 */
  skip_reason?: string;
  errors?: ArtifactSyncError[];
}

/** POST /projects/{id}/artifacts — 手动新增 / 从模板补齐（source=manual）。 */
export interface CreateProjectArtifactRequest {
  scope: ArtifactScope;
  stage?: ArtifactStage | null;
  doc_type: ArtifactDocType;
  rel_path: string;
  requirement_key?: string | null;
  issue_id?: string | null;
  content?: string;
  attachment_id?: string | null;
  version?: number;
}

/** PATCH /projects/{id}/artifacts/{id} 可写字段。 */
export interface PatchProjectArtifactRequest {
  scope?: ArtifactScope;
  stage?: ArtifactStage | null;
  doc_type?: ArtifactDocType;
  rel_path?: string;
  requirement_key?: string | null;
  issue_id?: string | null;
  content?: string;
}
