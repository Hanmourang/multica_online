#!/usr/bin/env python3
"""把「代码本体平台」数据模型 v2 的演示数据写入数据库。

在 seed_ontology_platform_demo.py（v1 快照）之上叠加：
- 新快照 demo-ontology-platform-v2：bus_matrix 升级为 模块→页面→业务过程
  三级粒度；新增 data_model JSONB（migration 467）：版本时间线、表级资产
  清单、消费绑定、前后端调用链。
- v2 快照对应的 ontology_changelog 表级变更行（驱动变更时间线/角标）。

不往应用代码里塞 mock。重复执行会按 scan_id 清理后重灌。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECT_ID = "57751040-94fd-4517-bd52-a77d9d4d4aa9"
WORKSPACE_ID = "b882de9b-ae4e-42d9-b284-0552b3a814d4"
SEED = "ontology-platform-demo"
SCAN_ID = "demo-ontology-platform-v2"
SNAPSHOT_ID = "a11c0de1-0002-4000-8000-000000000002"
V1_SCAN_ID = "demo-ontology-platform-v1"

# ---------------------------------------------------------------------------
# 列定义（业务过程格子里的 tables 明细复用）
# ---------------------------------------------------------------------------


def col(name: str, type_: str = "text", access: str = "read") -> dict:
    return {"name": name, "type": type_, "access": access}


COLS = {
    "ontology_object": [
        col("id", "uuid"), col("project_id", "uuid"), col("qualified_name"),
        col("domain"), col("lifecycle"), col("updated_at", "timestamptz", "read_write"),
    ],
    "ontology_link": [
        col("id", "uuid"), col("source_id", "uuid"), col("target_id", "uuid"),
        col("link_type"), col("weight", "float8", "read_write"),
    ],
    "project_graph_snapshot": [
        col("id", "uuid"), col("project_id", "uuid"), col("scan_id"),
        col("data_model", "jsonb"), col("created_at", "timestamptz"),
    ],
    "ontology_changelog": [
        col("id", "uuid"), col("snapshot_id", "uuid"), col("change_type"),
        col("entity_type"), col("name"), col("version_label"), col("created_at", "timestamptz"),
    ],
    "scan_job": [
        col("id", "uuid"), col("status"),
        col("started_at", "timestamptz"), col("finished_at", "timestamptz"),
    ],
    "scan_file": [
        col("id", "uuid"), col("job_id", "uuid"), col("path"), col("status"),
    ],
    "extract_run": [
        col("id", "uuid"), col("strategy_id", "uuid"), col("status"), col("created_at", "timestamptz"),
    ],
    "strategy_pack": [
        col("id", "uuid"), col("name"), col("strategy_scope"), col("version", "int4", "read_write"),
    ],
    "bus_matrix_cell": [
        col("id", "uuid"), col("cell_locator"), col("domain"), col("table_count", "int4"),
    ],
    "asset_mount": [
        col("id", "uuid"), col("project_id", "uuid"), col("cell_locator"),
        col("table_name"), col("rw"), col("ignored", "bool", "read_write"),
    ],
    "audit_log": [
        col("id", "uuid"), col("actor"), col("action"), col("target"), col("created_at", "timestamptz"),
    ],
    "archive_item": [
        col("id", "uuid"), col("title"), col("doc_class"), col("archived_at", "timestamptz", "read_write"),
    ],
    "project_module": [
        col("id", "uuid"), col("name"), col("color"), col("graph_node_id"),
    ],
    "legacy_scan_cache": [col("path")],
}


def tbl(name: str, domain: str, r: int, w: int, new: bool = False) -> dict:
    t = {
        "name": name,
        "domain": domain,
        "columns": COLS[name],
        "read_count": r,
        "write_count": w,
        "is_new_table": new,
    }
    return t


# ---------------------------------------------------------------------------
# 总线矩阵：模块 → 子功能页面 → 业务过程（主键组合）三级行
# ---------------------------------------------------------------------------

MOD_ONTOLOGY = ("本体管理", "comm-ontology")
MOD_GRAPH = ("图谱浏览", "comm-graph")
MOD_SCAN = ("扫描任务", "comm-scan")
MOD_EXTRACT = ("抽取配置", "comm-extract")
MOD_BUS = ("总线矩阵", "comm-bus")
MOD_ARCHIVE = ("档案管理", "comm-archive")


def cell(
    module: tuple[str, str],
    page: tuple[str, str],
    proc: tuple[str, str],
    domain: str,
    tables: list[dict],
    added: int = 0,
    modified: int = 0,
    removed: int = 0,
    cross: bool = False,
) -> dict:
    return {
        "module_name": module[0],
        "module_node_id": module[1],
        "page_name": page[0],
        "page_key": page[1],
        "process_name": proc[0],
        "process_key": proc[1],
        "domain": domain,
        "table_count": len(tables),
        "read_count": sum(t["read_count"] for t in tables),
        "write_count": sum(t["write_count"] for t in tables),
        "is_new_table": any(t.get("is_new_table") for t in tables),
        "is_cross_domain_write": cross,
        "added": added,
        "modified": modified,
        "removed": removed,
        "tables": tables,
    }


def bus_matrix() -> list[dict]:
    return [
        # 本体管理 · 本体对象页
        cell(MOD_ONTOLOGY, ("本体对象页", "page-ontology"), ("对象浏览", "proc-obj-browse"),
             "ontology", [tbl("ontology_object", "ontology", 4, 0)]),
        cell(MOD_ONTOLOGY, ("本体对象页", "page-ontology"), ("对象编辑", "proc-obj-edit"),
             "ontology", [tbl("ontology_object", "ontology", 2, 2), tbl("ontology_link", "ontology", 1, 2)]),
        cell(MOD_ONTOLOGY, ("本体对象页", "page-ontology"), ("关系维护", "proc-link-maintain"),
             "ontology", [tbl("ontology_link", "ontology", 3, 1)]),
        # 图谱浏览 · 图谱总览页 / 变更时间线页
        cell(MOD_GRAPH, ("图谱总览页", "page-graph-explorer"), ("图谱加载", "proc-graph-load"),
             "graph", [tbl("project_graph_snapshot", "graph", 5, 0)], modified=1),
        cell(MOD_GRAPH, ("图谱总览页", "page-graph-explorer"), ("节点筛选", "proc-graph-filter"),
             "graph", [tbl("project_graph_snapshot", "graph", 3, 0), tbl("project_module", "graph", 2, 0)]),
        cell(MOD_GRAPH, ("变更时间线页", "page-graph-timeline"), ("时间线浏览", "proc-timeline-browse"),
             "graph", [tbl("ontology_changelog", "graph", 3, 0)], modified=1),
        # 扫描任务 · 扫描任务页 / 文件明细页
        cell(MOD_SCAN, ("扫描任务页", "page-scan"), ("任务创建", "proc-scan-create"),
             "scan", [tbl("scan_job", "scan", 1, 2)]),
        cell(MOD_SCAN, ("扫描任务页", "page-scan"), ("进度追踪", "proc-scan-progress"),
             "scan", [tbl("scan_job", "scan", 4, 0), tbl("scan_file", "scan", 3, 0)]),
        cell(MOD_SCAN, ("文件明细页", "page-scan-files"), ("文件清单", "proc-file-list"),
             "scan", [tbl("scan_file", "scan", 4, 0)]),
        # 抽取配置 · 抽取配置页
        cell(MOD_EXTRACT, ("抽取配置页", "page-extract"), ("策略配置", "proc-strategy"),
             "extract", [tbl("strategy_pack", "extract", 2, 2)]),
        cell(MOD_EXTRACT, ("抽取配置页", "page-extract"), ("运行监控", "proc-extract-monitor"),
             "extract", [tbl("extract_run", "extract", 4, 0)]),
        # 总线矩阵 · 数据模型页
        cell(MOD_BUS, ("数据模型页", "page-bus-matrix"), ("矩阵浏览", "proc-matrix-browse"),
             "bus", [tbl("bus_matrix_cell", "bus", 4, 0), tbl("project_graph_snapshot", "graph", 2, 0)],
             modified=1),
        cell(MOD_BUS, ("数据模型页", "page-bus-matrix"), ("资产挂载", "proc-asset-mount"),
             "bus", [tbl("asset_mount", "bus", 2, 2, new=True), tbl("audit_log", "archive", 0, 2, new=True)],
             added=2, cross=True),
        # 档案管理 · 档案浏览页
        cell(MOD_ARCHIVE, ("档案浏览页", "page-archive"), ("档案加载", "proc-archive-load"),
             "archive", [tbl("archive_item", "archive", 3, 0)], removed=1),
        cell(MOD_ARCHIVE, ("档案浏览页", "page-archive"), ("归档操作", "proc-archive-store"),
             "archive", [tbl("archive_item", "archive", 1, 2), tbl("audit_log", "archive", 2, 0)]),
    ]


def module_summary() -> list[dict]:
    base = {
        "comm-ontology": ("本体对象页", 46, 6, 214, 37, ["ontology_object", "ontology_link"]),
        "comm-graph": ("图谱浏览页", 38, 5, 120, 18,
                       ["project_graph_snapshot", "ontology_changelog", "project_module"]),
        "comm-scan": ("扫描任务页", 21, 3, 64, 11, ["scan_job", "scan_file"]),
        "comm-extract": ("抽取配置页", 17, 4, 48, 9, ["extract_run", "strategy_pack"]),
        "comm-bus": ("总线矩阵页", 24, 2, 36, 7, ["bus_matrix_cell", "asset_mount", "audit_log"]),
        "comm-archive": ("档案浏览页", 12, 2, 28, 5, ["archive_item"]),
        "comm-filing": ("申报清单页", 15, 3, 22, 4, ["filing_item", "filing_check_run"]),
    }
    return [
        {
            "name": name,
            "node_id": node_id,
            "biz_kind": "product",
            "obj_count": obj,
            "strategy_count": strategy,
            "edge_stats": {"calls_internal": calls_in, "calls_external": calls_out},
            "tables_touched": tables,
        }
        for node_id, (name, obj, strategy, calls_in, calls_out, tables) in base.items()
    ]


# ---------------------------------------------------------------------------
# data_model v2：版本时间线 + 表级资产清单 + 消费绑定 + 前后端调用链
# ---------------------------------------------------------------------------

PAGES = {
    "page-ontology": (MOD_ONTOLOGY, "本体对象页"),
    "page-graph-explorer": (MOD_GRAPH, "图谱总览页"),
    "page-graph-timeline": (MOD_GRAPH, "变更时间线页"),
    "page-scan": (MOD_SCAN, "扫描任务页"),
    "page-scan-files": (MOD_SCAN, "文件明细页"),
    "page-extract": (MOD_EXTRACT, "抽取配置页"),
    "page-bus-matrix": (MOD_BUS, "数据模型页"),
    "page-archive": (MOD_ARCHIVE, "档案浏览页"),
}


def cons(page_key: str, proc: tuple[str, str], rw: str) -> dict:
    (module_name, module_id), page_name = PAGES[page_key]
    return {
        "module_node_id": module_id,
        "module_name": module_name,
        "page_key": page_key,
        "page_name": page_name,
        "process_key": proc[1],
        "process_name": proc[0],
        "rw": rw,
    }


def chain(frontend: list[str], api: list[str], service: list[str], risks: list[str] | None = None) -> dict:
    c = {"frontend": frontend, "api": api, "service": service}
    if risks:
        c["risks"] = risks
    return c


def table_entry(
    name: str,
    domain: str,
    status: str,
    consumers: list[dict],
    migration: str | None = None,
    column_diffs: dict | None = None,
    call_chain: list[dict] | None = None,
    r: int = 0,
    w: int = 0,
) -> dict:
    t: dict = {
        "name": name,
        "domain": domain,
        "status": status,
        "columns": COLS[name],
        "read_count": r,
        "write_count": w,
        "consumers": consumers,
    }
    if migration:
        t["migration"] = migration
    if column_diffs:
        t["column_diffs"] = column_diffs
    if call_chain:
        t["call_chain"] = call_chain
    return t


def data_model() -> dict:
    proc_browse = ("对象浏览", "proc-obj-browse")
    proc_edit = ("对象编辑", "proc-obj-edit")
    proc_link = ("关系维护", "proc-link-maintain")
    proc_gload = ("图谱加载", "proc-graph-load")
    proc_gfilter = ("节点筛选", "proc-graph-filter")
    proc_timeline = ("时间线浏览", "proc-timeline-browse")
    proc_scan_create = ("任务创建", "proc-scan-create")
    proc_scan_progress = ("进度追踪", "proc-scan-progress")
    proc_file_list = ("文件清单", "proc-file-list")
    proc_strategy = ("策略配置", "proc-strategy")
    proc_monitor = ("运行监控", "proc-extract-monitor")
    proc_mbrowse = ("矩阵浏览", "proc-matrix-browse")
    proc_mount = ("资产挂载", "proc-asset-mount")
    proc_aload = ("档案加载", "proc-archive-load")
    proc_astore = ("归档操作", "proc-archive-store")

    tables = [
        table_entry(
            "ontology_object", "ontology", "unchanged",
            [cons("page-ontology", proc_browse, "R"), cons("page-ontology", proc_edit, "RW")],
            call_chain=[chain(
                ["本体对象页 · OntologyExplorer", "useOntologyObjects()"],
                ["GET /api/projects/{id}/ontology/objects"],
                ["ontology.go · ListOntologyObjects", "db · ListOntologyObjects"],
            )],
            r=6, w=2,
        ),
        table_entry(
            "ontology_link", "ontology", "unchanged",
            [cons("page-ontology", proc_edit, "RW"), cons("page-ontology", proc_link, "RW")],
            call_chain=[chain(
                ["本体对象页 · 关系画布"],
                ["GET /api/projects/{id}/ontology/links"],
                ["ontology.go · ListOntologyLinks"],
            )],
            r=4, w=3,
        ),
        table_entry(
            "project_graph_snapshot", "graph", "modified",
            [cons("page-graph-explorer", proc_gload, "R"),
             cons("page-graph-explorer", proc_gfilter, "R"),
             cons("page-bus-matrix", proc_mbrowse, "R")],
            migration="0467",
            column_diffs={"added": ["data_model"], "removed": [], "type_changed": []},
            call_chain=[chain(
                ["数据模型页 · bus-matrix-tab.tsx", "latestGraphSnapshotOptions()"],
                ["GET /api/projects/{id}/graph/latest"],
                ["project_graph.go · GetLatestGraphSnapshot", "loadLatestGraphSnapshot"],
            )],
            r=10, w=1,
        ),
        table_entry(
            "ontology_changelog", "graph", "modified",
            [cons("page-graph-timeline", proc_timeline, "R")],
            migration="0462",
            column_diffs={"added": ["version_label"], "removed": [], "type_changed": []},
            call_chain=[chain(
                ["变更时间线 · BusMatrixTimeline", "busMatrixTimelineOptions()"],
                ["GET /api/projects/{id}/graph/bus-matrix/timeline"],
                ["project_graph.go · GetBusMatrixTimeline"],
            )],
            r=3, w=1,
        ),
        table_entry(
            "scan_job", "scan", "unchanged",
            [cons("page-scan", proc_scan_create, "W"), cons("page-scan", proc_scan_progress, "R")],
            call_chain=[chain(
                ["扫描任务页 · ScanJobPanel"],
                ["POST /api/projects/{id}/graph/sync"],
                ["project_graph.go · SyncGraphSnapshot"],
            )],
            r=5, w=2,
        ),
        table_entry(
            "scan_file", "scan", "unchanged",
            [cons("page-scan", proc_scan_progress, "R"), cons("page-scan-files", proc_file_list, "R")],
            r=7, w=1,
        ),
        table_entry(
            "extract_run", "extract", "unchanged",
            [cons("page-extract", proc_monitor, "R")],
            r=4, w=1,
        ),
        table_entry(
            "strategy_pack", "extract", "unchanged",
            [cons("page-extract", proc_strategy, "RW")],
            call_chain=[chain(
                ["抽取配置页 · StrategyEditor"],
                ["GET /api/projects/{id}/extract/strategies"],
                ["extract.go · ListStrategyPacks"],
            )],
            r=2, w=2,
        ),
        table_entry(
            "bus_matrix_cell", "bus", "unchanged",
            [cons("page-bus-matrix", proc_mbrowse, "R")],
            migration="0456",
            r=4, w=1,
        ),
        table_entry(
            "asset_mount", "bus", "added",
            [cons("page-bus-matrix", proc_mount, "RW")],
            migration="0467",
            call_chain=[chain(
                ["资产挂载弹窗 · bus-matrix-mount-dialog.tsx"],
                [],
                [],
                risks=["当前仅写入 localStorage，服务端持久化链路待接入", "刷新或换机后手动挂载关系可能丢失"],
            )],
            r=2, w=2,
        ),
        table_entry(
            "audit_log", "archive", "added",
            [cons("page-bus-matrix", proc_mount, "W"), cons("page-archive", proc_astore, "R")],
            migration="0467",
            call_chain=[chain(
                ["资产挂载弹窗", "归档操作"],
                ["POST /api/projects/{id}/audit"],
                ["audit.go · WriteAuditLog"],
                risks=["跨域写：总线矩阵域直接写审计域"],
            )],
            r=2, w=2,
        ),
        table_entry(
            "archive_item", "archive", "unchanged",
            [cons("page-archive", proc_aload, "R"), cons("page-archive", proc_astore, "RW")],
            call_chain=[chain(
                ["档案浏览页 · ArchiveList"],
                ["GET /api/projects/{id}/artifacts"],
                ["artifact.go · ListArtifacts"],
            )],
            r=4, w=2,
        ),
        table_entry(
            "project_module", "graph", "unchanged",
            [cons("page-graph-explorer", proc_gfilter, "R")],
            r=2, w=0,
        ),
        table_entry(
            "legacy_scan_cache", "unknown", "removed",
            [],
            migration="0467",
            call_chain=[chain([], [], [], risks=["已下线：v1.1 起由 asset_mount 链路取代"])],
        ),
    ]

    def ch(table: str, change_type: str, detail: str) -> dict:
        return {"table": table, "change_type": change_type, "detail": detail}

    versions = [
        {
            "scan_id": "demo-ontology-platform-v0",
            "label": "v0.9",
            "git_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "created_at": "2026-09-06T09:00:00Z",
            "change_summary": {"added": 11, "modified": 0, "removed": 0},
            "changes": [
                ch("ontology_object", "added", "本体对象主表，首次建模"),
                ch("ontology_link", "added", "本体关系表，首次建模"),
                ch("project_graph_snapshot", "added", "图谱快照存储"),
                ch("ontology_changelog", "added", "本体变更流水"),
                ch("scan_job", "added", "扫描任务"),
                ch("scan_file", "added", "扫描文件明细"),
                ch("extract_run", "added", "抽取运行记录"),
                ch("strategy_pack", "added", "抽取策略包"),
                ch("project_module", "added", "产品模块桥接"),
                ch("archive_item", "added", "档案条目"),
                ch("legacy_scan_cache", "added", "过渡期扫描缓存"),
            ],
        },
        {
            "scan_id": V1_SCAN_ID,
            "label": "v1.0",
            "git_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "created_at": "2026-09-13T10:04:21Z",
            "change_summary": {"added": 1, "modified": 2, "removed": 0},
            "changes": [
                ch("bus_matrix_cell", "added", "总线矩阵格子预聚合落地（0456）"),
                ch("strategy_pack", "modified", "新增 strategy_scope 列（0458）"),
                ch("ontology_changelog", "modified", "change_type 约束扩展 status_change（0459）"),
            ],
        },
        {
            "scan_id": SCAN_ID,
            "label": "v1.1",
            "git_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "created_at": "2026-09-14T09:30:00Z",
            "change_summary": {"added": 2, "modified": 2, "removed": 1},
            "changes": [
                ch("asset_mount", "added", "资产挂载关系持久化（0467）"),
                ch("audit_log", "added", "挂载 / 归档操作审计（0467）"),
                ch("project_graph_snapshot", "modified", "新增 data_model 列（0467）"),
                ch("ontology_changelog", "modified", "新增 version_label 列（0462）"),
                ch("legacy_scan_cache", "removed", "被资产挂载链路替代，下线"),
            ],
        },
    ]

    return {
        "schema_version": 2,
        "current_version": SCAN_ID,
        "versions": versions,
        "tables": tables,
    }


CHANGELOG = [
    ("added", "table", "table:asset_mount", "asset_mount",
     {"domain": "bus", "migration": "0467", "note": "资产挂载关系持久化"}),
    ("added", "table", "table:audit_log", "audit_log",
     {"domain": "archive", "migration": "0467", "note": "挂载 / 归档操作审计"}),
    ("modified", "table", "table:project_graph_snapshot", "project_graph_snapshot",
     {"migration": "0467", "columns_added": ["data_model"]}),
    ("modified", "table", "table:ontology_changelog", "ontology_changelog",
     {"migration": "0462", "columns_added": ["version_label"]}),
    ("removed", "table", "table:legacy_scan_cache", "legacy_scan_cache",
     {"reason": "被资产挂载链路替代，v1.1 下线"}),
]


def load_database_url() -> str:
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"')
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL not found")
    return url


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def json_sql(value: object) -> str:
    return sql_literal(json.dumps(value, ensure_ascii=False))


def build_sql() -> str:
    parts: list[str] = [
        "BEGIN;",
        f"-- seed={SEED} scan={SCAN_ID} project={PROJECT_ID}",
        # 清理本脚本上次写入的行（不动 v1 快照与其changelog）
        f"DELETE FROM ontology_changelog WHERE snapshot_id = '{SNAPSHOT_ID}'::uuid;",
        "DELETE FROM project_graph_snapshot "
        f"WHERE id = '{SNAPSHOT_ID}'::uuid OR (project_id = '{PROJECT_ID}'::uuid AND scan_id = '{SCAN_ID}');",
        # 快照正文：nodes/edges/communities/stats 复用 v1（同一仓库的图），
        # bus_matrix / module_summary / data_model 换 v2 投影。
        f"""
