#!/usr/bin/env python3
"""把「代码本体平台」八个 TAB 的演示数据写入数据库。

不往应用代码里塞 mock。重复执行会按 seed 标记清理后重灌。
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
RESOURCE_ID = "961e1cb4-5fcc-4f37-840d-d3e00075e7b6"
CREATOR_ID = "a321a9c5-47b0-4ca4-948c-1c45d55e296f"
SEED = "ontology-platform-demo"
SCAN_ID = "demo-ontology-platform-v1"
SNAPSHOT_ID = "a11c0de1-0001-4000-8000-000000000001"

# 已有模块 + 新产品模块（graph_node_id = 社区 id）
MODULES = [
    ("b0a887ea-8f69-4e32-967b-030bdf13cb13", "本体对象页", "#f97316", "comm-ontology"),
    ("2172f88a-da22-4691-b34a-d14d73df999d", "图谱浏览页", "#64748b", "comm-graph"),
    ("c0de0001-0001-4000-8000-000000000001", "扫描任务页", "#0ea5e9", "comm-scan"),
    ("c0de0001-0001-4000-8000-000000000002", "抽取配置页", "#8b5cf6", "comm-extract"),
    ("c0de0001-0001-4000-8000-000000000003", "总线矩阵页", "#22c55e", "comm-bus"),
    ("c0de0001-0001-4000-8000-000000000004", "档案浏览页", "#eab308", "comm-archive"),
    ("c0de0001-0001-4000-8000-000000000005", "申报清单页", "#ef4444", "comm-filing"),
]
UNBOUND_MODULE = ("c0de0001-0001-4000-8000-000000000099", "legacy-import", "#94a3b8", None)
ALL_MODULES = [*MODULES, UNBOUND_MODULE]
SUMMARY_COUNTS = {
    "comm-ontology": {"obj": 46, "strategy": 6, "calls_in": 214, "calls_out": 37},
    "comm-graph": {"obj": 38, "strategy": 5, "calls_in": 120, "calls_out": 18},
    "comm-scan": {"obj": 21, "strategy": 3, "calls_in": 64, "calls_out": 11},
    "comm-extract": {"obj": 17, "strategy": 4, "calls_in": 48, "calls_out": 9},
    "comm-bus": {"obj": 24, "strategy": 2, "calls_in": 36, "calls_out": 7},
    "comm-archive": {"obj": 12, "strategy": 2, "calls_in": 28, "calls_out": 5},
    "comm-filing": {"obj": 15, "strategy": 3, "calls_in": 22, "calls_out": 4},
}


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


def graph_payload() -> tuple[list, list, list, list, list]:
    communities = []
    nodes = []
    edges = []
    summaries = []
    bus = []

    page_by_module = {
        "comm-ontology": ("本体对象页", "page-ontology", "ontology"),
        "comm-graph": ("图谱浏览页", "page-graph", "graph"),
        "comm-scan": ("扫描任务页", "page-scan", "pipeline"),
        "comm-extract": ("抽取配置页", "page-extract", "ontology"),
        "comm-bus": ("总线矩阵页", "page-bus", "data"),
        "comm-archive": ("档案浏览页", "page-archive", "archive"),
        "comm-filing": ("申报清单页", "page-filing", "compliance"),
    }
    tables_by_module = {
        "comm-ontology": ["ontology_object", "ontology_link"],
        "comm-graph": ["project_graph_snapshot", "ontology_changelog"],
        "comm-scan": ["scan_job", "scan_file"],
        "comm-extract": ["extract_run", "strategy_pack"],
        "comm-bus": ["bus_matrix_cell", "table_column"],
        "comm-archive": ["project_artifact", "archive_sync_run"],
        "comm-filing": ["filing_item", "filing_check_run"],
    }

    for mid, name, _color, comm in MODULES:
        members = [
            f"fn-{comm}-parse",
            f"fn-{comm}-bridge",
            f"cls-{comm}-service",
            f"route-{comm}-api",
        ]
        communities.append(
            {
                "id": comm,
                "name": name,
                "label": name,
                "node_ids": members,
                "biz_kind": "product",
            }
        )
        nodes.append(
            {
                "id": comm,
                "type": "Community",
                "name": name,
                "qualified_name": f"modules.{comm}",
                "properties": {"module_id": mid},
            }
        )
        kind_map = {
            0: ("Function", "parse"),
            1: ("Function", "bridge"),
            2: ("Class", "Service"),
            3: ("Route", "api"),
        }
        for i, nid in enumerate(members):
            ntype, suffix = kind_map[i]
            nodes.append(
                {
                    "id": nid,
                    "type": ntype,
                    "name": f"{name}{suffix[0].upper()}{suffix[1:]}",
                    "qualified_name": f"src/{comm}/{suffix}.ts#{suffix}",
                    "file_path": f"src/{comm}/{suffix}.ts",
                    "community_id": comm,
                }
            )
            edges.append({"source": nid, "target": comm, "type": "MEMBER_OF"})
        edges.append({"source": members[3], "target": members[0], "type": "HANDLES_ROUTE"})
        edges.append({"source": members[2], "target": members[0], "type": "CALLS"})
        edges.append({"source": members[0], "target": members[1], "type": "CALLS"})
        for table in tables_by_module[comm]:
            edges.append(
                {
                    "source": members[2],
                    "target": f"tbl-{table}",
                    "type": "QUERIES",
                    "properties": {"table": table, "domain": page_by_module[comm][2]},
                }
            )
        nodes.append(
            {
                "id": f"proc-{comm}",
                "type": "Process",
                "name": f"{name}主流程",
                "qualified_name": f"process.{comm}.main",
                "community_id": comm,
            }
        )
        nodes.append(
            {
                "id": f"cmp-{comm}-page",
                "type": "Component",
                "name": f"{name}Page",
                "qualified_name": f"src/{comm}/page.tsx",
                "file_path": f"src/{comm}/page.tsx",
                "community_id": comm,
            }
        )
        nodes.append(
            {
                "id": f"hook-{comm}-use",
                "type": "Hook",
                "name": f"use{name}",
                "qualified_name": f"src/{comm}/use-module.ts",
                "file_path": f"src/{comm}/use-module.ts",
                "community_id": comm,
            }
        )
        edges.append({"source": f"proc-{comm}", "target": comm, "type": "MEMBER_OF"})
        edges.append({"source": f"cmp-{comm}-page", "target": comm, "type": "MEMBER_OF"})
        edges.append({"source": f"hook-{comm}-use", "target": comm, "type": "MEMBER_OF"})
        edges.append({"source": members[0], "target": f"proc-{comm}", "type": "STEP_IN_PROCESS"})
        edges.append({"source": members[1], "target": f"proc-{comm}", "type": "STEP_IN_PROCESS"})
        counts = SUMMARY_COUNTS[comm]
        summaries.append(
            {
                "node_id": comm,
                "name": name,
                "obj_count": counts["obj"],
                "strategy_count": counts["strategy"],
                "edge_stats": {
                    "calls_internal": counts["calls_in"],
                    "calls_external": counts["calls_out"],
                },
                "tables_touched": tables_by_module[comm],
                "biz_kind": "product",
            }
        )
        page_name, page_key, domain = page_by_module[comm]
        bus.append(
            {
                "module_name": name,
                "module_node_id": comm,
                "page_name": page_name,
                "page_key": page_key,
                "domain": domain,
                "table_count": len(tables_by_module[comm]),
                "read_count": 8,
                "write_count": 3 if comm != "comm-filing" else 1,
                "is_new_table": comm == "comm-bus",
                "is_cross_domain_write": comm == "comm-archive",
                "added": 1 if comm == "comm-bus" else 0,
                "modified": 2,
                "removed": 0,
                "tables": [
                    {
                        "name": table,
                        "domain": domain,
                        "read_count": 4,
                        "write_count": 1,
                        "is_new_table": comm == "comm-bus" and i == 0,
                        "columns": [
                            {"name": "id", "type": "uuid", "access": "read"},
                            {"name": "project_id", "type": "uuid", "access": "read"},
                            {"name": "updated_at", "type": "timestamptz", "access": "read_write"},
                        ],
                    }
                    for i, table in enumerate(tables_by_module[comm])
                ],
            }
        )

    # 表节点：邻域 / 总线下钻能指到真实 id
    seen_tables: set[str] = set()
    for comm, tables in tables_by_module.items():
        for table in tables:
            if table in seen_tables:
                continue
            seen_tables.add(table)
            domain = page_by_module[comm][2]
            nodes.append(
                {
                    "id": f"tbl-{table}",
                    "type": "Class",
                    "name": table,
                    "qualified_name": f"public.{table}",
                    "community_id": comm,
                    "properties": {"kind": "table", "domain": domain},
                }
            )
    nodes.append(
        {
            "id": "tbl-legacy_scan_cache",
            "type": "Class",
            "name": "legacy_scan_cache",
            "qualified_name": "public.legacy_scan_cache",
            "properties": {"kind": "table", "domain": "unknown"},
        }
    )
    bus[0]["tables"].append(
        {
            "name": "legacy_scan_cache",
            "domain": "unknown",
            "read_count": 2,
            "write_count": 0,
            "columns": [{"name": "path", "type": "text", "access": "read"}],
        }
    )
    bus[0]["table_count"] = len(bus[0]["tables"])

    # 跨模块调用，给邻域 / 告警更丰满
    edges.append({"source": "fn-comm-extract-bridge", "target": "fn-comm-ontology-parse", "type": "CALLS"})
    edges.append(
        {
            "source": "fn-comm-bus-bridge",
            "target": "cls-comm-graph-service",
            "type": "ACCESSES",
            "properties": {"domain": "graph"},
        }
    )
    edges.append(
        {
            "source": "cls-comm-archive-service",
            "target": "tbl-filing_item",
            "type": "ACCESSES",
            "properties": {"domain": "compliance"},
        }
    )
    edges.append(
        {
            "source": "cls-comm-scan-service",
            "target": "tbl-legacy_scan_cache",
            "type": "QUERIES",
            "properties": {"table": "legacy_scan_cache"},
        }
    )

    # 未绑定社区：出现在绑定选择器，模块 legacy-import 故意不挂 graph_node_id
    communities.append(
        {
            "id": "comm-legacy",
            "name": "legacy-import",
            "label": "legacy-import",
            "node_ids": ["fn-comm-legacy-parse"],
            "biz_kind": "infra",
        }
    )
    nodes.append(
        {
            "id": "comm-legacy",
            "type": "Community",
            "name": "legacy-import",
            "qualified_name": "modules.comm-legacy",
        }
    )
    nodes.append(
        {
            "id": "fn-comm-legacy-parse",
            "type": "Function",
            "name": "legacyParse",
            "qualified_name": "src/legacy/parse.ts#legacyParse",
            "file_path": "src/legacy/parse.ts",
            "community_id": "comm-legacy",
        }
    )
    edges.append({"source": "fn-comm-legacy-parse", "target": "comm-legacy", "type": "MEMBER_OF"})
    summaries.append(
        {
            "node_id": "comm-legacy",
            "name": "legacy-import",
            "obj_count": 23,
            "strategy_count": 0,
            "edge_stats": {"calls_internal": 4, "calls_external": 1},
            "tables_touched": ["legacy_scan_cache"],
            "biz_kind": "infra",
        }
    )

    return nodes, edges, communities, summaries, bus


def build_sql() -> str:
    nodes, edges, communities, summaries, bus = graph_payload()
    stats = {
        "node_count": len(nodes),
        "edge_count": len(edges),
        "community_count": len(communities),
        "table_count": 14,
    }

    parts: list[str] = [
        "BEGIN;",
        f"-- seed={SEED} project={PROJECT_ID}",
        # 清理本脚本上次写入的行（不动用户原有 issue 1-12 / 已同步档案）
        f"DELETE FROM ontology_changelog WHERE snapshot_id = '{SNAPSHOT_ID}'::uuid;",
        f"DELETE FROM ontology_link WHERE snapshot_id = '{SNAPSHOT_ID}'::uuid;",
        f"DELETE FROM ontology_object WHERE snapshot_id = '{SNAPSHOT_ID}'::uuid;",
        f"DELETE FROM project_graph_snapshot WHERE id = '{SNAPSHOT_ID}'::uuid OR (project_id = '{PROJECT_ID}'::uuid AND scan_id = '{SCAN_ID}');",
        f"DELETE FROM project_artifact WHERE project_id = '{PROJECT_ID}'::uuid AND blob_sha LIKE 'demo-seed-%';",
        f"""
