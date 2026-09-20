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
