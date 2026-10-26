package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 图谱快照 + 本体层（migrations 456/457）：CLI sync 一次性导入，server 只存
// 不解析文件系统。快照保留策略：同一 project 最多 5 份，sync 时事务内清理
// 最旧。module_summary / bus_matrix 为独立 JSONB 列（migration 456），CLI
// 预聚合后直接落库，读取时直接提取，契约对齐
// packages/core/types/graph.ts。
// spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §5.2/§5.3

// GraphSyncPayload mirrors the TS `GraphSyncPayload` (snake_case). nodes /
// edges / communities / stats stay as raw JSON: the server never parses the
// graph body, it only validates that each blob is well-formed JSON.
type GraphSyncPayload struct {
	ScanID          string          `json:"scan_id"`
	GitSha          string          `json:"git_sha"`
	GitnexusVersion string          `json:"gitnexus_version"`
	Nodes           json.RawMessage `json:"nodes"`
	Edges           json.RawMessage `json:"edges"`
	Communities     json.RawMessage `json:"communities"`
	Stats           json.RawMessage `json:"stats"`
	ModuleSummary   json.RawMessage `json:"module_summary"`
	BusMatrix       json.RawMessage `json:"bus_matrix"`
	// DataModel carries the v2 versioned data-asset projection (migration
	// 467): opaque JSONB like module_summary / bus_matrix — the server never
	// parses it, it only validates well-formedness implicitly via JSONB.
	DataModel json.RawMessage `json:"data_model"`
	// ExpectedScanID is an OPTIONAL optimistic-lock precondition (task 27):
	// when non-empty, the sync only proceeds if the project's newest snapshot
	// still carries this scan_id; otherwise the handler answers 409 with the
	// current scan_id. It closes the residual read-then-post race the frontend
	// rescan guard could not (a CLI push landing between the guard read and the
	// POST round-trip). Chosen as a body field over an If-Match header because
	// the payload is already JSON-decoded here and scan_id is a plain string,
	// not an ETag — no header quoting/escaping semantics to honor. Empty (the
	// default for the CLI's full sync) leaves the upsert behavior unchanged, so
	// the field is fully backward compatible.
	ExpectedScanID string `json:"expected_scan_id"`
}

// maxGraphSyncBodyBytes caps the graph/sync request body before parsing.
//
// SIZING BASIS — Jimmy's task-23 measurements of real serialized snapshots:
//
//	small repo  (2k nodes / 5k edges)   ≈  1.30 MiB
//	medium repo (12k / 40k)             ≈  9.17 MiB
//	multica-scale (26k / 90k)           ≈ 20.36 MiB
//
// The 1 MiB cap used by agent_run.go would reject EVERY real snapshot, so it
// is the wrong precedent here. 64 MiB sits ~3× above the largest measured
// payload (headroom for repos bigger than multica) while still bounding one
// request's memory so a malicious / runaway body cannot OOM the handler.
// Streaming parse was considered but rejected: the upsert needs nodes/edges/
// communities as whole JSONB values to write in one statement, so the body is
// materialized regardless — a hard cap is the simpler, sufficient guard.
// Over-limit requests fail fast with 413 (see SyncGraphSnapshot).
const maxGraphSyncBodyBytes = 64 << 20 // 64 MiB

// SyncGraphSnapshotResponse is the result of POST .../graph/sync.
type SyncGraphSnapshotResponse struct {
	SnapshotID string `json:"snapshot_id"`
	Inserted   bool   `json:"inserted"`
	CleanedUp  int64  `json:"cleaned_up"`
	// Module ↔ Community bridge pass (migration 455 graph_node_id): how many
	// communities matched a same-named project_module, how many modules were
	// actually (re)bound, and which community names found no module. The CLI
	// surfaces unmatched names so operators can rename either side.
	MatchedModules       int      `json:"matched_modules"`
	UpdatedModules       int      `json:"updated_modules"`
	UnmatchedCommunities []string `json:"unmatched_communities"`
}

// jsonOrNullArray normalizes an absent JSONB extraction to `[]` so list-typed
// contract fields never surface as null.
func jsonOrNullArray(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage("[]")
	}
	return raw
}

// jsonOrNullObject is jsonOrNullArray's sibling for object-typed fields
// (data_model): an absent extraction surfaces as `{}`, never null.
func jsonOrNullObject(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage("{}")
	}
	return raw
}

// extractStatsField pulls a top-level key out of the stats JSONB payload.
func extractStatsField(stats []byte, key string) json.RawMessage {
	if len(stats) == 0 {
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(stats, &obj); err != nil {
		return nil
	}
	if v, ok := obj[key]; ok {
		return v
	}
	return nil
}

// graphSnapshotRow is the shared scan target for summary queries (no
// nodes/edges payload).
type graphSnapshotRow struct {
	ID              pgtype.UUID
	ProjectID       pgtype.UUID
	ScanID          string
	GitSha          string
	GitnexusVersion string
	Stats           []byte
	ModuleSummary   []byte
	BusMatrix       []byte
	DataModel       []byte
	CreatedAt       pgtype.Timestamptz
}

// loadLatestGraphSnapshot returns the newest snapshot for the project, or
// ok=false when none exists yet (structured empty states are the caller's
// responsibility — see §5.2 降级).
func (h *Handler) loadLatestGraphSnapshot(w http.ResponseWriter, r *http.Request, project db.Project) (graphSnapshotRow, bool) {
	row := graphSnapshotRow{}
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, project_id, scan_id, git_sha, gitnexus_version, stats, module_summary, bus_matrix, data_model, created_at
		FROM project_graph_snapshot
		WHERE project_id = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		project.ID,
	).Scan(&row.ID, &row.ProjectID, &row.ScanID, &row.GitSha, &row.GitnexusVersion, &row.Stats, &row.ModuleSummary, &row.BusMatrix, &row.DataModel, &row.CreatedAt)
	if err != nil {
		writeErrorCode(w, http.StatusNotFound, "graph_snapshot_missing", "no graph snapshot available for this project")
		return graphSnapshotRow{}, false
	}
	return row, true
}

// SyncGraphSnapshot implements POST /api/projects/{id}/graph/sync: UPSERT by
// (project_id, scan_id) inside one transaction, then trim the project's
// snapshots to the 5 most recent (spec §4.2 retention policy).
func (h *Handler) SyncGraphSnapshot(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	archiveResourceID, ok := h.loadArchiveResourceID(w, r, project)
	if !ok {
		return
	}
	var req GraphSyncPayload
	// Bound the body before parsing (task 27): a real snapshot can be ~20 MiB,
	// so the cap is 64 MiB (see maxGraphSyncBodyBytes for the sizing basis).
	// MaxBytesReader makes the decoder fail with *http.MaxBytesError once the
	// limit is exceeded → 413; any other decode failure stays a client 400.
	body := http.MaxBytesReader(w, r.Body, maxGraphSyncBodyBytes)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "graph snapshot payload exceeds the 64 MiB body limit")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	// Optimistic lock (task 27): when the caller supplies expected_scan_id,
	// verify it still matches the project's newest snapshot INSIDE this
	// transaction so the check and the upsert below are atomic w.r.t. a
	// concurrent CLI push. A mismatch → 409 with the current scan_id so the
	// client can re-read and retry. Absent (empty) → behavior is unchanged.
	if expected := strings.TrimSpace(req.ExpectedScanID); expected != "" {
		var currentScanID string
		err := tx.QueryRow(ctx, `
			SELECT scan_id FROM project_graph_snapshot
			WHERE project_id = $1
			ORDER BY created_at DESC
			LIMIT 1`,
			project.ID,
		).Scan(&currentScanID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "failed to verify expected scan id")
			return
		}
		// No snapshot yet (ErrNoRows → currentScanID stays "") also conflicts:
		// the client expected a specific snapshot that is not the latest.
		if currentScanID != expected {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":            "graph snapshot changed since it was read",
				"code":             "scan_id_conflict",
				"expected_scan_id": expected,
				"current_scan_id":  currentScanID,
			})
			return
		}
	}

	result, err := syncGraphSnapshotDetailedInTx(ctx, tx, project, archiveResourceID, req)
	if err != nil {
		// Payload validation errors are client-fixable → 400 with details;
		// anything else (DB / transaction failures) is a server fault → 500
		// with a fixed message so internals never leak.
		var validationErr *graphPayloadValidationError
		if errors.As(err, &validationErr) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to sync graph snapshot")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit graph sync")
		return
	}
	// TODO(project-archive): publish EventProjectGraphSynced once the protocol
	// constant exists.
	writeJSON(w, http.StatusOK, SyncGraphSnapshotResponse{
		SnapshotID:           result.SnapshotID,
		Inserted:             result.Inserted,
		CleanedUp:            result.CleanedUp,
		MatchedModules:       result.Bridge.Matched,
		UpdatedModules:       result.Bridge.Updated,
		UnmatchedCommunities: result.Bridge.Unmatched,
	})
}

// RebridgeGraphSnapshotResponse is the result of POST .../graph/rebridge: the
// module ↔ community bridge pass re-run against the project's latest snapshot,
// WITHOUT the client re-uploading the graph body. node_count is echoed so the
// caller can confirm which snapshot was bridged and that it was non-trivial.
type RebridgeGraphSnapshotResponse struct {
	ScanID               string   `json:"scan_id"`
	NodeCount            int64    `json:"node_count"`
	MatchedModules       int      `json:"matched_modules"`
	UpdatedModules       int      `json:"updated_modules"`
	UnmatchedCommunities []string `json:"unmatched_communities"`
}

