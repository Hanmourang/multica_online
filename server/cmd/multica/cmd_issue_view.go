package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 保存视图（issue views）是筛选器的具名快照：query 里放筛选条件，display 里放
// 列宽/排序。UI 的「保存当前视图」「分享给工作区」两个按钮就是这里的 create
// 与 update --visibility workspace。
var issueViewCmd = &cobra.Command{
	Use:   "issue-view",
	Short: "Create and manage saved issue views (named filter snapshots)",
	Long: `A view stores a filter (query) and a layout (display) under a name, scoped to
the workspace, to My Issues, or to one project.

  multica issue-view list --scope workspace
  multica issue-view list --scope my
  multica issue-view list --scope project --project <id|prefix>
  multica issue-view get <id>
  multica issue-view create --name "My open bugs" --scope workspace \
      --query '{"status":["todo"],"priority":["high"]}'
  multica issue-view update <id> --name "Bugs (P0)" --visibility workspace
  multica issue-view delete <id> --yes
  multica issue-view preference get --scope workspace
  multica issue-view preference set --scope workspace --prefs '{"sort":"updated_at"}'

scope_type: workspace | my | project
scope_variant: my → assigned|created|involved|any; workspace/project → members|agents
visibility: private (default) | workspace — "my" views are always private.

update requires the revision you last read; omit --revision and the CLI reads it
for you, which is right unless another writer is racing you.`,
}

var issueViewListCmd = &cobra.Command{
	Use:   "list",
	Short: "List saved views for one scope",
	Args:  cobra.NoArgs,
	RunE:  runIssueViewList,
}

var issueViewGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Show one saved view",
	Args:  exactArgs(1),
	RunE:  runIssueViewGet,
}

var issueViewCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Save a new view",
	Args:  cobra.NoArgs,
	RunE:  runIssueViewCreate,
}

var issueViewUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Rename, re-scope or re-filter a saved view",
	Args:  exactArgs(1),
	RunE:  runIssueViewUpdate,
}

var issueViewDeleteCmd = &cobra.Command{
	Use:   "delete <id> --yes",
	Short: "Delete a saved view",
	Args:  exactArgs(1),
	RunE:  runIssueViewDelete,
}

var issueViewPreferenceCmd = &cobra.Command{
	Use:   "preference",
	Short: "Read or write your per-scope view preferences",
	Long: `Pins the arrangement you last used for a scope (selected view, sort, hidden
columns). It is UI state, not shared data.

  multica issue-view preference get --scope workspace
  multica issue-view preference set --scope project --project <id> --prefs '{"sort":"updated_at"}'`,
}

var issueViewPreferenceGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Read the preference document for a scope",
	Args:  cobra.NoArgs,
	RunE:  runIssueViewPreferenceGet,
}

var issueViewPreferenceSetCmd = &cobra.Command{
	Use:   "set",
	Short: "Replace the preference document for a scope",
	Args:  cobra.NoArgs,
	RunE:  runIssueViewPreferenceSet,
}

