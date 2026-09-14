"use client";

import type { ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";
import type { StorybookDemoStory } from "./catalog";

export function StorybookDemoCanvas({
  communityId,
  story,
  selectedFp,
  onSelectFp,
}: {
  communityId: string;
  story: StorybookDemoStory;
  selectedFp: string | null;
  onSelectFp: (id: string) => void;
}) {
  const active = selectedFp ?? story.points[0]?.id ?? "";
  const select = (id: string) => onSelectFp(id);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f4f5f8]" data-testid="storybook-demo-canvas">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-black/8 bg-white px-3">
        <span className="rounded bg-[#ff4785] px-1.5 py-px text-[9px] font-bold tracking-wide text-white">
          STORY
        </span>
        <span className="truncate font-mono text-[11px] text-[#333]">{story.storyId}</span>
        <span className="ml-auto text-[10px] text-[#888]">{story.title}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {communityId === "comm-ontology" && story.variant === "Empty" ? (
          <EmptyOntology onSelect={select} active={active} />
        ) : communityId === "comm-ontology" ? (
          <OntologyPage onSelect={select} active={active} />
        ) : communityId === "comm-graph" ? (
          <GraphPage onSelect={select} active={active} />
        ) : communityId === "comm-scan" ? (
          <ScanPage onSelect={select} active={active} />
        ) : communityId === "comm-extract" ? (
          <ExtractPage onSelect={select} active={active} />
        ) : communityId === "comm-bus" ? (
          <BusPage onSelect={select} active={active} />
        ) : communityId === "comm-archive" ? (
          <ArchivePage onSelect={select} active={active} />
        ) : communityId === "comm-filing" ? (
          <FilingPage onSelect={select} active={active} />
        ) : (
          <p className="text-[11px] text-muted-foreground">{story.title}</p>
        )}
      </div>
    </div>
  );
}

function Spot({
  id,
  active,
  onSelect,
  className,
  children,
}: {
  id: string;
  active: string;
  onSelect: (id: string) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-fp={id}
      onClick={() => onSelect(id)}
      className={cn(
        "rounded-lg border border-transparent text-left transition-shadow",
        active === id && "border-primary shadow-[0_0_0_3px] shadow-primary/20",
        className,
      )}
    >
      {children}
    </button>
  );
}

function OntologyPage({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  const rows = [
    ["Function", "parseOntology", "src/comm-ontology/parse.ts", "ontology_object"],
    ["Class", "OntologyService", "src/comm-ontology/Service.ts", "ontology_object · ontology_link"],
    ["Route", "GET /api/ontology", "src/comm-ontology/api.ts", "ontology_object"],
  ];
  return (
    <div className="flex gap-2">
      <Spot id="fp.ontology.filter" active={active} onSelect={onSelect} className="w-[132px] shrink-0 bg-white p-2">
        <p className="mb-1.5 text-[10px] font-bold text-[#666]">类型</p>
        {["Function", "Class", "Route"].map((kind, index) => (
          <div
            key={kind}
            className={cn(
              "mb-1 rounded-md px-2 py-1 text-[11px]",
              index === 0 ? "bg-primary/10 font-semibold text-primary" : "bg-[#f4f5f8] text-[#555]",
            )}
          >
            {kind}
          </div>
        ))}
      </Spot>
      <div className="min-w-0 flex-1 space-y-2">
        <Spot id="fp.ontology.list" active={active} onSelect={onSelect} className="block w-full bg-white">
          <table className="w-full text-[11px]">
            <thead className="bg-[#f7f7fa] text-[10px] text-[#888]">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">类型</th>
                <th className="px-2 py-1.5 text-left font-medium">名称</th>
                <th className="px-2 py-1.5 text-left font-medium">路径</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row[1]} className="border-t border-[#eee]">
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row[0]}</td>
                  <td className="px-2 py-1.5 font-semibold">{row[1]}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px] text-[#888]">{row[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Spot>
        <Spot id="fp.ontology.drawer" active={active} onSelect={onSelect} className="block w-full bg-white p-2.5">
          <p className="text-[10px] font-bold text-[#888]">对象抽屉</p>
          <p className="font-mono text-[11px]">src/comm-ontology/Service.ts#Service</p>
          <p className="mt-1 text-[10px] text-[#888]">触达表 · ontology_object · ontology_link</p>
        </Spot>
      </div>
    </div>
  );
}

