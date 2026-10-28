package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 聊天（chat）在 UI 里是「多会话 + 消息流 + 群成员管理」，过去 CLI 只有 agent
// 侧的 history/thread 只读两条。这里把人的那一侧补齐：会话 CRUD、发消息、
// 回复、reaction、已读、群参与者。
//
// 两条边界必须记住：
//   - 给 agent 会话发消息会创建 agent 任务（真的会让一个 agent 开始干活），
//     所以 skill 把它列为 Level B；
//   - dm/group 是 migration 478 的会话泛化面，flag 关闭时服务端 404。
var chatSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Create, list, and manage chat sessions",
	Long: `A session is one conversation: an agent chat ("agent"), a 1:1 DM with a member
("dm"), or a group ("group"). Sessions are per creator — list returns yours.

  multica chat session list [--status active|archived|all]
  multica chat session get <session>
  multica chat session create --agent <agent> [--title t] [--project p]
  multica chat session dm --member <member>
  multica chat session group --title t [--member id]... [--agent id]... [--project p]
  multica chat session update <session> [--title t] [--project p]
  multica chat session pin|archive <session> [--off]
  multica chat session delete <session> --yes

<session> accepts the full UUID or a unique short prefix (use --full-id on list
to copy one).`,
}

var chatSessionListCmd = &cobra.Command{
	Use:   "list",
	Short: "List your chat sessions",
	Args:  cobra.NoArgs,
	RunE:  runChatSessionList,
}

var chatSessionGetCmd = &cobra.Command{
	Use:   "get <session>",
	Short: "Show one chat session",
	Args:  exactArgs(1),
	RunE:  runChatSessionGet,
}

var chatSessionCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Start a 1:1 agent chat",
	Args:  cobra.NoArgs,
	RunE:  runChatSessionCreate,
}

var chatSessionDMCmd = &cobra.Command{
	Use:   "dm",
	Short: "Start (or reopen) a DM with a workspace member",
	Args:  cobra.NoArgs,
	RunE:  runChatSessionDM,
}

var chatSessionGroupCmd = &cobra.Command{
	Use:   "group",
	Short: "Create a group chat",
	Args:  cobra.NoArgs,
	RunE:  runChatSessionGroup,
}

var chatSessionUpdateCmd = &cobra.Command{
	Use:   "update <session>",
	Short: "Rename a session or change its project context",
	Args:  exactArgs(1),
	RunE:  runChatSessionUpdate,
}

var chatSessionPinCmd = &cobra.Command{
	Use:   "pin <session>",
	Short: "Pin or unpin a session in your list",
	Args:  exactArgs(1),
	RunE:  runChatSessionPin,
}

var chatSessionArchiveCmd = &cobra.Command{
	Use:   "archive <session>",
	Short: "Archive or unarchive a session",
	Args:  exactArgs(1),
	RunE:  runChatSessionArchive,
}

var chatSessionDeleteCmd = &cobra.Command{
	Use:   "delete <session> --yes",
	Short: "Delete a session and its messages",
	Args:  exactArgs(1),
	RunE:  runChatSessionDelete,
}

// ---------------------------------------------------------------------------
// messages / send / reply / react / read
// ---------------------------------------------------------------------------

var chatMessagesCmd = &cobra.Command{
	Use:   "messages <session>",
	Short: "Read a session's messages (newest page first)",
	Args:  exactArgs(1),
	RunE:  runChatMessages,
}

var chatSendCmd = &cobra.Command{
	Use:   "send <session>",
	Short: "Send a message (starts an agent task in an agent chat)",
	Long: `Send one message into a session.

In an agent chat this creates a task for the agent — it is a real action, not a
draft. In a DM/group it posts the message and may @mention participants.

  multica chat send <session> --content "hello"
  multica chat send <session> --content-file ./prompt.md --attachment ./shot.png`,
	Args: exactArgs(1),
	RunE: runChatSend,
}

var chatReplyCmd = &cobra.Command{
	Use:   "reply <session> <message-id>",
	Short: "Reply in the thread under one message",
	Args:  exactArgs(2),
	RunE:  runChatReply,
}

var chatReactCmd = &cobra.Command{
	Use:   "react <session> <message-id> --emoji <e>",
	Short: "Toggle an emoji reaction on a message",
	Args:  exactArgs(2),
	RunE:  runChatReact,
}

