package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 收件箱是工作区里唯一「按人」的通知面：它没有独立的写模型（通知由服务端在
// 任务/评论/状态变化时生成），用户能做的只有读、标记已读、归档。过去这些按钮
// 只在 UI 里，agent 无法清空自己的队列，也无法在开工前确认「有没有人 @ 我」。
var inboxCmd = &cobra.Command{
	Use:   "inbox",
	Short: "Read and triage your inbox (notifications addressed to you)",
	Long: `The inbox is per person, not per workspace role: every command here acts on the
notifications addressed to the current token's user.

  multica inbox list [--limit 50]                 unread + read, active only
  multica inbox archived [--limit 50]             the Archived sub-view
  multica inbox unread                           unread count for this workspace
  multica inbox summary                          unread counts across EVERY workspace you belong to
  multica inbox read <id>                        mark one notification read
  multica inbox mark-unread <id>                 flip one back to unread
  multica inbox archive <id>                     archive one
  multica inbox unarchive <id>
  multica inbox mark-all-read                    every active item in this workspace
  multica inbox archive-all                      archive every active item
  multica inbox archive-read                     archive only the read ones
  multica inbox archive-completed                archive items whose issue reached a terminal status

Archiving is reversible (unarchive), so none of these need --yes. Deleting the
underlying issue/task is what actually removes a notification.`,
}

var inboxListCmd = &cobra.Command{
	Use:   "list",
	Short: "List active inbox notifications",
	Args:  cobra.NoArgs,
	RunE:  runInboxList,
}

var inboxArchivedCmd = &cobra.Command{
	Use:   "archived",
	Short: "List archived inbox notifications",
	Args:  cobra.NoArgs,
	RunE:  runInboxArchived,
}

var inboxUnreadCmd = &cobra.Command{
	Use:   "unread",
	Short: "Count unread notifications in this workspace",
	Args:  cobra.NoArgs,
	RunE:  runInboxUnread,
}

var inboxSummaryCmd = &cobra.Command{
	Use:   "summary",
	Short: "Unread counts across every workspace you belong to",
	Args:  cobra.NoArgs,
	RunE:  runInboxSummary,
}

var inboxReadCmd = &cobra.Command{
	Use:   "read <notification-id>",
	Short: "Mark one notification read",
	Args:  exactArgs(1),
	RunE:  inboxItemAction("read", "mark read"),
}

var inboxMarkUnreadCmd = &cobra.Command{
	Use:   "mark-unread <notification-id>",
	Short: "Mark one notification unread again",
	Args:  exactArgs(1),
	RunE:  inboxItemAction("unread", "mark unread"),
}

var inboxArchiveCmd = &cobra.Command{
	Use:   "archive <notification-id>",
	Short: "Archive one notification",
	Args:  exactArgs(1),
	RunE:  inboxItemAction("archive", "archive"),
}

var inboxUnarchiveCmd = &cobra.Command{
	Use:   "unarchive <notification-id>",
	Short: "Move one notification back to the active list",
	Args:  exactArgs(1),
	RunE:  inboxItemAction("unarchive", "unarchive"),
}

var inboxMarkAllReadCmd = &cobra.Command{
	Use:   "mark-all-read",
	Short: "Mark every active notification read",
	Args:  cobra.NoArgs,
	RunE:  inboxBulkAction("mark-all-read", "mark all read"),
}

var inboxArchiveAllCmd = &cobra.Command{
	Use:   "archive-all",
	Short: "Archive every active notification",
	Args:  cobra.NoArgs,
	RunE:  inboxBulkAction("archive-all", "archive all"),
}

var inboxArchiveReadCmd = &cobra.Command{
	Use:   "archive-read",
	Short: "Archive only the notifications already read",
	Args:  cobra.NoArgs,
	RunE:  inboxBulkAction("archive-all-read", "archive read"),
}

var inboxArchiveCompletedCmd = &cobra.Command{
	Use:   "archive-completed",
	Short: "Archive notifications whose issue is in a terminal status",
	Args:  cobra.NoArgs,
	RunE:  inboxBulkAction("archive-completed", "archive completed"),
}

