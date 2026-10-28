-- agent 运行所属的工作流步骤（移植自 multica-main MUL-7420）：task 入队时记录当时的
-- issue 状态，运行自身的状态推进随之更新。当 issue 已离开该步骤（运行期间被别人移走），
-- 运行的状态改动会被拒绝而不是回退那次移动。
--
-- 由按 issue 行写入的 task INSERT 与运行自行改状态的路径写入，其余路径不写；
-- 本迁移之前的行、无 issue 的 task 为 NULL，NULL 表示「不校验」而非「匹配」。
ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS workflow_step TEXT;
