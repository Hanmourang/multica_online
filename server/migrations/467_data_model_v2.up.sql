-- 数据模型 v2：快照携带版本化的数据资产投影（表级清单 / 消费绑定 / 调用链）。
-- 与 module_summary / bus_matrix 同为 CLI 预聚合的不透明 JSONB，服务端只透传。
-- 缺省 {} 表示该快照没有 v2 投影，前端按旧版降级渲染。
ALTER TABLE project_graph_snapshot
    ADD COLUMN IF NOT EXISTS data_model jsonb NOT NULL DEFAULT '{}'::jsonb;
