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

// 插件（Settings → Plugins）：装、配、启停、卸、发 token、看调用记录。安装是
// 两步——preview 只读清单与 scope，install 才是写入。发布 bundle 是插件作者的
// multipart 流程，CLI 不提供。
var pluginCmd = &cobra.Command{
	Use:   "plugin",
	Short: "Install, configure and inspect workspace Plugins",
	Long: `Workspace Plugins are gated behind a server feature flag: when it is off every
command here answers 404/501, which is not a permission problem.

Install is two steps on purpose. ` + "`plugin preview --version <id>`" + ` reads the
manifest and the scope list without writing anything; ` + "`plugin install --version <id>`" + `
is the consent. Publishing a bundle (multipart zip) is an authoring flow with no
CLI surface.`,
}

var pluginListCmd = &cobra.Command{
	Use:   "list",
	Short: "List installed Plugins",
	Args:  cobra.NoArgs,
	RunE:  runPluginList,
}

var pluginInvocationsCmd = &cobra.Command{
	Use:   "invocations <plugin-id>",
	Short: "Show a Plugin's recent hook invocations",
	Args:  exactArgs(1),
	RunE:  runPluginInvocations,
}

var pluginEnableCmd = &cobra.Command{
	Use:   "enable <plugin-id>",
	Short: "Enable an installed Plugin",
	Args:  exactArgs(1),
	RunE:  pluginToggle(true),
}

var pluginDisableCmd = &cobra.Command{
	Use:   "disable <plugin-id>",
	Short: "Disable an installed Plugin without uninstalling it",
	Args:  exactArgs(1),
	RunE:  pluginToggle(false),
}

var pluginConfigCmd = &cobra.Command{
	Use:   "config <plugin-id>",
	Short: "Write a Plugin's configuration values",
	Long: `Values are the host-rendered fields from ` + "`plugin list --output json`" + ` (key →
config_schema). Secret fields belong in --values-file or --values-stdin: an inline
value lands in shell history and ps.

The document replaces the stored values for the keys it names.`,
	Args: exactArgs(1),
	RunE: runPluginConfig,
}

var pluginPreviewCmd = &cobra.Command{
	Use:   "preview",
	Short: "Read a published version's manifest and scopes (writes nothing)",
	Args:  cobra.NoArgs,
	RunE:  runPluginPreview,
}

var pluginInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install a published Plugin version",
	Long: `Installs the version you previewed. Passing --scope is a narrower grant than
the manifest asked for; the server refuses to install without the scopes the
Plugin declares mandatory, so a refusal here means "grant the listed scopes or
do not install".`,
	Args: cobra.NoArgs,
	RunE: runPluginInstall,
}

var pluginUninstallCmd = &cobra.Command{
	Use:   "uninstall <plugin-id> --yes",
	Short: "Uninstall a Plugin and drop its token",
	Args:  exactArgs(1),
	RunE:  runPluginUninstall,
}

var pluginTokenCmd = &cobra.Command{
	Use:   "token",
	Short: "Rotate or revoke a Plugin's callback token",
}

var pluginTokenRotateCmd = &cobra.Command{
	Use:   "rotate <plugin-id>",
	Short: "Mint a new callback token (the old one stops working)",
	Args:  exactArgs(1),
	RunE:  runPluginTokenRotate,
}

var pluginTokenRevokeCmd = &cobra.Command{
	Use:   "revoke <plugin-id> --yes",
	Short: "Revoke the callback token without uninstalling",
	Args:  exactArgs(1),
	RunE:  runPluginTokenRevoke,
}

var pluginSurfaceCmd = &cobra.Command{
	Use:   "surface <plugin-id> <surface-key>",
	Short: "Fetch a Plugin surface's launch payload",
	Args:  exactArgs(2),
	RunE:  runPluginSurface,
}

var pluginMCPCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Inspect and approve a Plugin's MCP tools",
}

var pluginMCPToolsCmd = &cobra.Command{
	Use:   "tools <plugin-id> <hook-key>",
	Short: "List the tools an MCP hook exposes, with approval state",
	Args:  exactArgs(2),
	RunE:  runPluginMCPTools,
}