DELETE FROM project_artifact
WHERE project_id = '{PROJECT_ID}'::uuid
  AND (
    rel_path LIKE 'requirements/REQ-本体抽取/s3-extract/%'
    OR rel_path = 'requirements/REQ-总线矩阵/deliverables/report.md'
  );
""",
        f"""
DELETE FROM issue
WHERE project_id = '{PROJECT_ID}'::uuid
  AND metadata->>'seed' = '{SEED}'
  AND parent_issue_id IS NOT NULL;
DELETE FROM issue
WHERE project_id = '{PROJECT_ID}'::uuid
  AND metadata->>'seed' = '{SEED}';
""",
        f"""
INSERT INTO project_module (id, project_id, workspace_id, name, color, graph_node_id)
VALUES
{os.linesep.join(
    (
        f"  ('{mid}'::uuid, '{PROJECT_ID}'::uuid, '{WORKSPACE_ID}'::uuid, {sql_literal(name)}, {sql_literal(color)}, "
        + (sql_literal(comm) if comm else "NULL")
        + ")"
        + ("," if i < len(ALL_MODULES) - 1 else "")
    )
    for i, (mid, name, color, comm) in enumerate(ALL_MODULES)
)}
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, color = EXCLUDED.color, graph_node_id = EXCLUDED.graph_node_id;
""",
        f"""
