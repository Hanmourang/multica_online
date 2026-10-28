package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const maxChatMessageResources = 3

var (
	errChatResourceDenied  = errors.New("chat resource access denied")
	errChatResourceMissing = errors.New("chat resource not found")
)

// normalizeChatResourceRefs validates the client-owned part of a resource
// reference. Existence and workspace visibility are checked separately before
// persistence; snapshots are always resolved from server data on read.
func normalizeChatResourceRefs(input []protocol.ChatResourceRef) ([]protocol.ChatResourceRef, error) {
	if len(input) > maxChatMessageResources {
		return nil, fmt.Errorf("a message can reference at most %d resources", maxChatMessageResources)
	}
	out := make([]protocol.ChatResourceRef, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, raw := range input {
		ref := protocol.ChatResourceRef{
			Type:      strings.TrimSpace(raw.Type),
			ID:        strings.TrimSpace(raw.ID),
			Kind:      strings.TrimSpace(raw.Kind),
			Source:    strings.TrimSpace(raw.Source),
			ProjectID: strings.TrimSpace(raw.ProjectID),
		}
		if ref.ID == "" {
			return nil, fmt.Errorf("resource id is required")
		}
		switch ref.Type {
		case "issue":
			if ref.Kind != "task" && ref.Kind != "requirement" {
				return nil, fmt.Errorf("issue resource kind must be task or requirement")
			}
			if ref.Source != "" || ref.ProjectID != "" {
				return nil, fmt.Errorf("issue resource cannot include document fields")
			}
		case "document":
			if ref.Kind != "" {
				return nil, fmt.Errorf("document resource cannot include issue kind")
			}
			switch ref.Source {
			case "artifact":
				if ref.ProjectID == "" {
					return nil, fmt.Errorf("artifact resource requires project_id")
				}
			case "attachment":
				// project_id is optional. The asset picker includes the owning
				// project so a reloaded card can open that project's files.
			default:
				return nil, fmt.Errorf("document resource source must be artifact or attachment")
			}
		case "module":
			// A module reference is always a first-class project module, never a
			// document and never an issue stand-in. kind is normalized rather than
			// required so older clients keep working after the upgrade.
			if ref.Kind != "" && ref.Kind != "module" {
				return nil, fmt.Errorf("module resource kind must be module")
			}
			ref.Kind = "module"
			if ref.Source != "" {
				return nil, fmt.Errorf("module resource cannot include document fields")
			}
		case "module_prototype":
			if ref.Kind != "" && ref.Kind != "prototype" {
				return nil, fmt.Errorf("module prototype resource kind must be prototype")
			}
			ref.Kind = "prototype"
			if ref.Source != "" {
				return nil, fmt.Errorf("module prototype resource cannot include document fields")
			}
		default:
			return nil, fmt.Errorf("resource type must be issue, document, module or module_prototype")
		}
		key := ref.Type + "\x00" + ref.ID + "\x00" + ref.Kind + "\x00" + ref.Source + "\x00" + ref.ProjectID
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, ref)
	}
	return out, nil
}