// RebridgeGraphSnapshot implements POST /api/projects/{id}/graph/rebridge
// (task 27): re-run ONLY the module ↔ community auto-bind against the newest
// stored snapshot. The server reads nodes/communities straight from the DB and
// calls the same matchModulesToCommunitiesInTx the sync path uses, so the
// matched/updated counts are honest. This removes the frontend's
// read-back-and-re-upload of the 9–20 MiB graph body entirely.
//
// No snapshot → 404 (an honest empty state, never a fabricated match count).
// The bridge is a write path (it may UPDATE project_module.graph_node_id), so
// it runs inside a transaction and requires an authenticated user, mirroring
// SyncGraphSnapshot.
func (h *Handler) RebridgeGraphSnapshot(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	// Read the newest snapshot's identity, communities and node count inside the
	// same transaction as the bridge below, so a concurrent CLI push cannot make
	// us bridge a communities blob that is no longer the latest. node_count uses
	// jsonb_typeof to stay safe if the column is null or a non-array shape.
	var scanID string
	var communities []byte
	var nodeCount int64
	err = tx.QueryRow(ctx, `
		SELECT scan_id, communities,
		       COALESCE(CASE WHEN jsonb_typeof(nodes) = 'array'
		                     THEN jsonb_array_length(nodes) ELSE 0 END, 0)
		FROM project_graph_snapshot
		WHERE project_id = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		project.ID,
	).Scan(&scanID, &communities, &nodeCount)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErrorCode(w, http.StatusNotFound, "graph_snapshot_missing", "no graph snapshot available for this project")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load latest graph snapshot")
		return
	}

	bridge, err := matchModulesToCommunitiesInTx(ctx, tx, project.ID, jsonOrNullArray(communities))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to re-run module bridge")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit rebridge")
		return
	}
	writeJSON(w, http.StatusOK, RebridgeGraphSnapshotResponse{
		ScanID:               scanID,
		NodeCount:            nodeCount,
		MatchedModules:       bridge.Matched,
		UpdatedModules:       bridge.Updated,
		UnmatchedCommunities: bridge.Unmatched,
	})
}

// graphSyncResult is the full outcome of one snapshot sync: identity, the
// retention trim count, and the module ↔ Community bridge pass.
type graphSyncResult struct {
	SnapshotID string
	Inserted   bool
	CleanedUp  int64
	Bridge     moduleBridgeMatch
}

// syncGraphSnapshotInTx validates the payload, upserts the snapshot, and
// enforces the 5-snapshot retention. Shared with the artifact-sync endpoint
// so a manifest and its graph snapshot land in the same transaction; that
// caller only needs the identity triple, hence the narrow signature.
func syncGraphSnapshotInTx(ctx context.Context, tx pgx.Tx, project db.Project, archiveResourceID pgtype.UUID, payload GraphSyncPayload) (string, bool, int64, error) {
	result, err := syncGraphSnapshotDetailedInTx(ctx, tx, project, archiveResourceID, payload)
	return result.SnapshotID, result.Inserted, result.CleanedUp, err
}

// syncGraphSnapshotDetailedInTx is the real implementation: upsert → retention
// trim → project_module.graph_node_id auto-binding, all inside the caller's
// transaction so a failed bind rolls the snapshot back with it.
func syncGraphSnapshotDetailedInTx(ctx context.Context, tx pgx.Tx, project db.Project, archiveResourceID pgtype.UUID, payload GraphSyncPayload) (graphSyncResult, error) {
	payload.ScanID = strings.TrimSpace(payload.ScanID)
	payload.GitSha = strings.TrimSpace(payload.GitSha)
	payload.GitnexusVersion = strings.TrimSpace(payload.GitnexusVersion)
	if payload.ScanID == "" || payload.GitSha == "" || payload.GitnexusVersion == "" {
		return graphSyncResult{}, errGraphPayloadValidation("scan_id, git_sha and gitnexus_version are required")
	}
	// Raw JSON fields must each be well-formed (json.Unmarshal into
	// RawMessage during decode already guarantees this for objects that
	// reached this struct, but a null literal or missing field still passes —
	// normalize those to the column defaults).
	nodes := jsonOrNullArray(payload.Nodes)
	edges := jsonOrNullArray(payload.Edges)
	communities := jsonOrNullArray(payload.Communities)
	stats := payload.Stats
	if len(stats) == 0 || string(stats) == "null" {
		stats = []byte("{}")
	}
	// stats may carry the CLI's pre-aggregated module_summary / bus_matrix
	// projections; validate they are arrays so later extraction can rely on
	// shape (§4.2: server does not recompute aggregations).
	for _, key := range []string{"module_summary", "bus_matrix"} {
		if v := extractStatsField(stats, key); v != nil && string(v) != "null" {
			var arr []json.RawMessage
			if err := json.Unmarshal(v, &arr); err != nil {
				return graphSyncResult{}, errGraphPayloadValidation("stats." + key + " must be an array")
			}
		}
	}

	// Normalize independent JSONB columns: CLI may submit module_summary /
	// bus_matrix as top-level payload fields; fall back to stats extraction.
	moduleSummary := payload.ModuleSummary
	busMatrix := payload.BusMatrix
	if len(moduleSummary) == 0 || string(moduleSummary) == "null" {
		if v := extractStatsField(stats, "module_summary"); v != nil {
			moduleSummary = v
		} else {
			moduleSummary = []byte("[]")
		}
	}
	if len(busMatrix) == 0 || string(busMatrix) == "null" {
		if v := extractStatsField(stats, "bus_matrix"); v != nil {
			busMatrix = v
		} else {
			busMatrix = []byte("[]")
		}
	}
	// data_model is the v2 versioned asset projection (object, not array);
	// absent payloads degrade to {} so older snapshots stay readable.
	dataModel := payload.DataModel
	if len(dataModel) == 0 || string(dataModel) == "null" {
		if v := extractStatsField(stats, "data_model"); v != nil {
			dataModel = v
		} else {
			dataModel = []byte("{}")
		}
	}

	var snapshotID pgtype.UUID
	var inserted bool
	err := tx.QueryRow(ctx, `
		INSERT INTO project_graph_snapshot (
			workspace_id, project_id, resource_id, scan_id,
			gitnexus_version, git_sha, nodes, edges, communities, stats,
			module_summary, bus_matrix, data_model
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (project_id, scan_id) DO UPDATE SET
			gitnexus_version = EXCLUDED.gitnexus_version,
			git_sha = EXCLUDED.git_sha,
			nodes = EXCLUDED.nodes,
			edges = EXCLUDED.edges,
			communities = EXCLUDED.communities,
			stats = EXCLUDED.stats,
			module_summary = EXCLUDED.module_summary,
			bus_matrix = EXCLUDED.bus_matrix,
			data_model = EXCLUDED.data_model
		RETURNING id, (xmax = 0)`,
		project.WorkspaceID, project.ID, archiveResourceID, payload.ScanID,
		payload.GitnexusVersion, payload.GitSha, nodes, edges, communities, stats,
		moduleSummary, busMatrix, dataModel,
	).Scan(&snapshotID, &inserted)
	if err != nil {
		return graphSyncResult{}, err
	}

	// Retention: keep the 5 newest snapshots (the just-upserted row is the
	// newest or among them). Cascades clean up ontology_* children.
	tag, err := tx.Exec(ctx, `
		DELETE FROM project_graph_snapshot
		WHERE project_id = $1
		  AND id NOT IN (
			SELECT id FROM project_graph_snapshot
			WHERE project_id = $1
			ORDER BY created_at DESC
			LIMIT 5
		  )`,
		project.ID)
	if err != nil {
		return graphSyncResult{}, err
	}

	// Module bridge (migration 455): bind project_module.graph_node_id to the
	// Community node carrying the same name. This snapshot is the only place
	// where community ids and module names meet, so it is also the only write
	// path for the column — skip it and every f10 module tab 404s forever.
	bridge, err := matchModulesToCommunitiesInTx(ctx, tx, project.ID, communities)
	if err != nil {
		return graphSyncResult{}, err
	}
	return graphSyncResult{
		SnapshotID: util.UUIDToString(snapshotID),
		Inserted:   inserted,
		CleanedUp:  tag.RowsAffected(),
		Bridge:     bridge,
	}, nil
}

// moduleBridgeMatch reports the outcome of the graph_node_id auto-binding pass.
type moduleBridgeMatch struct {
	// Matched counts communities whose name resolved to a project_module.
	Matched int
	// Updated counts the modules whose graph_node_id actually changed.
	Updated int
	// Unmatched lists community names with no module of the same name.
	Unmatched []string
}

// communityBridge is a tolerant projection of one GraphCommunity entry
// (packages/core/types/graph.ts): the contract names the community node id
// `id`, payloads in the wild also carry `node_id`, and the display name may
// arrive as `name` or `label`.
type communityBridge struct {
	ID     string `json:"id"`
	NodeID string `json:"node_id"`
	Name   string `json:"name"`
	Label  string `json:"label"`
}

func (c communityBridge) nodeID() string {
	if v := strings.TrimSpace(c.ID); v != "" {
		return v
	}
	return strings.TrimSpace(c.NodeID)
}

func (c communityBridge) displayName() string {
	if v := strings.TrimSpace(c.Name); v != "" {
		return v
	}
	return strings.TrimSpace(c.Label)
}

// maxUnmatchedCommunities caps the diagnostic list echoed back to the CLI so a
// snapshot with hundreds of unbridged communities cannot bloat the response.
const maxUnmatchedCommunities = 50

// bridgeModuleRow is one project_module candidate for the name match.
type bridgeModuleRow struct {
	id          pgtype.UUID
	graphNodeID string
}

// matchModulesToCommunitiesInTx binds project_module.graph_node_id to the
// community node with the same name (trimmed, case-insensitive). Idempotent: a
// module already pointing at the matched node id is counted but not rewritten.
func matchModulesToCommunitiesInTx(ctx context.Context, tx pgx.Tx, projectID pgtype.UUID, communities json.RawMessage) (moduleBridgeMatch, error) {
	match := moduleBridgeMatch{Unmatched: []string{}}
	if len(communities) == 0 || string(communities) == "null" {
		return match, nil
	}
	var parsed []communityBridge
	if err := json.Unmarshal(communities, &parsed); err != nil {
		// Shape tolerance: the communities column stores the payload verbatim,
		// so a blob this pass cannot read must not fail the sync — it only
		// skips the bridge and the snapshot stays queryable.
		return match, nil
	}
	if len(parsed) == 0 {
		return match, nil
	}

	byName := map[string]bridgeModuleRow{}
	// Rows must be fully drained and closed before the UPDATEs below: a pgx
	// transaction holds one connection, and an open cursor blocks it.
	if err := func() error {
		rows, err := tx.Query(ctx, `
			SELECT id, name, graph_node_id FROM project_module WHERE project_id = $1`,
			projectID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m bridgeModuleRow
			var name string
			var graphNodeID pgtype.Text
			if err := rows.Scan(&m.id, &name, &graphNodeID); err != nil {
				return err
			}
			if graphNodeID.Valid {
				m.graphNodeID = graphNodeID.String
			}
			key := strings.ToLower(strings.TrimSpace(name))
			if key == "" {
				continue
			}
			// UNIQUE(project_id, name) rules out exact duplicates; a
			// case-insensitive collision keeps the first module deterministically.
			if _, exists := byName[key]; !exists {
				byName[key] = m
			}
		}
		return rows.Err()
	}(); err != nil {
		return moduleBridgeMatch{}, err
	}

	reported := map[string]bool{}
	for _, c := range parsed {
		nodeID := c.nodeID()
		name := c.displayName()
		if nodeID == "" || name == "" {
			continue
		}
		key := strings.ToLower(name)
		module, ok := byName[key]
		if !ok {
			if !reported[name] && len(match.Unmatched) < maxUnmatchedCommunities {
				reported[name] = true
				match.Unmatched = append(match.Unmatched, name)
			}
			continue
		}
		match.Matched++
		if module.graphNodeID == nodeID {
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE project_module SET graph_node_id = $2 WHERE id = $1`, module.id, nodeID); err != nil {
			return moduleBridgeMatch{}, err
		}
		match.Updated++
		// Keep the candidate in sync so a second community carrying the same
		// name does not issue a redundant UPDATE.
		module.graphNodeID = nodeID
		byName[key] = module
	}
	return match, nil
}