var chatReadCmd = &cobra.Command{
	Use:   "read <session>",
	Short: "Mark a session read up to now (or through one message)",
	Args:  exactArgs(1),
	RunE:  runChatRead,
}

var chatPendingCmd = &cobra.Command{
	Use:   "pending",
	Short: "List the chat tasks queued or running for you",
	Args:  cobra.NoArgs,
	RunE:  runChatPending,
}

// ---------------------------------------------------------------------------
// participants
// ---------------------------------------------------------------------------

var chatParticipantCmd = &cobra.Command{
	Use:   "participant",
	Short: "Inspect and manage group participants",
	Long: `Group-only: an agent chat has no participant set, and a DM is fixed to the pair.

  multica chat participant list <session>
  multica chat participant add <session> [--member id]... [--agent id]...
  multica chat participant remove <session> <member|agent> <id>
  multica chat participant admin <session> <member-id> [--off]
  multica chat participant leave <session>`,
}

var chatParticipantListCmd = &cobra.Command{
	Use:   "list <session>",
	Short: "List participants",
	Args:  exactArgs(1),
	RunE:  runChatParticipantList,
}

var chatParticipantAddCmd = &cobra.Command{
	Use:   "add <session>",
	Short: "Add members and/or agents to a group",
	Args:  exactArgs(1),
	RunE:  runChatParticipantAdd,
}

var chatParticipantRemoveCmd = &cobra.Command{
	Use:   "remove <session> <member|agent> <id>",
	Short: "Remove one participant",
	Args:  exactArgs(3),
	RunE:  runChatParticipantRemove,
}

var chatParticipantAdminCmd = &cobra.Command{
	Use:   "admin <session> <member-id>",
	Short: "Grant or revoke group admin",
	Args:  exactArgs(2),
	RunE:  runChatParticipantAdmin,
}

var chatParticipantLeaveCmd = &cobra.Command{
	Use:   "leave <session>",
	Short: "Leave a group chat",
	Args:  exactArgs(1),
	RunE:  runChatParticipantLeave,
}