var pluginMCPApproveCmd = &cobra.Command{
	Use:   "approve <plugin-id> <hook-key>",
	Short: "Replace the approved tool set for one MCP hook",
	Long: `Takes the COMPLETE approved set, not a delta: omitting a tool revokes it. The
approval pins each tool by schema digest, so a provider that later changes a
tool's schema shows up as drifted and has to be re-approved.`,
	Args: exactArgs(2),
	RunE: runPluginMCPApprove,
}

var pluginPackageCmd = &cobra.Command{
	Use:   "package",
	Short: "Inspect published Plugin packages",
}

var pluginPackageListCmd = &cobra.Command{
	Use:   "list",
	Short: "List published packages in this workspace",
	Args:  cobra.NoArgs,
	RunE:  runPluginPackageList,
}

var pluginPackagePublishLocalCmd = &cobra.Command{
	Use:   "publish-local",
	Short: "Publish a bundle from the server's local Plugin directory",
	Long: `For development on the server host: publishes the directory named by --name
that already exists on the server's disk. Not the way to ship a Plugin to a
shared workspace.`,
	Args: cobra.NoArgs,
	RunE: runPluginPackagePublishLocal,
}

var pluginPackageDeleteCmd = &cobra.Command{
	Use:   "delete <package-id> --yes",
	Short: "Delete a published package",
	Args:  exactArgs(1),
	RunE:  runPluginPackageDelete,
}

func init() {
	pluginListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	pluginListCmd.Flags().Bool("full-id", false, "Print full ids instead of 8-character prefixes")
	pluginListCmd.Flags().String("output", "table", "Output format: table or json")

	pluginInvocationsCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	pluginInvocationsCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{pluginEnableCmd, pluginDisableCmd, pluginInstallCmd, pluginConfigCmd, pluginSurfaceCmd} {
		c.Flags().String("output", "json", "Output format: json or table")
	}

	pluginConfigCmd.Flags().String("values", "", "Configuration values as JSON (avoid: lands in shell history)")
	pluginConfigCmd.Flags().String("values-file", "", "Read the values JSON from a file")
	pluginConfigCmd.Flags().Bool("values-stdin", false, "Read the values JSON from stdin")

	pluginPreviewCmd.Flags().String("version", "", "Published package version id (required)")
	pluginPreviewCmd.Flags().String("output", "json", "Output format: json or table")

	pluginInstallCmd.Flags().String("version", "", "Published package version id (required)")
	pluginInstallCmd.Flags().StringSlice("scope", nil, "Granted scopes (repeatable; default = everything the manifest asks for)")

	pluginMCPToolsCmd.Flags().String("output", "json", "Output format: json or table")
	pluginMCPApproveCmd.Flags().StringSlice("tools", nil, "Tool names to approve (the complete set)")
	pluginMCPApproveCmd.Flags().String("tools-file", "", "Read the approved tool names from a JSON array or one-per-line file")
	pluginMCPApproveCmd.Flags().String("output", "json", "Output format: json or table")

	pluginPackageListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	pluginPackageListCmd.Flags().String("output", "table", "Output format: table or json")
	pluginPackagePublishLocalCmd.Flags().String("name", "", "Directory name under the server's local Plugin root (required)")
	pluginPackagePublishLocalCmd.Flags().String("output", "json", "Output format: json or table")

	addDestructiveFlags(pluginUninstallCmd)
	addDestructiveFlags(pluginTokenRevokeCmd)
	addDestructiveFlags(pluginPackageDeleteCmd)

	pluginTokenCmd.AddCommand(pluginTokenRotateCmd)
	pluginTokenCmd.AddCommand(pluginTokenRevokeCmd)
	pluginMCPCmd.AddCommand(pluginMCPToolsCmd)
	pluginMCPCmd.AddCommand(pluginMCPApproveCmd)
	pluginPackageCmd.AddCommand(pluginPackageListCmd)
	pluginPackageCmd.AddCommand(pluginPackagePublishLocalCmd)
	pluginPackageCmd.AddCommand(pluginPackageDeleteCmd)

	pluginCmd.AddCommand(pluginListCmd)
	pluginCmd.AddCommand(pluginInvocationsCmd)
	pluginCmd.AddCommand(pluginEnableCmd)
	pluginCmd.AddCommand(pluginDisableCmd)
	pluginCmd.AddCommand(pluginConfigCmd)
	pluginCmd.AddCommand(pluginPreviewCmd)
	pluginCmd.AddCommand(pluginInstallCmd)
	pluginCmd.AddCommand(pluginUninstallCmd)
	pluginCmd.AddCommand(pluginTokenCmd)
	pluginCmd.AddCommand(pluginSurfaceCmd)
	pluginCmd.AddCommand(pluginMCPCmd)
	pluginCmd.AddCommand(pluginPackageCmd)
}