type graphPayloadValidationError struct{ msg string }

func (e *graphPayloadValidationError) Error() string { return e.msg }

func errGraphPayloadValidation(msg string) error {
	return &graphPayloadValidationError{msg: msg}
}

// GraphSnapshotSummaryResponse mirrors the TS `GraphSnapshotSummary`: entry
// point without the nodes/edges payload.
type GraphSnapshotSummaryResponse struct {
	ID              string          `json:"id"`
	ProjectID       string          `json:"project_id"`
	ScanID          string          `json:"scan_id"`
	GitSha          string          `json:"git_sha"`
	GitnexusVersion string          `json:"gitnexus_version"`
	Stats           json.RawMessage `json:"stats"`
	ModuleSummary   json.RawMessage `json:"module_summary"`
	BusMatrix       json.RawMessage `json:"bus_matrix"`
	DataModel       json.RawMessage `json:"data_model"`
	CreatedAt       string          `json:"created_at"`
}

// GetLatestGraphSnapshot implements GET /api/projects/{id}/graph/latest:
// summary only — the nodes/edges JSONB blobs are deliberately not selected
// so the entry-point query stays cheap.
func (h *Handler) GetLatestGraphSnapshot(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	row, ok := h.loadLatestGraphSnapshot(w, r, project)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, GraphSnapshotSummaryResponse{
		ID:              uuidToString(row.ID),
		ProjectID:       uuidToString(row.ProjectID),
		ScanID:          row.ScanID,
		GitSha:          row.GitSha,
		GitnexusVersion: row.GitnexusVersion,
		Stats:           json.RawMessage(row.Stats),
		ModuleSummary:   jsonOrNullArray(row.ModuleSummary),
		BusMatrix:       jsonOrNullArray(row.BusMatrix),
		DataModel:       jsonOrNullObject(row.DataModel),
		CreatedAt:       timestampToString(row.CreatedAt),
	})
}

// GraphSnapshotDetailResponse mirrors the TS `ProjectGraphSnapshot`: the full
// nodes/edges/communities payload for the「产品功能」「数据模型」tabs.
type GraphSnapshotDetailResponse struct {
	ID              string          `json:"id"`
	WorkspaceID     string          `json:"workspace_id"`
	ProjectID       string          `json:"project_id"`
	ResourceID      string          `json:"resource_id"`
	ScanID          string          `json:"scan_id"`
	GitnexusVersion string          `json:"gitnexus_version"`
	GitSha          string          `json:"git_sha"`
	Nodes           json.RawMessage `json:"nodes"`
	Edges           json.RawMessage `json:"edges"`
	Communities     json.RawMessage `json:"communities"`
	Stats           json.RawMessage `json:"stats"`
	CreatedAt       string          `json:"created_at"`
}

// GetGraphSnapshotDetail implements GET /api/projects/{id}/graph/latest/detail:
// returns the complete newest snapshot. Contract fields are always present
// (nodes/edges/communities default to `[]`). Skeleton note: the optional
// node_ids filter is accepted but not yet applied server-side — the Go-side
// subgraph extraction is left as a TODO; clients filtering on the full
// payload get the documented full response.
func (h *Handler) GetGraphSnapshotDetail(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if nodeIDs := r.URL.Query().Get("node_ids"); nodeIDs != "" {
		// Validate shape early so callers get 400 instead of a silently
		// ignored filter once the server-side extraction lands.
		var ids []string
		if err := json.Unmarshal([]byte(nodeIDs), &ids); err != nil {
			writeError(w, http.StatusBadRequest, "node_ids must be a JSON array of node id strings")
			return
		}
		// TODO(project-archive): server-side node_ids subgraph extraction
		// (walk edges both directions within the requested node set).
	}

	var resp GraphSnapshotDetailResponse
	var snapshotUUID, workspaceUUID, projectUUID, resourceID pgtype.UUID
	var nodes, edges, communities, stats []byte
	var createdAt pgtype.Timestamptz
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, workspace_id, project_id, resource_id, scan_id,
		       gitnexus_version, git_sha, nodes, edges, communities, stats, created_at
		FROM project_graph_snapshot
		WHERE project_id = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		project.ID,
	).Scan(
		&snapshotUUID, &workspaceUUID, &projectUUID, &resourceID, &resp.ScanID,
		&resp.GitnexusVersion, &resp.GitSha, &nodes, &edges, &communities, &stats, &createdAt,
	)
	if err != nil {
		writeErrorCode(w, http.StatusNotFound, "graph_snapshot_missing", "no graph snapshot available for this project")
		return
	}
	resp.ID = uuidToString(snapshotUUID)
	resp.WorkspaceID = uuidToString(workspaceUUID)
	resp.ProjectID = uuidToString(projectUUID)
	resp.ResourceID = uuidToString(resourceID)
	resp.CreatedAt = timestampToString(createdAt)
	resp.Nodes = jsonOrNullArray(nodes)
	resp.Edges = jsonOrNullArray(edges)
	resp.Communities = jsonOrNullArray(communities)
	resp.Stats = stats
	writeJSON(w, http.StatusOK, resp)
}

// GraphModuleResponse is one row of the module-bridge list: project_module
// LEFT JOIN issue counts, plus the graph_node_id bridge state (column added
// in migration 455; not yet in the sqlc snapshot, hence the raw query).
type GraphModuleResponse struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Color       string  `json:"color"`
	GraphNodeID *string `json:"graph_node_id"`
	IssueCount  int64   `json:"issue_count"`
}

// ListGraphModules implements GET /api/projects/{id}/graph/modules: the
// module list with graph bridge state and per-module issue aggregation.
func (h *Handler) ListGraphModules(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT pm.id, pm.name, pm.color, pm.graph_node_id, COUNT(i.id)::bigint AS issue_count
		FROM project_module pm
		LEFT JOIN issue i ON i.module_id = pm.id
		WHERE pm.project_id = $1
		GROUP BY pm.id, pm.name, pm.color, pm.graph_node_id
		ORDER BY pm.name`,
		project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list graph modules")
		return
	}
	defer rows.Close()

	modules := []GraphModuleResponse{}
	for rows.Next() {
		var m GraphModuleResponse
		var id pgtype.UUID
		var graphNodeID pgtype.Text
		if err := rows.Scan(&id, &m.Name, &m.Color, &graphNodeID, &m.IssueCount); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan graph module")
			return
		}
		m.ID = uuidToString(id)
		m.GraphNodeID = textToPtr(graphNodeID)
		modules = append(modules, m)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list graph modules")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"modules": modules, "total": len(modules)})
}

// loadModuleByGraphNodeID resolves the URL's nodeId (a graph node id, i.e.
// the Community id the module is bridged to) to a project_module row.
func (h *Handler) loadModuleByGraphNodeID(w http.ResponseWriter, r *http.Request, project db.Project) (moduleID pgtype.UUID, name string, ok bool) {
	nodeID := chi.URLParam(r, "nodeId")
	if strings.TrimSpace(nodeID) == "" {
		writeError(w, http.StatusBadRequest, "node id is required")
		return pgtype.UUID{}, "", false
	}
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, name FROM project_module
		WHERE project_id = $1 AND graph_node_id = $2`,
		project.ID, nodeID,
	).Scan(&moduleID, &name)
	if err != nil {
		writeError(w, http.StatusNotFound, "no module is bridged to this graph node")
		return pgtype.UUID{}, "", false
	}
	return moduleID, name, true
}

