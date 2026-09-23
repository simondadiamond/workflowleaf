/**
 * WorkflowLeaf's own SQLite schema.
 *
 * A separate database file, a separate migration namespace and a separate
 * connection. WorkflowLeaf never writes a T3 table, and T3 never sees these,
 * so an upstream migration cannot collide with one of ours.
 *
 * The run aggregate is stored as one canonically serialized document plus the
 * columns worth querying. The alternative, exploding every visit and operation
 * into its own table, buys queries nobody has asked for and costs the
 * guarantee that a run's state is read and written in one piece.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const MIGRATIONS: readonly {
  readonly id: number;
  readonly name: string;
  readonly sql: readonly string[];
}[] = [
  {
    id: 1,
    name: "initial",
    sql: [
      `CREATE TABLE IF NOT EXISTS wl_runs (
         run_id TEXT PRIMARY KEY,
         plan_digest TEXT NOT NULL,
         workspace_id TEXT NOT NULL,
         state TEXT NOT NULL,
         revision INTEGER NOT NULL,
         document TEXT NOT NULL,
         plan TEXT NOT NULL,
         profile_name TEXT NOT NULL,
         origin TEXT NOT NULL,
         repo_root TEXT NOT NULL,
         base_revision TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS wl_runs_state ON wl_runs (state, updated_at DESC)`,

      `CREATE TABLE IF NOT EXISTS wl_leases (
         run_id TEXT PRIMARY KEY,
         owner TEXT NOT NULL,
         generation INTEGER NOT NULL,
         expires_at TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS wl_transitions (
         run_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         at TEXT NOT NULL,
         input TEXT NOT NULL,
         effects TEXT NOT NULL,
         revision INTEGER NOT NULL,
         PRIMARY KEY (run_id, seq)
       )`,

      `CREATE TABLE IF NOT EXISTS wl_operations (
         operation_id TEXT PRIMARY KEY,
         run_id TEXT NOT NULL,
         visit_id TEXT NOT NULL,
         attempt_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         idempotency_key TEXT NOT NULL UNIQUE,
         dispatched_at TEXT NOT NULL,
         acknowledged_at TEXT,
         handle TEXT,
         settled_at TEXT,
         outcome TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS wl_operations_run ON wl_operations (run_id, dispatched_at)`,

      `CREATE TABLE IF NOT EXISTS wl_evidence (
         run_id TEXT NOT NULL,
         visit_id TEXT NOT NULL,
         attempt_id TEXT NOT NULL,
         gate_id TEXT NOT NULL,
         recorded_at TEXT NOT NULL,
         outcome TEXT NOT NULL,
         document TEXT NOT NULL,
         PRIMARY KEY (run_id, visit_id, attempt_id, gate_id)
       )`,

      `CREATE TABLE IF NOT EXISTS wl_decisions (
         decision_id TEXT PRIMARY KEY,
         run_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         detail TEXT NOT NULL,
         plan_digest TEXT NOT NULL,
         raised_at TEXT NOT NULL,
         answered_at TEXT,
         answer TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS wl_decisions_open ON wl_decisions (run_id, answered_at)`,

      `CREATE TABLE IF NOT EXISTS wl_limitations (
         run_id TEXT NOT NULL,
         stage_id TEXT NOT NULL,
         capability TEXT NOT NULL,
         detail TEXT NOT NULL,
         at TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS wl_cursors (
         run_id TEXT PRIMARY KEY,
         cursor TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS wl_workspaces (
         workspace_id TEXT PRIMARY KEY,
         run_id TEXT NOT NULL UNIQUE,
         path TEXT NOT NULL UNIQUE,
         branch TEXT NOT NULL,
         base_revision TEXT NOT NULL,
         created_at TEXT NOT NULL,
         disposed_at TEXT
       )`,
    ],
  },
  {
    id: 2,
    name: "run-is-a-story",
    sql: [
      // The run id is now the story plus its ordinal, so the story is what
      // groups a split one, and the pull request is how a person finds it.
      `ALTER TABLE wl_runs ADD COLUMN story TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE wl_runs ADD COLUMN pull_request_number INTEGER`,
      `CREATE INDEX IF NOT EXISTS wl_runs_story ON wl_runs (story, run_id)`,
      `CREATE INDEX IF NOT EXISTS wl_runs_pull_request ON wl_runs (pull_request_number)`,
      // Runs recorded before this migration have no pull request and no
      // declared split. Writing that in leaves every stored document readable
      // by the current schema instead of failing to decode on first read.
      `UPDATE wl_runs
         SET document = json_set(document, '$.pullRequest', json('null'), '$.scopeSplit', json('null'))`,
    ],
  },
  {
    id: 3,
    name: "decisions-are-asked",
    sql: [
      // A decision is recorded against the visit that raised it, and whether a
      // person was asked somewhere they already look, and where the answer
      // came from.
      `ALTER TABLE wl_decisions ADD COLUMN visit_id TEXT`,
      `ALTER TABLE wl_decisions ADD COLUMN asked_at TEXT`,
      `ALTER TABLE wl_decisions ADD COLUMN answered_via TEXT`,
    ],
  },
  {
    id: 4,
    name: "findings",
    sql: [
      // What a run noticed and did not act on: a stage's "found, not fixed"
      // notes, and what code saw that no gate judges. Keyed by content, so
      // reading the same note twice records it once.
      `CREATE TABLE IF NOT EXISTS wl_findings (
         run_id TEXT NOT NULL,
         stage_id TEXT NOT NULL,
         source TEXT NOT NULL,
         digest TEXT NOT NULL,
         detail TEXT NOT NULL,
         at TEXT NOT NULL,
         PRIMARY KEY (run_id, digest)
       )`,
    ],
  },
];

export const runMigrations = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS wl_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`;

  const appliedAt = DateTime.formatIso(yield* DateTime.now);
  const applied = yield* sql<{ id: number }>`SELECT id FROM wl_migrations`;
  const done = new Set(applied.map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    for (const statement of migration.sql) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO wl_migrations (id, name, applied_at)
               VALUES (${migration.id}, ${migration.name}, ${appliedAt})`;
  }
});
