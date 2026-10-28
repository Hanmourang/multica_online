package main

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 工作区成员与准入（UI 的 Settings → Members / Invitations / Share links）。
// 这些是 owner/admin 的写面：过去 CLI 只能 `workspace member list` 和
// `workspace member invite`，改角色、踢人、撤销邀请、发分享链接都必须回 UI。
var workspaceMemberRoleCmd = &cobra.Command{
	Use:   "role <member-id> <owner|admin|member>",
	Short: "Change a member's workspace role",
	Args:  exactArgs(2),
	RunE:  runWorkspaceMemberRole,
}

var workspaceMemberRemoveCmd = &cobra.Command{
	Use:   "remove <member-id> --yes",
	Short: "Remove a member from the workspace",
	Args:  exactArgs(1),
	RunE:  runWorkspaceMemberRemove,
}

var workspaceMemberLeaveCmd = &cobra.Command{
	Use:   "leave",
	Short: "Leave the current workspace (as yourself)",
	Args:  cobra.NoArgs,
	RunE:  runWorkspaceMemberLeave,
}

var workspaceInvitationCmd = &cobra.Command{
	Use:   "invitation",
	Short: "Inspect, revoke and answer workspace invitations",
	Long: `  multica workspace invitation list                 pending + past, this workspace (admin)
  multica workspace invitation mine                 invitations addressed to you, any workspace
  multica workspace invitation revoke <id> --yes    cancel a pending invite (admin)
  multica workspace invitation accept <id>          accept an invite addressed to you
  multica workspace invitation decline <id>         decline an invite addressed to you

Inviting someone is ` + "`multica workspace member invite <email>`" + `.`,
}

var workspaceInvitationListCmd = &cobra.Command{
	Use:   "list",
	Short: "List this workspace's invitations",
	Args:  cobra.NoArgs,
	RunE:  runWorkspaceInvitationList,
}

var workspaceInvitationMineCmd = &cobra.Command{
	Use:   "mine",
	Short: "List the pending invitations addressed to you",
	Args:  cobra.NoArgs,
	RunE:  runWorkspaceInvitationMine,
}

var workspaceInvitationRevokeCmd = &cobra.Command{
	Use:   "revoke <invitation-id> --yes",
	Short: "Revoke a pending invitation",
	Args:  exactArgs(1),
	RunE:  runWorkspaceInvitationRevoke,
}

var workspaceInvitationAcceptCmd = &cobra.Command{
	Use:   "accept <invitation-id>",
	Short: "Accept an invitation addressed to you",
	Args:  exactArgs(1),
	RunE:  runWorkspaceInvitationAccept,
}

var workspaceInvitationDeclineCmd = &cobra.Command{
	Use:   "decline <invitation-id>",
	Short: "Decline an invitation addressed to you",
	Args:  exactArgs(1),
	RunE:  runWorkspaceInvitationDecline,
}

var workspaceShareLinkCmd = &cobra.Command{
	Use:   "share-link",
	Short: "Create and revoke workspace join links",
	Long: `A share link lets anyone holding it join with a fixed role, optionally until an
expiry or after a number of uses.

  multica workspace share-link list
  multica workspace share-link create --role member [--expires-in 168] [--max-uses 5]
  multica workspace share-link revoke <link-id> --yes

--expires-in is hours from now; omit it for a link that never expires.`,
}

var workspaceShareLinkListCmd = &cobra.Command{
	Use:   "list",
	Short: "List share links for this workspace",
	Args:  cobra.NoArgs,
	RunE:  runWorkspaceShareLinkList,
}

var workspaceShareLinkCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Mint a new share link",
	Args:  cobra.NoArgs,
	RunE:  runWorkspaceShareLinkCreate,
}

var workspaceShareLinkRevokeCmd = &cobra.Command{
	Use:   "revoke <link-id> --yes",
	Short: "Revoke a share link",
	Args:  exactArgs(1),
	RunE:  runWorkspaceShareLinkRevoke,
}