// ModuleIssueSummary is one issue row of the module changes aggregate.
type ModuleIssueSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updated_at"`
}

// GetModuleChanges implements GET .../graph/modules/{nodeId}/changes: the
// issues aggregated under the module bridged to this graph node.
func (h *Handler) GetModuleChanges(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, moduleName, ok := h.loadModuleByGraphNodeID(w, r, project)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, title, status, updated_at
		FROM issue
		WHERE module_id = $1
		ORDER BY updated_at DESC
		LIMIT 50`,
		moduleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list module changes")
		return
	}
	defer rows.Close()

	issues := []ModuleIssueSummary{}
	for rows.Next() {
		var s ModuleIssueSummary
		var id pgtype.UUID
		var updatedAt pgtype.Timestamptz
		if err := rows.Scan(&id, &s.Title, &s.Status, &updatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan module change")
			return
		}
		s.ID = uuidToString(id)
		s.UpdatedAt = timestampToString(updatedAt)
		issues = append(issues, s)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list module changes")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id": uuidToString(moduleID),
		"node_id":   chi.URLParam(r, "nodeId"),
		"name":      moduleName,
		"issues":    issues,
		"total":     len(issues),
	})
}

// OntologyObjectResponse mirrors the TS `OntologyObject`. DB column
// entity_type matches the API field directly (migration 457).
type OntologyObjectResponse struct {
	ID            string          `json:"id"`
	EntityType    string          `json:"entity_type"`
	QualifiedName string          `json:"qualified_name"`
	Domain        *string         `json:"domain"`
	Lifecycle     *string         `json:"lifecycle"`
	ImplStatus    *string         `json:"impl_status"`
	Properties    json.RawMessage `json:"properties,omitempty"`
}

// ModuleObjectsResponse combines the graph-layer module summary with the
// ontology-layer object list (empty until ontology extraction is ready).
type ModuleObjectsResponse struct {
	ModuleID      string                   `json:"module_id"`
	NodeID        string                   `json:"node_id"`
	Name          string                   `json:"name"`
	ObjCount      int64                    `json:"obj_count"`
	TablesTouched []string                 `json:"tables_touched"`
	Objects       []OntologyObjectResponse `json:"objects"`
}

// GetModuleObjects implements GET .../graph/modules/{nodeId}/objects: the
// module's object list from the ontology layer when extracted, falling back
// to the graph-layer module_summary projection carried in the snapshot
// stats (skeleton path until ontology extraction lands).
func (h *Handler) GetModuleObjects(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, moduleName, ok := h.loadModuleByGraphNodeID(w, r, project)
	if !ok {
		return
	}
	nodeID := chi.URLParam(r, "nodeId")

	resp := ModuleObjectsResponse{
		ModuleID:      uuidToString(moduleID),
		NodeID:        nodeID,
		Name:          moduleName,
		TablesTouched: []string{},
		Objects:       []OntologyObjectResponse{},
	}

	// Ontology layer first (migration 457): rows exist once extraction ran.
	objects, err := h.listOntologyObjects(r, project.ID, nodeID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list module objects")
		return
	}
	resp.Objects = objects
	resp.ObjCount = int64(len(objects))

	// Graph-layer fallback enrichment: pull the module_summary entry carried
	// in the latest snapshot's stats to fill obj_count/tables_touched when
	// the ontology layer is still empty.
	if len(objects) == 0 {
		if summary, err := h.latestSnapshotModuleSummary(r, project.ID); err == nil && len(summary) > 0 {
			var entries []struct {
				NodeID        string   `json:"node_id"`
				Name          string   `json:"name"`
				ObjCount      int64    `json:"obj_count"`
				TablesTouched []string `json:"tables_touched"`
			}
			if json.Unmarshal(summary, &entries) == nil {
				for _, e := range entries {
					if e.NodeID == nodeID {
						resp.ObjCount = e.ObjCount
						resp.TablesTouched = e.TablesTouched
						if resp.TablesTouched == nil {
							resp.TablesTouched = []string{}
						}
						break
					}
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) listOntologyObjects(r *http.Request, projectID pgtype.UUID, nodeID string) ([]OntologyObjectResponse, error) {
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, entity_type, name, qualified_name, domain, lifecycle, impl_status, properties
		FROM ontology_object
		WHERE project_id = $1
		  AND (node_id = $2 OR properties->>'community_id' = $2)
		ORDER BY name`,
		projectID, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	objects := []OntologyObjectResponse{}
	for rows.Next() {
		var o OntologyObjectResponse
		var id pgtype.UUID
		var name, entityType string
		var qualifiedName pgtype.Text
		var domain, lifecycle, implStatus pgtype.Text
		var properties []byte
		if err := rows.Scan(&id, &entityType, &name, &qualifiedName, &domain, &lifecycle, &implStatus, &properties); err != nil {
			return nil, err
		}
		o.ID = uuidToString(id)
		o.EntityType = entityType
		o.QualifiedName = qualifiedName.String
		if !qualifiedName.Valid {
			o.QualifiedName = name
		}
		o.Domain = textToPtr(domain)
		o.Lifecycle = textToPtr(lifecycle)
		o.ImplStatus = textToPtr(implStatus)
		o.Properties = properties
		objects = append(objects, o)
	}
	return objects, rows.Err()
}

func (h *Handler) latestSnapshotStats(r *http.Request, projectID pgtype.UUID) ([]byte, error) {
	var stats []byte
	err := h.DB.QueryRow(r.Context(), `
		SELECT stats FROM project_graph_snapshot
		WHERE project_id = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		projectID,
	).Scan(&stats)
	return stats, err
}

// latestSnapshotModuleSummary reads the independent module_summary JSONB
// column from the newest snapshot for the given project.
func (h *Handler) latestSnapshotModuleSummary(r *http.Request, projectID pgtype.UUID) ([]byte, error) {
	var ms []byte
	err := h.DB.QueryRow(r.Context(), `
		SELECT module_summary FROM project_graph_snapshot
		WHERE project_id = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		projectID,
	).Scan(&ms)
	return ms, err
}

// ModuleStrategyResponse is one strategy kv projection.
type ModuleStrategyResponse struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Source string `json:"source"`
	Status string `json:"status"`
}

