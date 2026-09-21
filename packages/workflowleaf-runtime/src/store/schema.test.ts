import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { twoStagePlan } from "@t3tools/workflowleaf-core/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { canonicalJson } from "../canonical.ts";
import { RunStore } from "./RunStore.ts";
import { MIGRATIONS, runMigrations } from "./schema.ts";
import { layerMemory } from "./Sqlite.ts";

/**
 * One database per test. These exercise what an outstanding migration does to
 * rows that are already there, so a database shared between them would have
 * the migration applied before the second test wrote its row.
 */
const withDatabase = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  program.pipe(Effect.provide(layerMemory));

/**
 * A run record as it was written before a run carried a pull request, written
 * out by hand because the current schema can no longer produce this shape.
 */
function legacyDocument(runId: string): string {
  return `{
    "budget": { "deadlineAt": null, "maxRepairCycles": 2, "repairCycles": 0 },
    "capabilities": {
      "freshContext": true,
      "interrupt": true,
      "recovery": true,
      "sameContextContinuation": true,
      "settledCompletion": true
    },
    "createdAt": "2026-01-01T00:00:00.000Z",
    "currentStageId": null,
    "decision": null,
    "failure": null,
    "planDigest": "sha256:plan",
    "revision": 0,
    "runId": "${runId}",
    "state": "queued",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "visits": [],
    "workspaceId": "ws-old"
  }`;
}

/** Brings the database to migration 1, the way one written before this change looks. */
const seedLegacyRun = Effect.fnUntraced(function* (runId: string) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS wl_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`;
  const first = MIGRATIONS[0]!;
  for (const statement of first.sql) yield* sql.unsafe(statement);
  yield* sql`INSERT OR IGNORE INTO wl_migrations (id, name, applied_at)
             VALUES (${first.id}, ${first.name}, '2026-01-01T00:00:00.000Z')`;

  yield* sql`INSERT INTO wl_runs (
    run_id, plan_digest, workspace_id, state, revision, document, plan,
    profile_name, origin, repo_root, base_revision, created_at, updated_at
  ) VALUES (
    ${runId}, 'sha256:plan', 'ws-old', 'queued', 0, ${legacyDocument(runId)},
    ${canonicalJson(twoStagePlan())}, 'test', '{}', '/repo', 'abc123',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  )`;
});

it.layer(NodeServices.layer)("migrations", (it) => {
  it.effect("give a run recorded before this change the fields the schema now requires", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacyRun("2026-01-01-old-run");

        yield* runMigrations();

        const rows = yield* sql<{
          document: string;
          story: string;
          pull_request_number: number | null;
        }>`SELECT document, story, pull_request_number FROM wl_runs
         WHERE run_id = '2026-01-01-old-run'`;

        const row = rows[0]!;
        assert.strictEqual(row.story, "");
        assert.strictEqual(row.pull_request_number, null);
        assert.include(row.document, '"pullRequest":null');
        assert.include(row.document, '"scopeSplit":null');
      }),
    ),
  );

  it.effect("so the store can still read it", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* seedLegacyRun("2026-01-02-old-run");

        // Building the store runs the outstanding migrations, which is how a
        // database written by an earlier version is met in practice.
        const loaded = yield* Effect.flatMap(RunStore, (store) =>
          store.loadRun("2026-01-02-old-run" as never),
        ).pipe(Effect.provide(RunStore.layer), Effect.orDie);

        assert.isTrue(Option.isSome(loaded));
        assert.strictEqual(Option.getOrThrow(loaded).record.pullRequest, null);
        assert.strictEqual(Option.getOrThrow(loaded).record.scopeSplit, null);
      }),
    ),
  );
});
