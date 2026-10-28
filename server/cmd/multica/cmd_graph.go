package main

import (
	"context"
	"fmt"
	"net/url"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 数据模型（图谱）是项目详情里的一个 TAB。它由本地扫描产物（graph snapshot）
// 单向写入，因此 CLI 只开放读：写入口是 graph/sync（daemon 侧）与
// graph/rebridge（会整体重建对象映射，属高危，明确不给 agent）。
//
// 注意 modules 列出的是「功能模块 ↔ 图谱节点」的桥接表（project_module 行），
// 不是扫描出来的 community 全集；per-module 命令的 <graph-node-id> 必须是
// project_module.graph_node_id，未桥接的模块没有这个 id（服务端 404）。
var graphCmd = &cobra.Command{
	Use:   "graph",
	Short: "Read a project's data-model graph (modules, objects, matrix, alerts)",
	Long: `Read-only on purpose: the graph is produced by scanning the codebase, and
rebuilding it (graph/rebridge) rewires every module ↔ object mapping at once.

  multica graph latest <project>                     snapshot summary
  multica graph detail <project>                     full snapshot (nodes/edges/communities)
  multica graph modules <project>                    feature modules + graph bridge state
  multica graph objects <project> <graph-node-id>    objects inside one module
  multica graph changes <project> <graph-node-id>    issues filed under that module
  multica graph strategies <project> <graph-node-id> strategies projected from the ontology
  multica graph neighborhood <project> <graph-node-id> [--depth 1..3]
  multica graph matrix <project>                     business-unit matrix
  multica graph drilldown <project> [filters]        tables/columns behind one matrix cell
  multica graph timeline <project> [--limit 20]      ontology changelog of the snapshot
  multica graph alerts <project>                     matrix anomalies

<graph-node-id> is project_module.graph_node_id, not the module id. Read
'multica graph modules' first: a module with no graph node is not bridged, and
every per-module command answers 404 'no module is bridged to this graph node'.
'multica graph detail' returns the whole snapshot payload — it is large; prefer
'modules' + 'objects' unless you truly need edges.`,
}

func init() {
	for _, child := range []*cobra.Command{
		graphLatestCmd,
		graphDetailCmd,
		graphModulesCmd,
		graphObjectsCmd,
		graphChangesCmd,
		graphStrategiesCmd,
		graphNeighborhoodCmd,
		graphMatrixCmd,
		graphDrilldownCmd,
		graphTimelineCmd,
		graphAlertsCmd,
	} {
		child.Flags().String("output", "json", "Output format: table or json")
		graphCmd.AddCommand(child)
	}
	graphModulesCmd.Flags().Set("output", "table")
	graphNeighborhoodCmd.Flags().Int("depth", 1, "Traversal depth from the module node (1..3)")
	graphDrilldownCmd.Flags().String("module-node", "", "Filter by bus-matrix module_node_id")
	graphDrilldownCmd.Flags().String("page", "", "Filter by page_key")
	graphDrilldownCmd.Flags().String("process", "", "Filter by process_key")
	graphDrilldownCmd.Flags().String("domain", "", "Filter by domain")
	graphTimelineCmd.Flags().Int("limit", 20, "Max changelog rows (1..100)")
}

var (
	graphLatestCmd = &cobra.Command{
		Use: "latest <project>", Short: "Latest graph snapshot summary", Args: exactArgs(1),
		RunE: graphRead("/graph/latest", false),
	}
	graphDetailCmd = &cobra.Command{
		Use: "detail <project>", Short: "Full latest snapshot (nodes, edges, communities)", Args: exactArgs(1),
		RunE: graphRead("/graph/latest/detail", false),
	}
	graphModulesCmd = &cobra.Command{
		Use: "modules <project>", Short: "Feature modules and their graph bridge state", Args: exactArgs(1),
		RunE: graphRead("/graph/modules", true),
	}
	graphObjectsCmd = &cobra.Command{
		Use: "objects <project> <graph-node-id>", Short: "Objects inside the module bridged to this graph node", Args: exactArgs(2),
		RunE: graphReadModule("/objects"),
	}
	graphChangesCmd = &cobra.Command{
		Use: "changes <project> <graph-node-id>", Short: "Issues filed under that module (newest 50)", Args: exactArgs(2),
		RunE: graphReadModule("/changes"),
	}
	graphStrategiesCmd = &cobra.Command{
		Use: "strategies <project> <graph-node-id>", Short: "Strategies projected from the module's ontology objects", Args: exactArgs(2),
		RunE: graphReadModule("/strategies"),
	}
	graphNeighborhoodCmd = &cobra.Command{
		Use: "neighborhood <project> <graph-node-id>", Short: "Ego network of one module (nodes + edges)", Args: exactArgs(2),
		RunE: runGraphNeighborhood,
	}
	graphMatrixCmd = &cobra.Command{
		Use: "matrix <project>", Short: "Business-unit matrix", Args: exactArgs(1),
		RunE: graphRead("/graph/bus-matrix", false),
	}
	graphDrilldownCmd = &cobra.Command{
		Use: "drilldown <project>", Short: "Tables and columns behind one matrix cell", Args: exactArgs(1),
		RunE: runGraphDrilldown,
	}
	graphTimelineCmd = &cobra.Command{
		Use: "timeline <project>", Short: "Ontology changelog of the latest snapshot", Args: exactArgs(1),
		RunE: runGraphTimeline,
	}
	graphAlertsCmd = &cobra.Command{
		Use: "alerts <project>", Short: "Matrix anomalies", Args: exactArgs(1),
		RunE: graphRead("/graph/bus-matrix/alerts", false),
	}
)

// graphGet resolves the project and performs one GET, returning the raw object
// so each command can decide between JSON and a table.
func graphGet(cmd *cobra.Command, projectArg, suffix string, params url.Values) (map[string]any, error) {
	client, err := newAPIClient(cmd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, projectArg)
	if err != nil {
		return nil, fmt.Errorf("resolve project: %w", err)
	}
	if params == nil {
		params = url.Values{}
	}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	path := "/api/projects/" + projectRef.ID + suffix
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var raw map[string]any
	if err := client.GetJSON(ctx, path, &raw); err != nil {
		return nil, fmt.Errorf("read graph (%s): %w", suffix, err)
	}
	return raw, nil
}

func graphRead(suffix string, table bool) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		raw, err := graphGet(cmd, args[0], suffix, nil)
		if err != nil {
			return err
		}
		if !table {
			return cli.PrintJSON(cmd.OutOrStdout(), raw)
		}
		return printGraphModules(cmd, raw)
	}
}

