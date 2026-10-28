package main

import (
	"context"
	"fmt"
	"net/url"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 申报（filing）是项目详情里的一个 TAB：软著/专利的材料清单、就绪度检查、
// 打包导出与回写。过去 CLI 只能 `project tab get <p> filing` 看到就绪度，
// 条目级别的补正与覆盖判定都做不了。
var filingCmd = &cobra.Command{
	Use:   "filing",
	Short: "Read and fix a project's filing readiness (copyright / patent)",
	Long: `Tracks: software_copyright | patent. Tiers: must | conditional | aux.

  multica filing readiness <project> [--track t] [--tier must]
  multica filing items <project> [--track t] [--tier must]
  multica filing patch <project> <item-id> --reason "why" [--status missing|partial|ready] [--artifact <id>]
  multica filing check <project>
  multica filing export <project>
  multica filing cross-project <project>
  multica filing writeback <project> --yes   (writes readiness back into the archive)

patch is the manual override: --reason is required by the server and is stored as
override_reason, so say why the rule engine is wrong.`,
}

func init() {
	filingReadinessCmd.Flags().String("track", "", "software_copyright | patent")
	filingReadinessCmd.Flags().String("tier", "", "must | conditional | aux")
	filingReadinessCmd.Flags().String("output", "table", "Output format: table or json")
	filingCmd.AddCommand(filingReadinessCmd)

	filingItemsCmd.Flags().String("track", "", "software_copyright | patent")
	filingItemsCmd.Flags().String("tier", "", "must | conditional | aux")
	filingItemsCmd.Flags().Int("limit", 100, "Maximum rows to print")
	filingItemsCmd.Flags().String("output", "table", "Output format: table or json")
	filingCmd.AddCommand(filingItemsCmd)

	filingPatchCmd.Flags().String("status", "", "missing | partial | ready")
	filingPatchCmd.Flags().String("artifact", "", "artifact_id to bind, or \"\" to unbind")
	filingPatchCmd.Flags().String("reason", "", "Why the override is justified (required)")
	filingPatchCmd.Flags().String("output", "json", "Output format: table or json")
	filingCmd.AddCommand(filingPatchCmd)

	for _, child := range []*cobra.Command{filingCheckCmd, filingExportCmd, filingCrossProjectCmd} {
		child.Flags().String("output", "json", "Output format: table or json")
		filingCmd.AddCommand(child)
	}
	filingWritebackCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(filingWritebackCmd)
	filingCmd.AddCommand(filingWritebackCmd)
}

var (
	filingReadinessCmd = &cobra.Command{
		Use: "readiness <project>", Short: "Readiness summary per track/tier", Args: exactArgs(1),
		RunE: filingRead("readiness"),
	}
	filingItemsCmd = &cobra.Command{
		Use: "items <project>", Short: "Filing items with status and bound artifact", Args: exactArgs(1),
		RunE: filingItems,
	}
	filingPatchCmd = &cobra.Command{
		Use: "patch <project> <item-id>", Short: "Manual override of one filing item", Args: exactArgs(2),
		RunE: filingPatch,
	}
	filingCheckCmd = &cobra.Command{
		Use: "check <project>", Short: "Run the rule engine and persist results", Args: exactArgs(1),
		RunE: filingAction("check"),
	}
	filingExportCmd = &cobra.Command{
		Use: "export <project>", Short: "Build the export package", Args: exactArgs(1),
		RunE: filingAction("export"),
	}
	filingCrossProjectCmd = &cobra.Command{
		Use: "cross-project <project>", Short: "Materials reused from other projects", Args: exactArgs(1),
		RunE: filingRead("cross-project"),
	}
	filingWritebackCmd = &cobra.Command{
		Use:   "writeback <project>",
		Short: "Write readiness back into archive docs (needs --yes: rewrites many rows)",
		Args:  exactArgs(1),
		RunE:  filingWriteback,
	}
)

func filingRead(kind string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()

		projectRef, err := resolveProjectID(ctx, client, args[0])
		if err != nil {
			return fmt.Errorf("resolve project: %w", err)
		}
		params := url.Values{}
		if client.WorkspaceID != "" {
			params.Set("workspace_id", client.WorkspaceID)
		}
		if v := flagOr(cmd, "track", ""); v != "" {
			params.Set("track", v)
		}
		if v := flagOr(cmd, "tier", ""); v != "" {
			params.Set("tier", v)
		}
		path := "/api/projects/" + projectRef.ID + "/filing/" + kind
		if encoded := params.Encode(); encoded != "" {
			path += "?" + encoded
		}
		var raw map[string]any
		if err := client.GetJSON(ctx, path, &raw); err != nil {
			return fmt.Errorf("read filing %s: %w", kind, err)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
}

func filingItems(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	params := url.Values{}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	if v := flagOr(cmd, "track", ""); v != "" {
		params.Set("track", v)
	}
	if v := flagOr(cmd, "tier", ""); v != "" {
		params.Set("tier", v)
	}
	path := "/api/projects/" + projectRef.ID + "/filing/items"
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var raw map[string]any
	if err := client.GetJSON(ctx, path, &raw); err != nil {
		return fmt.Errorf("list filing items: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	items := anySlice(raw["items"])
	limit, _ := cmd.Flags().GetInt("limit")
	rows := anySlice(capAny(items, limit))
	headers := []string{"ID", "TRACK", "TIER", "TITLE", "STATUS", "ARTIFACT"}
	out := make([][]string, 0, len(rows))
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, []string{
			shortID(strVal(row, "id")),
			blankDash(strVal(row, "track")),
			blankDash(strVal(row, "tier")),
			truncateCell(strVal(row, "title"), 40),
			blankDash(strVal(row, "status")),
			shortID(strVal(row, "artifact_id")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d item(s).\n", len(out))
	return nil
}

func filingPatch(cmd *cobra.Command, args []string) error {
	reason := flagOr(cmd, "reason", "")
	if reason == "" {
		return fmt.Errorf("--reason is required: the server stores it as override_reason and rejects the patch without it")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	body := map[string]any{"override_reason": reason}
	if cmd.Flags().Changed("status") {
		status := flagOr(cmd, "status", "")
		switch status {
		case "missing", "partial", "ready":
			body["status"] = status
		default:
			return fmt.Errorf("--status must be missing, partial or ready")
		}
	}
	if cmd.Flags().Changed("artifact") {
		body["artifact_id"] = flagOr(cmd, "artifact", "")
	}

	var updated map[string]any
	path := "/api/projects/" + projectRef.ID + "/filing/items/" + args[1]
	if err := client.PatchJSON(ctx, path, body, &updated); err != nil {
		return fmt.Errorf("patch filing item: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

func filingAction(action string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()

		projectRef, err := resolveProjectID(ctx, client, args[0])
		if err != nil {
			return fmt.Errorf("resolve project: %w", err)
		}
		var result map[string]any
		path := "/api/projects/" + projectRef.ID + "/filing/" + action
		if err := client.PostJSON(ctx, path, nil, &result); err != nil {
			return fmt.Errorf("%s filing: %w", action, err)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
}

func filingWriteback(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Write filing readiness back into every bound archive document of project %s. This rewrites document content in bulk; check the readiness output first.",
		args[0])); err != nil {
		return err
	}
	return filingAction("writeback")(cmd, args)
}

// capAny truncates an []any the way capRows does for typed rows.
func capAny(rows []any, limit int) []any {
	if limit > 0 && len(rows) > limit {
		return rows[:limit]
	}
	return rows
}