function EmptyOntology({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  return (
    <Spot
      id="fp.ontology.empty"
      active={active}
      onSelect={onSelect}
      className="flex h-full min-h-[180px] w-full items-center justify-center bg-white"
    >
      <div className="text-center">
        <p className="text-[12px] font-semibold">本体层尚未抽取</p>
        <p className="mt-1 text-[11px] text-[#888]">跑完扫描后在此查看对象列表</p>
      </div>
    </Spot>
  );
}

function GraphPage({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  return (
    <div className="grid h-full min-h-[220px] grid-cols-[140px_1fr] gap-2">
      <Spot id="fp.graph.list" active={active} onSelect={onSelect} className="bg-white p-2">
        <p className="mb-1.5 text-[10px] font-bold text-[#666]">Community</p>
        {["本体对象页 · 46", "图谱浏览页 · 38", "总线矩阵页 · 24"].map((name, index) => (
          <div
            key={name}
            className={cn(
              "mb-1 rounded-md px-2 py-1.5 text-[11px]",
              index === 1 ? "bg-primary/10 font-semibold text-primary" : "bg-[#f4f5f8]",
            )}
          >
            {name}
          </div>
        ))}
      </Spot>
      <div className="flex flex-col gap-2">
        <Spot id="fp.graph.hop" active={active} onSelect={onSelect} className="flex flex-1 items-center justify-center bg-white p-3">
          <div className="flex items-center gap-2 text-[11px]">
            <NodeChip label="parse" />
            <span className="text-[#bbb]">CALLS</span>
            <NodeChip label="bridge" accent />
            <span className="text-[#bbb]">MEMBER_OF</span>
            <NodeChip label="comm-graph" />
          </div>
        </Spot>
        <div className="grid grid-cols-2 gap-2">
          <Spot id="fp.graph.route" active={active} onSelect={onSelect} className="bg-white p-2">
            <p className="text-[10px] font-bold text-[#888]">HANDLES_ROUTE</p>
            <p className="font-mono text-[11px]">GET /api/graph</p>
          </Spot>
          <Spot id="fp.graph.hotspot" active={active} onSelect={onSelect} className="bg-white p-2">
            <p className="text-[10px] font-bold text-[#888]">热点</p>
            <p className="text-[11px]">点节点看 codeHints</p>
          </Spot>
        </div>
      </div>
    </div>
  );
}

function ScanPage({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  return (
    <div className="space-y-2">
      <Spot id="fp.scan.list" active={active} onSelect={onSelect} className="block w-full bg-white p-2.5">
        <div className="mb-2 flex items-center justify-between text-[11px]">
          <span className="font-semibold">demo-ontology-platform-v1</span>
          <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-bold text-emerald-700">success</span>
        </div>
        <Spot id="fp.scan.progress" active={active} onSelect={onSelect} className="block w-full">
          <div className="h-1.5 overflow-hidden rounded-full bg-[#eee]">
            <div className="h-full w-[92%] bg-emerald-500" />
          </div>
          <p className="mt-1 text-[10px] text-[#888]">214 / 233 files</p>
        </Spot>
      </Spot>
      <Spot id="fp.scan.log" active={active} onSelect={onSelect} className="block w-full bg-[#111] p-2.5 font-mono text-[10.5px] text-[#c6f6d5]">
        scan_file · src/comm-graph/parse.ts · ok · 12ms
      </Spot>
    </div>
  );
}

function ExtractPage({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Spot id="fp.extract.pack" active={active} onSelect={onSelect} className="bg-white p-2.5">
        <p className="mb-2 text-[10px] font-bold text-[#888]">strategy_pack</p>
        {["S1 社区桥接", "S2 对象投影", "S3 策略展平"].map((row, index) => (
          <div key={row} className="mb-1 flex items-center justify-between rounded-md bg-[#f4f5f8] px-2 py-1.5 text-[11px]">
            <span>{row}</span>
            <span className="font-mono text-[10px] text-primary">{index === 0 ? "on" : "on"}</span>
          </div>
        ))}
      </Spot>
      <div className="space-y-2">
        <Spot id="fp.extract.rules" active={active} onSelect={onSelect} className="block w-full bg-white p-2.5">
          <p className="text-[10px] font-bold text-[#888]">规则</p>
          <p className="text-[11px]">graph_node_id ↔ community_id</p>
        </Spot>
        <Spot id="fp.extract.run" active={active} onSelect={onSelect} className="block w-full bg-white p-2.5">
          <p className="text-[10px] font-bold text-[#888]">extract_run</p>
          <p className="text-[11px]">最近一次 · 对象 181 · 12s</p>
        </Spot>
      </div>
    </div>
  );
}

function BusPage({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  const cells = [
    [2, 1, 0, 3],
    [1, 4, 1, 0],
    [0, 0, 2, 1],
  ];
  return (
    <div className="space-y-2">
      <Spot id="fp.bus.matrix" active={active} onSelect={onSelect} className="block w-full overflow-hidden bg-white">
        <table className="w-full text-center text-[10px]">
          <thead className="bg-[#f7f7fa] text-[#888]">
            <tr>
              <th className="px-2 py-1.5 text-left">页面</th>
              <th>本体</th>
              <th>图谱</th>
              <th>档案</th>
              <th>申报</th>
            </tr>
          </thead>
          <tbody>
            {["本体对象页", "图谱浏览页", "档案浏览页"].map((name, row) => (
              <tr key={name} className="border-t border-[#eee]">
                <td className="px-2 py-1.5 text-left font-semibold">{name}</td>
                {cells[row]!.map((n, col) => (
                  <td key={`${row}-${col}`}>
                    <span
                      className={cn(
                        "inline-block min-w-7 rounded px-1 py-0.5 font-mono",
                        n === 0 ? "text-[#ccc]" : "bg-primary/10 text-primary",
                      )}
                    >
                      {n || "·"}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Spot>
      <div className="grid grid-cols-2 gap-2">
        <Spot id="fp.bus.cell" active={active} onSelect={onSelect} className="bg-white p-2.5">
          <p className="text-[10px] font-bold text-[#888]">格子</p>
          <p className="text-[11px]">project_graph_snapshot · R4 / W1</p>
        </Spot>
        <Spot id="fp.bus.alert" active={active} onSelect={onSelect} className="bg-white p-2.5">
          <p className="text-[10px] font-bold text-amber-700">跨域直写</p>
          <p className="text-[11px]">档案浏览页 → filing_item</p>
        </Spot>
      </div>
    </div>
  );
}

function ArchivePage({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  return (
    <div className="space-y-2">
      <Spot id="fp.archive.shelf" active={active} onSelect={onSelect} className="grid w-full grid-cols-4 gap-1.5 bg-white p-2">
        {["调研", "产品设计", "技术架构", "复盘"].map((name) => (
          <div key={name} className="rounded-md bg-[#f4f5f8] px-2 py-2 text-center text-[11px] font-semibold">
            {name}
            <span className="mt-0.5 block text-[10px] font-normal text-[#888]">2</span>
          </div>
        ))}
      </Spot>
      <div className="grid grid-cols-[1.4fr_0.8fr] gap-2">
        <Spot id="fp.archive.matrix" active={active} onSelect={onSelect} className="bg-white p-2">
          <p className="mb-1.5 text-[10px] font-bold text-[#888]">需求 × 阶段</p>
          {["REQ-本体抽取", "REQ-图谱邻域"].map((name) => (
            <div key={name} className="mb-1 flex items-center gap-1 text-[10px]">
              <span className="w-[92px] truncate font-semibold">{name}</span>
              {["S1", "S2", "S3", "S4"].map((stage, index) => (
                <span
                  key={stage}
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    index < 3 ? "bg-primary/10 text-primary" : "bg-[#f4f5f8] text-[#bbb]",
                  )}
                >
                  {stage}
                </span>
              ))}
            </div>
          ))}
        </Spot>
        <Spot id="fp.archive.preview" active={active} onSelect={onSelect} className="bg-white p-2">
          <p className="text-[10px] font-bold text-[#888]">预览</p>
          <p className="text-[11px]">PRD-模块桥接.md</p>
          <p className="mt-1 text-[10px] text-[#888]">选中后展开 260–320px</p>
        </Spot>
      </div>
    </div>
  );
}

function FilingPage({ onSelect, active }: { onSelect: (id: string) => void; active: string }) {
  const items = [
    ["申请表", "必备", "ok"],
    ["鉴别材料 60 页", "必备", "warn"],
    ["说明书", "必备", "ok"],
  ];
  return (
    <div className="space-y-2">
      <Spot id="fp.filing.items" active={active} onSelect={onSelect} className="block w-full bg-white">
        {items.map((row) => (
          <div key={row[0]} className="flex items-center gap-2 border-b border-[#f0f0f3] px-2.5 py-2 text-[11px] last:border-0">
            <span className="flex-1 font-semibold">{row[0]}</span>
            <span className="text-[10px] text-[#888]">{row[1]}</span>
            <span className={cn("rounded px-1.5 py-px text-[10px] font-bold", row[2] === "ok" ? "bg-emerald-500/15 text-emerald-700" : "bg-amber-500/15 text-amber-800")}>
              {row[2]}
            </span>
          </div>
        ))}
      </Spot>
      <div className="grid grid-cols-2 gap-2">
        <Spot id="fp.filing.check" active={active} onSelect={onSelect} className="bg-white p-2.5">
          <p className="text-[10px] font-bold text-[#888]">机检</p>
          <p className="text-[11px]">页眉版本号 ≠ 申请表</p>
        </Spot>
        <Spot id="fp.filing.export" active={active} onSelect={onSelect} className="bg-white p-2.5">
          <p className="text-[10px] font-bold text-[#888]">导出</p>
          <p className="text-[11px]">必备未齐 · 已拒绝</p>
        </Spot>
      </div>
    </div>
  );
}

function NodeChip({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-1 font-mono text-[10px]",
        accent ? "border-primary bg-primary/10 text-primary" : "border-[#e5e5ea] bg-white",
      )}
    >
      {label}
    </span>
  );
}
