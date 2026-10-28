package main

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 用量与稳定性看板（UI 的 /usage 页）。过去它只有前端聚合，agent 无法回答
// 「这个工作区最近 7 天花了多少 token / 哪个 agent 失败最多」这类问题。
// 六个端点全是只读聚合，没有写面。
var dashboardCmd = &cobra.Command{
	Use:   "dashboard",
	Short: "Read workspace usage, run-time and failure rollups",
	Long: `All six views are read-only rollups over the last --days calendar days
(default 30), scoped to the active workspace, and optionally to one project.

  multica dashboard usage [--days 30]              tokens + cost per date/model
  multica dashboard usage-by-agent                 tokens + cost per agent
  multica dashboard runtime                        run seconds per date
  multica dashboard agent-runtime                  run seconds per agent
  multica dashboard failures                       failed-task count per date/reason
  multica dashboard failures-by-agent              failed-task count per agent/reason
  multica dashboard overview                       all six, as one JSON document

Day buckets are cut in --tz (defaults to your stored timezone, else UTC), so
"yesterday" matches what the dashboard shows you.`,
}

var dashboardUsageCmd = &cobra.Command{
	Use:   "usage",
	Short: "Token and cost buckets per date/model",
	Args:  cobra.NoArgs,
	RunE:  runDashboardUsageDaily,
}

var dashboardUsageByAgentCmd = &cobra.Command{
	Use:   "usage-by-agent",
	Short: "Token and cost buckets per agent",
	Args:  cobra.NoArgs,
	RunE:  runDashboardUsageByAgent,
}

var dashboardRuntimeCmd = &cobra.Command{
	Use:   "runtime",
	Short: "Task run time and counts per date",
	Args:  cobra.NoArgs,
	RunE:  runDashboardRunTimeDaily,
}

var dashboardAgentRuntimeCmd = &cobra.Command{
	Use:   "agent-runtime",
	Short: "Task run time and counts per agent",
	Args:  cobra.NoArgs,
	RunE:  runDashboardAgentRunTime,
}

var dashboardFailuresCmd = &cobra.Command{
	Use:   "failures",
	Short: "Terminal-task counts per date and failure reason",
	Args:  cobra.NoArgs,
	RunE:  runDashboardFailuresDaily,
}

var dashboardFailuresByAgentCmd = &cobra.Command{
	Use:   "failures-by-agent",
	Short: "Terminal-task counts per agent and failure reason",
	Args:  cobra.NoArgs,
	RunE:  runDashboardFailuresByAgent,
}

var dashboardOverviewCmd = &cobra.Command{
	Use:   "overview",
	Short: "Fetch every dashboard rollup as one JSON document",
	Long: `One call that returns all six rollups keyed by view name. Use it to brief an
agent on a workspace's health without six round trips.

  multica dashboard overview --days 7 --output json`,
	Args: cobra.NoArgs,
	RunE: runDashboardOverview,
}

func init() {
	views := []*cobra.Command{
		dashboardUsageCmd, dashboardUsageByAgentCmd,
		dashboardRuntimeCmd, dashboardAgentRuntimeCmd,
		dashboardFailuresCmd, dashboardFailuresByAgentCmd,
		dashboardOverviewCmd,
	}
	for _, c := range views {
		c.Flags().Int("days", 30, "Window size in calendar days (1..365)")
		c.Flags().String("tz", "", "IANA timezone for day boundaries (default: your stored tz, else UTC)")
		c.Flags().String("project", "", "Scope the rollup to one project id")
		c.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
		c.Flags().String("output", "table", "Output format: table or json")
	}
	// overview always answers with one JSON document, so its --output default
	// stays "table" only to keep the shared flag set uniform.

	dashboardCmd.AddCommand(dashboardUsageCmd)
	dashboardCmd.AddCommand(dashboardUsageByAgentCmd)
	dashboardCmd.AddCommand(dashboardRuntimeCmd)
	dashboardCmd.AddCommand(dashboardAgentRuntimeCmd)
	dashboardCmd.AddCommand(dashboardFailuresCmd)
	dashboardCmd.AddCommand(dashboardFailuresByAgentCmd)
	dashboardCmd.AddCommand(dashboardOverviewCmd)
}

// dashboardQuery builds the shared ?days/tz/project_id query string.
func dashboardQuery(cmd *cobra.Command) (string, error) {
	days, _ := cmd.Flags().GetInt("days")
	if days < 1 || days > 365 {
		return "", fmt.Errorf("--days must be between 1 and 365")
	}
	params := url.Values{}
	params.Set("days", strconv.Itoa(days))
	if tz, _ := cmd.Flags().GetString("tz"); strings.TrimSpace(tz) != "" {
		params.Set("tz", strings.TrimSpace(tz))
	}
	if project, _ := cmd.Flags().GetString("project"); strings.TrimSpace(project) != "" {
		params.Set("project_id", strings.TrimSpace(project))
	}
	return params.Encode(), nil
}