// resolvePluginID accepts a full UUID or a unique prefix among installed Plugins.
func resolvePluginID(ctx context.Context, client *cli.APIClient, cmd *cobra.Command, input string) (resolvedID, error) {
	prefix, err := workspacePathPrefix(cmd)
	if err != nil {
		return resolvedID{}, err
	}
	return resolveIDByPrefix(ctx, client, "plugin", input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var rows []map[string]any
		if err := client.GetJSON(ctx, prefix+"/plugins", &rows); err != nil {
			return nil, err
		}
		out := make([]idCandidate, 0, len(rows))
		for _, row := range rows {
			out = append(out, idCandidate{
				ID:      strVal(row, "id"),
				Display: strVal(row, "name"),
				Detail:  strVal(row, "plugin_key"),
			})
		}
		return out, nil
	})
}

// pluginPath resolves the installation and returns the workspace-scoped base URL.
func pluginPath(cmd *cobra.Command) (prefix string, client *cli.APIClient, ctx context.Context, cancel func(), err error) {
	prefix, err = workspacePathPrefix(cmd)
	if err != nil {
		return "", nil, nil, nil, err
	}
	client, err = newAPIClient(cmd)
	if err != nil {
		return "", nil, nil, nil, err
	}
	ctx, cancel = cli.APIContext(context.Background())
	return prefix, client, ctx, cancel, nil
}

