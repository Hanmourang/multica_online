package main

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 状态目录（issue statuses）是看板的列定义：每个状态有 category（决定机器
// 语义：是否算完成）和 color。UI 设置页的「新增状态 / 拖动排序 / 归档」三个
// 按钮就是这里的 create、reorder、archive。
var issueStatusCatalogCmd = &cobra.Command{
	Use:   "issue-status",
	Short: "Manage the workspace's issue status catalog (board columns)",
	Long: `Writes are owner/admin only. A status's key and category are immutable once
created — changing either would silently rewrite the meaning of every issue
already sitting on it.

  multica issue-status list [--include-archived]
  multica issue-status create --name "In review" --category in_progress [--key in_review] [--color "#8b5cf6"]
  multica issue-status update <id> [--name ...] [--description ...] [--color ...] [--position 2.5]
  multica issue-status archive <id> [--yes]        archive (reversible via the API, not the CLI)
  multica issue-status reorder <category> <id>...

Categories are the fixed set the server reports under "categories" in
` + "`multica issue-status list --output json`" + `; reorder takes EVERY active custom
status of one category, in the order you want them shown.`,
}

var issueStatusListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the status catalog in display order",
	Args:  cobra.NoArgs,
	RunE:  runIssueStatusList,
}

var issueStatusCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Add a custom status",
	Args:  cobra.NoArgs,
	RunE:  runIssueStatusCreate,
}

var issueStatusUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Rename, recolor or reposition a status",
	Args:  exactArgs(1),
	RunE:  runIssueStatusUpdate,
}

var issueStatusArchiveCmd = &cobra.Command{
	Use:   "archive <id> --yes",
	Short: "Archive a custom status",
	Args:  exactArgs(1),
	RunE:  runIssueStatusArchive,
}

var issueStatusReorderCmd = &cobra.Command{
	Use:   "reorder <category> <id>...",
	Short: "Rewrite one category's status order",
	Long: `Pass every active custom status of the category, in the order you want:

  multica issue-status reorder in_progress 3f2a1b44 8c9d0e11

A partial list is rejected: positions are assigned from the array index, so a
subset would collide with the rows left out.`,
	Args: cobra.MinimumNArgs(2),
	RunE: runIssueStatusReorder,
}

func init() {
	issueStatusListCmd.Flags().Bool("include-archived", false, "Also list archived statuses")
	issueStatusListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	issueStatusListCmd.Flags().Bool("full-id", false, "Print full ids instead of 8-character prefixes")
	issueStatusListCmd.Flags().String("output", "table", "Output format: table or json")

	issueStatusCreateCmd.Flags().String("name", "", "Display name (required)")
	issueStatusCreateCmd.Flags().String("category", "", "Category: the fixed set reported by `list --output json` (required)")
	issueStatusCreateCmd.Flags().String("key", "", "Machine key stored on issues (derived from --name when omitted)")
	issueStatusCreateCmd.Flags().String("description", "", "What this status means")
	issueStatusCreateCmd.Flags().String("color", "", "Hex color, e.g. #8b5cf6")
	issueStatusCreateCmd.Flags().String("output", "json", "Output format: json or table")

	issueStatusUpdateCmd.Flags().String("name", "", "New display name")
	issueStatusUpdateCmd.Flags().String("description", "", "New description")
	issueStatusUpdateCmd.Flags().String("color", "", "New hex color")
	issueStatusUpdateCmd.Flags().Float64("position", 0, "New position within its category (low = left)")
	issueStatusUpdateCmd.Flags().String("output", "json", "Output format: json or table")

	issueStatusReorderCmd.Flags().String("output", "json", "Output format: json or table")
	addDestructiveFlags(issueStatusArchiveCmd)

	issueStatusCatalogCmd.AddCommand(issueStatusListCmd)
	issueStatusCatalogCmd.AddCommand(issueStatusCreateCmd)
	issueStatusCatalogCmd.AddCommand(issueStatusUpdateCmd)
	issueStatusCatalogCmd.AddCommand(issueStatusArchiveCmd)
	issueStatusCatalogCmd.AddCommand(issueStatusReorderCmd)
}

