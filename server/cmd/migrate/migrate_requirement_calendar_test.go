package main

import (
        "context"
        "math/rand/v2"
        "testing"
        "time"

        "github.com/jackc/pgx/v5/pgxpool"
)

// 452 extends issue with the requirement-calendar columns and backfills
// root_requirement_id along the parent chain. These tests run the real
// migration SQL through the runner against a scratch schema seeded with the
// minimal pre-452 tables the migration touches (issue + project_resource).
const requirementCalendarMigration = "452_requirement_calendar"

// seedRequirementCalendarFixture creates the pre-452 tables and one parent
// chain A→B→C plus a standalone issue D. It returns the four issue ids.
func seedRequirementCalendarFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (a, b, c, d string) {
        t.Helper()
        if _, err := pool.Exec(ctx, `CREATE TABLE project_resource (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid()
        )`); err != nil {
                t.Fatalf("create project_resource fixture: %v", err)
        }
        if _, err := pool.Exec(ctx, `CREATE TABLE issue (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                parent_issue_id UUID REFERENCES issue(id) ON DELETE SET NULL
        )`); err != nil {
                t.Fatalf("create issue fixture: %v", err)
        }
        if err := pool.QueryRow(ctx, `INSERT INTO issue DEFAULT VALUES RETURNING id`).Scan(&a); err != nil {
                t.Fatalf("seed A: %v", err)
        }
        if err := pool.QueryRow(ctx, `INSERT INTO issue (parent_issue_id) VALUES ($1) RETURNING id`, a).Scan(&b); err != nil {
                t.Fatalf("seed B: %v", err)
        }
        if err := pool.QueryRow(ctx, `INSERT INTO issue (parent_issue_id) VALUES ($1) RETURNING id`, b).Scan(&c); err != nil {
                t.Fatalf("seed C: %v", err)
        }
        if err := pool.QueryRow(ctx, `INSERT INTO issue DEFAULT VALUES RETURNING id`).Scan(&d); err != nil {
                t.Fatalf("seed D: %v", err)
        }
        return a, b, c, d
}

func applyRequirementCalendar(t *testing.T, ctx context.Context, pool *pgxpool.Pool, schema, direction string) {
        t.Helper()
        if err := runMigrations(ctx, pool, runOptions{
                Direction:             direction,
                Files:                 realMigrationFiles(t, []string{requirementCalendarMigration}, direction),
                SchemaMigrationsTable: schema + ".schema_migrations",
                AdvisoryLockKey:       int64(rand.Uint64()&0x7fffffffffffffff) | 1,
                Hooks:                 hooksForDirection(direction),
                Conditions:            conditionsForDirection(direction),
        }); err != nil {
                t.Fatalf("apply %s %s: %v", requirementCalendarMigration, direction, err)
        }
}

func issueColumnExists(t *testing.T, ctx context.Context, pool *pgxpool.Pool, schema, column string) bool {
        t.Helper()
        var exists bool
        if err := pool.QueryRow(ctx, `
                SELECT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = $1 AND table_name = 'issue' AND column_name = $2
                )
        `, schema, column).Scan(&exists); err != nil {
                t.Fatalf("check column %s: %v", column, err)
        }
        return exists
}

func TestRequirementCalendarMigrationBackfillsRootRequirementID(t *testing.T) {
        adminPool := openTestPool(t)
        ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
        defer cancel()

        schema := createScratchSchema(t, ctx, adminPool, "migrate_requirement_calendar_")
        pool := openTestPoolWithSearchPath(t, schema+", public")
        a, b, c, d := seedRequirementCalendarFixture(t, ctx, pool)

        applyRequirementCalendar(t, ctx, pool, schema, "up")
        assertMigrationVersionRecorded(t, ctx, pool, schema, requirementCalendarMigration, true)

        // Backfill: the whole chain reports the chain head; a parentless issue
        // is its own requirement group.
        for tc, want := range map[string]string{a: a, b: a, c: a, d: d} {
                var got *string
                if err := pool.QueryRow(ctx, `SELECT root_requirement_id FROM issue WHERE id = $1`, tc).Scan(&got); err != nil {
                        t.Fatalf("read root for %s: %v", tc, err)
                }
                if got == nil || *got != want {
                        t.Fatalf("root_requirement_id of %s = %v, want %s", tc, got, want)
                }
        }

        // New requirement columns exist.
        for _, col := range []string{
                "start_at", "goal", "repo_resource_id", "decompose_mode",
                "auto_trigger", "decomposition_confirmed_at", "triggered_at",
                "acceptance_round", "root_requirement_id",
                "feature_points", "graph_context", "acceptance_spec",
        } {
                if !issueColumnExists(t, ctx, pool, schema, col) {
                        t.Fatalf("column issue.%s missing after up", col)
                }
        }

        // Defaults: confirm mode + auto trigger on, empty structured details.
        var mode string
        var autoTrigger bool
        var round int
        var fp []byte
        if err := pool.QueryRow(ctx, `SELECT decompose_mode, auto_trigger, acceptance_round, feature_points FROM issue WHERE id = $1`, a).
                Scan(&mode, &autoTrigger, &round, &fp); err != nil {
                t.Fatalf("read defaults: %v", err)
        }
        if mode != "confirm" || !autoTrigger || round != 0 || string(fp) != "[]" {
                t.Fatalf("defaults = (%s, %v, %d, %s), want (confirm, true, 0, [])", mode, autoTrigger, round, fp)
        }

        // Indexes exist, including the partial trigger-sweep index.
        assertIndexExists(t, pool, schema, "idx_issue_trigger_sweep", true)
        assertIndexExists(t, pool, schema, "idx_issue_root_requirement", true)
        assertIndexExists(t, pool, schema, "idx_issue_repo_resource", true)
}

func TestRequirementCalendarMigrationDownRestoresSchema(t *testing.T) {
        adminPool := openTestPool(t)
        ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
        defer cancel()

        schema := createScratchSchema(t, ctx, adminPool, "migrate_requirement_calendar_down_")
        pool := openTestPoolWithSearchPath(t, schema+", public")
        seedRequirementCalendarFixture(t, ctx, pool)

        applyRequirementCalendar(t, ctx, pool, schema, "up")
        applyRequirementCalendar(t, ctx, pool, schema, "down")

        for _, col := range []string{"start_at", "root_requirement_id", "feature_points", "acceptance_spec"} {
                if issueColumnExists(t, ctx, pool, schema, col) {
                        t.Fatalf("column issue.%s still present after down", col)
                }
        }
        assertIndexExists(t, pool, schema, "idx_issue_trigger_sweep", false)
        assertIndexExists(t, pool, schema, "idx_issue_root_requirement", false)
        assertIndexExists(t, pool, schema, "idx_issue_repo_resource", false)
}