func init() {
	chatSessionListCmd.Flags().String("status", "active", "Filter: active | archived | all")
	chatSessionListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	chatSessionListCmd.Flags().Bool("full-id", false, "Print full session ids instead of 8-character prefixes")
	chatSessionListCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{
		chatSessionGetCmd, chatSessionPinCmd, chatSessionArchiveCmd,
		chatSessionDeleteCmd, chatPendingCmd,
	} {
		c.Flags().String("output", "json", "Output format: json or table")
	}

	chatSessionCreateCmd.Flags().String("agent", "", "Agent id/prefix to chat with (required)")
	chatSessionCreateCmd.Flags().String("title", "", "Session title")
	chatSessionCreateCmd.Flags().String("project", "", "Attach project context")
	chatSessionCreateCmd.Flags().String("output", "json", "Output format: json or table")

	chatSessionDMCmd.Flags().String("member", "", "Workspace member id (required)")
	chatSessionDMCmd.Flags().String("output", "json", "Output format: json or table")

	chatSessionGroupCmd.Flags().String("title", "", "Group title (required)")
	chatSessionGroupCmd.Flags().StringArray("member", nil, "Member id to include (repeatable)")
	chatSessionGroupCmd.Flags().StringArray("agent", nil, "Agent id to include (repeatable)")
	chatSessionGroupCmd.Flags().String("project", "", "Attach project context")
	chatSessionGroupCmd.Flags().String("output", "json", "Output format: json or table")

	chatSessionUpdateCmd.Flags().String("title", "", "New title")
	chatSessionUpdateCmd.Flags().String("project", "", "New project id (pass \"\" to clear)")
	chatSessionUpdateCmd.Flags().String("output", "json", "Output format: json or table")

	for _, c := range []*cobra.Command{chatSessionPinCmd, chatSessionArchiveCmd} {
		c.Flags().Bool("off", false, "Turn the flag off instead of on")
	}
	addDestructiveFlags(chatSessionDeleteCmd)

	chatMessagesCmd.Flags().Int("limit", 50, "Messages per page (1..100)")
	chatMessagesCmd.Flags().String("before-created-at", "", "Cursor: created_at of the oldest message you already have")
	chatMessagesCmd.Flags().String("before-id", "", "Cursor: id of the oldest message you already have")
	chatMessagesCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{chatSendCmd, chatReplyCmd} {
		c.Flags().String("content", "", "Message body (decodes \\n, \\r, \\t, \\\\); prefer --content-file for long text)")
		c.Flags().Bool("content-stdin", false, "Read the body from stdin")
		c.Flags().String("content-file", "", "Read the body from a UTF-8 file inside the working directory")
		c.Flags().Bool("allow-external-file", false, "Allow --content-file outside the working directory")
		c.Flags().String("output", "json", "Output format: json or table")
	}
	chatSendCmd.Flags().StringArray("attachment", nil, "Local file(s) to attach (repeatable)")

	chatReactCmd.Flags().String("emoji", "", "Emoji to toggle (required)")
	chatReactCmd.Flags().String("output", "json", "Output format: json or table")

	chatReadCmd.Flags().String("through", "", "Mark read only through this message id")
	chatReadCmd.Flags().String("output", "json", "Output format: json or table")

	chatParticipantListCmd.Flags().String("output", "table", "Output format: table or json")
	chatParticipantAddCmd.Flags().StringArray("member", nil, "Member id (repeatable)")
	chatParticipantAddCmd.Flags().StringArray("agent", nil, "Agent id (repeatable)")
	chatParticipantAddCmd.Flags().String("output", "json", "Output format: json or table")
	for _, c := range []*cobra.Command{chatParticipantRemoveCmd, chatParticipantAdminCmd, chatParticipantLeaveCmd} {
		c.Flags().String("output", "json", "Output format: json or table")
	}
	chatParticipantAdminCmd.Flags().Bool("off", false, "Revoke admin instead of granting it")

	chatCmd.AddCommand(chatSessionCmd)
	chatSessionCmd.AddCommand(chatSessionListCmd)
	chatSessionCmd.AddCommand(chatSessionGetCmd)
	chatSessionCmd.AddCommand(chatSessionCreateCmd)
	chatSessionCmd.AddCommand(chatSessionDMCmd)
	chatSessionCmd.AddCommand(chatSessionGroupCmd)
	chatSessionCmd.AddCommand(chatSessionUpdateCmd)
	chatSessionCmd.AddCommand(chatSessionPinCmd)
	chatSessionCmd.AddCommand(chatSessionArchiveCmd)
	chatSessionCmd.AddCommand(chatSessionDeleteCmd)

	chatCmd.AddCommand(chatMessagesCmd)
	chatCmd.AddCommand(chatSendCmd)
	chatCmd.AddCommand(chatReplyCmd)
	chatCmd.AddCommand(chatReactCmd)
	chatCmd.AddCommand(chatReadCmd)
	chatCmd.AddCommand(chatPendingCmd)
	chatCmd.AddCommand(chatParticipantCmd)
	chatParticipantCmd.AddCommand(chatParticipantListCmd)
	chatParticipantCmd.AddCommand(chatParticipantAddCmd)
	chatParticipantCmd.AddCommand(chatParticipantRemoveCmd)
	chatParticipantCmd.AddCommand(chatParticipantAdminCmd)
	chatParticipantCmd.AddCommand(chatParticipantLeaveCmd)
}

// resolveChatSession accepts a full UUID or a unique id prefix. The list call is
// scoped to the caller's sessions, so a prefix can never resolve to somebody
// else's conversation.
func resolveChatSession(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "chat session", input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var sessions []map[string]any
		if err := client.GetJSON(ctx, "/api/chat/sessions?status=all", &sessions); err != nil {
			return nil, err
		}
		out := make([]idCandidate, 0, len(sessions))
		for _, s := range sessions {
			out = append(out, idCandidate{
				ID:      strVal(s, "id"),
				Display: strVal(s, "title"),
				Detail:  strVal(s, "kind"),
			})
		}
		return out, nil
	})
}

func sessionPath(id, suffix string) string {
	return "/api/chat/sessions/" + url.PathEscape(id) + suffix
}