// resolveIssueStatusID accepts a full UUID or a unique prefix across the whole
// catalog, archived rows included.
func resolveIssueStatusID(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "issue status", input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var resp struct {
			Statuses []map[string]any `json:"statuses"`
		}
		if err := client.GetJSON(ctx, "/api/issue-statuses?include_archived=true", &resp); err != nil {
			return nil, err
		}
		out := make([]idCandidate, 0, len(resp.Statuses))
		for _, s := range resp.Statuses {
			out = append(out, idCandidate{
				ID:      strVal(s, "id"),
				Display: strVal(s, "name"),
				Detail:  strVal(s, "key"),
			})
		}
		return out, nil
	})
}

func runIssueStatusList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	path := "/api/issue-statuses"
	if include, _ := cmd.Flags().GetBool("include-archived"); include {
		path += "?include_archived=true"
	}
	var resp struct {
		Statuses   []map[string]any `json:"statuses"`
		Categories []string         `json:"categories"`
		Total      int              `json:"total"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("list issue statuses: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(resp.Statuses, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
			"statuses": rows, "categories": resp.Categories, "total": resp.Total,
		})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, s := range rows {
		id := strVal(s, "id")
		if !fullID {
			id = shortID(id)
		}
		out = append(out, []string{
			id,
			blankDash(strVal(s, "key")),
			truncateCell(blankDash(strVal(s, "name")), 28),
			blankDash(strVal(s, "category")),
			blankDash(strVal(s, "color")),
			yesNo(isTrue(s["is_system"])),
			compactCount(s, "position"),
			yesNo(strVal(s, "archived_at") != ""),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "KEY", "NAME", "CATEGORY", "COLOR", "SYSTEM", "POS", "ARCHIVED"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d status(es). Categories: %s\n", len(rows), strings.Join(resp.Categories, ", "))
	return nil
}

func runIssueStatusCreate(cmd *cobra.Command, _ []string) error {
	name, _ := cmd.Flags().GetString("name")
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("--name is required")
	}
	category, _ := cmd.Flags().GetString("category")
	category = strings.ToLower(strings.TrimSpace(category))
	if category == "" {
		return fmt.Errorf("--category is required (run `multica issue-status list --output json` to see the allowed set)")
	}
	body := map[string]any{"name": name, "category": category}
	for flag, key := range map[string]string{
		"key": "key", "description": "description", "color": "color",
	} {
		if value, _ := cmd.Flags().GetString(flag); strings.TrimSpace(value) != "" {
			body[key] = strings.TrimSpace(value)
		}
	}
	return doJSONWrite(cmd, "POST", "/api/issue-statuses", body, "create issue status")
}

func runIssueStatusUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueStatusID(ctx, client, args[0])
	if err != nil {
		return err
	}
	body := map[string]any{}
	for _, flag := range []string{"name", "description", "color"} {
		if !cmd.Flags().Changed(flag) {
			continue
		}
		value, _ := cmd.Flags().GetString(flag)
		body[flag] = value
	}
	if cmd.Flags().Changed("position") {
		position, _ := cmd.Flags().GetFloat64("position")
		body["position"] = position
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --name, --description, --color or --position")
	}
	path := "/api/issue-statuses/" + url.PathEscape(ref.ID)
	return doJSONWrite(cmd, "PATCH", path, body, "update issue status")
}

func runIssueStatusArchive(cmd *cobra.Command, args []string) error {
	hint := fmt.Sprintf("Archive issue status %s. Issues on it must be moved first; the status disappears from the board.", args[0])
	if err := confirmDestructive(cmd, hint); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueStatusID(ctx, client, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, "/api/issue-statuses/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("archive issue status: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "archived issue status %s\n", ref.ID)
	return nil
}

func runIssueStatusReorder(cmd *cobra.Command, args []string) error {
	category := strings.ToLower(strings.TrimSpace(args[0]))
	if category == "" {
		return fmt.Errorf("category is required")
	}
	ids := make([]string, 0, len(args)-1)
	for _, id := range args[1:] {
		ids = append(ids, strings.TrimSpace(id))
	}
	body := map[string]any{"category": category, "ids": ids}
	return doJSONWrite(cmd, "PATCH", "/api/issue-statuses/reorder", body, "reorder issue statuses")
}