INSERT INTO project_graph_snapshot (
  id, workspace_id, project_id, resource_id, scan_id,
  gitnexus_version, git_sha, nodes, edges, communities, stats, module_summary, bus_matrix
) VALUES (
  '{SNAPSHOT_ID}'::uuid,
  '{WORKSPACE_ID}'::uuid,
  '{PROJECT_ID}'::uuid,
  '{RESOURCE_ID}'::uuid,
  '{SCAN_ID}',
  'demo-1.0',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  {json_sql(nodes)}::jsonb,
  {json_sql(edges)}::jsonb,
  {json_sql(communities)}::jsonb,
  {json_sql(stats)}::jsonb,
  {json_sql(summaries)}::jsonb,
  {json_sql(bus)}::jsonb
);
""",
    ]

    # 本体对象 / 策略 / 变更
    obj_rows = []
    link_rows = []
    change_rows = []
    tables_for_objects = {
        "comm-ontology": ["ontology_object", "ontology_link"],
        "comm-graph": ["project_graph_snapshot"],
        "comm-scan": ["scan_job"],
        "comm-extract": ["extract_run"],
        "comm-bus": ["bus_matrix_cell"],
        "comm-archive": ["project_artifact"],
        "comm-filing": ["filing_item"],
    }
    for _mid, name, _color, comm in MODULES:
        tables = tables_for_objects[comm]
        obj_rows.append(
            f"""(
            '{WORKSPACE_ID}'::uuid, '{PROJECT_ID}'::uuid, '{SNAPSHOT_ID}'::uuid,
            '{comm}', 'biz', {sql_literal(name + "域")},
            {sql_literal("biz." + comm)}, {sql_literal("product")}, 'active', 'ready',
            {json_sql({
                "community_id": comm,
                "kind": "Community",
                "S1": "按社区桥接模块",
                "S2": "对象生命周期可观测",
                "S3": f"{name} 变更进入需求日历",
                "S4": "阶段门与模块锁互斥",
                "S5": "图谱邻域 2 hop 可见",
                "S6": "触达表由 QUERIES 边聚合",
                "S7": "未绑定社区不静默丢弃",
                "S8": "v3 · partition=workspace_id 哈希",
                "S9": "策略来源=ontology 属性展平",
                "S10": "—",
            })}::jsonb
        )"""
        )
        page_short = name.replace("页", "")
        extra_objects = [
            (f"cmp-{comm}-page", "code", f"{page_short}Page", f"{page_short.lower()}-page.tsx", "Component", "implemented", tables),
            (f"hook-{comm}-use", "code", f"use{page_short}", f"use{page_short}.ts", "Hook", "implemented", tables[:1]),
            (f"cls-{comm}-service", "semantic", f"{page_short}Service", f"{page_short}Service.ts", "Class", "accepted", tables),
            (f"route-{comm}-api", "code", f"{name}路由", f"GET /api/{comm.replace('comm-', '')}", "Route", "implemented", tables[:1]),
            (f"fn-{comm}-parse", "code", f"{page_short}Parse", f"src/{comm}/parse.ts", "Function", "implemented", []),
            (f"fn-{comm}-bridge", "code", f"{page_short}Bridge", f"src/{comm}/bridge.ts", "Function", "implemented", []),
        ]
        for nid, etype, label, qname, kind, impl, touched in extra_objects:
            obj_rows.append(
                f"""(
                '{WORKSPACE_ID}'::uuid, '{PROJECT_ID}'::uuid, '{SNAPSHOT_ID}'::uuid,
                '{nid}', '{etype}', {sql_literal(label)},
                {sql_literal(qname)}, {sql_literal("product")}, 'stable', {sql_literal(impl)},
                {json_sql({"community_id": comm, "kind": kind, "tables": touched, "lang": "ts"})}::jsonb
            )"""
            )
        for table in tables:
            obj_rows.append(
                f"""(
                '{WORKSPACE_ID}'::uuid, '{PROJECT_ID}'::uuid, '{SNAPSHOT_ID}'::uuid,
                'tbl-{table}', 'table', {sql_literal(table)},
                {sql_literal("public." + table)}, {sql_literal("data")}, 'active', 'ready',
                {json_sql({"community_id": comm, "kind": "Class", "pk": "id", "tables": [table]})}::jsonb
            )"""
            )
        link_rows.append(
            f"""('{WORKSPACE_ID}'::uuid, '{SNAPSHOT_ID}'::uuid, 'fn-{comm}-parse', '{comm}', 'MEMBER_OF', 1, '{{}}'::jsonb)"""
        )
        link_rows.append(
            f"""('{WORKSPACE_ID}'::uuid, '{SNAPSHOT_ID}'::uuid, 'cls-{comm}-service', 'tbl-{ {
                "comm-ontology": "ontology_object",
                "comm-graph": "project_graph_snapshot",
                "comm-scan": "scan_job",
                "comm-extract": "extract_run",
                "comm-bus": "bus_matrix_cell",
                "comm-archive": "project_artifact",
                "comm-filing": "filing_item",
            }[comm] }', 'QUERIES', 2, '{{}}'::jsonb)"""
        )
        change_rows.append(
            f"""('{WORKSPACE_ID}'::uuid, '{SNAPSHOT_ID}'::uuid, 'modified', 'semantic', '{comm}', {sql_literal(name)}, {json_sql({"note": "演示迭代：补齐对象字段"})}::jsonb)"""
        )
        change_rows.append(
            f"""('{WORKSPACE_ID}'::uuid, '{SNAPSHOT_ID}'::uuid, 'added', 'code', 'fn-{comm}-bridge', {sql_literal(name + "桥接器")}, {json_sql({"note": "新增社区桥接"})}::jsonb)"""
        )

    parts.append(
        f"""
INSERT INTO ontology_object (
  workspace_id, project_id, snapshot_id, node_id, entity_type, name,
  qualified_name, domain, lifecycle, impl_status, properties
) VALUES
{os.linesep.join(f"  {row}{',' if i < len(obj_rows)-1 else ''}" for i, row in enumerate(obj_rows))};
"""
    )
    parts.append(
        f"""
INSERT INTO ontology_link (workspace_id, snapshot_id, source_id, target_id, link_type, weight, properties)
VALUES
{os.linesep.join(f"  {row}{',' if i < len(link_rows)-1 else ''}" for i, row in enumerate(link_rows))};
"""
    )
    parts.append(
        f"""
INSERT INTO ontology_changelog (workspace_id, snapshot_id, change_type, entity_type, node_id, name, detail)
VALUES
{os.linesep.join(f"  {row}{',' if i < len(change_rows)-1 else ''}" for i, row in enumerate(change_rows))};
"""
    )

    # 档案：补四货架 / 需求级 / 交付 / 验收，并给已有文件打模块标签
    parts.append(
        f"""
UPDATE project_artifact
SET doc_module = 'deepseek-harness'
WHERE project_id = '{PROJECT_ID}'::uuid
  AND deleted_at IS NULL
  AND rel_path LIKE '%/deepseek-harness/%'
  AND (doc_module IS NULL OR doc_module = '');

UPDATE project_artifact
SET doc_class = 'prd'
WHERE project_id = '{PROJECT_ID}'::uuid
  AND deleted_at IS NULL
  AND doc_type = 'product-design'
  AND (doc_class IS NULL OR doc_class = '');

UPDATE project_artifact
SET doc_module = COALESCE(NULLIF(doc_module, ''), '图谱')
WHERE project_id = '{PROJECT_ID}'::uuid
  AND deleted_at IS NULL
  AND doc_type = 'architecture'
  AND rel_path LIKE 'overview/architecture/%'
  AND rel_path NOT LIKE '%/spec_infos/%';
"""
    )

    # 需求 × 阶段矩阵：根文档 stage=NULL；s1..s4 对齐 checklist blocking 类型
    demo_docs = [
        ("overview/research/MRD-代码本体立项.md", "research", "mrd", "本体对象", None, None),
        ("overview/research/BRD-知识经营价值.md", "research", "brd", "图谱", None, None),
        ("overview/product-design/PRD-模块桥接.md", "product-design", "prd", "本体抽取", None, None),
        ("overview/architecture/ADR-快照只存指针.md", "architecture", None, "扫描引擎", None, None),
        ("overview/retrospective/RETRO-首轮本体评测.md", "retrospective", None, "申报就绪", None, None),
        ("plans/ROADMAP-Q3.md", "work-plan", "roadmap", "档案同步", None, None),
        ("filing/software_copyright/software_manual.md", "filing-software-copyright", None, "申报就绪", None, None),
        ("demo/unbound-inbox.md", "research", "mrd", "扫描引擎", None, None),
        # REQ-本体抽取：四阶段齐套
        ("requirements/REQ-本体抽取/requirement.md", "requirement", "prd", "本体抽取", "REQ-本体抽取", None),
        ("requirements/REQ-本体抽取/s1-prototype/prototype.html", "prototype", None, "本体抽取", "REQ-本体抽取", 1),
        ("requirements/REQ-本体抽取/s2-plan/plan.md", "plan", None, "本体抽取", "REQ-本体抽取", 2),
        ("requirements/REQ-本体抽取/s2-plan/decomposition.md", "decomposition", None, "本体抽取", "REQ-本体抽取", 2),
        ("requirements/REQ-本体抽取/s3-execution/design.md", "design", None, "本体抽取", "REQ-本体抽取", 3),
        ("requirements/REQ-本体抽取/s3-execution/test-plan.md", "test-plan", None, "本体抽取", "REQ-本体抽取", 3),
        ("requirements/REQ-本体抽取/s3-execution/src/extract-bridge.ts", "design", None, "本体抽取", "REQ-本体抽取", 3),
        ("requirements/REQ-本体抽取/s4-acceptance/acceptance.md", "acceptance", None, "本体抽取", "REQ-本体抽取", 4),
        ("requirements/REQ-本体抽取/s4-acceptance/report-r1.md", "report", None, "本体抽取", "REQ-本体抽取", 4),
        # REQ-总线矩阵：四阶段齐套
        ("requirements/REQ-总线矩阵/requirement.md", "requirement", "prd", "总线矩阵", "REQ-总线矩阵", None),
        ("requirements/REQ-总线矩阵/s1-prototype/prototype.html", "prototype", None, "总线矩阵", "REQ-总线矩阵", 1),
        ("requirements/REQ-总线矩阵/s2-plan/plan.md", "plan", None, "总线矩阵", "REQ-总线矩阵", 2),
        ("requirements/REQ-总线矩阵/s2-plan/decomposition.md", "decomposition", None, "总线矩阵", "REQ-总线矩阵", 2),
        ("requirements/REQ-总线矩阵/s3-execution/design.md", "design", None, "总线矩阵", "REQ-总线矩阵", 3),
        ("requirements/REQ-总线矩阵/s3-execution/test-plan.md", "test-plan", None, "总线矩阵", "REQ-总线矩阵", 3),
        ("requirements/REQ-总线矩阵/s4-acceptance/acceptance.md", "acceptance", None, "总线矩阵", "REQ-总线矩阵", 4),
        ("requirements/REQ-总线矩阵/s4-acceptance/report-r1.md", "report", None, "总线矩阵", "REQ-总线矩阵", 4),
        # REQ-图谱邻域：缺 S4，矩阵显示部分就绪
        ("requirements/REQ-图谱邻域/requirement.md", "requirement", "prd", "图谱", "REQ-图谱邻域", None),
        ("requirements/REQ-图谱邻域/s1-prototype/prototype.html", "prototype", None, "图谱浏览页", "REQ-图谱邻域", 1),
        ("requirements/REQ-图谱邻域/s1-prototype/prototype-v2.html", "prototype", None, "图谱浏览页", "REQ-图谱邻域", 1),
        ("requirements/REQ-图谱邻域/s1-prototype/prototype-v3.html", "prototype", None, "图谱浏览页", "REQ-图谱邻域", 1),
        ("requirements/REQ-图谱邻域/s2-plan/plan.md", "plan", None, "图谱", "REQ-图谱邻域", 2),
        ("requirements/REQ-图谱邻域/s2-plan/decomposition.md", "decomposition", None, "图谱", "REQ-图谱邻域", 2),
        ("requirements/REQ-图谱邻域/s3-execution/design.md", "design", None, "图谱", "REQ-图谱邻域", 3),
        # REQ-扫描增量：仅根文档，缺件行
        ("requirements/REQ-扫描增量/requirement.md", "requirement", "prd", "扫描引擎", "REQ-扫描增量", None),
    ]
    artifact_values = []
    for rel, doc_type, doc_class, module, req_key, stage in demo_docs:
        stage_sql = "NULL" if stage is None else str(stage)
        class_sql = "NULL" if doc_class is None else sql_literal(doc_class)
        scope = "requirement" if rel.startswith("requirements/") else "project"
        sha = "demo-seed-" + rel.replace("/", "-")[:40]
        key_sql = sql_literal(req_key) if req_key else "NULL"
        artifact_values.append(
            f"""(
            '{WORKSPACE_ID}'::uuid, '{PROJECT_ID}'::uuid, '{RESOURCE_ID}'::uuid,
            {sql_literal(scope)}, {stage_sql}, {sql_literal(doc_type)}, 1,
            {sql_literal(rel)}, {key_sql},
            {class_sql}, {sql_literal(module)},
            {sql_literal(sha)}, NULL, 2048, 'manual'
        )"""
        )
    parts.append(
        f"""
INSERT INTO project_artifact (
  workspace_id, project_id, resource_id, scope, stage, doc_type, version,
  rel_path, requirement_key, doc_class, doc_module, blob_sha, attachment_id, size_bytes, source
) VALUES
{os.linesep.join(f"  {row}{',' if i < len(artifact_values)-1 else ''}" for i, row in enumerate(artifact_values))}
ON CONFLICT (resource_id, rel_path, version) DO UPDATE
SET doc_type = EXCLUDED.doc_type,
    doc_class = EXCLUDED.doc_class,
    doc_module = EXCLUDED.doc_module,
    scope = EXCLUDED.scope,
    stage = EXCLUDED.stage,
    requirement_key = EXCLUDED.requirement_key,
    source = EXCLUDED.source,
    deleted_at = NULL,
    updated_at = now();
"""
    )

    # 需求 / 任务：覆盖各派生状态，并挂到模块
    parts.append(
        f"""
-- 补齐已有顶层需求的日历字段与模块，让需求管理 / 验收 TAB 能分桶
UPDATE issue SET
  start_at = COALESCE(start_at, now() - interval '14 days'),
  goal = COALESCE(NULLIF(goal, ''), title),
  repo_resource_id = '{RESOURCE_ID}'::uuid,
  decompose_mode = 'confirm',
  module_id = CASE number
    WHEN 1 THEN 'b0a887ea-8f69-4e32-967b-030bdf13cb13'::uuid
    WHEN 2 THEN 'c0de0001-0001-4000-8000-000000000003'::uuid
    WHEN 9 THEN 'b0a887ea-8f69-4e32-967b-030bdf13cb13'::uuid
    ELSE module_id
  END,
  feature_points = CASE WHEN feature_points = '[]'::jsonb THEN {json_sql([
      {"title": "盘点功能点", "kind": "modify", "code_objects": ["ProjectScanner"], "detail": "按社区输出模块清单"}
  ])}::jsonb ELSE feature_points END,
  graph_context = CASE WHEN graph_context = '{{}}'::jsonb THEN {json_sql({
      "nodes": ["comm-ontology", "comm-graph"],
      "code_objects": ["ExtractVisitor"],
      "dependencies": ["LadybugDB"],
      "impacts": ["总线矩阵"],
  })}::jsonb ELSE graph_context END,
  acceptance_spec = CASE WHEN acceptance_spec = '{{}}'::jsonb THEN {json_sql({
      "path": "requirements/acceptance.md",
      "version": "v1",
      "assertions": ["模块列表可桥接社区", "对象子 TAB 非空", "总线矩阵可下钻"],
      "cases": ["打开功能模块 TAB", "切换数据模型 TAB"],
      "evidence": ["demo scan " + SCAN_ID],
      "coverage": ["f10", "f11"],
      "graph": ["comm-ontology"],
  })}::jsonb ELSE acceptance_spec END
WHERE project_id = '{PROJECT_ID}'::uuid AND parent_issue_id IS NULL;

UPDATE issue SET
  module_id = COALESCE(module_id, (
    SELECT module_id FROM issue p WHERE p.id = issue.parent_issue_id
  )),
  acceptance_spec = CASE
    WHEN stage = 4 AND acceptance_spec = '{{}}'::jsonb THEN {json_sql({
        "path": "requirements/s4-acceptance/acceptance.md",
        "version": "v1",
        "assertions": ["验收用例可回放", "证据路径可打开"],
        "cases": ["回归模块桥接"],
        "evidence": ["agent run log"],
    })}::jsonb
    ELSE acceptance_spec
  END
WHERE project_id = '{PROJECT_ID}'::uuid AND parent_issue_id IS NOT NULL;
"""
    )

    # 新需求：未拆解 / 拆解待确认 / 待触发 / 执行中 / 验收中 / 验收失败
    req_defs = [
        ("未拆解：扫描增量策略", "todo", "c0de0001-0001-4000-8000-000000000001", "pending_decomp", None),
        ("拆解待确认：档案四货架映射", "todo", "c0de0001-0001-4000-8000-000000000004", "confirm_decomp", None),
        ("待触发：申报材料自动齐套", "todo", "c0de0001-0001-4000-8000-000000000005", "waiting_trigger", None),
        ("执行中：图谱邻域下钻", "in_progress", "2172f88a-da22-4691-b34a-d14d73df999d", "running", None),
        ("验收中：总线矩阵告警规则", "in_progress", "c0de0001-0001-4000-8000-000000000003", "accepting", 1),
        ("验收失败：抽取策略热更新", "in_progress", "c0de0001-0001-4000-8000-000000000002", "accept_fail", 4),
        ("独立任务：补齐模块色板", "todo", "c0de0001-0001-4000-8000-000000000004", "plain_task", None),
        ("独立任务：同步控制台空态走查", "in_progress", "c0de0001-0001-4000-8000-000000000004", "plain_task", None),
        ("独立任务：申报导出诊断包", "in_review", "c0de0001-0001-4000-8000-000000000005", "plain_task", None),
    ]

    parts.append(
        f"""
WITH numbered AS (
  SELECT '{WORKSPACE_ID}'::uuid AS workspace_id,
         GREATEST(
           (SELECT issue_counter FROM workspace WHERE id = '{WORKSPACE_ID}'::uuid),
           (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = '{WORKSPACE_ID}'::uuid)
         ) AS base
)
UPDATE workspace w
SET issue_counter = (SELECT base FROM numbered) + {len(req_defs) + 60}
WHERE w.id = '{WORKSPACE_ID}'::uuid;
"""
    )

    # Use a temp table of new issues created in a DO block for numbering
    parts.append(
        f"""
DO $$
DECLARE
  ws uuid := '{WORKSPACE_ID}'::uuid;
  proj uuid := '{PROJECT_ID}'::uuid;
  creator uuid := '{CREATOR_ID}'::uuid;
  resource uuid := '{RESOURCE_ID}'::uuid;
  n int;
  root uuid;
  child uuid;
  rec record;
BEGIN
  SELECT GREATEST(issue_counter, (SELECT COALESCE(MAX(number),0) FROM issue WHERE workspace_id = ws))
    INTO n FROM workspace WHERE id = ws;

  -- 原型待确认：有未完成 stage1
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, start_at, goal, repo_resource_id, decompose_mode, auto_trigger,
    module_id, metadata, feature_points)
  VALUES (ws, '原型待确认：模块对象抽屉', '验证功能模块对象 / 策略子 TAB。', 'todo', 'high', 'member', creator,
    n, n, proj, now(), '对象列表与策略键值可见', resource, 'confirm', false,
    'b0a887ea-8f69-4e32-967b-030bdf13cb13', jsonb_build_object('seed', '{SEED}'),
    {json_sql([{"title": "对象抽屉", "kind": "new", "detail": "社区成员可点开"}])}::jsonb)
  RETURNING id INTO root;
  UPDATE issue SET root_requirement_id = id WHERE id = root;
  n := n + 1;
  INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number,
    project_id, parent_issue_id, stage, module_id, metadata)
  VALUES (ws, '原型：模块对象抽屉', 'todo', 'none', 'member', creator, n, n,
    proj, root, 1, 'b0a887ea-8f69-4e32-967b-030bdf13cb13', jsonb_build_object('seed', '{SEED}'));

  -- 未拆解
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, start_at, goal, repo_resource_id, decompose_mode, auto_trigger,
    module_id, metadata, feature_points, graph_context)
  VALUES (ws, '未拆解：扫描增量策略', '只扫变更文件，验证扫描引擎 TAB。', 'todo', 'high', 'member', creator,
    n, n, proj, now() + interval '1 day', '给出增量扫描方案', resource, 'confirm', false,
    'c0de0001-0001-4000-8000-000000000001', jsonb_build_object('seed', '{SEED}'),
    {json_sql([{"title": "增量扫描", "kind": "new", "detail": "按 git sha 差量"}])}::jsonb,
    {json_sql({"nodes": ["comm-scan"]})}::jsonb);

  -- 拆解待确认：有 stage2 子任务但未确认
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, start_at, goal, repo_resource_id, decompose_mode, auto_trigger,
    module_id, metadata)
  VALUES (ws, '拆解待确认：档案四货架映射', '验证项目档案货架与模块标签。', 'todo', 'medium', 'member', creator,
    n, n, proj, now(), '四货架均可拖拽归类', resource, 'confirm', false,
    'c0de0001-0001-4000-8000-000000000004', jsonb_build_object('seed', '{SEED}'))
  RETURNING id INTO root;
  UPDATE issue SET root_requirement_id = id WHERE id = root;
  n := n + 1;
  INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number,
    project_id, parent_issue_id, stage, module_id, metadata)
  VALUES (ws, 'PM plan + 拆解：档案四货架映射', 'todo', 'none', 'member', creator, n, n,
    proj, root, 2, 'c0de0001-0001-4000-8000-000000000004', jsonb_build_object('seed', '{SEED}'));

  -- 待触发
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, start_at, goal, repo_resource_id, decompose_mode, auto_trigger,
    decomposition_confirmed_at, module_id, metadata)
  VALUES (ws, '待触发：申报材料自动齐套', '验证申报 TAB 必备件状态。', 'todo', 'urgent', 'member', creator,
    n, n, proj, now() + interval '2 days', '软著三项必备件变 ready', resource, 'confirm', true,
    now(), 'c0de0001-0001-4000-8000-000000000005', jsonb_build_object('seed', '{SEED}'))
  RETURNING id INTO root;
  UPDATE issue SET root_requirement_id = id WHERE id = root;

  -- 执行中：stage3 未完成
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, start_at, goal, repo_resource_id, decompose_mode, auto_trigger,
    decomposition_confirmed_at, triggered_at, module_id, metadata, acceptance_round)
  VALUES (ws, '执行中：图谱邻域下钻', '验证功能模块邻域子 TAB。', 'in_progress', 'high', 'member', creator,
    n, n, proj, now() - interval '2 days', '邻域 1 hop 可见社区成员', resource, 'confirm', true,
    now() - interval '2 days', now() - interval '1 day',
    '2172f88a-da22-4691-b34a-d14d73df999d', jsonb_build_object('seed', '{SEED}'), 0)
  RETURNING id INTO root;
  UPDATE issue SET root_requirement_id = id WHERE id = root;
  n := n + 1;
  INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number,
    project_id, parent_issue_id, stage, module_id, metadata)
  VALUES (ws, '实现邻域 BFS', 'todo', 'none', 'member', creator, n, n,
    proj, root, 3, '2172f88a-da22-4691-b34a-d14d73df999d', jsonb_build_object('seed', '{SEED}'));
  n := n + 1;
  INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number,
    project_id, parent_issue_id, stage, module_id, metadata)
  VALUES (ws, '补齐社区 MEMBER_OF 边', 'done', 'none', 'member', creator, n, n,
    proj, root, 3, '2172f88a-da22-4691-b34a-d14d73df999d', jsonb_build_object('seed', '{SEED}'));

  -- 验收中：stage4 未完成
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, start_at, goal, repo_resource_id, decompose_mode, auto_trigger,
    decomposition_confirmed_at, triggered_at, module_id, metadata, acceptance_round, acceptance_spec)
  VALUES (ws, '验收中：总线矩阵告警规则', '验证数据模型告警与下钻。', 'in_progress', 'medium', 'member', creator,
    n, n, proj, now() - interval '5 days', '跨域写告警可见', resource, 'confirm', true,
    now() - interval '5 days', now() - interval '4 days',
    'c0de0001-0001-4000-8000-000000000003', jsonb_build_object('seed', '{SEED}'), 1,
    {json_sql({
        "path": "requirements/REQ-总线矩阵/s4-acceptance/acceptance.md",
        "version": "v2",
        "assertions": ["跨域写格子高亮", "孤儿表告警可展开", "下钻列出列"],
        "cases": ["打开数据模型 TAB", "点选总线矩阵格子"],
        "evidence": ["bus_matrix demo cells"],
        "coverage": ["f11 alerts", "f11 drilldown"],
    })}::jsonb)
  RETURNING id INTO root;
  UPDATE issue SET root_requirement_id = id WHERE id = root;
  n := n + 1;
  INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number,
    project_id, parent_issue_id, stage, module_id, metadata)
  VALUES (ws, '实现跨域写检测', 'done', 'none', 'member', creator, n, n,
    proj, root, 3, 'c0de0001-0001-4000-8000-000000000003', jsonb_build_object('seed', '{SEED}'));
  n := n + 1;
  INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number,
    project_id, parent_issue_id, stage, module_id, metadata, acceptance_spec)
  VALUES (ws, '验收：总线矩阵告警规则', 'todo', 'none', 'member', creator, n, n,
    proj, root, 4, 'c0de0001-0001-4000-8000-000000000003', jsonb_build_object('seed', '{SEED}'),
    {json_sql({
        "path": "requirements/REQ-总线矩阵/s4-acceptance/acceptance.md",
        "version": "v2",
        "assertions": ["跨域写格子高亮", "下钻列出列"],
        "cases": ["点选 comm-archive 格子"],
    })}::jsonb);

  -- 验收失败：acceptance_round > 3
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, start_at, goal, repo_resource_id, decompose_mode, auto_trigger,
    decomposition_confirmed_at, triggered_at, module_id, metadata, acceptance_round, acceptance_spec)
  VALUES (ws, '验收失败：抽取策略热更新', '验证验收失败分桶与回流。', 'in_progress', 'high', 'member', creator,
    n, n, proj, now() - interval '10 days', '策略包不重启生效', resource, 'confirm', true,
    now() - interval '10 days', now() - interval '9 days',
    'c0de0001-0001-4000-8000-000000000002', jsonb_build_object('seed', '{SEED}'), 4,
    {json_sql({
        "path": "requirements/s4-acceptance/extract.md",
        "version": "v3",
        "assertions": ["热更新后对象列表刷新", "旧策略不再命中"],
        "cases": ["替换 strategy pack", "重跑抽取"],
        "evidence": ["round 4 failed"],
    })}::jsonb)
  RETURNING id INTO root;
  UPDATE issue SET root_requirement_id = id WHERE id = root;
  n := n + 1;
  INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number,
    project_id, parent_issue_id, stage, module_id, metadata, acceptance_spec)
  VALUES (ws, '验收：抽取策略热更新', 'todo', 'none', 'member', creator, n, n,
    proj, root, 4, 'c0de0001-0001-4000-8000-000000000002', jsonb_build_object('seed', '{SEED}'),
    {json_sql({
        "assertions": ["热更新后对象列表刷新"],
        "cases": ["替换 strategy pack"],
    })}::jsonb);

  -- 独立任务（任务追踪，非顶层需求：无 start_at / repo / 拆解）
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, module_id, metadata, auto_trigger)
  VALUES (ws, '独立任务：补齐模块色板', '任务追踪列表用。', 'todo', 'low', 'member', creator,
    n, n, proj, 'c0de0001-0001-4000-8000-000000000004', jsonb_build_object('seed', '{SEED}'), false);
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, module_id, metadata, auto_trigger)
  VALUES (ws, '独立任务：同步控制台空态走查', '任务追踪进行中。', 'in_progress', 'medium', 'member', creator,
    n, n, proj, 'c0de0001-0001-4000-8000-000000000004', jsonb_build_object('seed', '{SEED}'), false);
  n := n + 1;
  INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id,
    position, number, project_id, module_id, metadata, auto_trigger)
  VALUES (ws, '独立任务：申报导出诊断包', '任务追踪评审中。', 'in_review', 'medium', 'member', creator,
    n, n, proj, 'c0de0001-0001-4000-8000-000000000005', jsonb_build_object('seed', '{SEED}'), false);

  UPDATE issue SET root_requirement_id = COALESCE(root_requirement_id, id)
  WHERE project_id = proj AND root_requirement_id IS NULL;

  -- 把演示需求级档案绑到对应需求
  UPDATE project_artifact a
  SET issue_id = i.id,
      requirement_key = 'REQ-' || i.number
  FROM issue i
  WHERE a.project_id = proj
    AND a.rel_path LIKE 'requirements/%'
    AND i.project_id = proj
    AND i.parent_issue_id IS NULL
    AND i.metadata->>'seed' = '{SEED}'
    AND (
      (a.rel_path LIKE '%REQ-本体抽取%' AND i.title LIKE '%抽取策略%')
      OR (a.rel_path LIKE '%REQ-总线矩阵%' AND i.title LIKE '%总线矩阵%')
      OR (a.rel_path LIKE '%REQ-图谱邻域%' AND i.title LIKE '%图谱邻域%')
      OR (a.rel_path LIKE '%REQ-扫描增量%' AND i.title LIKE '%扫描增量%')
    );

  -- 把已同步的原型 / 部分架构文档挂到存量需求，交付物 TAB 不再全是未绑定
  UPDATE project_artifact
  SET issue_id = (SELECT id FROM issue WHERE project_id = proj AND number = 1),
      requirement_key = 'REQ-1'
  WHERE project_id = proj AND deleted_at IS NULL
    AND rel_path IN (
      'overview/architecture/00-总览与能力架构图.md',
      'overview/architecture/03-数据模型.md',
      'change_logs/docs/prototypes/pseudocode-split-view.html'
    );

  UPDATE project_artifact
  SET issue_id = (SELECT id FROM issue WHERE project_id = proj AND number = 2),
      requirement_key = 'REQ-2'
  WHERE project_id = proj AND deleted_at IS NULL
    AND rel_path IN (
      'overview/architecture/spec_infos/product-improvements/3-opc-agents/09-product-data-model-design.md',
      'overview/research/01-可行性评估报告.md'
    );

  UPDATE project_artifact
  SET issue_id = (SELECT id FROM issue WHERE project_id = proj AND number = 9),
      requirement_key = 'REQ-9'
  WHERE project_id = proj AND deleted_at IS NULL
    AND rel_path IN (
      'overview/research/dsh_desktop-市场与商业可行性调研报告.md',
      'change_logs/docs/prototypes/pseudocode-view-v2.html'
    );

  -- 每个已绑定模块补进度条子任务；blocked 只给部分模块，健康点才有绿/蓝/黄分层
  FOR rec IN
    SELECT id, graph_node_id FROM project_module
    WHERE project_id = proj AND graph_node_id IS NOT NULL
  LOOP
    n := n + 1;
    INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id,
      position, number, project_id, module_id, metadata)
    VALUES (ws, '演示任务：已完成切片', 'done', 'none', 'member', creator,
      n, n, proj, rec.id, jsonb_build_object('seed', '{SEED}'));
    n := n + 1;
    INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id,
      position, number, project_id, module_id, metadata)
    VALUES (ws, '演示任务：待办回归', 'todo', 'none', 'member', creator,
      n, n, proj, rec.id, jsonb_build_object('seed', '{SEED}'));
    IF rec.graph_node_id IN ('comm-graph', 'comm-extract', 'comm-bus', 'comm-filing') THEN
      n := n + 1;
      INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id,
        position, number, project_id, module_id, metadata)
      VALUES (ws, '演示任务：进行中联调', 'in_progress', 'none', 'member', creator,
        n, n, proj, rec.id, jsonb_build_object('seed', '{SEED}'));
    END IF;
    IF rec.graph_node_id IN ('comm-scan', 'comm-archive') THEN
      n := n + 1;
      INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id,
        position, number, project_id, module_id, metadata)
      VALUES (ws, '演示任务：阻塞依赖', 'blocked', 'none', 'member', creator,
        n, n, proj, rec.id, jsonb_build_object('seed', '{SEED}'));
    END IF;
  END LOOP;

  UPDATE workspace SET issue_counter = n WHERE id = ws;
END $$;
"""
    )

    # 申报：把必备件标成 ready/partial，并挂档案 + 检查运行
    parts.append(
        f"""
UPDATE filing_item SET
  status = CASE item_key
    WHEN 'software_manual' THEN 'ready'
    WHEN 'source_code' THEN 'partial'
    WHEN 'test_report' THEN 'ready'
    WHEN 'tech_disclosure' THEN 'ready'
    WHEN 'claims_draft' THEN 'partial'
    WHEN 'spec_drawings' THEN 'missing'
    ELSE status
  END,
  blocking = CASE
    WHEN item_key IN ('spec_drawings') THEN TRUE
    WHEN item_key IN ('source_code', 'claims_draft') THEN FALSE
    ELSE blocking
  END,
  source_path = CASE item_key
    WHEN 'software_manual' THEN 'filing/software_copyright/software_manual.md'
    ELSE source_path
  END,
  artifact_id = CASE item_key
    WHEN 'software_manual' THEN (
      SELECT id FROM project_artifact
      WHERE project_id = '{PROJECT_ID}'::uuid
        AND rel_path = 'filing/software_copyright/software_manual.md'
      LIMIT 1
    )
    ELSE artifact_id
  END,
  rule_result = jsonb_build_object(
    'seed', '{SEED}',
    'checked', TRUE,
    'note', '演示数据：' || item_name
  ),
  checked_at = now(),
  updated_at = now()
WHERE project_id = '{PROJECT_ID}'::uuid;

INSERT INTO filing_check_run (workspace_id, filing_item_id, check_type, page_count, lines_per_page, header_consistency, detail, verdict)
SELECT '{WORKSPACE_ID}'::uuid, id, 'page_layout', 32, 50, TRUE,
       jsonb_build_object('seed', '{SEED}', 'note', '版式检查通过'),
       CASE WHEN status = 'ready' THEN 'pass' WHEN status = 'partial' THEN 'warning' ELSE 'fail' END
FROM filing_item
WHERE project_id = '{PROJECT_ID}'::uuid
  AND NOT EXISTS (
    SELECT 1 FROM filing_check_run r WHERE r.filing_item_id = filing_item.id AND r.detail->>'seed' = '{SEED}'
  );
"""
    )

    # 把存量档案打上模块标签、绑到需求，任务/甘特才有日期，申报清单不再大片 missing
    extra_filing_docs = [
        ("filing/software_copyright/source_code_excerpt.md", "filing-software-copyright", "扫描引擎", "source_code", "partial"),
        ("filing/software_copyright/test_report.md", "filing-software-copyright", "申报就绪", "test_report", "ready"),
        ("filing/software_copyright/requirement_spec.md", "filing-software-copyright", "本体对象", "requirement_spec", "partial"),
        ("filing/software_copyright/design_doc.md", "filing-software-copyright", "图谱", "design_doc", "partial"),
        ("filing/software_copyright/code_stats.md", "filing-software-copyright", "本体抽取", "code_stats_report", "ready"),
        ("filing/patent/tech_disclosure.md", "filing-patent", "总线矩阵", "tech_disclosure", "ready"),
        ("filing/patent/claims_draft.md", "filing-patent", "总线矩阵", "claims_draft", "partial"),
        ("filing/patent/spec_drawings.md", "filing-patent", "图谱", "spec_drawings", "partial"),
        ("filing/patent/search_report.md", "filing-patent", "本体对象", "search_report", "ready"),
        ("filing/patent/prototype_final.html", "filing-patent", "档案同步", "prototype_final", "ready"),
        ("filing/patent/originality.md", "filing-patent", "申报就绪", "originality_statement", "partial"),
    ]
    extra_values = []
    for rel, doc_type, module, _key, _status in extra_filing_docs:
        sha = "demo-seed-" + rel.replace("/", "-")[:40]
        extra_values.append(
            f"""(
            '{WORKSPACE_ID}'::uuid, '{PROJECT_ID}'::uuid, '{RESOURCE_ID}'::uuid,
            'project', NULL, {sql_literal(doc_type)}, 1,
            {sql_literal(rel)}, NULL, NULL, {sql_literal(module)},
            {sql_literal(sha)}, NULL, 1024, 'manual'
        )"""
        )
    parts.append(
        f"""
INSERT INTO project_artifact (
  workspace_id, project_id, resource_id, scope, stage, doc_type, version,
  rel_path, requirement_key, doc_class, doc_module, blob_sha, attachment_id, size_bytes, source
) VALUES
{os.linesep.join(f"  {row}{',' if i < len(extra_values)-1 else ''}" for i, row in enumerate(extra_values))}
ON CONFLICT (resource_id, rel_path, version) DO UPDATE
SET doc_type = EXCLUDED.doc_type,
    doc_module = EXCLUDED.doc_module,
    source = EXCLUDED.source,
    deleted_at = NULL,
    updated_at = now();

UPDATE project_artifact
SET doc_module = CASE
  WHEN rel_path LIKE '%/deepseek-harness/%' THEN 'deepseek-harness'
  WHEN rel_path LIKE '%/product-improvements/1-dsh-desktop-tauri/%' THEN '扫描引擎'
  WHEN rel_path LIKE '%/product-improvements/2-nocobase/%' THEN '档案同步'
  WHEN rel_path LIKE '%/product-improvements/3-opc-agents/%' THEN '总线矩阵'
  WHEN rel_path LIKE 'overview/product-design/%' THEN '本体对象'
  WHEN rel_path LIKE 'overview/architecture/%' THEN '图谱'
  WHEN rel_path LIKE 'overview/research/%' THEN '本体对象'
  WHEN rel_path LIKE 'change_logs/%' THEN '本体抽取'
  WHEN rel_path LIKE 'filing/%' THEN COALESCE(NULLIF(doc_module, ''), '申报就绪')
  ELSE doc_module
END
WHERE project_id = '{PROJECT_ID}'::uuid
  AND deleted_at IS NULL
  AND (doc_module IS NULL OR doc_module = '');

UPDATE project_artifact a
SET issue_id = i.id,
    requirement_key = COALESCE(NULLIF(a.requirement_key, ''), 'REQ-' || i.number)
FROM issue i
WHERE a.project_id = '{PROJECT_ID}'::uuid
  AND a.deleted_at IS NULL
  AND a.issue_id IS NULL
  AND i.project_id = '{PROJECT_ID}'::uuid
  AND i.parent_issue_id IS NULL
  AND (
    (a.rel_path LIKE 'overview/product-design/%' AND i.number = 1)
    OR (a.rel_path LIKE 'overview/research/%' AND i.number = 1)
    OR (a.rel_path LIKE '%/product-improvements/3-opc-agents/%' AND i.number = 2)
    OR (a.rel_path LIKE 'overview/architecture/%'
        AND a.rel_path NOT LIKE '%/product-improvements/%'
        AND i.number = 9)
    OR (a.rel_path LIKE '%/product-improvements/1-dsh-desktop-tauri/%' AND i.title LIKE '%扫描增量%')
    OR (a.rel_path LIKE '%/product-improvements/2-nocobase/%' AND i.title LIKE '%四货架%')
    OR (a.rel_path LIKE 'change_logs/%' AND i.title LIKE '%抽取策略%')
    OR (a.rel_path LIKE 'filing/%' AND i.title LIKE '%申报材料%')
  );

UPDATE issue SET
  start_date = COALESCE(start_date, (now() - interval '10 days')::date),
  due_date = COALESCE(due_date, (now() + interval '12 days')::date),
  assignee_type = CASE WHEN assignee_id IS NULL THEN 'member' ELSE assignee_type END,
  assignee_id = COALESCE(assignee_id, '{CREATOR_ID}'::uuid)
WHERE project_id = '{PROJECT_ID}'::uuid
  AND parent_issue_id IS NULL;

UPDATE issue SET
  start_date = COALESCE(start_date, (now() - interval '6 days')::date),
  due_date = COALESCE(due_date, (now() + interval '8 days')::date)
WHERE project_id = '{PROJECT_ID}'::uuid
  AND parent_issue_id IS NOT NULL;

UPDATE project SET
  start_date = COALESCE(start_date, DATE '2026-08-01'),
  due_date = COALESCE(due_date, DATE '2026-10-15')
WHERE id = '{PROJECT_ID}'::uuid;

UPDATE filing_item fi
SET
  status = x.status,
  blocking = CASE WHEN x.status = 'missing' THEN fi.blocking ELSE FALSE END,
  source_path = x.rel_path,
  artifact_id = (
    SELECT id FROM project_artifact
    WHERE project_id = '{PROJECT_ID}'::uuid AND rel_path = x.rel_path
    LIMIT 1
  ),
  rule_result = jsonb_build_object('seed', '{SEED}', 'checked', TRUE, 'note', '演示数据：' || fi.item_name),
  checked_at = now(),
  updated_at = now()
FROM (VALUES
  ('source_code', 'partial', 'filing/software_copyright/source_code_excerpt.md'),
  ('software_manual', 'ready', 'filing/software_copyright/software_manual.md'),
  ('test_report', 'ready', 'filing/software_copyright/test_report.md'),
  ('requirement_spec', 'partial', 'filing/software_copyright/requirement_spec.md'),
  ('design_doc', 'partial', 'filing/software_copyright/design_doc.md'),
  ('code_stats_report', 'ready', 'filing/software_copyright/code_stats.md'),
  ('tech_disclosure', 'ready', 'filing/patent/tech_disclosure.md'),
  ('claims_draft', 'partial', 'filing/patent/claims_draft.md'),
  ('spec_drawings', 'partial', 'filing/patent/spec_drawings.md'),
  ('search_report', 'ready', 'filing/patent/search_report.md'),
  ('prototype_final', 'ready', 'filing/patent/prototype_final.html'),
  ('originality_statement', 'partial', 'filing/patent/originality.md')
) AS x(item_key, status, rel_path)
WHERE fi.project_id = '{PROJECT_ID}'::uuid
  AND fi.item_key = x.item_key;
"""
    )

    parts.append(
        f"""
DELETE FROM issue_prototype_version ipv
USING issue i
WHERE ipv.issue_id = i.id
  AND i.project_id = '{PROJECT_ID}'::uuid
  AND (
    i.metadata->>'seed' = '{SEED}'
    OR ipv.html_path LIKE 'requirements/REQ-%/s1-prototype/%'
  );

INSERT INTO issue_prototype_version (
  issue_id, workspace_id, version, html_path, prompt, marks, status, created_by_type, created_by_id
)
SELECT i.id, '{WORKSPACE_ID}'::uuid, v.version, v.path, v.prompt, '[]'::jsonb, v.status, 'member', '{CREATOR_ID}'::uuid
FROM issue i
JOIN (VALUES
  (1, 'requirements/REQ-图谱邻域/s1-prototype/prototype.html', 'v1 初版', 'superseded'),
  (2, 'requirements/REQ-图谱邻域/s1-prototype/prototype-v2.html', 'v2 修正邻域下钻', 'superseded'),
  (3, 'requirements/REQ-图谱邻域/s1-prototype/prototype-v3.html', 'v3 confirmed 当前', 'confirmed')
) AS v(version, path, prompt, status) ON TRUE
WHERE i.project_id = '{PROJECT_ID}'::uuid
  AND i.parent_issue_id IS NULL
  AND i.title LIKE '%图谱邻域%';
"""
    )

    parts.append("COMMIT;")
    return "\n".join(parts)