var workspaceDeleteCmd = &cobra.Command{
	Use:   "delete --yes",
	Short: "Delete an entire workspace (owner only)",
	Long: `Permanently deletes the workspace and everything inside it — issues, projects,
chats, agents, skills, artifacts — and removes access for every member. There is
no undo, no export step, and no automatic fallback workspace.

This is the UI's Settings → Delete workspace and nothing else. Print the command
for the owner to run instead of running it after a general "clean up" request.`,
	Args: cobra.NoArgs,
	RunE: runWorkspaceDelete,
}

func init() {
	workspaceMemberRoleCmd.Flags().String("output", "json", "Output format: json or table")
	workspaceMemberLeaveCmd.Flags().String("output", "json", "Output format: json or table")
	addDestructiveFlags(workspaceMemberRemoveCmd)

	for _, c := range []*cobra.Command{workspaceInvitationListCmd, workspaceInvitationMineCmd} {
		c.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
		c.Flags().Bool("full-id", false, "Print full ids instead of 8-character prefixes")
		c.Flags().String("output", "table", "Output format: table or json")
	}
	addDestructiveFlags(workspaceInvitationRevokeCmd)
	for _, c := range []*cobra.Command{workspaceInvitationAcceptCmd, workspaceInvitationDeclineCmd} {
		c.Flags().String("output", "json", "Output format: json or table")
	}

	workspaceShareLinkListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	workspaceShareLinkListCmd.Flags().Bool("full-id", false, "Print full ids instead of 8-character prefixes")
	workspaceShareLinkListCmd.Flags().String("output", "table", "Output format: table or json")
	workspaceShareLinkCreateCmd.Flags().String("role", "member", "Role the link grants: member, admin or owner")
	workspaceShareLinkCreateCmd.Flags().Int("expires-in", 0, "Hours until the link expires (0 = never)")
	workspaceShareLinkCreateCmd.Flags().Int("max-uses", 0, "Maximum number of joins (0 = unlimited)")
	workspaceShareLinkCreateCmd.Flags().String("output", "json", "Output format: json or table")
	addDestructiveFlags(workspaceShareLinkRevokeCmd)

	workspaceMemberCmd.AddCommand(workspaceMemberRoleCmd)
	workspaceMemberCmd.AddCommand(workspaceMemberRemoveCmd)
	workspaceMemberCmd.AddCommand(workspaceMemberLeaveCmd)
	workspaceCmd.AddCommand(workspaceDeleteCmd)
	addDestructiveFlags(workspaceDeleteCmd)
	workspaceCmd.AddCommand(workspaceInvitationCmd)
	workspaceInvitationCmd.AddCommand(workspaceInvitationListCmd)
	workspaceInvitationCmd.AddCommand(workspaceInvitationMineCmd)
	workspaceInvitationCmd.AddCommand(workspaceInvitationRevokeCmd)
	workspaceInvitationCmd.AddCommand(workspaceInvitationAcceptCmd)
	workspaceInvitationCmd.AddCommand(workspaceInvitationDeclineCmd)
	workspaceCmd.AddCommand(workspaceShareLinkCmd)
	workspaceShareLinkCmd.AddCommand(workspaceShareLinkListCmd)
	workspaceShareLinkCmd.AddCommand(workspaceShareLinkCreateCmd)
	workspaceShareLinkCmd.AddCommand(workspaceShareLinkRevokeCmd)
}

// workspacePathPrefix resolves the workspace for a URL-scoped admin call.
func workspacePathPrefix(cmd *cobra.Command) (string, error) {
	wsID, err := resolveWorkspaceArg(cmd, nil)
	if err != nil {
		return "", err
	}
	if wsID == "" {
		return "", fmt.Errorf("workspace ID is required: set MULTICA_WORKSPACE_ID or pass --workspace-id")
	}
	return "/api/workspaces/" + url.PathEscape(wsID), nil
}