INSERT INTO project_graph_snapshot (
  id, workspace_id, project_id, resource_id, scan_id,
  gitnexus_version, git_sha, nodes, edges, communities, stats,
  module_summary, bus_matrix, data_model, created_at
)
SELECT
  '{SNAPSHOT_ID}'::uuid,
  workspace_id,
  project_id,
  resource_id,
  '{SCAN_ID}',
  'demo-1.1',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  nodes,
  edges,
  communities,
  stats || '{{"table_count": 15}}'::jsonb,
  {json_sql(module_summary())}::jsonb,
  {json_sql(bus_matrix())}::jsonb,
  {json_sql(data_model())}::jsonb,
  '2026-09-14T09:30:00Z'
FROM project_graph_snapshot
WHERE project_id = '{PROJECT_ID}'::uuid AND scan_id = '{V1_SCAN_ID}';
""",
        "INSERT INTO ontology_changelog (workspace_id, snapshot_id, change_type, entity_type, node_id, name, detail, created_at)\nVALUES\n"
        + ",\n".join(
            f"  ('{WORKSPACE_ID}'::uuid, '{SNAPSHOT_ID}'::uuid, {sql_literal(ct)}, {sql_literal(et)}, "
            f"{sql_literal(nid)}, {sql_literal(name)}, {json_sql(detail)}::jsonb, '2026-09-14T09:30:00Z')"
            for ct, et, nid, name, detail in CHANGELOG
        )
        + ";",
        "COMMIT;",
    ]
    return "\n".join(parts)


def main() -> None:
    url = load_database_url()
    sql = build_sql()
    out = Path("/tmp/seed_data_model_v2_demo.sql")
    out.write_text(sql, encoding="utf-8")
    result = subprocess.run(
        ["psql", url, "-v", "ON_ERROR_STOP=1", "-f", str(out)],
        check=False,
        capture_output=True,
        text=True,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    print("seed applied:", out)


if __name__ == "__main__":
    main()