// GetModuleStrategies implements GET .../graph/modules/{nodeId}/strategies:
// strategies live in the ontology layer. Before ontology extraction is
// ready the endpoint reports ontology_ready="empty" with an empty list
// (降级先行, spec §4.3).
func (h *Handler) GetModuleStrategies(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, moduleName, ok := h.loadModuleByGraphNodeID(w, r, project)
	if !ok {
		return
	}
	nodeID := chi.URLParam(r, "nodeId")

	strategies := []ModuleStrategyResponse{}
	ontologyReady := "empty"
	objects, err := h.listOntologyObjects(r, project.ID, nodeID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list module strategies")
		return
	}
	if len(objects) > 0 {
		ontologyReady = "ready"
		// Strategy projection: each ontology object's properties map is
		// flattened into key/value pairs (source=ontology, status from
		// impl_status).
		for _, o := range objects {
			var props map[string]any
			if len(o.Properties) == 0 || json.Unmarshal(o.Properties, &props) != nil {
				continue
			}
			for k, v := range props {
				if s, isStr := v.(string); isStr {
					status := ""
					if o.ImplStatus != nil {
						status = *o.ImplStatus
					}
					strategies = append(strategies, ModuleStrategyResponse{
						Key: k, Value: s, Source: "ontology", Status: status,
					})
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":      uuidToString(moduleID),
		"node_id":        nodeID,
		"name":           moduleName,
		"ontology_ready": ontologyReady,
		"strategies":     strategies,
		"total":          len(strategies),
	})
}

// ModuleNeighborhoodResponse identifies the snapshot and returns the module's
// ego network. `nodes` is center + neighbours (the subgraph the f10 renderer
// draws); `neighbor_nodes` excludes the center; `edges` holds exactly the edges
// that connect them, in traversal order.
type ModuleNeighborhoodResponse struct {
	SnapshotID    string          `json:"snapshot_id"`
	ScanID        string          `json:"scan_id"`
	GitSha        string          `json:"git_sha"`
	Stats         json.RawMessage `json:"stats"`
	Nodes         json.RawMessage `json:"nodes"`
	Edges         json.RawMessage `json:"edges"`
	ModuleID      string          `json:"module_id"`
	ModuleName    string          `json:"module_name"`
	NodeID        string          `json:"node_id"`
	CenterNode    json.RawMessage `json:"center_node"`
	NeighborNodes json.RawMessage `json:"neighbor_nodes"`
	Depth         int             `json:"depth"`
	NodeCount     int             `json:"node_count"`
	EdgeCount     int             `json:"edge_count"`
	Truncated     bool            `json:"truncated"`
}

// graphNodeJSON / graphEdgeJSON are the minimal subset of the TS GraphNode /
// GraphEdge contract (packages/core/types/graph.ts) needed to synthesize the
// entries the CLI payload does not carry: a Community hub, a dangling edge
// endpoint, a derived membership edge. Scanned entries are passed through as
// raw JSON so unknown CLI fields survive the round-trip.
type graphNodeJSON struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	Name       string         `json:"name"`
	Properties map[string]any `json:"properties,omitempty"`
}

type graphEdgeJSON struct {
	Source     string         `json:"source"`
	Target     string         `json:"target"`
	Type       string         `json:"type"`
	Properties map[string]any `json:"properties,omitempty"`
}

// graphNodeEntry is one scanned node: the traversal keys plus the untouched
// payload element.
type graphNodeEntry struct {
	raw         json.RawMessage
	id          string
	nodeType    string
	communityID string
}

// graphEdgeEntry is one scanned edge: both endpoints plus the raw element.
type graphEdgeEntry struct {
	raw      json.RawMessage
	source   string
	target   string
	edgeType string
}

// moduleNeighborhood is the BFS output before JSON encoding.
type moduleNeighborhood struct {
	Center    json.RawMessage
	Neighbors []json.RawMessage
	Edges     []json.RawMessage
	Truncated bool
}

const (
	// defaultNeighborhoodDepth is the documented 1-hop ego network.
	defaultNeighborhoodDepth = 1
	// maxNeighborhoodDepth keeps ?depth from turning the endpoint into a full
	// graph dump.
	maxNeighborhoodDepth = 3
	// maxNeighborhoodNodes caps the returned subgraph (center included) so a
	// hub community cannot blow up the response.
	maxNeighborhoodNodes = 500
)

// marshalGraphJSON encodes a synthesized node/edge; a `null` literal is the
// only possible failure and it keeps the response shape intact.
func marshalGraphJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

// splitJSONArray validates that a JSONB column holds an array and hands back
// its elements untouched (absent column / null → no elements).
func splitJSONArray(raw []byte) ([]json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	return items, nil
}

func parseGraphNodes(raw []byte) ([]graphNodeEntry, error) {
	items, err := splitJSONArray(raw)
	if err != nil {
		return nil, err
	}
	nodes := make([]graphNodeEntry, 0, len(items))
	for _, item := range items {
		var light struct {
			ID          string `json:"id"`
			Type        string `json:"type"`
			CommunityID string `json:"community_id"`
		}
		if err := json.Unmarshal(item, &light); err != nil {
			continue
		}
		id := strings.TrimSpace(light.ID)
		if id == "" {
			continue
		}
		nodes = append(nodes, graphNodeEntry{
			raw:         item,
			id:          id,
			nodeType:    light.Type,
			communityID: strings.TrimSpace(light.CommunityID),
		})
	}
	return nodes, nil
}

func parseGraphEdges(raw []byte) ([]graphEdgeEntry, error) {
	items, err := splitJSONArray(raw)
	if err != nil {
		return nil, err
	}
	edges := make([]graphEdgeEntry, 0, len(items))
	for _, item := range items {
		var light struct {
			Source string `json:"source"`
			Target string `json:"target"`
			Type   string `json:"type"`
		}
		if err := json.Unmarshal(item, &light); err != nil {
			continue
		}
		source := strings.TrimSpace(light.Source)
		target := strings.TrimSpace(light.Target)
		if source == "" || target == "" {
			continue
		}
		edges = append(edges, graphEdgeEntry{raw: item, source: source, target: target, edgeType: light.Type})
	}
	return edges, nil
}

// buildModuleNeighborhood walks the ego network of nodeID over the snapshot's
// in-memory edge index, BFS by hop (depth 1 = the documented neighbourhood).
//
// Two honesty rules shape the output:
//   - a hub that is not itself a scanned node (Community ids live in their own
//     array) is synthesized and flagged `properties.synthesized`;
//   - when the hub has no incident edge at all, its members are reached through
//     `community_id` and each such edge is flagged `properties.derived`, so the
//     UI can always tell scanned topology from the projection.
//
// An empty result stays empty: nothing is invented to fill the tab.
func buildModuleNeighborhood(nodeID, moduleName string, nodes []graphNodeEntry, edges []graphEdgeEntry, depth int) moduleNeighborhood {
	byID := make(map[string]graphNodeEntry, len(nodes))
	for _, n := range nodes {
		if _, dup := byID[n.id]; !dup {
			byID[n.id] = n
		}
	}
	// Undirected adjacency: one entry per edge per endpoint.
	type adjacency struct {
		edge graphEdgeEntry
		peer string
	}
	adj := make(map[string][]adjacency, len(edges)*2)
	for _, e := range edges {
		adj[e.source] = append(adj[e.source], adjacency{edge: e, peer: e.target})
		adj[e.target] = append(adj[e.target], adjacency{edge: e, peer: e.source})
	}

	out := moduleNeighborhood{Neighbors: []json.RawMessage{}, Edges: []json.RawMessage{}}
	centerEntry, hasCenter := byID[nodeID]
	if hasCenter {
		out.Center = centerEntry.raw
	} else {
		out.Center = marshalGraphJSON(graphNodeJSON{
			ID:         nodeID,
			Type:       "Community",
			Name:       moduleName,
			Properties: map[string]any{"synthesized": true},
		})
	}
	isCommunity := !hasCenter || strings.EqualFold(centerEntry.nodeType, "Community")

	visited := map[string]bool{nodeID: true}
	frontier := []string{nodeID}
	seenEdge := map[string]bool{}
	for hop := 0; hop < depth && len(frontier) > 0 && !out.Truncated; hop++ {
		next := make([]string, 0, len(frontier))
		for _, current := range frontier {
			for _, link := range adj[current] {
				key := link.edge.source + "\x00" + link.edge.target + "\x00" + link.edge.edgeType
				if !seenEdge[key] {
					seenEdge[key] = true
					out.Edges = append(out.Edges, link.edge.raw)
				}
				if visited[link.peer] {
					continue
				}
				if len(visited) >= maxNeighborhoodNodes {
					out.Truncated = true
					break
				}
				visited[link.peer] = true
				if entry, ok := byID[link.peer]; ok {
					out.Neighbors = append(out.Neighbors, entry.raw)
				} else {
					// Dangling endpoint: keep the neighbour visible as a stub
					// instead of dropping the edge's context.
					out.Neighbors = append(out.Neighbors, marshalGraphJSON(graphNodeJSON{
						ID:         link.peer,
						Type:       "Unknown",
						Name:       link.peer,
						Properties: map[string]any{"stub": true},
					}))
				}
				next = append(next, link.peer)
			}
			if out.Truncated {
				break
			}
		}
		frontier = next
	}

	// Community membership fallback (see doc comment above).
	if isCommunity && len(out.Edges) == 0 {
		for _, n := range nodes {
			if n.communityID != nodeID || visited[n.id] {
				continue
			}
			if len(visited) >= maxNeighborhoodNodes {
				out.Truncated = true
				break
			}
			visited[n.id] = true
			out.Neighbors = append(out.Neighbors, n.raw)
			out.Edges = append(out.Edges, marshalGraphJSON(graphEdgeJSON{
				Source:     n.id,
				Target:     nodeID,
				Type:       "MEMBER_OF",
				Properties: map[string]any{"derived": "community_id"},
			}))
		}
	}
	return out
}

// GetModuleNeighborhood implements GET .../graph/modules/{nodeId}/neighborhood:
// the module's ego network inside the latest snapshot. The snapshot's
// nodes/edges JSONB are parsed in memory (the column is the CLI's projection,
// the server never recomputes the graph) and walked with a bounded BFS;
// ?depth=1..3 widens the walk, default 1 hop.
func (h *Handler) GetModuleNeighborhood(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, moduleName, ok := h.loadModuleByGraphNodeID(w, r, project)
	if !ok {
		return
	}
	nodeID := chi.URLParam(r, "nodeId")

	depth := defaultNeighborhoodDepth
	if raw := strings.TrimSpace(r.URL.Query().Get("depth")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxNeighborhoodDepth {
			writeError(w, http.StatusBadRequest, "depth must be an integer within 1..3")
			return
		}
		depth = parsed
	}

	// The summary loader deliberately skips nodes/edges; this endpoint needs
	// both, so it selects the newest snapshot payload directly.
	var snapshotID pgtype.UUID
	var scanID, gitSha string
	var stats, nodesRaw, edgesRaw []byte
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, scan_id, git_sha, stats, nodes, edges
		FROM project_graph_snapshot
		WHERE project_id = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		project.ID,
	).Scan(&snapshotID, &scanID, &gitSha, &stats, &nodesRaw, &edgesRaw)
	if err != nil {
		writeErrorCode(w, http.StatusNotFound, "graph_snapshot_missing", "no graph snapshot available for this project")
		return
	}

	nodes, err := parseGraphNodes(nodesRaw)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "snapshot nodes payload is malformed")
		return
	}
	edgeList, err := parseGraphEdges(edgesRaw)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "snapshot edges payload is malformed")
		return
	}

	neighborhood := buildModuleNeighborhood(nodeID, moduleName, nodes, edgeList, depth)
	subgraph := make([]json.RawMessage, 0, len(neighborhood.Neighbors)+1)
	subgraph = append(subgraph, neighborhood.Center)
	subgraph = append(subgraph, neighborhood.Neighbors...)

	nodesJSON, err := json.Marshal(subgraph)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode module neighborhood")
		return
	}
	neighborsJSON, err := json.Marshal(neighborhood.Neighbors)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode module neighborhood")
		return
	}
	edgesJSON, err := json.Marshal(neighborhood.Edges)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode module neighborhood")
		return
	}
	if len(stats) == 0 || string(stats) == "null" {
		stats = []byte("{}")
	}

	writeJSON(w, http.StatusOK, ModuleNeighborhoodResponse{
		SnapshotID:    uuidToString(snapshotID),
		ScanID:        scanID,
		GitSha:        gitSha,
		Stats:         json.RawMessage(stats),
		Nodes:         nodesJSON,
		Edges:         edgesJSON,
		ModuleID:      uuidToString(moduleID),
		ModuleName:    moduleName,
		NodeID:        nodeID,
		CenterNode:    neighborhood.Center,
		NeighborNodes: neighborsJSON,
		Depth:         depth,
		NodeCount:     len(subgraph),
		EdgeCount:     len(neighborhood.Edges),
		Truncated:     neighborhood.Truncated,
	})
}