// resolveWorkspaceScopedID resolves a full UUID or a unique prefix against a
// JSON array endpoint, which is how every admin write here gets its id: the
// list commands print 8-character prefixes, but the routes require whole UUIDs.
func resolveWorkspaceScopedID(ctx context.Context, client *cli.APIClient, kind, input, path string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, kind, input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var rows []map[string]any
		if err := client.GetJSON(ctx, path, &rows); err != nil {
			return nil, err
		}
		out := make([]idCandidate, 0, len(rows))
		for _, row := range rows {
			label := strVal(row, "invitee_email")
			if label == "" {
				label = strVal(row, "email")
			}
			if label == "" {
				label = strVal(row, "code")
			}
			out = append(out, idCandidate{
				ID:      strVal(row, "id"),
				Display: label,
				Detail:  strVal(row, "role"),
			})
		}
		return out, nil
	})
}

func runWorkspaceMemberRole(cmd *cobra.Command, args []string) error {
	role := strings.ToLower(strings.TrimSpace(args[1]))
	switch role {
	case "owner", "admin", "member":
	default:
		return fmt.Errorf("role must be owner, admin or member")
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

	ref, err := resolveWorkspaceScopedID(ctx, client, "workspace member", args[0], prefix+"/members")
	if err != nil {
		return err
	}
	return doJSONWrite(cmd, "PATCH", prefix+"/members/"+url.PathEscape(ref.ID), map[string]any{"role": role}, "change member role")
}

func runWorkspaceMemberRemove(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Remove member %s from the workspace. Their chats and task history stay, their access is gone.", args[0])); err != nil {
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

	ref, err := resolveWorkspaceScopedID(ctx, client, "workspace member", args[0], prefix+"/members")
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, prefix+"/members/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("remove member: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "removed member %s\n", ref.ID)
	return nil
}

func runWorkspaceMemberLeave(cmd *cobra.Command, _ []string) error {
	prefix, err := workspacePathPrefix(cmd)
	if err != nil {
		return err
	}
	return doJSONWrite(cmd, "POST", prefix+"/leave", nil, "leave workspace")
}