// resolveChatResource returns a fresh display snapshot only when the target
// still exists in the reader's workspace. Callers either reject a send or omit
// the entire card; neither path falls back to client-supplied metadata.
func (h *Handler) resolveChatResource(r *http.Request, workspaceID pgtype.UUID, ref protocol.ChatResourceRef) (*protocol.ChatResourcePayload, error) {
	id, err := util.ParseUUID(ref.ID)
	if err != nil {
		return nil, errChatResourceMissing
	}
	out := &protocol.ChatResourcePayload{Type: ref.Type, ID: ref.ID, Kind: ref.Kind, Source: ref.Source, ProjectID: ref.ProjectID, Access: "granted"}
	switch ref.Type {
	case "issue":
		issue, err := h.Queries.GetIssue(r.Context(), id)
		if err != nil {
			return nil, errChatResourceMissing
		}
		if err := h.fillIssueResource(r, workspaceID, ref, issue, out); err != nil {
			return nil, err
		}
	case "document":
		switch ref.Source {
		case "artifact":
			row, err := scanProjectArtifactRow(func(dest ...any) error {
				return h.DB.QueryRow(r.Context(), `SELECT `+projectArtifactColumns+` FROM project_artifact
					WHERE id = $1 AND deleted_at IS NULL`, id).Scan(dest...)
			})
			if err != nil {
				return nil, errChatResourceMissing
			}
			if err := fillArtifactResource(workspaceID, ref, row, out); err != nil {
				return nil, err
			}
		case "attachment":
			attachment, err := h.Queries.GetAttachmentByIDOnly(r.Context(), id)
			if err != nil {
				return nil, errChatResourceMissing
			}
			if err := h.fillAttachmentResource(r, workspaceID, attachment, out); err != nil {
				return nil, err
			}
		}
	case "module":
		if !featureflags.ModulePrototypeChatEnabled(r.Context(), h.FeatureFlags) {
			return nil, errChatResourceMissing
		}
		if err := h.fillModuleResource(r.Context(), workspaceID, id, out); err != nil {
			return nil, err
		}
	case "module_prototype":
		if !featureflags.ModulePrototypeChatEnabled(r.Context(), h.FeatureFlags) {
			return nil, errChatResourceMissing
		}
		if err := h.fillModulePrototypeResource(r.Context(), workspaceID, id, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func fillArtifactResource(workspaceID pgtype.UUID, ref protocol.ChatResourceRef, row projectArtifactRow, out *protocol.ChatResourcePayload) error {
	projectID, err := util.ParseUUID(ref.ProjectID)
	if err != nil {
		return errChatResourceMissing
	}
	if row.WorkspaceID != workspaceID {
		return errChatResourceDenied
	}
	if row.ProjectID != projectID {
		return errChatResourceMissing
	}
	out.Artifact = projectArtifactToResponse(row)
	return nil
}

func (h *Handler) fillAttachmentResource(r *http.Request, workspaceID pgtype.UUID, attachment db.Attachment, out *protocol.ChatResourcePayload) error {
	if attachment.WorkspaceID != workspaceID {
		return errChatResourceDenied
	}
	out.Attachment = h.attachmentToResponse(attachment, attachmentURLModeFromRequest(r))
	return nil
}

// moduleSpecReady reports whether migration 484 (module spec + canonical
// pointer) has landed. Chat ships ahead of the module spec centre, so the
// snapshot degrades instead of failing on a column that does not exist yet.
func (h *Handler) moduleSpecReady(ctx context.Context) bool {
	var ok bool
	err := h.DB.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema()
		  AND table_name = 'project_module'
		  AND column_name = 'canonical_prototype_version')`).Scan(&ok)
	return err == nil && ok
}

func (h *Handler) moduleFeatureTableReady(ctx context.Context) bool {
	var ok bool
	err := h.DB.QueryRow(ctx, `SELECT to_regclass('project_module_feature') IS NOT NULL`).Scan(&ok)
	return err == nil && ok
}

// fillModuleResource resolves a module reference into a fresh snapshot. The
// module must belong to the reader's workspace; the project id is taken from
// the database rather than the client ref so a forged id cannot mislabel a card.
func (h *Handler) fillModuleResource(ctx context.Context, workspaceID, id pgtype.UUID, out *protocol.ChatResourcePayload) error {
	var (
		moduleID  pgtype.UUID
		name      string
		projectID pgtype.UUID
		color     string
	)
	snapshot := protocol.ChatModuleSnapshot{}
	if h.moduleSpecReady(ctx) {
		var (
			specVersion int32
			canonical   pgtype.Int4
		)
		if err := h.DB.QueryRow(ctx, `SELECT pm.id, pm.name, pm.project_id, pm.color,
			pm.spec_version, pm.canonical_prototype_version
			FROM project_module pm JOIN project p ON p.id = pm.project_id
			WHERE pm.id = $1 AND p.workspace_id = $2`, id, workspaceID).
			Scan(&moduleID, &name, &projectID, &color, &specVersion, &canonical); err != nil {
			return errChatResourceMissing
		}
		snapshot.SpecVersion = int(specVersion)
		if canonical.Valid {
			value := int(canonical.Int32)
			snapshot.CanonicalPrototypeVersion = &value
		}
	} else if err := h.DB.QueryRow(ctx, `SELECT pm.id, pm.name, pm.project_id, pm.color
		FROM project_module pm JOIN project p ON p.id = pm.project_id
		WHERE pm.id = $1 AND p.workspace_id = $2`, id, workspaceID).
		Scan(&moduleID, &name, &projectID, &color); err != nil {
		return errChatResourceMissing
	}

	if h.moduleFeatureTableReady(ctx) {
		var count int
		if err := h.DB.QueryRow(ctx,
			`SELECT count(*) FROM project_module_feature WHERE module_id = $1`, moduleID).Scan(&count); err == nil {
			snapshot.FeaturePointCount = count
		}
	}

	snapshot.ModuleID = uuidToString(moduleID)
	snapshot.Name = name
	snapshot.ProjectID = uuidToString(projectID)
	snapshot.Color = color
	out.ProjectID = snapshot.ProjectID
	out.Module = snapshot
	return nil
}

// fillModulePrototypeResource resolves one prototype version by version id, so
// it works before issue_prototype_version.module_id exists. Module attribution
// is best-effort and only attached once migration 484 has run.
func (h *Handler) fillModulePrototypeResource(ctx context.Context, workspaceID, id pgtype.UUID, out *protocol.ChatResourcePayload) error {
	var (
		version    int32
		htmlPath   string
		status     string
		issueID    pgtype.UUID
		issueTitle string
	)
	if err := h.DB.QueryRow(ctx, `SELECT v.version, v.html_path, v.status, i.id, i.title
		FROM issue_prototype_version v JOIN issue i ON i.id = v.issue_id
		WHERE v.id = $1 AND v.workspace_id = $2`, id, workspaceID).
		Scan(&version, &htmlPath, &status, &issueID, &issueTitle); err != nil {
		return errChatResourceMissing
	}
	snapshot := protocol.ChatModulePrototypeSnapshot{
		VersionID:  uuidToString(id),
		IssueID:    uuidToString(issueID),
		IssueTitle: issueTitle,
		Version:    int(version),
		HTMLPath:   htmlPath,
		Status:     status,
	}
	if h.moduleSpecReady(ctx) {
		var (
			moduleID   pgtype.UUID
			moduleName string
		)
		if err := h.DB.QueryRow(ctx, `SELECT pm.id, pm.name
			FROM project_module pm JOIN issue_prototype_version v ON v.module_id = pm.id
			WHERE v.id = $1`, id).Scan(&moduleID, &moduleName); err == nil && moduleID.Valid {
			snapshot.ModuleID = uuidToString(moduleID)
			snapshot.ModuleName = moduleName
		}
	}
	out.Kind = "prototype"
	out.Prototype = snapshot
	return nil
}

func (h *Handler) fillIssueResource(r *http.Request, workspaceID pgtype.UUID, ref protocol.ChatResourceRef, issue db.Issue, out *protocol.ChatResourcePayload) error {
	if issue.WorkspaceID != workspaceID {
		return errChatResourceDenied
	}
	isRequirement := issueKindIsRequirement(issue.ParentIssueID.Valid, issue.StartAt, issue.DecompositionConfirmedAt, issue.TriggeredAt, issue.RepoResourceID)
	if (ref.Kind == "requirement") != isRequirement {
		return fmt.Errorf("resource kind does not match")
	}
	resp := issueToResponse(issue, h.getIssuePrefix(r.Context(), issue.WorkspaceID))
	h.fillStatusCategory(r.Context(), issue.WorkspaceID, &resp)
	out.Issue = resp
	return nil
}

func chatResourceKey(ref protocol.ChatResourceRef) string {
	if ref.Type == "document" {
		return ref.Source + ":" + ref.ID
	}
	return ref.Type + ":" + ref.ID
}

// chatResourcePrompt gives an agent stable keys and freshly authorized display
// metadata. An attached issue includes the fields needed to answer about that
// task without a shell: status, goal, description, acceptance, children, and
// recent comments. Document bodies and attachment URLs stay out of the prompt;
// the daemon can retrieve an authorized document later by its immutable key.
func (h *Handler) chatResourcePrompt(r *http.Request, workspaceID pgtype.UUID, rows []db.ChatMessageResourceRef) string {
	if len(rows) == 0 {
		return ""
	}
	lines := make([]string, 0, len(rows)+1)
	lines = append(lines, "Shared resources:")
	refs := make([]protocol.ChatResourceRef, 0, len(rows))
	for _, row := range rows {
		refs = append(refs, protocol.ChatResourceRef{
			Type: row.ResourceType, ID: uuidToString(row.ResourceID),
			Kind: row.ResourceKind, Source: row.ResourceSource, ProjectID: uuidToString(row.ProjectID),
		})
	}
	resolved := h.resolveChatResourceBatch(r, workspaceID, refs)
	issueIDs := make([]pgtype.UUID, 0, len(refs))
	for i, ref := range refs {
		if ref.Type != "issue" || i >= len(resolved) || resolved[i].Access != "granted" {
			continue
		}
		if id, err := util.ParseUUID(ref.ID); err == nil {
			issueIDs = append(issueIDs, id)
		}
	}
	extras := h.loadSharedIssuePromptExtras(r.Context(), workspaceID, issueIDs)
	sawIssue := false
	sawDocument := false
	for i, ref := range refs {
		key := chatResourceKey(ref)
		line := "- " + key
		if i >= len(resolved) || resolved[i].Access != "granted" {
			lines = append(lines, line+" (reference unavailable)")
			continue
		}
		resource := resolved[i]
		if snapshot, ok := resource.Issue.(IssueResponse); ok {
			lines = append(lines, formatSharedIssueResource(key, snapshot, extras[snapshot.ID]))
			sawIssue = true
			continue
		}
		if snapshot, ok := resource.Module.(protocol.ChatModuleSnapshot); ok {
			lines = append(lines, formatSharedModuleResource(key, snapshot))
			continue
		}
		if snapshot, ok := resource.Prototype.(protocol.ChatModulePrototypeSnapshot); ok {
			lines = append(lines, formatSharedModulePrototypeResource(key, snapshot))
			continue
		}
		title := ""
		body := ""
		if snapshot, ok := resource.Artifact.(ProjectArtifactResponse); ok {
			title = snapshot.RelPath
			body = h.chatArtifactBody(r.Context(), workspaceID, snapshot)
			sawDocument = true
		}
		if snapshot, ok := resource.Attachment.(AttachmentResponse); ok {
			title = snapshot.Filename
			sawDocument = true
		}
		title = strings.Join(strings.Fields(title), " ")
		if sawDocument && (resource.Artifact != nil || resource.Attachment != nil) {
			lines = append(lines, formatSharedDocumentResource(key, title, body))
			continue
		}
		if title != "" {
			line += " — " + title
		}
		lines = append(lines, line)
	}
	var notes []string
	if sawIssue {
		notes = append(notes, "The issue snapshots below are the authorized record for this turn: status, goal, description, acceptance, child issues, and recent comments. The same text is in `"+execenv.ChatSharedIssuesRelPath+"`. Answer from this record. Do not run `multica issue list`, `multica issue get`, or fetch a resource URL for these issues. A rejected shell command is not missing data.")
	}
	if sawDocument {
		notes = append(notes, "Document bodies below are the authorized text for this turn. Answer from that text directly. Do not search the workdir or the archive, do not run find, and do not run `multica attachment`, `multica artifact`, `multica project`, or `multica chat history` to locate these files.")
	}
	if len(notes) > 0 {
		lines[0] = "Shared resources:\n" + strings.Join(notes, "\n")
	}
	return strings.Join(lines, "\n")
}

const chatDocumentBodyLimit = 20000

// formatSharedModuleResource keeps module context deliberately small: name,
// ids, spec version, canonical prototype version and feature-point count. Full
// contracts stay out of the prompt, but the ids and the exact CLI chain that
// pulls them are spelled out: "not inlined" without a next step is what left
// chat agents trying `project`/`requirement` commands for dozens of steps
// without ever reaching the prototype file.
func formatSharedModuleResource(key string, snapshot protocol.ChatModuleSnapshot) string {
	parts := []string{fmt.Sprintf("- %s — module %q", key, snapshot.Name)}
	if snapshot.ModuleID != "" {
		parts = append(parts, "module_id "+snapshot.ModuleID)
	}
	if snapshot.ProjectID != "" {
		parts = append(parts, "project_id "+snapshot.ProjectID)
	}
	if snapshot.SpecVersion > 0 {
		parts = append(parts, fmt.Sprintf("spec v%d", snapshot.SpecVersion))
	}
	if snapshot.CanonicalPrototypeVersion != nil {
		parts = append(parts, fmt.Sprintf("canonical prototype v%d", *snapshot.CanonicalPrototypeVersion))
	}
	if snapshot.FeaturePointCount > 0 {
		parts = append(parts, fmt.Sprintf("%d feature points", snapshot.FeaturePointCount))
	}
	parts = append(parts, "full feature contracts are intentionally not inlined")
	line := strings.Join(parts, " · ")
	if snapshot.ModuleID != "" {
		line += fmt.Sprintf("\n  read on demand: `multica module get %s` (requirements) → `multica module prototype list %s` (versions) → `multica module prototype read %s` (absolute file path of the live version)",
			snapshot.ModuleID, snapshot.ModuleID, snapshot.ModuleID)
	}
	return clipPromptText(line, 1600)
}

func formatSharedModulePrototypeResource(key string, snapshot protocol.ChatModulePrototypeSnapshot) string {
	name := snapshot.ModuleName
	if name == "" {
		name = snapshot.IssueTitle
	}
	line := fmt.Sprintf("- %s — prototype v%d", key, snapshot.Version)
	if name != "" {
		line += fmt.Sprintf(" of %q", name)
	}
	if snapshot.Status != "" {
		line += " (" + snapshot.Status + ")"
	}
	if snapshot.HTMLPath != "" {
		line += " · " + snapshot.HTMLPath
	}
	// html_path is repo-relative and the archive root is not the agent's
	// workdir, so hand over the resolver instead of letting the agent guess
	// where the file lives on this machine.
	if snapshot.ModuleID != "" && snapshot.Version > 0 {
		line += fmt.Sprintf("\n  read it with `multica module prototype read %s --version %d` (prints the absolute path)", snapshot.ModuleID, snapshot.Version)
	} else if snapshot.IssueID != "" {
		line += fmt.Sprintf("\n  html_path is repo-relative; list versions with `multica requirement prototype list %s`", snapshot.IssueID)
	}
	return clipPromptText(line, 1600)
}

// formatSharedDocumentResource inlines a chat-attached document so the agent
// can summarize it without searching the workdir or the CLI. An empty body
// means this machine could not read the archive file; the agent must say so
// instead of hunting.
func formatSharedDocumentResource(key, title, body string) string {
	var b strings.Builder
	b.WriteString("- ")
	b.WriteString(key)
	title = strings.Join(strings.Fields(title), " ")
	if title != "" {
		b.WriteString(" — ")
		b.WriteString(title)
	}
	b.WriteString("\n  body:\n")
	body = clipPromptText(body, chatDocumentBodyLimit)
	if body == "" {
		b.WriteString("    (unavailable; tell the user the document text could not be read. Do not search the disk or the CLI for it.)")
		return b.String()
	}
	b.WriteString(indentPromptBlock(body))
	return b.String()
}

func (h *Handler) chatArtifactBody(ctx context.Context, workspaceID pgtype.UUID, artifact ProjectArtifactResponse) string {
	if !chatDocumentTextPath(artifact.RelPath) {
		return ""
	}
	projectID, err := util.ParseUUID(artifact.ProjectID)
	if err != nil {
		return ""
	}
	roots, err := h.chatArchiveRoots(ctx, workspaceID, projectID)
	if err != nil {
		slog.Warn("chat claim: load archive roots failed", "project_id", artifact.ProjectID, "error", err)
		return ""
	}
	return readChatDocumentAt(roots, artifact.RelPath)
}

func (h *Handler) chatArchiveRoots(ctx context.Context, workspaceID, projectID pgtype.UUID) ([]string, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(resource_ref->>'local_path', '')
		FROM project_resource
		WHERE project_id = $1 AND workspace_id = $2 AND resource_type = 'local_directory'`,
		projectID, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var locals []string
	for rows.Next() {
		var local string
		if err := rows.Scan(&local); err != nil {
			return nil, err
		}
		if strings.TrimSpace(local) != "" {
			locals = append(locals, local)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return expandArchiveRoots(locals), nil
}

// expandArchiveRoots adds the projects_mgmt shelves the desktop preview probes.
// Archive markdown often lives under projects_mgmt/projects, while the bound
// local_directory is a code checkout several levels away.
func expandArchiveRoots(localPaths []string) []string {
	seen := make(map[string]struct{})
	var out []string
	add := func(path string) {
		path = filepath.Clean(strings.TrimSpace(path))
		if path == "" || path == "." || path == string(filepath.Separator) {
			return
		}
		if _, ok := seen[path]; ok {
			return
		}
		seen[path] = struct{}{}
		out = append(out, path)
	}
	for _, local := range localPaths {
		cur := filepath.Clean(local)
		for depth := 0; depth < 6 && cur != "" && cur != string(filepath.Separator); depth++ {
			add(cur)
			add(filepath.Join(cur, "projects_mgmt"))
			add(filepath.Join(cur, "projects_mgmt", "projects"))
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
	}
	return out
}

func readChatDocumentAt(roots []string, relPath string) string {
	if !chatDocumentTextPath(relPath) {
		return ""
	}
	for _, root := range roots {
		rootClean := filepath.Clean(root)
		for _, candidate := range relPathCandidates(relPath) {
			abs := safeJoin(rootClean, candidate)
			if abs == "" {
				continue
			}
			info, err := os.Stat(abs)
			if err != nil || info.IsDir() || info.Size() <= 0 || info.Size() > 512*1024 {
				continue
			}
			data, err := os.ReadFile(abs)
			if err != nil || !utf8.Valid(data) || bytes.Contains(data, []byte{0}) {
				continue
			}
			return strings.TrimSpace(string(data))
		}
	}
	return ""
}

func chatDocumentTextPath(relPath string) bool {
	switch strings.ToLower(filepath.Ext(relPath)) {
	case ".md", ".markdown", ".txt", ".rst", ".adoc", ".csv", ".json", ".yaml", ".yml":
		return true
	default:
		return false
	}
}

const (
	issuePromptGoalLimit        = 2000
	issuePromptDescriptionLimit = 4000
	issuePromptAcceptanceLimit  = 2000
	issuePromptCommentLimit     = 800
	issuePromptChildCap         = 30
	issuePromptCommentCap       = 12
)

type sharedIssueChild struct {
	Identifier string
	Title      string
	Status     string
}

type sharedIssueComment struct {
	At      string
	Author  string
	Content string
}

// sharedIssuePromptExtra is the progress data a chat agent needs when shell
// exec cannot run `multica issue`. Loaded distinguishes "we looked and there
// are none" from "this formatter was called without a lookup".
type sharedIssuePromptExtra struct {
	Loaded              bool
	Acceptance          string
	Children            []sharedIssueChild
	ChildrenOmitted     int
	ChildrenClosed      int
	ChildrenUnavailable bool
	Comments            []sharedIssueComment
	CommentsOmitted     int
	CommentsUnavailable bool
}

// formatSharedIssueResource inlines the issue the sender attached, so a chat
// agent can report status and progress without a second lookup. The runtime
// exec policy often blocks `multica issue …`, and resource URLs on localhost
// are not fetchable from the agent sandbox.
func formatSharedIssueResource(key string, issue IssueResponse, extra sharedIssuePromptExtra) string {
	var b strings.Builder
	b.WriteString("- ")
	b.WriteString(key)
	heading := strings.TrimSpace(issue.Identifier + " " + issue.Title)
	heading = strings.Join(strings.Fields(heading), " ")
	if heading != "" {
		b.WriteString(" — ")
		b.WriteString(heading)
	}
	status := strings.TrimSpace(issue.Status)
	if name := strings.TrimSpace(issue.StatusName); name != "" && name != status {
		if status == "" {
			status = name
		} else {
			status += " (" + name + ")"
		}
	}
	writeField := func(label, value string) {
		value = strings.Join(strings.Fields(value), " ")
		if value == "" {
			return
		}
		b.WriteString("\n  ")
		b.WriteString(label)
		b.WriteString(": ")
		b.WriteString(value)
	}
	writeField("status", status)
	writeField("priority", issue.Priority)
	if issue.DueDate != nil {
		writeField("due", *issue.DueDate)
	}
	writeField("updated", issue.UpdatedAt)
	if issue.Goal != nil {
		if goal := clipPromptText(*issue.Goal, issuePromptGoalLimit); goal != "" {
			b.WriteString("\n  goal:\n")
			b.WriteString(indentPromptBlock(goal))
		}
	}
	if issue.Description != nil {
		if desc := clipPromptText(*issue.Description, issuePromptDescriptionLimit); desc != "" {
			b.WriteString("\n  description:\n")
			b.WriteString(indentPromptBlock(desc))
		}
	}
	if extra.Loaded {
		if acceptance := clipPromptText(extra.Acceptance, issuePromptAcceptanceLimit); acceptance != "" {
			b.WriteString("\n  acceptance:\n")
			b.WriteString(indentPromptBlock(acceptance))
		}
		writeIssueListSection(&b, "children", extra.ChildrenUnavailable, len(extra.Children), extra.ChildrenOmitted, func(i int) string {
			child := extra.Children[i]
			line := strings.TrimSpace(child.Identifier + " " + child.Title)
			line = strings.Join(strings.Fields(line), " ")
			if status := strings.TrimSpace(child.Status); status != "" {
				line += " — " + status
			}
			return line
		})
		if total := len(extra.Children) + extra.ChildrenOmitted; total > 0 && !extra.ChildrenUnavailable {
			writeField("child_progress", fmt.Sprintf("%d/%d closed (done or cancelled)", extra.ChildrenClosed, total))
		}
		writeIssueListSection(&b, "comments", extra.CommentsUnavailable, len(extra.Comments), extra.CommentsOmitted, func(i int) string {
			comment := extra.Comments[i]
			head := strings.TrimSpace(comment.At + " " + comment.Author)
			body := strings.Join(strings.Fields(comment.Content), " ")
			if head == "" {
				return body
			}
			if body == "" {
				return head
			}
			return head + ": " + body
		})
	}
	return b.String()
}

func writeIssueListSection(b *strings.Builder, label string, unavailable bool, shown, omitted int, line func(int) string) {
	b.WriteString("\n  ")
	b.WriteString(label)
	b.WriteString(":")
	if unavailable {
		b.WriteString(" unavailable")
		return
	}
	if shown == 0 {
		b.WriteString(" none")
		return
	}
	for i := 0; i < shown; i++ {
		text := strings.TrimSpace(line(i))
		if text == "" {
			continue
		}
		b.WriteString("\n    - ")
		b.WriteString(text)
	}
	if omitted > 0 {
		if label == "comments" {
			b.WriteString("\n    - … older comments were not included")
		} else {
			fmt.Fprintf(b, "\n    - … %d more not included", omitted)
		}
	}
}

func (h *Handler) loadSharedIssuePromptExtras(ctx context.Context, workspaceID pgtype.UUID, issueIDs []pgtype.UUID) map[string]sharedIssuePromptExtra {
	out := make(map[string]sharedIssuePromptExtra, len(issueIDs))
	if len(issueIDs) == 0 {
		return out
	}
	for _, id := range issueIDs {
		out[uuidToString(id)] = sharedIssuePromptExtra{Loaded: true}
	}
	issues, err := h.Queries.ListIssuesByIDs(ctx, issueIDs)
	if err != nil {
		slog.Warn("chat claim: load attached issue details failed", "error", err)
		for id, extra := range out {
			extra.ChildrenUnavailable = true
			extra.CommentsUnavailable = true
			out[id] = extra
		}
		return out
	}
	for _, issue := range issues {
		extra := out[uuidToString(issue.ID)]
		extra.Acceptance = formatAcceptanceForPrompt(issue.AcceptanceCriteria, issue.AcceptanceSpec)
		out[uuidToString(issue.ID)] = extra
	}
	children, err := h.Queries.ListChildrenByParents(ctx, db.ListChildrenByParentsParams{
		WorkspaceID: workspaceID,
		ParentIds:   issueIDs,
	})
	if err != nil {
		slog.Warn("chat claim: load attached issue children failed", "error", err)
		for id, extra := range out {
			extra.ChildrenUnavailable = true
			out[id] = extra
		}
	} else {
		grouped := make(map[string][]sharedIssueChild, len(issueIDs))
		for _, child := range children {
			parent := uuidToString(child.ParentIssueID)
			grouped[parent] = append(grouped[parent], sharedIssueChild{
				Identifier: identifierForIssueFields(child.ParentIssueID.Valid, child.Number, child.StartAt, child.DecompositionConfirmedAt, child.TriggeredAt, child.RepoResourceID),
				Title:      child.Title,
				Status:     child.Status,
			})
		}
		for parent, list := range grouped {
			extra := out[parent]
			for _, child := range list {
				if child.Status == "done" || child.Status == "cancelled" {
					extra.ChildrenClosed++
				}
			}
			if len(list) > issuePromptChildCap {
				extra.ChildrenOmitted = len(list) - issuePromptChildCap
				list = list[:issuePromptChildCap]
			}
			extra.Children = list
			out[parent] = extra
		}
	}
	for _, id := range issueIDs {
		key := uuidToString(id)
		comments, err := h.Queries.ListCommentsForIssue(ctx, db.ListCommentsForIssueParams{
			IssueID: id, WorkspaceID: workspaceID, Limit: issuePromptCommentCap + 1,
		})
		extra := out[key]
		if err != nil {
			slog.Warn("chat claim: load attached issue comments failed", "issue_id", key, "error", err)
			extra.CommentsUnavailable = true
			out[key] = extra
			continue
		}
		if len(comments) > issuePromptCommentCap {
			extra.CommentsOmitted = len(comments) - issuePromptCommentCap
			comments = comments[len(comments)-issuePromptCommentCap:]
		}
		extra.Comments = make([]sharedIssueComment, 0, len(comments))
		for _, comment := range comments {
			body := clipPromptText(comment.Content, issuePromptCommentLimit)
			if body == "" {
				continue
			}
			extra.Comments = append(extra.Comments, sharedIssueComment{
				At:      timestampToString(comment.CreatedAt),
				Author:  comment.AuthorType,
				Content: body,
			})
		}
		out[key] = extra
	}
	return out
}

func formatAcceptanceForPrompt(criteria, spec []byte) string {
	parts := make([]string, 0, 2)
	if text := acceptanceJSONText(criteria); text != "" {
		parts = append(parts, text)
	}
	if text := acceptanceJSONText(spec); text != "" && text != strings.Join(parts, "\n") {
		parts = append(parts, text)
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func acceptanceJSONText(raw []byte) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) || bytes.Equal(raw, []byte("{}")) || bytes.Equal(raw, []byte("[]")) {
		return ""
	}
	var lines []string
	if err := json.Unmarshal(raw, &lines); err == nil {
		return joinNonEmpty(lines)
	}
	var objects []map[string]any
	if err := json.Unmarshal(raw, &objects); err == nil {
		for _, object := range objects {
			for _, key := range []string{"text", "title", "content", "name", "assertion"} {
				if value, ok := object[key].(string); ok && strings.TrimSpace(value) != "" {
					lines = append(lines, strings.TrimSpace(value))
					break
				}
			}
		}
		return joinNonEmpty(lines)
	}
	var wrapped struct {
		Assertions []string `json:"assertions"`
		Items      []string `json:"items"`
	}
	if err := json.Unmarshal(raw, &wrapped); err == nil {
		return joinNonEmpty(append(wrapped.Assertions, wrapped.Items...))
	}
	return strings.TrimSpace(string(raw))
}

func joinNonEmpty(lines []string) string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func clipPromptText(s string, limit int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return strings.TrimSpace(string(runes[:limit])) + "…"
}

func indentPromptBlock(s string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = "    " + line
	}
	return strings.Join(lines, "\n")
}

// alignChatResourceKinds rewrites an issue ref to the kind the server
// actually stores. The picker tab can label a child task as a requirement;
// rejecting that used to fail the whole send, and persisting the wrong kind
// made the card vanish on the next read.
func (h *Handler) alignChatResourceKinds(r *http.Request, refs []protocol.ChatResourceRef) {
	ids := make([]pgtype.UUID, 0, len(refs))
	for _, ref := range refs {
		if ref.Type != "issue" {
			continue
		}
		id, err := util.ParseUUID(ref.ID)
		if err != nil {
			continue
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return
	}
	loaded, err := h.Queries.ListIssuesByIDs(r.Context(), ids)
	if err != nil {
		return
	}
	byID := make(map[string]db.Issue, len(loaded))
	for _, issue := range loaded {
		byID[uuidToString(issue.ID)] = issue
	}
	for i, ref := range refs {
		issue, ok := byID[ref.ID]
		if ref.Type != "issue" || !ok {
			continue
		}
		if issueKindIsRequirement(issue.ParentIssueID.Valid, issue.StartAt, issue.DecompositionConfirmedAt, issue.TriggeredAt, issue.RepoResourceID) {
			refs[i].Kind = "requirement"
		} else {
			refs[i].Kind = "task"
		}
	}
}

func (h *Handler) validateChatResourceRefs(r *http.Request, workspaceID pgtype.UUID, refs []protocol.ChatResourceRef) bool {
	resolved := h.resolveChatResourceBatch(r, workspaceID, refs)
	if len(resolved) != len(refs) {
		return false
	}
	for _, resource := range resolved {
		if resource.Access != "granted" {
			return false
		}
	}
	return true
}

func (h *Handler) resolveChatResourceBatch(r *http.Request, workspaceID pgtype.UUID, refs []protocol.ChatResourceRef) []protocol.ChatResourcePayload {
	out := make([]protocol.ChatResourcePayload, 0, len(refs))
	issueIDs := make([]pgtype.UUID, 0, len(refs))
	artifactIDs := make([]pgtype.UUID, 0, len(refs))
	attachmentIDs := make([]pgtype.UUID, 0, len(refs))
	for _, ref := range refs {
		id, parseErr := util.ParseUUID(ref.ID)
		if parseErr != nil {
			continue
		}
		switch {
		case ref.Type == "issue":
			issueIDs = append(issueIDs, id)
		case ref.Type == "document" && ref.Source == "artifact":
			artifactIDs = append(artifactIDs, id)
		case ref.Type == "document" && ref.Source == "attachment":
			attachmentIDs = append(attachmentIDs, id)
		}
	}
	issues := make(map[string]db.Issue, len(issueIDs))
	if len(issueIDs) > 0 {
		loaded, loadErr := h.Queries.ListIssuesByIDs(r.Context(), issueIDs)
		if loadErr != nil {
			return out
		}
		for _, issue := range loaded {
			issues[uuidToString(issue.ID)] = issue
		}
	}
	artifacts := make(map[string]projectArtifactRow, len(artifactIDs))
	if len(artifactIDs) > 0 {
		artifactRows, loadErr := h.DB.Query(r.Context(), `SELECT `+projectArtifactColumns+`
			FROM project_artifact WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, artifactIDs)
		if loadErr != nil {
			return out
		}
		for artifactRows.Next() {
			artifact, scanErr := scanProjectArtifactRow(artifactRows.Scan)
			if scanErr != nil {
				artifactRows.Close()
				return out
			}
			artifacts[uuidToString(artifact.ID)] = artifact
		}
		if loadErr = artifactRows.Err(); loadErr != nil {
			artifactRows.Close()
			return out
		}
		artifactRows.Close()
	}
	attachments := make(map[string]db.Attachment, len(attachmentIDs))
	if len(attachmentIDs) > 0 {
		loaded, loadErr := h.Queries.ListAttachmentsByIDsOnly(r.Context(), attachmentIDs)
		if loadErr != nil {
			return out
		}
		for _, attachment := range loaded {
			attachments[uuidToString(attachment.ID)] = attachment
		}
	}
	for _, ref := range refs {
		var resolved *protocol.ChatResourcePayload
		var err error
		resolved = &protocol.ChatResourcePayload{
			Type: ref.Type, ID: ref.ID, Kind: ref.Kind, Source: ref.Source,
			ProjectID: ref.ProjectID, Access: "granted",
		}
		switch {
		case ref.Type == "issue":
			issue, ok := issues[ref.ID]
			if !ok {
				err = errChatResourceMissing
			} else {
				err = h.fillIssueResource(r, workspaceID, ref, issue, resolved)
			}
		case ref.Type == "document" && ref.Source == "artifact":
			artifact, ok := artifacts[ref.ID]
			if !ok {
				err = errChatResourceMissing
			} else {
				err = fillArtifactResource(workspaceID, ref, artifact, resolved)
			}
		case ref.Type == "document" && ref.Source == "attachment":
			attachment, ok := attachments[ref.ID]
			if !ok {
				err = errChatResourceMissing
			} else {
				err = h.fillAttachmentResource(r, workspaceID, attachment, resolved)
			}
		case ref.Type == "module":
			if !featureflags.ModulePrototypeChatEnabled(r.Context(), h.FeatureFlags) {
				err = errChatResourceMissing
			} else if targetID, parseErr := util.ParseUUID(ref.ID); parseErr != nil {
				err = errChatResourceMissing
			} else {
				err = h.fillModuleResource(r.Context(), workspaceID, targetID, resolved)
			}
		case ref.Type == "module_prototype":
			if !featureflags.ModulePrototypeChatEnabled(r.Context(), h.FeatureFlags) {
				err = errChatResourceMissing
			} else if targetID, parseErr := util.ParseUUID(ref.ID); parseErr != nil {
				err = errChatResourceMissing
			} else {
				err = h.fillModulePrototypeResource(r.Context(), workspaceID, targetID, resolved)
			}
		default:
			err = errChatResourceMissing
		}
		if err != nil {
			access := "missing"
			if errors.Is(err, errChatResourceDenied) {
				access = "denied"
			}
			out = append(out, protocol.ChatResourcePayload{
				Type: ref.Type, ID: ref.ID, Kind: ref.Kind, Source: ref.Source,
				ProjectID: ref.ProjectID, Access: access,
			})
			continue
		}
		out = append(out, *resolved)
	}
	return out
}

func (h *Handler) groupChatMessageResources(r *http.Request, workspaceID pgtype.UUID, messageIDs []pgtype.UUID) map[string][]protocol.ChatResourcePayload {
	out := make(map[string][]protocol.ChatResourcePayload)
	if len(messageIDs) == 0 {
		return out
	}
	rows, err := h.Queries.ListChatMessageResourceRefs(r.Context(), messageIDs)
	if err != nil {
		return out
	}
	refs := make([]protocol.ChatResourceRef, 0, len(rows))
	for _, row := range rows {
		refs = append(refs, protocol.ChatResourceRef{
			Type: row.ResourceType, ID: uuidToString(row.ResourceID),
			Kind: row.ResourceKind, Source: row.ResourceSource, ProjectID: uuidToString(row.ProjectID),
		})
	}
	resolved := h.resolveChatResourceBatch(r, workspaceID, refs)
	if len(resolved) != len(rows) {
		return out
	}
	for i, row := range rows {
		key := uuidToString(row.MessageID)
		out[key] = append(out[key], resolved[i])
	}
	return out
}

func writeChatResourceRefs(ctx context.Context, qtx *db.Queries, messageID pgtype.UUID, refs []protocol.ChatResourceRef) error {
	for i, ref := range refs {
		resourceID, err := util.ParseUUID(ref.ID)
		if err != nil {
			return fmt.Errorf("invalid resource id: %w", err)
		}
		projectID := pgtype.UUID{}
		if ref.ProjectID != "" {
			projectID, err = util.ParseUUID(ref.ProjectID)
			if err != nil {
				return fmt.Errorf("invalid project id: %w", err)
			}
		}
		if err := qtx.CreateChatMessageResourceRef(ctx, db.CreateChatMessageResourceRefParams{
			MessageID: messageID, Position: int32(i), ResourceType: ref.Type,
			ResourceID: resourceID, ResourceKind: ref.Kind, ResourceSource: ref.Source, ProjectID: projectID,
		}); err != nil {
			return err
		}
	}
	return nil
}