// BusMatrixCell mirrors the TS `BusMatrixCell`.
type BusMatrixCell struct {
	ModuleName         string `json:"module_name"`
	ModuleNodeID       string `json:"module_node_id"`
	PageName           string `json:"page_name"`
	PageKey            string `json:"page_key"`
	Domain             string `json:"domain"`
	TableCount         int64  `json:"table_count"`
	ReadCount          int64  `json:"read_count"`
	WriteCount         int64  `json:"write_count"`
	IsNewTable         *bool  `json:"is_new_table,omitempty"`
	IsCrossDomainWrite *bool  `json:"is_cross_domain_write,omitempty"`
	// Process granularity (数据模型 v2): a page can carry several business
	// processes (主键组合); each becomes its own matrix row. Absent on v1
	// payloads, where rows stay page-level.
	ProcessKey  string `json:"process_key,omitempty"`
	ProcessName string `json:"process_name,omitempty"`
}

// loadBusMatrixCells reads the CLI's pre-aggregated bus_matrix projection
// from the latest snapshot stats.
func (h *Handler) loadBusMatrixCells(w http.ResponseWriter, r *http.Request, project db.Project) (graphSnapshotRow, []BusMatrixCell, bool) {
	snapshot, ok := h.loadLatestGraphSnapshot(w, r, project)
	if !ok {
		return graphSnapshotRow{}, nil, false
	}
	cells := []BusMatrixCell{}
	if raw := snapshot.BusMatrix; len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &cells); err != nil {
			writeError(w, http.StatusInternalServerError, "snapshot bus_matrix payload is malformed")
			return graphSnapshotRow{}, nil, false
		}
	}
	return snapshot, cells, true
}

// GetBusMatrix implements GET /api/projects/{id}/graph/bus-matrix: the
// module × page → table read/write matrix from the latest snapshot.
func (h *Handler) GetBusMatrix(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	snapshot, cells, ok := h.loadBusMatrixCells(w, r, project)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"snapshot_id": uuidToString(snapshot.ID),
		"scan_id":     snapshot.ScanID,
		"git_sha":     snapshot.GitSha,
		"bus_matrix":  cells,
		"total":       len(cells),
	})
}

// ---------------------------------------------------------------------------
// Optional bus_matrix detail keys
//
// migration 456 declares bus_matrix as opaque JSONB and the server never
// scans the filesystem, so the CLI pre-aggregation is the only producer. The
// stored *contract* — BusMatrixCell above, mirrored by TS BusMatrixCell — is
// aggregate-only: module × page × domain with table/read/write counts and the
// two flags. It carries NO table names and NO column names.
//
// The permissive decoder below additionally accepts the detail keys a
// pre-aggregation MAY deliver (`tables`, plus per-cell `added` / `modified` /
// `removed`). Every consumer checks presence explicitly and reports
// detail_available / columns_available rather than assuming: when the CLI
// delivered no table list, the drilldown answers with the aggregate numbers
// only and says so — table names are never invented server-side.
// ---------------------------------------------------------------------------

// busMatrixTableColumn decodes one touched column, accepting both the bare
// string form ("id") and the object form ({"name":"id","type":"uuid"}).
type busMatrixTableColumn struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Access string `json:"access"`
}

func (c *busMatrixTableColumn) UnmarshalJSON(data []byte) error {
	var name string
	if err := json.Unmarshal(data, &name); err == nil {
		c.Name = name
		return nil
	}
	type columnAlias busMatrixTableColumn
	var alias columnAlias
	if err := json.Unmarshal(data, &alias); err != nil {
		return err
	}
	*c = busMatrixTableColumn(alias)
	return nil
}

// busMatrixTable decodes one table behind a cell, accepting both the bare
// string form ("issue") and the object form. A bare string yields no columns,
// which surfaces as columns_available=false instead of a guessed column list.
type busMatrixTable struct {
	Name       string                 `json:"name"`
	Domain     string                 `json:"domain"`
	Columns    []busMatrixTableColumn `json:"columns"`
	ReadCount  *int64                 `json:"read_count"`
	WriteCount *int64                 `json:"write_count"`
	IsNewTable *bool                  `json:"is_new_table"`
}

func (t *busMatrixTable) UnmarshalJSON(data []byte) error {
	var name string
	if err := json.Unmarshal(data, &name); err == nil {
		t.Name = name
		return nil
	}
	type tableAlias busMatrixTable
	var alias tableAlias
	if err := json.Unmarshal(data, &alias); err != nil {
		return err
	}
	*t = busMatrixTable(alias)
	return nil
}

// busMatrixCellDetail is the permissive decode of one bus_matrix element:
// the strict contract fields plus the optional detail keys.
type busMatrixCellDetail struct {
	BusMatrixCell
	Tables   []busMatrixTable `json:"tables"`
	Added    *int64           `json:"added"`
	Modified *int64           `json:"modified"`
	Removed  *int64           `json:"removed"`
}

// cellLocator is the "module_node_id:page_key:domain" key the f11 UI already
// uses to identify a matrix cell.
func (c busMatrixCellDetail) cellLocator() string {
	return c.ModuleNodeID + ":" + c.PageKey + ":" + c.Domain
}

// loadBusMatrixCellDetails is loadBusMatrixCells' permissive sibling: the same
// snapshot row, but the decoded cells keep the optional detail keys the strict
// BusMatrixCell decode drops. loadBusMatrixCells stays untouched because
// GetBusMatrix serves the documented aggregate contract.
func (h *Handler) loadBusMatrixCellDetails(w http.ResponseWriter, r *http.Request, project db.Project) (graphSnapshotRow, []busMatrixCellDetail, bool) {
	snapshot, ok := h.loadLatestGraphSnapshot(w, r, project)
	if !ok {
		return graphSnapshotRow{}, nil, false
	}
	cells := []busMatrixCellDetail{}
	if raw := snapshot.BusMatrix; len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &cells); err != nil {
			writeError(w, http.StatusInternalServerError, "snapshot bus_matrix payload is malformed")
			return graphSnapshotRow{}, nil, false
		}
	}
	return snapshot, cells, true
}

// appendUniqueString appends value unless it is already present (source-cell
// locators repeat across the cells that share a table).
func appendUniqueString(list []string, value string) []string {
	for _, existing := range list {
		if existing == value {
			return list
		}
	}
	return append(list, value)
}

// maxDrilldownTables caps the rolled-up table list so a loosely filtered
// drilldown (module only, say) cannot become a full data-dictionary dump.
// TablesTruncated reports the cap; Total always counts the real cells.
const maxDrilldownTables = 200

// BusMatrixTableColumn mirrors the TS `BusMatrixTableColumn`.
type BusMatrixTableColumn struct {
	Name   string `json:"name"`
	Type   string `json:"type,omitempty"`
	Access string `json:"access,omitempty"`
}

// BusMatrixTableDetail mirrors the TS `BusMatrixTableDetail`.
type BusMatrixTableDetail struct {
	Name       string                 `json:"name"`
	Domain     string                 `json:"domain,omitempty"`
	Columns    []BusMatrixTableColumn `json:"columns"`
	ReadCount  *int64                 `json:"read_count,omitempty"`
	WriteCount *int64                 `json:"write_count,omitempty"`
	IsNewTable *bool                  `json:"is_new_table,omitempty"`
	// Cell locators ("module_node_id:page_key:domain") the table was seen in.
	SourceCells []string `json:"source_cells,omitempty"`
}

// BusMatrixDrilldownResponse mirrors the TS `BusMatrixDrilldownResponse`.
type BusMatrixDrilldownResponse struct {
	Cells  []BusMatrixCell        `json:"cells"`
	Total  int                    `json:"total"`
	Tables []BusMatrixTableDetail `json:"tables"`
	// DetailAvailable is true only when at least one matched cell carried a
	// `tables` list; ColumnsAvailable only when a table carried columns. The
	// UI degrades on these flags instead of rendering an empty table shell.
	DetailAvailable  bool `json:"detail_available"`
	ColumnsAvailable bool `json:"columns_available"`
	TablesTruncated  bool `json:"tables_truncated"`
}