func init() {
	issueViewListCmd.Flags().String("scope", "workspace", "scope_type: workspace | my | project")
	issueViewListCmd.Flags().String("project", "", "Project id (required for --scope project)")
	issueViewListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	issueViewListCmd.Flags().Bool("full-id", false, "Print full ids instead of 8-character prefixes")
	issueViewListCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{issueViewGetCmd} {
		c.Flags().String("output", "json", "Output format: json or table")
	}

	issueViewCreateCmd.Flags().String("name", "", "View name, 1..80 characters (required)")
	issueViewCreateCmd.Flags().String("scope", "workspace", "scope_type: workspace | my | project")
	issueViewCreateCmd.Flags().String("project", "", "Project id for --scope project")
	issueViewCreateCmd.Flags().String("variant", "", "scope_variant (my: assigned|created|involved|any; workspace/project: members|agents)")
	issueViewCreateCmd.Flags().String("visibility", "private", "private | workspace")
	issueViewCreateCmd.Flags().String("query", "", "Filter definition as a JSON object (required)")
	issueViewCreateCmd.Flags().String("query-file", "", "Read --query from a JSON file inside the working directory")
	issueViewCreateCmd.Flags().Bool("allow-external-file", false, "Allow --query-file outside the working directory")
	issueViewCreateCmd.Flags().String("display", "{}", "Layout definition as a JSON object")
	issueViewCreateCmd.Flags().String("output", "json", "Output format: json or table")

	issueViewUpdateCmd.Flags().String("name", "", "New name")
	issueViewUpdateCmd.Flags().String("visibility", "", "private | workspace")
	issueViewUpdateCmd.Flags().String("variant", "", "New scope_variant")
	issueViewUpdateCmd.Flags().String("query", "", "New filter definition as a JSON object")
	issueViewUpdateCmd.Flags().String("query-file", "", "Read --query from a JSON file inside the working directory")
	issueViewUpdateCmd.Flags().Bool("allow-external-file", false, "Allow --query-file outside the working directory")
	issueViewUpdateCmd.Flags().String("display", "", "New layout definition as a JSON object")
	issueViewUpdateCmd.Flags().Int("revision", 0, "Expected revision (default: read it first)")
	issueViewUpdateCmd.Flags().String("output", "json", "Output format: json or table")
	addDestructiveFlags(issueViewDeleteCmd)

	for _, c := range []*cobra.Command{issueViewPreferenceGetCmd} {
		c.Flags().String("scope", "workspace", "scope_type: workspace | my | project")
		c.Flags().String("project", "", "Project id for --scope project")
		c.Flags().String("output", "json", "Output format: json or table")
	}
	issueViewPreferenceSetCmd.Flags().String("scope", "workspace", "scope_type: workspace | my | project")
	issueViewPreferenceSetCmd.Flags().String("project", "", "Project id for --scope project")
	issueViewPreferenceSetCmd.Flags().String("prefs", "{}", "Preference document as a JSON object")
	issueViewPreferenceSetCmd.Flags().String("prefs-file", "", "Read --prefs from a JSON file inside the working directory")
	issueViewPreferenceSetCmd.Flags().Bool("allow-external-file", false, "Allow --prefs-file outside the working directory")
	issueViewPreferenceSetCmd.Flags().String("output", "json", "Output format: json or table")

	issueViewCmd.AddCommand(issueViewListCmd)
	issueViewCmd.AddCommand(issueViewGetCmd)
	issueViewCmd.AddCommand(issueViewCreateCmd)
	issueViewCmd.AddCommand(issueViewUpdateCmd)
	issueViewCmd.AddCommand(issueViewDeleteCmd)
	issueViewCmd.AddCommand(issueViewPreferenceCmd)
	issueViewPreferenceCmd.AddCommand(issueViewPreferenceGetCmd)
	issueViewPreferenceCmd.AddCommand(issueViewPreferenceSetCmd)
}

// resolveIssueViewID accepts a full UUID or a unique prefix, searching every
// scope the caller can see (workspace, my, and each project is not enumerable
// cheaply — so scope is taken from --scope when given).
func resolveIssueViewID(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "issue view", input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		out := make([]idCandidate, 0, 16)
		seen := map[string]bool{}
		for _, scope := range []string{"workspace", "my"} {
			var views []map[string]any
			if err := client.GetJSON(ctx, "/api/issue-views?scope_type="+scope, &views); err != nil {
				return nil, err
			}
			for _, v := range views {
				id := strVal(v, "id")
				if id == "" || seen[id] {
					continue
				}
				seen[id] = true
				out = append(out, idCandidate{ID: id, Display: strVal(v, "name"), Detail: strVal(v, "scope_type")})
			}
		}
		return out, nil
	})
}

// doJSONWrite is the single write path shared by the board-config commands:
// POST/PATCH/PUT with an optional body, printing whatever comes back.
func doJSONWrite(cmd *cobra.Command, method, path string, body map[string]any, verb string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	resp := map[string]any{}
	switch method {
	case "POST":
		err = client.PostJSON(ctx, path, body, &resp)
	case "PATCH":
		err = client.PatchJSON(ctx, path, body, &resp)
	case "PUT":
		err = client.PutJSON(ctx, path, body, &resp)
	default:
		return fmt.Errorf("unsupported method %s", method)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", verb, err)
	}
	if len(resp) == 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "%s: ok\n", verb)
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), resp)
}