ARCHIVE_ROOT = Path(
    "/Users/eleme/Documents/workspace/ai_workspace/github/ai_code/GitNexus-main"
)

DEMO_FILE_BODIES = {
    "overview/research/MRD-代码本体立项.md": """---
doc_type: research
doc_class: mrd
doc_module: 本体对象
---

# MRD · 代码本体立项

演示文档：项目档案「调研」货架 + MRD 分类。用于验证矩阵、模块标签与预览。
""",
    "overview/research/BRD-知识经营价值.md": """---
doc_type: research
doc_class: brd
doc_module: 图谱
---

# BRD · 知识经营价值

演示文档：图谱模块的商业需求，挂在调研货架。
""",
    "overview/product-design/PRD-模块桥接.md": """---
doc_type: product-design
doc_class: prd
doc_module: 本体抽取
---

# PRD · 模块桥接

`project_module.graph_node_id` 对齐社区 id，功能模块 TAB 才能打开对象 / 策略 / 邻域。
""",
    "overview/architecture/ADR-快照只存指针.md": """---
doc_type: architecture
doc_module: 扫描引擎
---

# ADR · 快照只存指针

图谱快照由 CLI 预聚合写入 `project_graph_snapshot`，服务端不重算图。
""",
    "overview/retrospective/RETRO-首轮本体评测.md": """---
doc_type: retrospective
doc_module: 申报就绪
---

# 复盘 · 首轮本体评测

演示文档：补齐档案「复盘」货架，避免该栏空态。
""",
    "plans/ROADMAP-Q3.md": """---
doc_type: work-plan
doc_class: roadmap
doc_module: 档案同步
---

# Roadmap Q3

档案四货架、总线矩阵、申报齐套。
""",
    "requirements/REQ-本体抽取/requirement.md": "---\ndoc_type: requirement\nrequirement_key: REQ-本体抽取\n---\n\n# 需求：本体抽取\n\n覆盖对象列表、策略展平、社区桥接。\n",
    "requirements/REQ-本体抽取/s1-prototype/prototype.html": "<!doctype html><html><body><h1>模块对象抽屉原型</h1></body></html>\n",
    "requirements/REQ-本体抽取/s2-plan/plan.md": "# 计划：本体抽取\n\nS2 拆解确认门。\n",
    "requirements/REQ-本体抽取/s2-plan/decomposition.md": "# 拆解：本体抽取\n\n对象 / 策略 / 邻域 三条子任务。\n",
    "requirements/REQ-本体抽取/s3-execution/design.md": "# 设计：抽取桥接\n\n社区成员写入 `ontology_object.properties.community_id`。\n",
    "requirements/REQ-本体抽取/s3-execution/test-plan.md": "# 测试方案：本体抽取\n\n对象列表、策略键、邻域 BFS。\n",
    "requirements/REQ-本体抽取/s3-execution/src/extract-bridge.ts": "export function bridgeCommunity(id: string) { return id; }\n",
    "requirements/REQ-本体抽取/s4-acceptance/acceptance.md": "# 验收标准：本体抽取\n\n- 模块对象非空\n- 策略键 S1/S2/S3 可见\n",
    "requirements/REQ-本体抽取/s4-acceptance/report-r1.md": "# 验收报告 R1：本体抽取\n\n首轮验收记录。\n",
    "requirements/REQ-总线矩阵/requirement.md": "---\ndoc_type: requirement\nrequirement_key: REQ-总线矩阵\n---\n\n# 需求：总线矩阵告警\n",
    "requirements/REQ-总线矩阵/s1-prototype/prototype.html": "<!doctype html><html><body><h1>总线矩阵原型</h1></body></html>\n",
    "requirements/REQ-总线矩阵/s2-plan/plan.md": "# 计划：总线矩阵\n",
    "requirements/REQ-总线矩阵/s2-plan/decomposition.md": "# 拆解：跨域写 / 孤儿表 / 下钻\n",
    "requirements/REQ-总线矩阵/s3-execution/design.md": "# 设计：告警规则\n",
    "requirements/REQ-总线矩阵/s3-execution/test-plan.md": "# 测试方案：告警与下钻\n",
    "requirements/REQ-总线矩阵/s4-acceptance/acceptance.md": "# 验收标准：总线矩阵\n",
    "requirements/REQ-总线矩阵/s4-acceptance/report-r1.md": "# 验收报告 R1：总线矩阵\n",
    "requirements/REQ-图谱邻域/requirement.md": "---\ndoc_type: requirement\nrequirement_key: REQ-图谱邻域\n---\n\n# 需求：图谱邻域下钻\n",
    "requirements/REQ-图谱邻域/s1-prototype/prototype.html": """<!doctype html><html><body>
<div data-fp="fp.graph.list" data-title="社区列表">社区列表 · 仅名称</div>
<div data-fp="fp.graph.hop" data-title="邻域 hop">1 hop MEMBER_OF</div>
</body></html>
""",
    "requirements/REQ-图谱邻域/s1-prototype/prototype-v2.html": """<!doctype html><html><body>
<div data-fp="fp.graph.list" data-title="社区列表">社区列表 · 名称 + 对象数</div>
<div data-fp="fp.graph.hop" data-title="邻域 hop">2 hop · STEP_IN_PROCESS</div>
<div data-fp="fp.graph.route" data-title="路由条">HANDLES_ROUTE 条带</div>
</body></html>
""",
    "requirements/REQ-图谱邻域/s1-prototype/prototype-v3.html": """<!doctype html><html><body>
<div data-fp="fp.graph.list" data-title="社区列表">社区列表 · 名称 + 对象数</div>
<div data-fp="fp.graph.hop" data-title="邻域 hop">2 hop · Process / Route / Community</div>
<div data-fp="fp.graph.route" data-title="路由条">HANDLES_ROUTE + CALLS 统计</div>
<div data-fp="fp.graph.hotspot" data-title="热点联动">点热点看代码与图谱</div>
</body></html>
""",
    "requirements/REQ-图谱邻域/s2-plan/plan.md": "# 计划：邻域 BFS\n",
    "requirements/REQ-图谱邻域/s2-plan/decomposition.md": "# 拆解：MEMBER_OF + CALLS\n",
    "requirements/REQ-图谱邻域/s3-execution/design.md": "# 设计：1 hop 邻域\n",
    "requirements/REQ-扫描增量/requirement.md": "---\ndoc_type: requirement\nrequirement_key: REQ-扫描增量\n---\n\n# 需求：扫描增量策略（缺阶段文档，用于矩阵缺件态）\n",
    "filing/software_copyright/software_manual.md": "# 软件说明书\n\n代码本体平台软著说明书演示稿。\n",
    "demo/unbound-inbox.md": "# 未绑定收件\n\n交付物 TAB 的未绑定分组演示。\n",
    "filing/software_copyright/source_code_excerpt.md": "# 源程序节选\n\n演示：软著源程序前后各 30 页摘录。\n",
    "filing/software_copyright/test_report.md": "# 测试报告\n\n覆盖扫描 / 抽取 / 总线 / 档案 / 申报主路径。\n",
    "filing/software_copyright/requirement_spec.md": "# 需求规格说明书\n\n委托开发情形下的规格演示稿。\n",
    "filing/software_copyright/design_doc.md": "# 设计说明书\n\n概要设计 + 详细设计演示稿。\n",
    "filing/software_copyright/code_stats.md": "# 代码统计\n\n语言分布与模块行数演示。\n",
    "filing/patent/tech_disclosure.md": "# 技术交底书\n\n总线矩阵与本体抽取的交底演示。\n",
    "filing/patent/claims_draft.md": "# 权利要求书草稿\n\n独立权利要求 + 从属权利要求。\n",
    "filing/patent/spec_drawings.md": "# 说明书附图\n\n架构图 / 时序图索引。\n",
    "filing/patent/search_report.md": "# 检索报告\n\n现有技术对比演示。\n",
    "filing/patent/prototype_final.html": "<!doctype html><html><body><h1>申报原型终稿</h1></body></html>\n",
    "filing/patent/originality.md": "# 独创性说明\n\n与现有代码图谱产品的差异点。\n",
}


def write_archive_files() -> None:
    if not ARCHIVE_ROOT.is_dir():
        print("archive root missing, skip files:", ARCHIVE_ROOT)
        return
    for rel, body in DEMO_FILE_BODIES.items():
        path = ARCHIVE_ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        print("wrote", path)


def main() -> None:
    write_archive_files()
    url = load_database_url()
    sql = build_sql()
    out = Path("/tmp/seed_ontology_platform_demo.sql")
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