func runWorkspaceDelete(cmd *cobra.Command, _ []string) error {
	wsID, err := resolveWorkspaceArg(cmd, nil)
	if err != nil {
		return err
	}
	if wsID == "" {
		return fmt.Errorf("workspace ID is required: set MULTICA_WORKSPACE_ID or pass --workspace-id")
	}
	hint := fmt.Sprintf("Delete workspace %s and everything in it (issues, projects, chats, agents, skills, artifacts). Every member loses access; there is no undo.", wsID)
	if err := confirmDestructive(cmd, hint); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if err := client.DeleteJSON(ctx, "/api/workspaces/"+url.PathEscape(wsID)); err != nil {
		return fmt.Errorf("delete workspace: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted workspace %s\n", wsID)
	return nil
}

func runWorkspaceInvitationList(cmd *cobra.Command, _ []string) error {
	prefix, err := workspacePathPrefix(cmd)
	if err != nil {
		return err
	}
	return printInvitations(cmd, prefix+"/invitations", "workspace")
}

func runWorkspaceInvitationMine(cmd *cobra.Command, _ []string) error {
	return printInvitations(cmd, "/api/invitations", "mine")
}

func printInvitations(cmd *cobra.Command, path, view string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var rows []map[string]any
	if err := client.GetJSON(ctx, path, &rows); err != nil {
		return fmt.Errorf("list invitations: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows = capRows(rows, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"invitations": rows, "total": len(rows)})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, inv := range rows {
		id := strVal(inv, "id")
		if !fullID {
			id = shortID(id)
		}
		workspace := strVal(inv, "workspace_name")
		if workspace == "" {
			workspace = shortID(strVal(inv, "workspace_id"))
		}
		out = append(out, []string{
			id,
			truncateCell(blankDash(strVal(inv, "invitee_email")), 32),
			blankDash(strVal(inv, "role")),
			blankDash(strVal(inv, "status")),
			truncateCell(blankDash(workspace), 24),
			shortTimestamp(strVal(inv, "expires_at")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "INVITEE", "ROLE", "STATUS", "WORKSPACE", "EXPIRES"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d %s invitation(s).\n", len(rows), view)
	return nil
}

func runWorkspaceInvitationRevoke(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Revoke invitation %s. The invitee's link stops working.", args[0])); err != nil {
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

	ref, err := resolveWorkspaceScopedID(ctx, client, "invitation", args[0], prefix+"/invitations")
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, prefix+"/invitations/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("revoke invitation: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "revoked invitation %s\n", ref.ID)
	return nil
}

func runWorkspaceInvitationAccept(cmd *cobra.Command, args []string) error {
	return respondToInvitation(cmd, args[0], "accept")
}

func runWorkspaceInvitationDecline(cmd *cobra.Command, args []string) error {
	return respondToInvitation(cmd, args[0], "decline")
}

// respondToInvitation answers an invitation addressed to the caller. The id is
// resolved against `/api/invitations` (your own inbox) rather than the
// workspace list, because accepting is a personal action a non-admin can take.
func respondToInvitation(cmd *cobra.Command, input, action string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveWorkspaceScopedID(ctx, client, "invitation", input, "/api/invitations")
	if err != nil {
		return err
	}
	return doJSONWrite(cmd, "POST", "/api/invitations/"+url.PathEscape(ref.ID)+"/"+action, nil, action+" invitation")
}

func runWorkspaceShareLinkList(cmd *cobra.Command, _ []string) error {
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

	var rows []map[string]any
	if err := client.GetJSON(ctx, prefix+"/share-links", &rows); err != nil {
		return fmt.Errorf("list share links: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows = capRows(rows, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"share_links": rows, "total": len(rows)})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, link := range rows {
		id := strVal(link, "id")
		if !fullID {
			id = shortID(id)
		}
		expires := strVal(link, "expires_at")
		if expires == "" {
			expires = "never"
		}
		maxUses := strVal(link, "max_uses")
		if maxUses == "" {
			maxUses = "unlimited"
		}
		out = append(out, []string{
			id,
			blankDash(strVal(link, "code")),
			blankDash(strVal(link, "role")),
			compactCount(link, "use_count") + "/" + maxUses,
			expires,
			yesNo(isTrue(link["is_active"])),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "CODE", "ROLE", "USES", "EXPIRES", "ACTIVE"}, out)
	return nil
}

func runWorkspaceShareLinkCreate(cmd *cobra.Command, _ []string) error {
	prefix, err := workspacePathPrefix(cmd)
	if err != nil {
		return err
	}
	role := strings.ToLower(strings.TrimSpace(flagOr(cmd, "role", "member")))
	switch role {
	case "member", "admin", "owner":
	default:
		return fmt.Errorf("--role must be member, admin or owner")
	}
	body := map[string]any{"role": role}
	if hours, _ := cmd.Flags().GetInt("expires-in"); hours > 0 {
		body["expires_in"] = hours
	}
	if maxUses, _ := cmd.Flags().GetInt("max-uses"); maxUses > 0 {
		body["max_uses"] = maxUses
	}
	return doJSONWrite(cmd, "POST", prefix+"/share-links", body, "create share link")
}

func runWorkspaceShareLinkRevoke(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Revoke share link %s. Anyone not yet joined loses access.", args[0])); err != nil {
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

	ref, err := resolveWorkspaceScopedID(ctx, client, "share link", args[0], prefix+"/share-links")
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, prefix+"/share-links/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("revoke share link: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "revoked share link %s\n", ref.ID)
	return nil
}