func runPluginList(cmd *cobra.Command, _ []string) error {
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	var rows []map[string]any
	if err := client.GetJSON(ctx, prefix+"/plugins", &rows); err != nil {
		return fmt.Errorf("list plugins: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows = capRows(rows, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"plugins": rows, "total": len(rows)})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		id := strVal(row, "id")
		if !fullID {
			id = shortID(id)
		}
		out = append(out, []string{
			id,
			truncateCell(blankDash(strVal(row, "plugin_key")), 24),
			truncateCell(blankDash(strVal(row, "name")), 28),
			blankDash(strVal(row, "version")),
			yesNo(isTrue(row["enabled"])),
			compactCount(row, "granted_scopes"),
			compactCount(row, "configured_secrets"),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "KEY", "NAME", "VERSION", "ENABLED", "SCOPES", "SECRETS"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d plugin(s).\n", len(rows))
	return nil
}

func runPluginInvocations(cmd *cobra.Command, args []string) error {
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	var resp struct {
		Invocations []map[string]any `json:"invocations"`
	}
	if err := client.GetJSON(ctx, prefix+"/plugins/"+url.PathEscape(ref.ID)+"/invocations", &resp); err != nil {
		return fmt.Errorf("list plugin invocations: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(resp.Invocations, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"invocations": rows, "total": len(rows)})
	}

	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, []string{
			shortTimestamp(strVal(row, "created_at")),
			blankDash(strVal(row, "hook_key")),
			blankDash(strVal(row, "trigger")),
			blankDash(strVal(row, "status")),
			compactCount(row, "attempt"),
			compactCount(row, "latency_ms"),
			truncateCell(blankDash(strVal(row, "error")), 32),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"WHEN", "HOOK", "TRIGGER", "STATUS", "TRY", "MS", "ERROR"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d invocation(s).\n", len(rows))
	return nil
}

func pluginToggle(enable bool) func(*cobra.Command, []string) error {
	action := "disable"
	if enable {
		action = "enable"
	}
	return func(cmd *cobra.Command, args []string) error {
		prefix, client, ctx, cancel, err := pluginPath(cmd)
		if err != nil {
			return err
		}
		defer cancel()

		ref, err := resolvePluginID(ctx, client, cmd, args[0])
		if err != nil {
			return err
		}
		return doJSONWrite(cmd, "POST", prefix+"/plugins/"+url.PathEscape(ref.ID)+"/"+action, nil, action+" plugin")
	}
}

func runPluginConfig(cmd *cobra.Command, args []string) error {
	raw, ok, err := resolveTextFlag(cmd, "values")
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("--values, --values-file or --values-stdin is required (a JSON object)")
	}
	var values map[string]any
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return fmt.Errorf("--values must be a JSON object: %w", err)
	}
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	body := map[string]any{"values": values}
	return doJSONWrite(cmd, "PUT", prefix+"/plugins/"+url.PathEscape(ref.ID)+"/config", body, "configure plugin")
}

func runPluginPreview(cmd *cobra.Command, _ []string) error {
	version, _ := cmd.Flags().GetString("version")
	version = strings.TrimSpace(version)
	if version == "" {
		return fmt.Errorf("--version is required (the published package version id from `multica plugin package list`)")
	}
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	var preview map[string]any
	if err := client.PostJSON(ctx, prefix+"/plugins/preview", map[string]any{"version_id": version}, &preview); err != nil {
		return fmt.Errorf("preview plugin: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), preview)
	}
	printPluginPreview(cmd, preview)
	return nil
}

func printPluginPreview(cmd *cobra.Command, preview map[string]any) {
	name := strVal(preview, "version")
	if manifest, ok := preview["manifest"].(map[string]any); ok {
		if v := strVal(manifest, "name"); v != "" {
			name = v + " " + name
		}
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n", strings.TrimSpace(name))
	fmt.Fprintf(cmd.OutOrStdout(), "Version id: %s\n", blankDash(strVal(preview, "version_id")))
	fmt.Fprintf(cmd.OutOrStdout(), "Digest:     %s\n", blankDash(strVal(preview, "digest")))
	fmt.Fprintf(cmd.OutOrStdout(), "Installed:  %s\n", yesNo(isTrue(preview["installed"])))
	if v := strVal(preview, "installed_version"); v != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "On disk:    %s\n", v)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Scopes:     %s\n", strings.Join(toStringSlice(preview["scopes"]), ", "))
	if added := toStringSlice(preview["added_scopes"]); len(added) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "New scopes: %s\n", strings.Join(added, ", "))
	}
}

func runPluginInstall(cmd *cobra.Command, _ []string) error {
	version, _ := cmd.Flags().GetString("version")
	version = strings.TrimSpace(version)
	if version == "" {
		return fmt.Errorf("--version is required (preview it first with `multica plugin preview --version <id>`)")
	}
	body := map[string]any{"version_id": version}
	if scopes, _ := cmd.Flags().GetStringSlice("scope"); len(scopes) > 0 {
		body["granted_scopes"] = scopes
	}
	prefix, err := workspacePathPrefix(cmd)
	if err != nil {
		return err
	}
	return doJSONWrite(cmd, "POST", prefix+"/plugins", body, "install plugin")
}

func runPluginUninstall(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Uninstall plugin %s. Its token is revoked and its hooks stop firing.", args[0])); err != nil {
		return err
	}
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, prefix+"/plugins/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("uninstall plugin: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "uninstalled plugin %s\n", ref.ID)
	return nil
}

func runPluginTokenRotate(cmd *cobra.Command, args []string) error {
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	var resp map[string]any
	if err := client.PostJSON(ctx, prefix+"/plugins/"+url.PathEscape(ref.ID)+"/token", nil, &resp); err != nil {
		return fmt.Errorf("rotate plugin token: %w", err)
	}
	// The token is returned exactly once; print it to the person and never
	// write it into an issue, a comment, or a document others can read.
	return cli.PrintJSON(cmd.OutOrStdout(), resp)
}

func runPluginTokenRevoke(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Revoke plugin %s's callback token. Its hooks will fail until you rotate.", args[0])); err != nil {
		return err
	}
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, prefix+"/plugins/"+url.PathEscape(ref.ID)+"/token"); err != nil {
		return fmt.Errorf("revoke plugin token: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "revoked token for plugin %s\n", ref.ID)
	return nil
}

func runPluginSurface(cmd *cobra.Command, args []string) error {
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	path := prefix + "/plugins/" + url.PathEscape(ref.ID) + "/surfaces/" + url.PathEscape(args[1]) + "/launch"
	var payload map[string]any
	if err := client.GetJSON(ctx, path, &payload); err != nil {
		return fmt.Errorf("launch plugin surface: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), payload)
}

func runPluginMCPTools(cmd *cobra.Command, args []string) error {
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	path := prefix + "/plugins/" + url.PathEscape(ref.ID) + "/mcp/" + url.PathEscape(args[1]) + "/tools"
	var resp struct {
		Tools []map[string]any `json:"tools"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("list plugin MCP tools: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), resp)
	}
	out := make([][]string, 0, len(resp.Tools))
	for _, tool := range resp.Tools {
		out = append(out, []string{
			blankDash(strVal(tool, "name")),
			yesNo(isTrue(tool["approved"])),
			yesNo(isTrue(tool["drifted"])),
			truncateCell(blankDash(strVal(tool, "description")), 48),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"TOOL", "APPROVED", "DRIFTED", "DESCRIPTION"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d tool(s). Drifted tools were approved with an older schema and need re-approval.\n", len(resp.Tools))
	return nil
}

func runPluginMCPApprove(cmd *cobra.Command, args []string) error {
	tools, _ := cmd.Flags().GetStringSlice("tools")
	if filePath, _ := cmd.Flags().GetString("tools-file"); strings.TrimSpace(filePath) != "" {
		if len(tools) > 0 {
			return fmt.Errorf("--tools and --tools-file are mutually exclusive")
		}
		if err := ensureFileFlagWithinWorkdir(cmd, "tools-file", "tools", filePath); err != nil {
			return err
		}
		data, err := readWorkdirFile(filePath)
		if err != nil {
			return err
		}
		trimmed := strings.TrimSpace(string(data))
		if strings.HasPrefix(trimmed, "[") {
			if err := json.Unmarshal([]byte(trimmed), &tools); err != nil {
				return fmt.Errorf("--tools-file must be a JSON array of strings or one name per line: %w", err)
			}
		} else {
			for _, line := range strings.Split(trimmed, "\n") {
				if name := strings.TrimSpace(line); name != "" {
					tools = append(tools, name)
				}
			}
		}
	}

	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	ref, err := resolvePluginID(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	path := prefix + "/plugins/" + url.PathEscape(ref.ID) + "/mcp/" + url.PathEscape(args[1]) + "/tools"
	body := map[string]any{"tools": tools}
	return doJSONWrite(cmd, "PUT", path, body, fmt.Sprintf("approve %d plugin MCP tool(s)", len(tools)))
}

// toStringSlice flattens a JSON array of strings and drops non-string entries.
func toStringSlice(value any) []string {
	items := anySlice(value)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func runPluginPackageList(cmd *cobra.Command, _ []string) error {
	prefix, client, ctx, cancel, err := pluginPath(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	var resp struct {
		Packages []map[string]any `json:"packages"`
	}
	if err := client.GetJSON(ctx, prefix+"/plugins/packages", &resp); err != nil {
		return fmt.Errorf("list plugin packages: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(resp.Packages, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"packages": rows, "total": len(rows)})
	}
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, []string{
			shortID(strVal(row, "id")),
			truncateCell(blankDash(strVal(row, "name")), 28),
			blankDash(strVal(row, "version")),
			shortTimestamp(strVal(row, "created_at")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "NAME", "VERSION", "PUBLISHED"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d package(s). Use a version id from --output json with `plugin preview --version`.\n", len(rows))
	return nil
}

func runPluginPackagePublishLocal(cmd *cobra.Command, _ []string) error {
	name, _ := cmd.Flags().GetString("name")
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("--name is required (a directory under the server's local Plugin root)")
	}
	prefix, err := workspacePathPrefix(cmd)
	if err != nil {
		return err
	}
	return doJSONWrite(cmd, "POST", prefix+"/plugins/packages/local", map[string]any{"name": name}, "publish local plugin package")
}

func runPluginPackageDelete(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Delete published plugin package %s. Existing installations keep running; new installs of it fail.", args[0])); err != nil {
		return err
	}
	prefix, err := workspacePathPrefix(cmd)
	if err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if err := client.DeleteJSON(ctx, prefix+"/plugins/packages/"+url.PathEscape(strings.TrimSpace(args[0]))); err != nil {
		return fmt.Errorf("delete plugin package: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted plugin package %s\n", args[0])
	return nil
}