func runChatSessionList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	status, _ := cmd.Flags().GetString("status")
	status = strings.ToLower(strings.TrimSpace(status))
	if status != "active" && status != "archived" && status != "all" {
		return fmt.Errorf("--status must be active, archived or all")
	}
	var sessions []map[string]any
	if err := client.GetJSON(ctx, "/api/chat/sessions?status="+url.QueryEscape(status), &sessions); err != nil {
		return fmt.Errorf("list chat sessions: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(sessions, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"sessions": rows, "total": len(sessions), "status": status})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	headers := []string{"ID", "KIND", "TITLE", "PIN", "UNREAD", "UPDATED"}
	out := make([][]string, 0, len(rows))
	for _, s := range rows {
		id := strVal(s, "id")
		if !fullID {
			id = shortID(id)
		}
		out = append(out, []string{
			id,
			blankDash(strVal(s, "kind")),
			truncateCell(blankDash(strVal(s, "title")), 48),
			yesNo(isTrue(s["pinned"])),
			strVal(s, "unread_count"),
			shortTimestamp(strVal(s, "updated_at")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d %s session(s). Use `multica chat messages <session>` to read one.\n", len(rows), status)
	return nil
}

func runChatSessionGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveChatSession(ctx, client, args[0])
	if err != nil {
		return err
	}
	var session map[string]any
	if err := client.GetJSON(ctx, sessionPath(ref.ID, ""), &session); err != nil {
		return fmt.Errorf("get chat session: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), session)
}

func runChatSessionCreate(cmd *cobra.Command, _ []string) error {
	agent, _ := cmd.Flags().GetString("agent")
	agent = strings.TrimSpace(agent)
	if agent == "" {
		return fmt.Errorf("--agent is required (list agents with `multica agent list`)")
	}
	body := map[string]any{"agent_id": agent}
	if title, _ := cmd.Flags().GetString("title"); strings.TrimSpace(title) != "" {
		body["title"] = strings.TrimSpace(title)
	}
	if project, _ := cmd.Flags().GetString("project"); strings.TrimSpace(project) != "" {
		body["project_id"] = strings.TrimSpace(project)
	}
	return postChatJSON(cmd, "/api/chat/sessions", body, "create chat session")
}

func runChatSessionDM(cmd *cobra.Command, _ []string) error {
	member, _ := cmd.Flags().GetString("member")
	member = strings.TrimSpace(member)
	if member == "" {
		return fmt.Errorf("--member is required (list members with `multica workspace member list`)")
	}
	return postChatJSON(cmd, "/api/chat/sessions/dm", map[string]any{"member_id": member}, "open DM")
}

func runChatSessionGroup(cmd *cobra.Command, _ []string) error {
	title, _ := cmd.Flags().GetString("title")
	title = strings.TrimSpace(title)
	if title == "" {
		return fmt.Errorf("--title is required")
	}
	members, _ := cmd.Flags().GetStringArray("member")
	agents, _ := cmd.Flags().GetStringArray("agent")
	if len(members) == 0 && len(agents) == 0 {
		return fmt.Errorf("a group needs at least one --member or --agent")
	}
	body := map[string]any{
		"title":      title,
		"member_ids": members,
		"agent_ids":  agents,
	}
	if project, _ := cmd.Flags().GetString("project"); strings.TrimSpace(project) != "" {
		body["project_id"] = strings.TrimSpace(project)
	}
	return postChatJSON(cmd, "/api/chat/sessions/group", body, "create group chat")
}

func runChatSessionUpdate(cmd *cobra.Command, args []string) error {
	body := map[string]any{}
	if cmd.Flags().Changed("title") {
		title, _ := cmd.Flags().GetString("title")
		body["title"] = title
	}
	if cmd.Flags().Changed("project") {
		project, _ := cmd.Flags().GetString("project")
		if strings.TrimSpace(project) == "" {
			body["project_id"] = nil
		} else {
			body["project_id"] = strings.TrimSpace(project)
		}
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --title and/or --project")
	}
	return patchChatJSON(cmd, args[0], "", body, "update chat session")
}

func runChatSessionPin(cmd *cobra.Command, args []string) error {
	off, _ := cmd.Flags().GetBool("off")
	return patchChatJSON(cmd, args[0], "/pin", map[string]any{"pinned": !off}, "pin chat session")
}

func runChatSessionArchive(cmd *cobra.Command, args []string) error {
	off, _ := cmd.Flags().GetBool("off")
	return patchChatJSON(cmd, args[0], "/archive", map[string]any{"archived": !off}, "archive chat session")
}

func runChatSessionDelete(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Delete chat session %s and every message in it.", args[0])); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveChatSession(ctx, client, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, sessionPath(ref.ID, "")); err != nil {
		return fmt.Errorf("delete chat session: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted chat session %s\n", ref.ID)
	return nil
}

func runChatMessages(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveChatSession(ctx, client, args[0])
	if err != nil {
		return err
	}
	params := url.Values{}
	if limit, _ := cmd.Flags().GetInt("limit"); limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", limit))
	}
	beforeAt, _ := cmd.Flags().GetString("before-created-at")
	beforeID, _ := cmd.Flags().GetString("before-id")
	if (beforeAt == "") != (beforeID == "") {
		return fmt.Errorf("--before-created-at and --before-id must be passed together (copy both from next_cursor)")
	}
	if beforeAt != "" {
		params.Set("before_created_at", beforeAt)
		params.Set("before_id", beforeID)
	}
	path := sessionPath(ref.ID, "/messages/page")
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}

	var resp struct {
		Messages   []map[string]any `json:"messages"`
		Limit      int              `json:"limit"`
		HasMore    bool             `json:"has_more"`
		NextCursor map[string]any   `json:"next_cursor"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("list chat messages: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), resp)
	}
	headers := []string{"AT", "ROLE", "ID", "CONTENT"}
	out := make([][]string, 0, len(resp.Messages))
	for _, m := range resp.Messages {
		out = append(out, []string{
			shortTimestamp(strVal(m, "created_at")),
			blankDash(strVal(m, "role")),
			shortID(strVal(m, "id")),
			truncateCell(strings.ReplaceAll(strVal(m, "content"), "\n", " "), 72),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	if resp.HasMore {
		if cursor := resp.NextCursor; cursor != nil {
			fmt.Fprintf(cmd.OutOrStdout(), "\nmore messages exist; page older with:\n  multica chat messages %s --before-created-at %s --before-id %s\n",
				ref.ID, strVal(cursor, "created_at"), strVal(cursor, "id"))
		}
	}
	return nil
}

func runChatSend(cmd *cobra.Command, args []string) error {
	content, ok, err := resolveTextFlag(cmd, "content")
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("--content, --content-stdin, or --content-file is required")
	}
	body := map[string]any{"content": content}
	if ids := chatAttachmentIDs(cmd); len(ids) > 0 {
		body["attachment_ids"] = ids
	}
	return postChatJSON(cmd, "/api/chat/sessions/"+url.PathEscape(args[0])+"/messages", body, "send chat message")
}

func runChatReply(cmd *cobra.Command, args []string) error {
	content, ok, err := resolveTextFlag(cmd, "content")
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("--content, --content-stdin, or --content-file is required")
	}
	path := "/api/chat/sessions/" + url.PathEscape(args[0]) + "/messages/" + url.PathEscape(args[1]) + "/replies"
	return postChatJSON(cmd, path, map[string]any{"content": content}, "reply to message")
}

func runChatReact(cmd *cobra.Command, args []string) error {
	emoji, _ := cmd.Flags().GetString("emoji")
	emoji = strings.TrimSpace(emoji)
	if emoji == "" {
		return fmt.Errorf("--emoji is required")
	}
	path := "/api/chat/sessions/" + url.PathEscape(args[0]) + "/messages/" + url.PathEscape(args[1]) + "/reactions"
	return postChatJSON(cmd, path, map[string]any{"emoji": emoji}, "toggle reaction")
}

func runChatRead(cmd *cobra.Command, args []string) error {
	body := map[string]any{}
	if through, _ := cmd.Flags().GetString("through"); strings.TrimSpace(through) != "" {
		body["through_message_id"] = strings.TrimSpace(through)
	}
	return postChatJSON(cmd, "/api/chat/sessions/"+url.PathEscape(args[0])+"/read", body, "mark chat read")
}

func runChatPending(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp map[string]any
	if err := client.GetJSON(ctx, "/api/chat/pending-tasks", &resp); err != nil {
		return fmt.Errorf("list pending chat tasks: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), resp)
}

func runChatParticipantList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveChatSession(ctx, client, args[0])
	if err != nil {
		return err
	}
	var rows []map[string]any
	if err := client.GetJSON(ctx, sessionPath(ref.ID, "/participants"), &rows); err != nil {
		return fmt.Errorf("list participants: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"participants": rows, "total": len(rows)})
	}
	headers := []string{"TYPE", "ID", "NAME", "ADMIN", "JOINED"}
	out := make([][]string, 0, len(rows))
	for _, p := range rows {
		out = append(out, []string{
			blankDash(strVal(p, "participant_type")),
			shortID(strVal(p, "participant_id")),
			truncateCell(blankDash(strVal(p, "display_name")), 32),
			yesNo(isTrue(p["admin"])),
			shortTimestamp(strVal(p, "joined_at")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	return nil
}

func runChatParticipantAdd(cmd *cobra.Command, args []string) error {
	members, _ := cmd.Flags().GetStringArray("member")
	agents, _ := cmd.Flags().GetStringArray("agent")
	if len(members) == 0 && len(agents) == 0 {
		return fmt.Errorf("pass at least one --member or --agent")
	}
	return postChatJSON(cmd, "/api/chat/sessions/"+url.PathEscape(args[0])+"/participants",
		map[string]any{"member_ids": members, "agent_ids": agents}, "add participants")
}

func runChatParticipantRemove(cmd *cobra.Command, args []string) error {
	kind := strings.ToLower(strings.TrimSpace(args[1]))
	if kind != "member" && kind != "agent" {
		return fmt.Errorf("participant type must be member or agent")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveChatSession(ctx, client, args[0])
	if err != nil {
		return err
	}
	path := sessionPath(ref.ID, "/participants/"+kind+"/"+url.PathEscape(args[2]))
	if err := client.DeleteJSON(ctx, path); err != nil {
		return fmt.Errorf("remove participant: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "removed %s %s from %s\n", kind, args[2], ref.ID)
	return nil
}

func runChatParticipantAdmin(cmd *cobra.Command, args []string) error {
	off, _ := cmd.Flags().GetBool("off")
	path := "/api/chat/sessions/" + url.PathEscape(args[0]) + "/participants/member/" + url.PathEscape(args[1])
	return callChatJSON(cmd, "PATCH", path, map[string]any{"admin": !off}, "set participant admin")
}

func runChatParticipantLeave(cmd *cobra.Command, args []string) error {
	return postChatJSON(cmd, "/api/chat/sessions/"+url.PathEscape(args[0])+"/participants/leave", map[string]any{}, "leave group")
}

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

func postChatJSON(cmd *cobra.Command, path string, body map[string]any, verb string) error {
	return callChatJSON(cmd, "POST", path, body, verb)
}

func patchChatJSON(cmd *cobra.Command, sessionRef, suffix string, body map[string]any, verb string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveChatSession(ctx, client, sessionRef)
	if err != nil {
		return err
	}
	var resp map[string]any
	if err := client.PatchJSON(ctx, sessionPath(ref.ID, suffix), body, &resp); err != nil {
		return fmt.Errorf("%s: %w", verb, err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), resp)
}

// callChatJSON POSTs/PATCHes and prints the response. A 204 or an empty body is
// normal here (mark-read, leave), so an empty response must not be an error.
func callChatJSON(cmd *cobra.Command, method, path string, body map[string]any, verb string) error {
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

func chatAttachmentIDs(cmd *cobra.Command) []string {
	paths, _ := cmd.Flags().GetStringArray("attachment")
	if len(paths) == 0 {
		return nil
	}
	// Attachments are uploaded by the caller before the send; this command only
	// forwards ids, so a file path here would silently bind nothing. Resolve the
	// paths into ids instead of passing them through.
	client, err := newAPIClient(cmd)
	if err != nil {
		return nil
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ids := make([]string, 0, len(paths))
	for _, path := range paths {
		attachment, err := uploadChatAttachment(cmd, ctx, client, path)
		if err != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "warning: %v\n", err)
			continue
		}
		ids = append(ids, attachment)
	}
	return ids
}

// uploadChatAttachment reads one local file and hands back its attachment id.
// The path goes through the same workdir guard as every other --*-file flag so
// a stale machine-shared file cannot be attached by mistake.
func uploadChatAttachment(cmd *cobra.Command, ctx context.Context, client *cli.APIClient, path string) (string, error) {
	if isHTTPURL(path) {
		return "", fmt.Errorf("attachments accept a local file path, not a URL: %s", path)
	}
	if err := ensureFileFlagWithinWorkdir(cmd, "attachment", "attachment", path); err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read attachment %s: %w", path, err)
	}
	resp, err := client.UploadChatAttachment(ctx, data, filepath.Base(path), "")
	if err != nil {
		return "", fmt.Errorf("upload %s: %w", path, err)
	}
	return resp.ID, nil
}

func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "-"
}

// jsonString keeps raw JSON bodies (issue-view query/display) round-trippable
// from a --query '{"...}' flag.
func jsonString(raw string) (json.RawMessage, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	if !json.Valid([]byte(trimmed)) {
		return nil, fmt.Errorf("not valid JSON: %s", trimmed)
	}
	return json.RawMessage(trimmed), nil
}