// GetBusMatrixDrilldown implements GET .../graph/bus-matrix/drilldown:
// validates the filters and selects the matching matrix cells.
// Supported filters: module_node_id, page_key, process_key, domain.
//
// On top of the matched cells it rolls up the table / column detail the CLI
// pre-aggregation attached to them. That detail is optional in the payload:
// when it is absent the response says detail_available=false and the aggregate
// numbers are all there is — the prototype's 表 + 列清单 then degrades to a
// named gap in the UI rather than a fabricated data dictionary.
func (h *Handler) GetBusMatrixDrilldown(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	query := r.URL.Query()
	moduleNodeID := strings.TrimSpace(query.Get("module_node_id"))
	pageKey := strings.TrimSpace(query.Get("page_key"))
	processKey := strings.TrimSpace(query.Get("process_key"))
	domain := strings.TrimSpace(query.Get("domain"))

	_, cells, ok := h.loadBusMatrixCellDetails(w, r, project)
	if !ok {
		return
	}
	filtered := make([]busMatrixCellDetail, 0, len(cells))
	for _, c := range cells {
		if moduleNodeID != "" && c.ModuleNodeID != moduleNodeID {
			continue
		}
		if pageKey != "" && c.PageKey != pageKey {
			continue
		}
		if processKey != "" && c.ProcessKey != processKey {
			continue
		}
		if domain != "" && c.Domain != domain {
			continue
		}
		filtered = append(filtered, c)
	}

	resp := BusMatrixDrilldownResponse{
		Cells:  make([]BusMatrixCell, 0, len(filtered)),
		Total:  len(filtered),
		Tables: []BusMatrixTableDetail{},
	}
	// Pointers keep the roll-up stable while `tables` grows; the response
	// copies them out by value at the end.
	tables := []*BusMatrixTableDetail{}
	tableIndex := map[string]int{}
	columnIndex := map[string]map[string]int{}
	for _, c := range filtered {
		resp.Cells = append(resp.Cells, c.BusMatrixCell)
		if len(c.Tables) == 0 {
			continue
		}
		resp.DetailAvailable = true
		locator := c.cellLocator()
		for _, table := range c.Tables {
			name := strings.TrimSpace(table.Name)
			if name == "" {
				continue
			}
			pos, seen := tableIndex[name]
			if !seen {
				if len(tables) >= maxDrilldownTables {
					resp.TablesTruncated = true
					continue
				}
				tableDomain := strings.TrimSpace(table.Domain)
				if tableDomain == "" {
					tableDomain = c.Domain
				}
				pos = len(tables)
				tableIndex[name] = pos
				tables = append(tables, &BusMatrixTableDetail{
					Name:    name,
					Domain:  tableDomain,
					Columns: []BusMatrixTableColumn{},
				})
			}
			entry := tables[pos]
			// First delivered value wins; later cells only fill gaps.
			if entry.ReadCount == nil {
				entry.ReadCount = table.ReadCount
			}
			if entry.WriteCount == nil {
				entry.WriteCount = table.WriteCount
			}
			if entry.IsNewTable == nil {
				entry.IsNewTable = table.IsNewTable
			}
			entry.SourceCells = appendUniqueString(entry.SourceCells, locator)
			if len(table.Columns) == 0 {
				continue
			}
			byName, ok := columnIndex[name]
			if !ok {
				byName = map[string]int{}
				columnIndex[name] = byName
			}
			for _, column := range table.Columns {
				columnName := strings.TrimSpace(column.Name)
				if columnName == "" {
					continue
				}
				resp.ColumnsAvailable = true
				if idx, dup := byName[columnName]; dup {
					if entry.Columns[idx].Type == "" {
						entry.Columns[idx].Type = column.Type
					}
					if entry.Columns[idx].Access == "" {
						entry.Columns[idx].Access = column.Access
					}
					continue
				}
				byName[columnName] = len(entry.Columns)
				entry.Columns = append(entry.Columns, BusMatrixTableColumn{
					Name:   columnName,
					Type:   column.Type,
					Access: column.Access,
				})
			}
		}
	}
	for _, table := range tables {
		resp.Tables = append(resp.Tables, *table)
	}
	writeJSON(w, http.StatusOK, resp)
}

// BusMatrixAlertEdgeRef locates one graph edge behind an alert.
//
// The GraphEdge contract (TS `GraphEdge`) carries no stable identifier, so ID
// is whatever the payload annotated (`id` / `properties.id`) and otherwise the
// edge's positional index inside the snapshot's edges array — a locator the
// client can reproduce, never a synthesized one.
type BusMatrixAlertEdgeRef struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}

// BusMatrixAlert mirrors the TS `BusMatrixAlert`.
type BusMatrixAlert struct {
	Severity    string   `json:"severity"`
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Tables      []string `json:"tables,omitempty"`
	// Edges are the located access relations (unclassified rule).
	Edges []BusMatrixAlertEdgeRef `json:"edges,omitempty"`
	// Count is how many occurrences this entry aggregates: 1 for the per-cell
	// cross_domain_write alerts, N for the rolled-up ones. The locator lists
	// are capped, Count is not.
	Count int `json:"count"`
	// Cell locators, present when the alert derives from one matrix cell.
	ModuleName string `json:"module_name,omitempty"`
	PageName   string `json:"page_name,omitempty"`
	Domain     string `json:"domain,omitempty"`
	// WriteCount carries the offending cell's write ops so the client can
	// localize the cross_domain_write sentence without reparsing Description.
	// Pointer, because 0 writes must stay distinguishable from "not a
	// cell-scoped alert".
	WriteCount *int64 `json:"write_count,omitempty"`
}

// BusMatrixRuleCoverage reports whether a rule could actually run against the
// snapshot payload. A rule whose input the pre-aggregation did not carry comes
// back evaluated=false with a machine-readable reason the client localizes —
// silently emitting nothing would read as "no problems found", which is a lie
// of omission. Reason is a code, never prose.
type BusMatrixRuleCoverage struct {
	Type      string `json:"type"`
	Evaluated bool   `json:"evaluated"`
	Reason    string `json:"reason,omitempty"`
}

// BusMatrixAlertsResponse mirrors the TS `BusMatrixAlertsResponse`.
type BusMatrixAlertsResponse struct {
	Alerts       []BusMatrixAlert        `json:"alerts"`
	Total        int                     `json:"total"`
	RuleCoverage []BusMatrixRuleCoverage `json:"rule_coverage"`
}

const (
	// maxAlertTables / maxAlertEdges cap the locator lists on the rolled-up
	// alerts; Count still reports the true total.
	maxAlertTables = 50
	maxAlertEdges  = 20
	// unknownDomainToken is the sentinel for an unclassified access relation,
	// matched case-insensitively alongside "" / absent.
	unknownDomainToken = "unknown"
)

// busMatrixAlertRules is the full rule set in the stable order the response
// reports coverage for (TS `BusMatrixAlertType`).
var busMatrixAlertRules = []string{
	"cross_domain_write",
	"orphan_table",
	"deprecated_access",
	"unclassified",
}

// accessEdgeTypes are the graph edges the bus matrix aggregates over
// (原型 f11 标注 2：格子来自 QUERIES / ACCESSES / FETCHES 边聚合).
var accessEdgeTypes = map[string]struct{}{
	"QUERIES":  {},
	"ACCESSES": {},
	"FETCHES":  {},
}

// snapshotEdgesByID reads one snapshot's edges JSONB by primary key. The
// summary scan (loadLatestGraphSnapshot) deliberately skips the graph body to
// stay cheap, so only the unclassified rule pays for it.
func (h *Handler) snapshotEdgesByID(r *http.Request, snapshotID pgtype.UUID) ([]byte, error) {
	var edges []byte
	err := h.DB.QueryRow(r.Context(), `
		SELECT edges FROM project_graph_snapshot WHERE id = $1`,
		snapshotID,
	).Scan(&edges)
	return edges, err
}

