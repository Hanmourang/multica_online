export type StoryFeaturePoint = {
  id: string;
  title: string;
  text: string;
};

export type StorybookDemoStory = {
  storyId: string;
  variant: string;
  title: string;
  points: StoryFeaturePoint[];
};

export type StorybookDemo = {
  communityId: string;
  moduleName: string;
  stories: StorybookDemoStory[];
};

/**
 * 代码本体平台（graph_node_id = comm-*）页面模块的本地演示 story。
 * 不是 discoverViews；没有真实 Storybook 服务时只渲染这些画布。
 */
export const ONTOLOGY_PLATFORM_STORYBOOK_DEMOS: StorybookDemo[] = [
  {
    communityId: "comm-ontology",
    moduleName: "本体对象页",
    stories: [
      {
        storyId: "pages-ontology-object--default",
        variant: "Default",
        title: "对象列表 + 抽屉",
        points: [
          { id: "fp.ontology.list", title: "对象表", text: "按 Community 聚合的本体对象" },
          { id: "fp.ontology.filter", title: "类型筛选", text: "Function / Class / Route" },
          { id: "fp.ontology.drawer", title: "对象抽屉", text: "qualified_name + 触达表" },
        ],
      },
      {
        storyId: "pages-ontology-object--empty",
        variant: "Empty",
        title: "未抽取空态",
        points: [
          { id: "fp.ontology.empty", title: "空态", text: "快照未抽取时的引导" },
        ],
      },
    ],
  },
  {
    communityId: "comm-graph",
    moduleName: "图谱浏览页",
    stories: [
      {
        storyId: "pages-graph-explorer--default",
        variant: "Default",
        title: "社区列表 + 邻域 hop",
        points: [
          { id: "fp.graph.list", title: "社区列表", text: "名称 + 对象数" },
          { id: "fp.graph.hop", title: "邻域 hop", text: "2 hop · Process / Route / Community" },
          { id: "fp.graph.route", title: "路由条", text: "HANDLES_ROUTE + CALLS" },
          { id: "fp.graph.hotspot", title: "热点联动", text: "点热点看代码与图谱" },
        ],
      },
    ],
  },
  {
    communityId: "comm-scan",
    moduleName: "扫描任务页",
    stories: [
      {
        storyId: "pages-scan-jobs--default",
        variant: "Default",
        title: "扫描任务队列",
        points: [
          { id: "fp.scan.list", title: "任务列表", text: "scan_job 运行中 / 成功 / 失败" },
          { id: "fp.scan.progress", title: "进度条", text: "已扫文件 / 总量" },
          { id: "fp.scan.log", title: "运行日志", text: "最近一条 scan_file 摘要" },
        ],
      },
    ],
  },
  {
    communityId: "comm-extract",
    moduleName: "抽取配置页",
    stories: [
      {
        storyId: "pages-extract-config--default",
        variant: "Default",
        title: "策略包与规则",
        points: [
          { id: "fp.extract.pack", title: "策略包", text: "strategy_pack S1–S3" },
          { id: "fp.extract.rules", title: "抽取规则", text: "社区桥接 + 对象投影" },
          { id: "fp.extract.run", title: "试跑", text: "extract_run 最近一次" },
        ],
      },
    ],
  },
  {
    communityId: "comm-bus",
    moduleName: "总线矩阵页",
    stories: [
      {
        storyId: "pages-bus-matrix--default",
        variant: "Default",
        title: "页面 × 数据域",
        points: [
          { id: "fp.bus.matrix", title: "矩阵", text: "模块页面 × 数据域表数" },
          { id: "fp.bus.cell", title: "格子下钻", text: "R / W 拆分 + 表清单" },
          { id: "fp.bus.alert", title: "跨域告警", text: "跨域直写 / 孤儿表" },
        ],
      },
    ],
  },
  {
    communityId: "comm-archive",
    moduleName: "档案浏览页",
    stories: [
      {
        storyId: "pages-archive-browse--default",
        variant: "Default",
        title: "货架 + 需求矩阵",
        points: [
          { id: "fp.archive.shelf", title: "四货架", text: "调研 / 设计 / 架构 / 复盘" },
          { id: "fp.archive.matrix", title: "需求矩阵", text: "S1–S4 阶段文档 chip" },
          { id: "fp.archive.preview", title: "预览栏", text: "选中文档才展开" },
        ],
      },
    ],
  },
  {
    communityId: "comm-filing",
    moduleName: "申报清单页",
    stories: [
      {
        storyId: "pages-filing-checklist--default",
        variant: "Default",
        title: "软著 / 专利齐套",
        points: [
          { id: "fp.filing.items", title: "清单项", text: "必备 / 条件必备 / 辅助" },
          { id: "fp.filing.check", title: "机检", text: "页数 / 页眉 / 摘要规则" },
          { id: "fp.filing.export", title: "导出包", text: "必备未齐拒绝导出" },
        ],
      },
    ],
  },
];

export function storybookDemoForModule(
  graphNodeId: string | null | undefined,
): StorybookDemo | undefined {
  if (!graphNodeId) return undefined;
  return ONTOLOGY_PLATFORM_STORYBOOK_DEMOS.find((row) => row.communityId === graphNodeId);
}