func fetchDashboardRows(cmd *cobra.Command, path string) ([]map[string]any, error) {
	client, err := newAPIClient(cmd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	query, err := dashboardQuery(cmd)
	if err != nil {
		return nil, err
	}
	var rows []map[string]any
	if err := client.GetJSON(ctx, path+"?"+query, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func printDashboardRows(cmd *cobra.Command, path, view string, headers []string, toRow func(map[string]any) []string) error {
	rows, err := fetchDashboardRows(cmd, path)
	if err != nil {
		return fmt.Errorf("%s: %w", view, err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows = capRows(rows, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{view: rows, "returned": len(rows)})
	}
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, toRow(row))
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	return nil
}

func runDashboardUsageDaily(cmd *cobra.Command, _ []string) error {
	return printDashboardRows(cmd, "/api/dashboard/usage/daily", "usage",
		[]string{"DATE", "PROVIDER", "MODEL", "IN", "OUT", "CACHE-R", "CACHE-W", "USD", "TASKS"},
		func(m map[string]any) []string {
			return []string{
				blankDash(strVal(m, "date")),
				blankDash(strVal(m, "provider")),
				truncateCell(blankDash(strVal(m, "model")), 28),
				compactCount(m, "input_tokens"),
				compactCount(m, "output_tokens"),
				compactCount(m, "cache_read_tokens"),
				compactCount(m, "cache_write_tokens"),
				usdTicks(m, "cost_usd_ticks"),
				compactCount(m, "task_count"),
			}
		})
}

func runDashboardUsageByAgent(cmd *cobra.Command, _ []string) error {
	return printDashboardRows(cmd, "/api/dashboard/usage/by-agent", "usage_by_agent",
		[]string{"AGENT", "PROVIDER", "MODEL", "IN", "OUT", "USD", "TASKS"},
		func(m map[string]any) []string {
			return []string{
				shortID(strVal(m, "agent_id")),
				blankDash(strVal(m, "provider")),
				truncateCell(blankDash(strVal(m, "model")), 28),
				compactCount(m, "input_tokens"),
				compactCount(m, "output_tokens"),
				usdTicks(m, "cost_usd_ticks"),
				compactCount(m, "task_count"),
			}
		})
}

func runDashboardRunTimeDaily(cmd *cobra.Command, _ []string) error {
	return printDashboardRows(cmd, "/api/dashboard/runtime/daily", "runtime",
		[]string{"DATE", "TASKS", "RUN-TIME", "FAILED", "CANCELLED"},
		func(m map[string]any) []string {
			return []string{
				blankDash(strVal(m, "date")),
				compactCount(m, "task_count"),
				durationSeconds(m, "total_seconds"),
				compactCount(m, "failed_count"),
				compactCount(m, "cancelled_count"),
			}
		})
}

func runDashboardAgentRunTime(cmd *cobra.Command, _ []string) error {
	return printDashboardRows(cmd, "/api/dashboard/agent-runtime", "agent_runtime",
		[]string{"AGENT", "TASKS", "RUN-TIME", "FAILED", "CANCELLED"},
		func(m map[string]any) []string {
			return []string{
				shortID(strVal(m, "agent_id")),
				compactCount(m, "task_count"),
				durationSeconds(m, "total_seconds"),
				compactCount(m, "failed_count"),
				compactCount(m, "cancelled_count"),
			}
		})
}

func runDashboardFailuresDaily(cmd *cobra.Command, _ []string) error {
	return printDashboardRows(cmd, "/api/dashboard/failures/daily", "failures",
		[]string{"DATE", "REASON", "TASKS"},
		func(m map[string]any) []string {
			return []string{
				blankDash(strVal(m, "date")),
				blankDash(strVal(m, "failure_reason")),
				compactCount(m, "task_count"),
			}
		})
}

func runDashboardFailuresByAgent(cmd *cobra.Command, _ []string) error {
	return printDashboardRows(cmd, "/api/dashboard/failures/by-agent", "failures_by_agent",
		[]string{"AGENT", "REASON", "TASKS"},
		func(m map[string]any) []string {
			return []string{
				shortID(strVal(m, "agent_id")),
				blankDash(strVal(m, "failure_reason")),
				compactCount(m, "task_count"),
			}
		})
}

func runDashboardOverview(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	query, err := dashboardQuery(cmd)
	if err != nil {
		return err
	}
	views := []struct {
		key  string
		path string
	}{
		{"usage", "/api/dashboard/usage/daily"},
		{"usage_by_agent", "/api/dashboard/usage/by-agent"},
		{"runtime", "/api/dashboard/runtime/daily"},
		{"agent_runtime", "/api/dashboard/agent-runtime"},
		{"failures", "/api/dashboard/failures/daily"},
		{"failures_by_agent", "/api/dashboard/failures/by-agent"},
	}
	out := map[string]any{}
	for _, v := range views {
		var rows []map[string]any
		if err := client.GetJSON(ctx, v.path+"?"+query, &rows); err != nil {
			return fmt.Errorf("dashboard %s: %w", v.key, err)
		}
		out[v.key] = rows
	}
	out["query"] = query
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

// compactCount renders a numeric field as a plain integer instead of the
// scientific notation fmt would print for a float64 token count.
func compactCount(m map[string]any, key string) string {
	return strconv.FormatInt(int64(floatVal(m, key)), 10)
}

// durationSeconds renders run time as `1h02m` / `3m20s` / `45s`.
func durationSeconds(m map[string]any, key string) string {
	total := int64(floatVal(m, key))
	if total <= 0 {
		return "-"
	}
	h := total / 3600
	min := (total % 3600) / 60
	sec := total % 60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh%02dm", h, min)
	case min > 0:
		return fmt.Sprintf("%dm%02ds", min, sec)
	default:
		return fmt.Sprintf("%ds", sec)
	}
}

// usdTicks renders the server's 1e-10-USD cost ticks as dollars.
func usdTicks(m map[string]any, key string) string {
	ticks := floatVal(m, key)
	if ticks <= 0 {
		return "-"
	}
	return fmt.Sprintf("$%.4f", ticks/1e10)
}