func init() {
	for _, c := range []*cobra.Command{inboxListCmd, inboxArchivedCmd} {
		c.Flags().Int("limit", 50, "Cap the rows printed (0 = all)")
		c.Flags().Bool("full-id", false, "Print full notification ids instead of 8-character prefixes")
		c.Flags().String("output", "table", "Output format: table or json")
	}
	for _, c := range []*cobra.Command{inboxUnreadCmd, inboxSummaryCmd} {
		c.Flags().String("output", "json", "Output format: table or json")
	}
	for _, c := range []*cobra.Command{
		inboxReadCmd, inboxMarkUnreadCmd, inboxArchiveCmd, inboxUnarchiveCmd,
		inboxMarkAllReadCmd, inboxArchiveAllCmd, inboxArchiveReadCmd, inboxArchiveCompletedCmd,
	} {
		c.Flags().String("output", "json", "Output format: json or table")
	}

	inboxCmd.AddCommand(inboxListCmd)
	inboxCmd.AddCommand(inboxArchivedCmd)
	inboxCmd.AddCommand(inboxUnreadCmd)
	inboxCmd.AddCommand(inboxSummaryCmd)
	inboxCmd.AddCommand(inboxReadCmd)
	inboxCmd.AddCommand(inboxMarkUnreadCmd)
	inboxCmd.AddCommand(inboxArchiveCmd)
	inboxCmd.AddCommand(inboxUnarchiveCmd)
	inboxCmd.AddCommand(inboxMarkAllReadCmd)
	inboxCmd.AddCommand(inboxArchiveAllCmd)
	inboxCmd.AddCommand(inboxArchiveReadCmd)
	inboxCmd.AddCommand(inboxArchiveCompletedCmd)
}

func runInboxList(cmd *cobra.Command, _ []string) error {
	return fetchInboxItems(cmd, "/api/inbox", "active")
}

func runInboxArchived(cmd *cobra.Command, _ []string) error {
	return fetchInboxItems(cmd, "/api/inbox/archived", "archived")
}

