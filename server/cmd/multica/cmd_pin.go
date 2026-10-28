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

// 侧边栏置顶（pins）是纯个人视图状态：它不改任何业务数据，但决定了人打开
// 工作区先看到什么。agent 帮人整理工作台时需要它——「把这三个 issue 置顶」
// 过去只能在 UI 里点。
var pinCmd = &cobra.Command{
	Use:   "pin",
	Short: "Pin issues, projects and saved views to your sidebar",
	Long: `Pins are per (workspace, user) and hold nothing but an order — titles, statuses
and icons are resolved by the client, so a pin never goes stale.

  multica pin list                              pinned items, in sidebar order
  multica pin add issue MUL-123
  multica pin add project <id|prefix>
  multica pin add view <id|prefix>
  multica pin remove issue MUL-123
  multica pin reorder <pin-id>=<position> ...   explicit positions, low = top

Reordering is explicit rather than relative: positions are floats, so
` + "`id=1.5`" + ` drops a pin between two neighbours without renumbering the rest.`,
}

var pinListCmd = &cobra.Command{
	Use:   "list",
	Short: "List pinned items in sidebar order",
	Args:  cobra.NoArgs,
	RunE:  runPinList,
}

var pinAddCmd = &cobra.Command{
	Use:   "add <issue|project|view> <id>",
	Short: "Pin one item",
	Args:  exactArgs(2),
	RunE:  runPinAdd,
}

var pinRemoveCmd = &cobra.Command{
	Use:   "remove <issue|project|view> <id>",
	Short: "Unpin one item",
	Args:  exactArgs(2),
	RunE:  runPinRemove,
}

var pinReorderCmd = &cobra.Command{
	Use:   "reorder <pin-id>=<position> ...",
	Short: "Rewrite pin positions",
	Long: `Positions are floats; a lower number sits higher in the sidebar.

  multica pin reorder 3f2a1b44=0 8c9d0e11=10 55aa66bb=20`,
	Args: cobra.MinimumNArgs(1),
	RunE: runPinReorder,
}

func init() {
	pinListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	pinListCmd.Flags().Bool("full-id", false, "Print full pin and item ids instead of 8-character prefixes")
	pinListCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{pinAddCmd, pinRemoveCmd} {
		c.Flags().String("output", "json", "Output format: json or table")
	}
	pinReorderCmd.Flags().String("output", "json", "Output format: json or table")

	pinCmd.AddCommand(pinListCmd)
	pinCmd.AddCommand(pinAddCmd)
	pinCmd.AddCommand(pinRemoveCmd)
	pinCmd.AddCommand(pinReorderCmd)
}

// resolvePinTarget turns whatever the user typed into the (type, uuid) pair the
// API wants: issue keys stay human ("MUL-123"), projects and views accept a
// short prefix.
func resolvePinTarget(ctx context.Context, client *cli.APIClient, kind, input string) (string, string, error) {
	switch kind {
	case "issue":
		ref, err := resolveIssueRef(ctx, client, input)
		if err != nil {
			return "", "", err
		}
		return "issue", ref.ID, nil
	case "project":
		ref, err := resolveProjectID(ctx, client, input)
		if err != nil {
			return "", "", err
		}
		return "project", ref.ID, nil
	case "view":
		ref, err := resolveIssueViewID(ctx, client, input)
		if err != nil {
			return "", "", err
		}
		return "view", ref.ID, nil
	default:
		return "", "", fmt.Errorf("type must be issue, project or view")
	}
}

func runPinList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	// include=view declares that this client understands view pins; without it
	// the server hides them for older clients.
	var pins []map[string]any
	if err := client.GetJSON(ctx, "/api/pins?include=view", &pins); err != nil {
		return fmt.Errorf("list pins: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(pins, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"pins": rows, "total": len(pins)})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, p := range rows {
		id := strVal(p, "id")
		item := strVal(p, "item_id")
		if !fullID {
			id = shortID(id)
			item = shortID(item)
		}
		out = append(out, []string{
			id,
			blankDash(strVal(p, "item_type")),
			item,
			strconv.FormatFloat(floatVal(p, "position"), 'f', -1, 64),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"PIN", "TYPE", "ITEM", "POSITION"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d pinned item(s).\n", len(rows))
	return nil
}

func runPinAdd(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	kind, itemID, err := resolvePinTarget(ctx, client, strings.ToLower(strings.TrimSpace(args[0])), args[1])
	if err != nil {
		return err
	}
	var resp map[string]any
	if err := client.PostJSON(ctx, "/api/pins", map[string]any{"item_type": kind, "item_id": itemID}, &resp); err != nil {
		return fmt.Errorf("pin %s: %w", kind, err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), resp)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "pinned %s %s as %s\n", kind, shortID(itemID), shortID(strVal(resp, "id")))
	return nil
}

func runPinRemove(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	kind, itemID, err := resolvePinTarget(ctx, client, strings.ToLower(strings.TrimSpace(args[0])), args[1])
	if err != nil {
		return err
	}
	path := "/api/pins/" + url.PathEscape(kind) + "/" + url.PathEscape(itemID)
	if err := client.DeleteJSON(ctx, path); err != nil {
		return fmt.Errorf("unpin %s: %w", kind, err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "unpinned %s %s\n", kind, itemID)
	return nil
}

func runPinReorder(cmd *cobra.Command, args []string) error {
	items := make([]map[string]any, 0, len(args))
	for _, raw := range args {
		parts := strings.SplitN(raw, "=", 2)
		if len(parts) != 2 {
			return fmt.Errorf("expected <pin-id>=<position>, got %q", raw)
		}
		id := strings.TrimSpace(parts[0])
		position, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		if err != nil {
			return fmt.Errorf("position for pin %q is not a number: %w", id, err)
		}
		items = append(items, map[string]any{"id": id, "position": position})
	}
	return doJSONWrite(cmd, "PUT", "/api/pins/reorder", map[string]any{"items": items}, "reorder pins")
}