// scopeQuery validates the --scope/--project pair and resolves a project prefix
// into the UUID the list and preference endpoints expect.
func scopeQuery(ctx context.Context, client *cli.APIClient, cmd *cobra.Command) (url.Values, error) {
	scope, _ := cmd.Flags().GetString("scope")
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope != "workspace" && scope != "my" && scope != "project" {
		return nil, fmt.Errorf("--scope must be workspace, my or project")
	}
	params := url.Values{"scope_type": {scope}}
	project, _ := cmd.Flags().GetString("project")
	project = strings.TrimSpace(project)
	if scope == "project" && project == "" {
		return nil, fmt.Errorf("--project is required for --scope project")
	}
	if project != "" {
		ref, err := resolveProjectID(ctx, client, project)
		if err != nil {
			return nil, err
		}
		params.Set("scope_id", ref.ID)
	}
	return params, nil
}

func runIssueViewList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	params, err := scopeQuery(ctx, client, cmd)
	if err != nil {
		return err
	}
	var views []map[string]any
	if err := client.GetJSON(ctx, "/api/issue-views?"+params.Encode(), &views); err != nil {
		return fmt.Errorf("list issue views: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(views, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"views": rows, "total": len(views)})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, v := range rows {
		id := strVal(v, "id")
		if !fullID {
			id = shortID(id)
		}
		out = append(out, []string{
			id,
			truncateCell(blankDash(strVal(v, "name")), 40),
			blankDash(strVal(v, "scope_variant")),
			blankDash(strVal(v, "visibility")),
			compactCount(v, "revision"),
			shortTimestamp(strVal(v, "updated_at")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "NAME", "VARIANT", "VISIBILITY", "REV", "UPDATED"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d view(s) in scope %s.\n", len(rows), params.Get("scope_type"))
	return nil
}

func runIssueViewGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueViewID(ctx, client, args[0])
	if err != nil {
		return err
	}
	var view map[string]any
	if err := client.GetJSON(ctx, "/api/issue-views/"+url.PathEscape(ref.ID), &view); err != nil {
		return fmt.Errorf("get issue view: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), view)
}

// readWorkdirFile reads a file the caller has already vetted with
// ensureFileFlagWithinWorkdir.
func readWorkdirFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return data, nil
}

// jsonFlagObject reads a JSON-object flag, optionally from a file. It keeps the
// file path inside the workdir for the same reason every --*-file flag does.
func jsonFlagObject(cmd *cobra.Command, flagName string, required bool) (json.RawMessage, error) {
	raw, _ := cmd.Flags().GetString(flagName)
	if filePath, _ := cmd.Flags().GetString(flagName + "-file"); strings.TrimSpace(filePath) != "" {
		if strings.TrimSpace(raw) != "" {
			return nil, fmt.Errorf("--%s and --%s-file are mutually exclusive", flagName, flagName)
		}
		if err := ensureFileFlagWithinWorkdir(cmd, flagName+"-file", flagName, filePath); err != nil {
			return nil, err
		}
		data, err := readWorkdirFile(filePath)
		if err != nil {
			return nil, err
		}
		raw = string(data)
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if required {
			return nil, fmt.Errorf("--%s is required (a JSON object)", flagName)
		}
		return nil, nil
	}
	if !strings.HasPrefix(raw, "{") || !json.Valid([]byte(raw)) {
		return nil, fmt.Errorf("--%s must be a JSON object, got %q", flagName, truncateCell(raw, 60))
	}
	return json.RawMessage(raw), nil
}

func runIssueViewCreate(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	name, _ := cmd.Flags().GetString("name")
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("--name is required")
	}
	scope, _ := cmd.Flags().GetString("scope")
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope != "workspace" && scope != "my" && scope != "project" {
		return fmt.Errorf("--scope must be workspace, my or project")
	}
	body := map[string]any{"name": name, "scope_type": scope}

	if scope == "project" {
		project, _ := cmd.Flags().GetString("project")
		if strings.TrimSpace(project) == "" {
			return fmt.Errorf("--project is required for --scope project")
		}
		ref, err := resolveProjectID(ctx, client, project)
		if err != nil {
			return err
		}
		body["scope_id"] = ref.ID
	}
	if variant, _ := cmd.Flags().GetString("variant"); strings.TrimSpace(variant) != "" {
		body["scope_variant"] = strings.TrimSpace(variant)
	}
	if visibility, _ := cmd.Flags().GetString("visibility"); strings.TrimSpace(visibility) != "" {
		body["visibility"] = strings.TrimSpace(visibility)
	}

	query, err := jsonFlagObject(cmd, "query", true)
	if err != nil {
		return err
	}
	body["query"] = query
	display, err := jsonFlagObject(cmd, "display", false)
	if err != nil {
		return err
	}
	if display != nil {
		body["display"] = display
	}

	return doJSONWrite(cmd, "POST", "/api/issue-views", body, "create issue view")
}

func runIssueViewUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueViewID(ctx, client, args[0])
	if err != nil {
		return err
	}
	path := "/api/issue-views/" + url.PathEscape(ref.ID)

	body := map[string]any{}
	if cmd.Flags().Changed("name") {
		name, _ := cmd.Flags().GetString("name")
		body["name"] = name
	}
	if cmd.Flags().Changed("visibility") {
		visibility, _ := cmd.Flags().GetString("visibility")
		body["visibility"] = strings.TrimSpace(visibility)
	}
	if cmd.Flags().Changed("variant") {
		variant, _ := cmd.Flags().GetString("variant")
		body["scope_variant"] = strings.TrimSpace(variant)
	}
	query, err := jsonFlagObject(cmd, "query", false)
	if err != nil {
		return err
	}
	if query != nil {
		body["query"] = query
	}
	display, err := jsonFlagObject(cmd, "display", false)
	if err != nil {
		return err
	}
	if display != nil {
		body["display"] = display
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --name, --visibility, --variant, --query or --display")
	}

	// expected_revision is mandatory server-side; read the current one unless
	// the caller pinned it explicitly (the optimistic-concurrency path).
	revision, _ := cmd.Flags().GetInt("revision")
	if revision <= 0 {
		var current map[string]any
		if err := client.GetJSON(ctx, path, &current); err != nil {
			return fmt.Errorf("read issue view for revision: %w", err)
		}
		revision = int(floatVal(current, "revision"))
		if revision <= 0 {
			return fmt.Errorf("could not determine the view's current revision; pass --revision")
		}
	}
	body["expected_revision"] = revision

	return doJSONWrite(cmd, "PATCH", path, body, "update issue view")
}

func runIssueViewDelete(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Delete saved view %s. Anyone it was shared with loses it.", args[0])); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueViewID(ctx, client, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, "/api/issue-views/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("delete issue view: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted issue view %s\n", ref.ID)
	return nil
}

func runIssueViewPreferenceGet(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	params, err := scopeQuery(ctx, client, cmd)
	if err != nil {
		return err
	}
	var pref map[string]any
	if err := client.GetJSON(ctx, "/api/issue-view-preferences?"+params.Encode(), &pref); err != nil {
		return fmt.Errorf("get issue view preference: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), pref)
}

func runIssueViewPreferenceSet(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	params, err := scopeQuery(ctx, client, cmd)
	if err != nil {
		return err
	}
	scopeType := params.Get("scope_type")
	body := map[string]any{"scope_type": scopeType}
	if scopeID := params.Get("scope_id"); scopeID != "" {
		body["scope_id"] = scopeID
	}
	prefs, err := jsonFlagObject(cmd, "prefs", true)
	if err != nil {
		return err
	}
	body["prefs"] = prefs

	return doJSONWrite(cmd, "PUT", "/api/issue-view-preferences", body, "set issue view preference")
}