func fetchInboxItems(cmd *cobra.Command, path, view string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var items []map[string]any
	if err := client.GetJSON(ctx, path, &items); err != nil {
		return fmt.Errorf("list inbox: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(items, limit)

	unread := 0
	for _, item := range rows {
		if isTrue(item["read"]) == false {
			unread++
		}
	}

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
			"source":       path,
			"view":         view,
			"items":        rows,
			"returned":     len(rows),
			"unread_shown": unread,
		})
	}

	headers := []string{"ID", "READ", "TYPE", "SEVERITY", "ISSUE", "TITLE", "CREATED"}
	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, item := range rows {
		id := strVal(item, "id")
		if !fullID {
			id = shortID(id)
		}
		out = append(out, []string{
			id,
			readMarker(item),
			blankDash(strVal(item, "type")),
			blankDash(strVal(item, "severity")),
			blankDash(shortID(strVal(item, "issue_id"))),
			truncateCell(strVal(item, "title"), 52),
			shortTimestamp(strVal(item, "created_at")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d %s notification(s), %d unread. Use `multica inbox read <id>` / `archive <id>` to triage.\n",
		len(rows), view, unread)
	return nil
}

func runInboxUnread(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp map[string]any
	if err := client.GetJSON(ctx, "/api/inbox/unread-count", &resp); err != nil {
		return fmt.Errorf("count unread inbox: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), resp)
}

func runInboxSummary(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	// Account-level: it deliberately ignores the active workspace.
	var rows []map[string]any
	if err := client.GetJSON(ctx, "/api/inbox/unread-summary", &rows); err != nil {
		return fmt.Errorf("summarize unread inbox: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"workspaces": rows, "total": len(rows)})
	}
	headers := []string{"WORKSPACE", "UNREAD"}
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, []string{shortID(strVal(row, "workspace_id")), strVal(row, "count")})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	return nil
}

func inboxItemAction(action, verb string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()

		path := "/api/inbox/" + url.PathEscape(args[0]) + "/" + action
		var resp map[string]any
		if err := client.PostJSON(ctx, path, nil, &resp); err != nil {
			return fmt.Errorf("%s notification: %w", verb, err)
		}
		if output, _ := cmd.Flags().GetString("output"); output == "json" {
			return cli.PrintJSON(cmd.OutOrStdout(), resp)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s: %s (%s)\n", verb, shortID(strVal(resp, "id")), strVal(resp, "title"))
		return nil
	}
}

func inboxBulkAction(pathSuffix, verb string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()

		var resp map[string]any
		if err := client.PostJSON(ctx, "/api/inbox/"+pathSuffix, nil, &resp); err != nil {
			return fmt.Errorf("%s notifications: %w", verb, err)
		}
		if output, _ := cmd.Flags().GetString("output"); output == "json" {
			return cli.PrintJSON(cmd.OutOrStdout(), resp)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s: %s notification(s) affected\n", verb, strVal(resp, "count"))
		return nil
	}
}

// ---------------------------------------------------------------------------
// notification preferences
// ---------------------------------------------------------------------------

// validNotifGroups mirrors the server's accepted keys; rejecting them locally
// turns a 400 into an error that names the allowed set.
var validNotifGroups = []string{
	"assignments", "status_changes", "comments", "mentions",
	"updates", "agent_activity", "system_notifications",
}

var notificationCmd = &cobra.Command{
	Use:   "notification",
	Short: "Read and update your notification preferences",
	Long: `Preferences are per (workspace, user) and each group is either "all" or "muted".

  multica notification get
  multica notification set --prefs '{"comments":"muted"}'
  multica notification set --group comments --value muted
  multica notification set --prefs '{...}' --replace     (PUT: drop keys you omitted)

Groups: ` + strings.Join(validNotifGroups, ", ") + `
system_notifications is the native OS banner switch, not an inbox group.`,
}

var notificationGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Show your notification preferences",
	Args:  cobra.NoArgs,
	RunE:  runNotificationGet,
}

var notificationSetCmd = &cobra.Command{
	Use:   "set",
	Short: "Merge (or replace) notification preferences",
	Args:  cobra.NoArgs,
	RunE:  runNotificationSet,
}

func init() {
	notificationGetCmd.Flags().String("output", "json", "Output format: json or table")
	notificationSetCmd.Flags().String("prefs", "", `JSON object of group → "all"|"muted", e.g. '{"comments":"muted"}'`)
	notificationSetCmd.Flags().String("group", "", "Single group to set (use with --value)")
	notificationSetCmd.Flags().String("value", "", "Value for --group: all or muted")
	notificationSetCmd.Flags().Bool("replace", false, "Replace the whole map instead of merging (drops omitted keys)")
	notificationSetCmd.Flags().String("output", "json", "Output format: json or table")

	notificationCmd.AddCommand(notificationGetCmd)
	notificationCmd.AddCommand(notificationSetCmd)
}

func runNotificationGet(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp map[string]any
	if err := client.GetJSON(ctx, "/api/notification-preferences", &resp); err != nil {
		return fmt.Errorf("get notification preferences: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), resp)
	}
	prefs, _ := resp["preferences"].(map[string]any)
	headers := []string{"GROUP", "VALUE"}
	out := make([][]string, 0, len(validNotifGroups))
	for _, group := range validNotifGroups {
		value := "all"
		if v, ok := prefs[group]; ok && v != nil {
			value = fmt.Sprintf("%v", v)
		}
		out = append(out, []string{group, value})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	return nil
}

func runNotificationSet(cmd *cobra.Command, _ []string) error {
	prefs, err := notificationPrefsFromFlags(cmd)
	if err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp map[string]any
	if replace, _ := cmd.Flags().GetBool("replace"); replace {
		err = client.PutJSON(ctx, "/api/notification-preferences", prefs, &resp)
	} else {
		err = client.PatchJSON(ctx, "/api/notification-preferences", prefs, &resp)
	}
	if err != nil {
		return fmt.Errorf("set notification preferences: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), resp)
}

func notificationPrefsFromFlags(cmd *cobra.Command) (map[string]string, error) {
	raw, _ := cmd.Flags().GetString("prefs")
	group, _ := cmd.Flags().GetString("group")
	value, _ := cmd.Flags().GetString("value")

	prefs := map[string]string{}
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &prefs); err != nil {
			return nil, fmt.Errorf("--prefs must be a JSON object of strings: %w", err)
		}
	}
	if strings.TrimSpace(group) != "" || strings.TrimSpace(value) != "" {
		if group == "" || value == "" {
			return nil, fmt.Errorf("--group and --value must be used together")
		}
		prefs[group] = value
	}
	if len(prefs) == 0 {
		return nil, fmt.Errorf("nothing to set: pass --prefs or --group/--value")
	}
	for g, v := range prefs {
		if !containsString(validNotifGroups, g) {
			return nil, fmt.Errorf("unknown notification group %q (allowed: %s)", g, strings.Join(validNotifGroups, ", "))
		}
		if v != "all" && v != "muted" {
			return nil, fmt.Errorf("group %q must be \"all\" or \"muted\", got %q", g, v)
		}
	}
	return prefs, nil
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

// readMarker renders the read/unread cell; JSON keeps the raw boolean, this is
// only for the table view.
func readMarker(item map[string]any) string {
	if isTrue(item["read"]) {
		return "yes"
	}
	return "NEW"
}

func isTrue(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

// shortTimestamp trims an RFC3339 timestamp to "YYYY-MM-DD HH:MM" for tables.
func shortTimestamp(value string) string {
	if len(value) < 16 {
		return blankDash(value)
	}
	return value[:10] + " " + value[11:16]
}