func graphReadModule(suffix string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		raw, err := graphGet(cmd, args[0], "/graph/modules/"+url.PathEscape(args[1])+suffix, nil)
		if err != nil {
			return err
		}
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
}

func runGraphNeighborhood(cmd *cobra.Command, args []string) error {
	params := url.Values{}
	if cmd.Flags().Changed("depth") {
		depth, err := cmd.Flags().GetInt("depth")
		if err != nil {
			return err
		}
		if depth < 1 || depth > 3 {
			return fmt.Errorf("--depth must be within 1..3")
		}
		params.Set("depth", strconv.Itoa(depth))
	}
	raw, err := graphGet(cmd, args[0], "/graph/modules/"+url.PathEscape(args[1])+"/neighborhood", params)
	if err != nil {
		return err
	}
	return cli.PrintJSON(cmd.OutOrStdout(), raw)
}

func runGraphDrilldown(cmd *cobra.Command, args []string) error {
	params := url.Values{}
	for _, pair := range []struct{ flag, key string }{
		{"module-node", "module_node_id"},
		{"page", "page_key"},
		{"process", "process_key"},
		{"domain", "domain"},
	} {
		if !cmd.Flags().Changed(pair.flag) {
			continue
		}
		value, err := cmd.Flags().GetString(pair.flag)
		if err != nil {
			return err
		}
		if value != "" {
			params.Set(pair.key, value)
		}
	}
	raw, err := graphGet(cmd, args[0], "/graph/bus-matrix/drilldown", params)
	if err != nil {
		return err
	}
	return cli.PrintJSON(cmd.OutOrStdout(), raw)
}

func runGraphTimeline(cmd *cobra.Command, args []string) error {
	params := url.Values{}
	limit, err := cmd.Flags().GetInt("limit")
	if err != nil {
		return err
	}
	if limit < 1 || limit > 100 {
		return fmt.Errorf("--limit must be within 1..100")
	}
	params.Set("limit", strconv.Itoa(limit))
	raw, err := graphGet(cmd, args[0], "/graph/bus-matrix/timeline", params)
	if err != nil {
		return err
	}
	return cli.PrintJSON(cmd.OutOrStdout(), raw)
}

func printGraphModules(cmd *cobra.Command, raw map[string]any) error {
	modules := anySlice(raw["modules"])
	headers := []string{"ID", "MODULE", "GRAPH NODE", "ISSUES"}
	rows := make([][]string, 0, len(modules))
	for _, item := range modules {
		module, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rows = append(rows, []string{
			shortID(strVal(module, "id")),
			truncateCell(strVal(module, "name"), 32),
			blankDash(truncateCell(strVal(module, "graph_node_id"), 40)),
			blankDash(strVal(module, "issue_count")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, rows)
	fmt.Fprintf(cmd.OutOrStdout(),
		"\n%d module(s). A '-' in GRAPH NODE means the module is not bridged; bind it with `multica module update <module> --graph-node <node-id>`.\n",
		len(rows))
	return nil
}