// edgeDomain reads the domain annotation off an edge element: top-level
// `domain` first, then `properties.domain`. "" means the payload carries no
// annotation at all, which the caller treats as unclassified.
func edgeDomain(raw json.RawMessage) string {
	var light struct {
		Domain     *string        `json:"domain"`
		Properties map[string]any `json:"properties"`
	}
	if err := json.Unmarshal(raw, &light); err != nil {
		return ""
	}
	if light.Domain != nil {
		if trimmed := strings.TrimSpace(*light.Domain); trimmed != "" {
			return trimmed
		}
	}
	if value, ok := light.Properties["domain"]; ok {
		if text, ok := value.(string); ok {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

// edgeLocatorID prefers an id the payload annotated and falls back to the
// edge's positional index inside the snapshot edges array.
func edgeLocatorID(raw json.RawMessage, index int) string {
	var light struct {
		ID         *string        `json:"id"`
		Properties map[string]any `json:"properties"`
	}
	if err := json.Unmarshal(raw, &light); err == nil {
		if light.ID != nil {
			if trimmed := strings.TrimSpace(*light.ID); trimmed != "" {
				return trimmed
			}
		}
		if value, ok := light.Properties["id"]; ok {
			if text, ok := value.(string); ok {
				if trimmed := strings.TrimSpace(text); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return "edges[" + strconv.Itoa(index) + "]"
}

// orphanTableRule derives the orphan_table alert: tables the bus matrix says
// are touched but that no module_summary entry claims via tables_touched.
//
// Both inputs are optional payload, so the rule reports why it could not run
// instead of answering "no orphans": no table names in the cells, or no
// module_summary at all (with an empty summary every table would come back
// orphaned, which describes the missing pre-aggregation rather than a real
// structural problem).
func orphanTableRule(cells []busMatrixCellDetail, moduleSummary []byte) ([]BusMatrixAlert, BusMatrixRuleCoverage) {
	rule := BusMatrixRuleCoverage{Type: "orphan_table"}

	touched := []string{}
	seen := map[string]struct{}{}
	for _, c := range cells {
		for _, table := range c.Tables {
			name := strings.TrimSpace(table.Name)
			if name == "" {
				continue
			}
			if _, dup := seen[name]; dup {
				continue
			}
			seen[name] = struct{}{}
			touched = append(touched, name)
		}
	}
	if len(touched) == 0 {
		rule.Reason = "no_table_names"
		return nil, rule
	}

	var entries []struct {
		NodeID        string   `json:"node_id"`
		Name          string   `json:"name"`
		TablesTouched []string `json:"tables_touched"`
	}
	if len(moduleSummary) > 0 && string(moduleSummary) != "null" {
		// A malformed summary must not read as "nothing is owned": surface the
		// rule as not runnable.
		if err := json.Unmarshal(moduleSummary, &entries); err != nil {
			rule.Reason = "module_summary_malformed"
			return nil, rule
		}
	}
	if len(entries) == 0 {
		rule.Reason = "no_module_summary"
		return nil, rule
	}

	owned := map[string]struct{}{}
	for _, entry := range entries {
		for _, name := range entry.TablesTouched {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				owned[trimmed] = struct{}{}
			}
		}
	}

	orphans := []string{}
	for _, name := range touched {
		if _, claimed := owned[name]; claimed {
			continue
		}
		orphans = append(orphans, name)
	}

	rule.Evaluated = true
	rule.Reason = "ok"
	if len(orphans) == 0 {
		return nil, rule
	}
	listed := orphans
	if len(listed) > maxAlertTables {
		listed = listed[:maxAlertTables]
	}
	return []BusMatrixAlert{{
		Severity: "warning",
		Type:     "orphan_table",
		Count:    len(orphans),
		Tables:   listed,
		Description: strconv.Itoa(len(orphans)) + " of " + strconv.Itoa(len(touched)) +
			" tables in the bus matrix are claimed by no module_summary entry",
	}}, rule
}

// unclassifiedAccessRule derives the unclassified alert: access edges
// (QUERIES / ACCESSES / FETCHES) whose domain annotation is absent, blank or
// "unknown". The edges are walked positionally over the raw array so the
// emitted locator is the element's true index — parseGraphEdges drops invalid
// elements and would shift it.
//
// One aggregated alert is emitted (never one per edge): a snapshot whose CLI
// pass does not annotate domains at all legitimately yields 100% unclassified,
// and flooding the panel with per-edge rows would hide the single fact that
// matters.
func unclassifiedAccessRule(edgesRaw []byte, loadErr error) ([]BusMatrixAlert, BusMatrixRuleCoverage) {
	rule := BusMatrixRuleCoverage{Type: "unclassified"}
	if loadErr != nil {
		rule.Reason = "edges_unavailable"
		return nil, rule
	}
	items, err := splitJSONArray(edgesRaw)
	if err != nil {
		rule.Reason = "edges_unavailable"
		return nil, rule
	}
	if len(items) == 0 {
		rule.Reason = "no_snapshot_edges"
		return nil, rule
	}

	access := 0
	unclassified := 0
	refs := []BusMatrixAlertEdgeRef{}
	for index, item := range items {
		var light struct {
			Source string `json:"source"`
			Target string `json:"target"`
			Type   string `json:"type"`
		}
		if json.Unmarshal(item, &light) != nil {
			continue
		}
		if _, isAccess := accessEdgeTypes[light.Type]; !isAccess {
			continue
		}
		source := strings.TrimSpace(light.Source)
		target := strings.TrimSpace(light.Target)
		if source == "" || target == "" {
			continue
		}
		access++
		if domain := edgeDomain(item); domain != "" && !strings.EqualFold(domain, unknownDomainToken) {
			continue
		}
		unclassified++
		if len(refs) < maxAlertEdges {
			refs = append(refs, BusMatrixAlertEdgeRef{
				ID:     edgeLocatorID(item, index),
				Source: source,
				Target: target,
				Type:   light.Type,
			})
		}
	}
	if access == 0 {
		rule.Reason = "no_access_edges"
		return nil, rule
	}

	rule.Evaluated = true
	rule.Reason = "ok"
	if unclassified == 0 {
		return nil, rule
	}
	return []BusMatrixAlert{{
		Severity: "info",
		Type:     "unclassified",
		Count:    unclassified,
		Edges:    refs,
		Description: strconv.Itoa(unclassified) + " of " + strconv.Itoa(access) +
			" access edges (QUERIES/ACCESSES/FETCHES) carry no domain annotation",
	}}, rule
}

// GetBusMatrixAlerts implements GET .../graph/bus-matrix/alerts: derives
// structured alerts from the latest snapshot.
//
// Rules implemented here:
//   - cross_domain_write — one alert per is_cross_domain_write cell, keeping
//     that cell's module × page × domain locator;
//   - orphan_table — matrix tables no module_summary entry claims;
//   - unclassified — access edges with no usable domain annotation.
//
// Every alert carries a severity plus real locators (table names and/or edge
// refs). rule_coverage states which rules actually ran: a rule whose input the
// CLI pre-aggregation did not deliver is reported as not evaluated with a
// reason code, so an empty alert list is never mistaken for a clean matrix.
func (h *Handler) GetBusMatrixAlerts(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	snapshot, cells, ok := h.loadBusMatrixCellDetails(w, r, project)
	if !ok {
		return
	}

	coverage := make(map[string]BusMatrixRuleCoverage, len(busMatrixAlertRules))
	alerts := []BusMatrixAlert{}

	// Rule 1 — cross_domain_write.
	if len(cells) == 0 {
		coverage["cross_domain_write"] = BusMatrixRuleCoverage{
			Type:   "cross_domain_write",
			Reason: "no_bus_matrix",
		}
	} else {
		coverage["cross_domain_write"] = BusMatrixRuleCoverage{
			Type:      "cross_domain_write",
			Evaluated: true,
			Reason:    "ok",
		}
		for _, c := range cells {
			if c.IsCrossDomainWrite == nil || !*c.IsCrossDomainWrite {
				continue
			}
			writeOps := c.WriteCount
			alert := BusMatrixAlert{
				Severity:   "error",
				Type:       "cross_domain_write",
				Count:      1,
				ModuleName: c.ModuleName,
				PageName:   c.PageName,
				Domain:     c.Domain,
				WriteCount: &writeOps,
				Description: "module " + c.ModuleName + " writes across domains via page " + c.PageName +
					" (" + strconv.FormatInt(c.WriteCount, 10) + " write ops)",
			}
			for _, table := range c.Tables {
				name := strings.TrimSpace(table.Name)
				if name == "" {
					continue
				}
				if len(alert.Tables) >= maxAlertTables {
					break
				}
				alert.Tables = appendUniqueString(alert.Tables, name)
			}
			alerts = append(alerts, alert)
		}
	}

	// Rule 2 — orphan_table.
	orphanAlerts, orphanCoverage := orphanTableRule(cells, snapshot.ModuleSummary)
	alerts = append(alerts, orphanAlerts...)
	coverage["orphan_table"] = orphanCoverage

	// Rule 3 — deprecated_access needs ontology lifecycle metadata
	// (ontology_object.lifecycle, migration 457); the ontology tables are
	// still empty, so the rule is reported as not runnable rather than
	// answering "nothing is deprecated".
	// TODO(project-archive): implement deprecated_access once the ontology
	// layer carries lifecycle metadata.
	coverage["deprecated_access"] = BusMatrixRuleCoverage{
		Type:   "deprecated_access",
		Reason: "not_implemented",
	}

	// Rule 4 — unclassified access relations.
	edgesRaw, edgesErr := h.snapshotEdgesByID(r, snapshot.ID)
	unclassifiedAlerts, unclassifiedCoverage := unclassifiedAccessRule(edgesRaw, edgesErr)
	alerts = append(alerts, unclassifiedAlerts...)
	coverage["unclassified"] = unclassifiedCoverage

	resp := BusMatrixAlertsResponse{
		Alerts:       alerts,
		Total:        len(alerts),
		RuleCoverage: make([]BusMatrixRuleCoverage, 0, len(busMatrixAlertRules)),
	}
	for _, rule := range busMatrixAlertRules {
		resp.RuleCoverage = append(resp.RuleCoverage, coverage[rule])
	}
	writeJSON(w, http.StatusOK, resp)
}

// OntologyChangelogResponse mirrors the TS `OntologyChangelog`.
type OntologyChangelogResponse struct {
	ID         string          `json:"id"`
	ObjectName string          `json:"object_name"`
	ChangeType string          `json:"change_type"`
	Details    json.RawMessage `json:"details,omitempty"`
	CreatedAt  string          `json:"created_at"`
}

// GetBusMatrixTimeline implements GET .../graph/bus-matrix/timeline: the
// most recent ontology changelog entries for the latest snapshot.
func (h *Handler) GetBusMatrixTimeline(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	limit := 20
	if limitStr := strings.TrimSpace(r.URL.Query().Get("limit")); limitStr != "" {
		parsed, err := strconv.Atoi(limitStr)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, http.StatusBadRequest, "limit must be an integer within 1..100")
			return
		}
		limit = parsed
	}
	snapshot, ok := h.loadLatestGraphSnapshot(w, r, project)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, name, change_type, detail, created_at
		FROM ontology_changelog
		WHERE snapshot_id = $1
		ORDER BY created_at DESC
		LIMIT $2`,
		snapshot.ID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list bus matrix timeline")
		return
	}
	defer rows.Close()

	changes := []OntologyChangelogResponse{}
	for rows.Next() {
		var c OntologyChangelogResponse
		var id pgtype.UUID
		var createdAt pgtype.Timestamptz
		var detail []byte
		if err := rows.Scan(&id, &c.ObjectName, &c.ChangeType, &detail, &createdAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan bus matrix timeline")
			return
		}
		c.ID = uuidToString(id)
		c.Details = detail
		c.CreatedAt = timestampToString(createdAt)
		changes = append(changes, c)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list bus matrix timeline")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"snapshot_id": uuidToString(snapshot.ID),
		"changes":     changes,
		"total":       len(changes),
	})
}
