/**
 * The authoritative run store.
 *
 * Three properties matter more than anything else here.
 *
 * One writer owns a run. Leases carry a generation, and a worker that lost its
 * lease and came back cannot finalize work the new owner has moved past.
 *
 * State advances under an optimistic revision check. A commit states the
 * revision it read; if the row has moved, the commit fails rather than
 * overwriting. That is what stops a resumed old worker from resetting an
 * exhausted attempt budget.
 *
 * Intent is persisted before dispatch. A crash between "sent" and
 * "acknowledged" leaves a row to reconcile against, which is the difference
 * between asking the executor what happened and assuming nothing did.
 */
import {
  RunPlan,
  RunRecord,
  type EvidenceRecord,
  type OperationId,
  type RunId,
  type StageLimitation,
  type VisitId,
} from "@t3tools/workflowleaf-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { canonicalJson } from "../canonical.ts";
import { runMigrations } from "./schema.ts";

export class RunStoreError extends Schema.TaggedError<RunStoreError>()("WlRunStoreError", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

/** The commit lost a race. The caller reloads and decides again; it never retries blind. */
export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()("WlRevisionConflict", {
  runId: Schema.String,
  expected: Schema.Int,
  actual: Schema.Int,
}) {
  override get message(): string {
    return `Run ${this.runId} moved from revision ${this.expected} to ${this.actual} while this worker was deciding.`;
  }
}

export class LeaseLost extends Schema.TaggedError<LeaseLost>()("WlLeaseLost", {
  runId: Schema.String,
  generation: Schema.Int,
}) {
  override get message(): string {
    return `This worker no longer holds run ${this.runId} at generation ${this.generation}.`;
  }
}

export interface RunOrigin {
  /** What caused this run to start. Manual today; schedules and events later. */
  readonly trigger: "manual" | "schedule" | "event" | "chained";
  readonly by: string;
}

export interface CreateRunInput {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly profileName: string;
  readonly origin: RunOrigin;
  readonly repoRoot: string;
  readonly baseRevision: string;
}

export interface LoadedRun {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly profileName: string;
  readonly repoRoot: string;
  readonly baseRevision: string;
}

export interface Lease {
  readonly runId: RunId;
  readonly owner: string;
  readonly generation: number;
}

export interface OperationRow {
  readonly operationId: OperationId;
  readonly runId: string;
  readonly visitId: string;
  readonly attemptId: string;
  readonly kind: "start" | "continue";
  readonly dispatchedAt: string;
  readonly acknowledgedAt: string | null;
  readonly handle: string | null;
  readonly settledAt: string | null;
  readonly outcome: string | null;
}

export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly runId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly disposedAt: string | null;
}

const decodeRunRecord = Schema.decodeUnknownResult(Schema.fromJsonString(RunRecord));
const decodeRunPlan = Schema.decodeUnknownResult(Schema.fromJsonString(RunPlan));
const decodeEvidence = Schema.decodeResult(Schema.fromJsonString(Schema.Unknown));

function decodeOrFail<A>(
  operation: string,
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: { readonly message: string } },
): Effect.Effect<A, RunStoreError> {
  return result._tag === "Success"
    ? Effect.succeed(result.success)
    : Effect.fail(new RunStoreError({ operation, detail: result.failure.message }));
}

export class RunStore extends Context.Service<
  RunStore,
  {
    readonly createRun: (input: CreateRunInput) => Effect.Effect<void, RunStoreError>;
    readonly loadRun: (runId: RunId) => Effect.Effect<Option.Option<LoadedRun>, RunStoreError>;
    /** Commits the next state and appends the transition, under a revision check. */
    readonly commit: (input: {
      readonly previous: RunRecord;
      readonly next: RunRecord;
      readonly transitionInput: unknown;
      readonly effects: unknown;
      readonly lease: Lease;
    }) => Effect.Effect<void, RunStoreError | RevisionConflict | LeaseLost>;
    readonly listRuns: (filter?: {
      readonly state?: string;
    }) => Effect.Effect<readonly LoadedRun[], RunStoreError>;

    readonly acquireLease: (
      runId: RunId,
      owner: string,
      ttlSeconds: number,
    ) => Effect.Effect<Option.Option<Lease>, RunStoreError>;
    readonly renewLease: (
      lease: Lease,
      ttlSeconds: number,
    ) => Effect.Effect<void, RunStoreError | LeaseLost>;
    readonly releaseLease: (lease: Lease) => Effect.Effect<void, RunStoreError>;

    readonly recordIntent: (input: {
      readonly operationId: OperationId;
      readonly runId: RunId;
      readonly visitId: string;
      readonly attemptId: string;
      readonly kind: "start" | "continue";
      readonly idempotencyKey: string;
    }) => Effect.Effect<void, RunStoreError>;
    readonly acknowledgeOperation: (
      operationId: OperationId,
      handle: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly settleOperation: (
      operationId: OperationId,
      outcome: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly findOperation: (
      operationId: OperationId,
    ) => Effect.Effect<Option.Option<OperationRow>, RunStoreError>;
    /** Operations dispatched but never settled. What recovery reconciles. */
    readonly unsettledOperations: (
      runId: RunId,
    ) => Effect.Effect<readonly OperationRow[], RunStoreError>;

    readonly putEvidence: (evidence: EvidenceRecord) => Effect.Effect<void, RunStoreError>;
    readonly evidenceFor: (
      runId: RunId,
      visitId: VisitId,
    ) => Effect.Effect<readonly EvidenceRecord[], RunStoreError>;

    readonly recordLimitation: (
      runId: RunId,
      limitation: StageLimitation,
    ) => Effect.Effect<void, RunStoreError>;
    readonly limitationsFor: (
      runId: RunId,
    ) => Effect.Effect<readonly (StageLimitation & { readonly at: string })[], RunStoreError>;

    readonly saveCursor: (runId: RunId, cursor: string) => Effect.Effect<void, RunStoreError>;
    readonly loadCursor: (runId: RunId) => Effect.Effect<Option.Option<string>, RunStoreError>;

    readonly claimWorkspace: (input: {
      readonly workspaceId: string;
      readonly runId: RunId;
      readonly path: string;
      readonly branch: string;
      readonly baseRevision: string;
    }) => Effect.Effect<void, RunStoreError>;
    readonly findWorkspace: (
      runId: RunId,
    ) => Effect.Effect<Option.Option<WorkspaceRow>, RunStoreError>;
    readonly disposeWorkspace: (runId: RunId) => Effect.Effect<void, RunStoreError>;
  }
>()("@t3tools/workflowleaf-runtime/store/RunStore") {
  static readonly layer = Layer.effect(
    RunStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations().pipe(
        Effect.mapError(
          (cause) => new RunStoreError({ operation: "migrate", detail: String(cause) }),
        ),
      );

      const now = Effect.map(DateTime.now, DateTime.formatIso);

      const fail = (operation: string) => (cause: unknown) =>
        new RunStoreError({ operation, detail: String(cause) });

      const readRun = (row: {
        document: string;
        plan: string;
        profile_name: string;
        repo_root: string;
        base_revision: string;
      }) =>
        Effect.gen(function* () {
          const record = yield* decodeOrFail("loadRun.document", decodeRunRecord(row.document));
          const plan = yield* decodeOrFail("loadRun.plan", decodeRunPlan(row.plan));
          return {
            record,
            plan,
            profileName: row.profile_name,
            repoRoot: row.repo_root,
            baseRevision: row.base_revision,
          } satisfies LoadedRun;
        });

      const createRun: RunStore["Service"]["createRun"] = Effect.fnUntraced(function* (input) {
        yield* sql`
          INSERT INTO wl_runs (
            run_id, plan_digest, workspace_id, state, revision, document, plan,
            profile_name, origin, repo_root, base_revision, created_at, updated_at
          ) VALUES (
            ${input.record.runId}, ${input.record.planDigest}, ${input.record.workspaceId},
            ${input.record.state}, ${input.record.revision}, ${canonicalJson(input.record)},
            ${canonicalJson(input.plan)}, ${input.profileName}, ${canonicalJson(input.origin)},
            ${input.repoRoot}, ${input.baseRevision}, ${input.record.createdAt}, ${input.record.updatedAt}
          )
        `.pipe(Effect.mapError(fail("createRun")));
      });

      const loadRun: RunStore["Service"]["loadRun"] = Effect.fnUntraced(function* (runId) {
        const rows = yield* sql<{
          document: string;
          plan: string;
          profile_name: string;
          repo_root: string;
          base_revision: string;
        }>`SELECT document, plan, profile_name, repo_root, base_revision
           FROM wl_runs WHERE run_id = ${runId}`.pipe(Effect.mapError(fail("loadRun")));

        const row = rows[0];
        return row === undefined ? Option.none() : Option.some(yield* readRun(row));
      });

      const listRuns: RunStore["Service"]["listRuns"] = Effect.fnUntraced(function* (filter) {
        const rows =
          filter?.state === undefined
            ? yield* sql<{
                document: string;
                plan: string;
                profile_name: string;
                repo_root: string;
                base_revision: string;
              }>`SELECT document, plan, profile_name, repo_root, base_revision
                 FROM wl_runs ORDER BY updated_at DESC`.pipe(Effect.mapError(fail("listRuns")))
            : yield* sql<{
                document: string;
                plan: string;
                profile_name: string;
                repo_root: string;
                base_revision: string;
              }>`SELECT document, plan, profile_name, repo_root, base_revision
                 FROM wl_runs WHERE state = ${filter.state} ORDER BY updated_at DESC`.pipe(
                Effect.mapError(fail("listRuns")),
              );

        return yield* Effect.forEach(rows, readRun);
      });

      const assertLease = Effect.fnUntraced(function* (lease: Lease) {
        const rows = yield* sql<{ owner: string; generation: number }>`
          SELECT owner, generation FROM wl_leases WHERE run_id = ${lease.runId}
        `.pipe(Effect.mapError(fail("assertLease")));

        const row = rows[0];
        if (row === undefined || row.owner !== lease.owner || row.generation !== lease.generation) {
          return yield* new LeaseLost({ runId: lease.runId, generation: lease.generation });
        }
      });

      const commit: RunStore["Service"]["commit"] = Effect.fnUntraced(function* (input) {
        yield* assertLease(input.lease);

        // Read first: a conditional UPDATE that matches nothing is
        // indistinguishable from one that matched and wrote the same values.
        const current = yield* sql<{ revision: number }>`
          SELECT revision FROM wl_runs WHERE run_id = ${input.next.runId}
        `.pipe(Effect.mapError(fail("commit.read")));

        const actualBefore = current[0]?.revision ?? -1;
        if (actualBefore !== input.previous.revision) {
          return yield* new RevisionConflict({
            runId: input.next.runId,
            expected: input.previous.revision,
            actual: actualBefore,
          });
        }

        const seqRows = yield* sql<{ next: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM wl_transitions WHERE run_id = ${input.next.runId}
        `.pipe(Effect.mapError(fail("commit.seq")));
        const seq = seqRows[0]?.next ?? 1;

        yield* sql`
          INSERT INTO wl_transitions (run_id, seq, at, input, effects, revision)
          VALUES (${input.next.runId}, ${seq}, ${input.next.updatedAt},
                  ${canonicalJson(input.transitionInput)}, ${canonicalJson(input.effects)},
                  ${input.next.revision})
        `.pipe(Effect.mapError(fail("commit.transition")));

        yield* sql`
          UPDATE wl_runs
          SET state = ${input.next.state},
              revision = ${input.next.revision},
              document = ${canonicalJson(input.next)},
              workspace_id = ${input.next.workspaceId},
              updated_at = ${input.next.updatedAt}
          WHERE run_id = ${input.next.runId} AND revision = ${input.previous.revision}
        `.pipe(Effect.mapError(fail("commit.update")));

        const check = yield* sql<{ revision: number }>`
          SELECT revision FROM wl_runs WHERE run_id = ${input.next.runId}
        `.pipe(Effect.mapError(fail("commit.verify")));

        const actualAfter = check[0]?.revision ?? -1;
        if (actualAfter !== input.next.revision) {
          return yield* new RevisionConflict({
            runId: input.next.runId,
            expected: input.previous.revision,
            actual: actualAfter,
          });
        }
      });

      const acquireLease: RunStore["Service"]["acquireLease"] = Effect.fnUntraced(
        function* (runId, owner, ttlSeconds) {
          const at = yield* now;
          const expiresAt = DateTime.formatIso(
            DateTime.addDuration(yield* DateTime.now, `${ttlSeconds} seconds`),
          );

          const rows = yield* sql<{ owner: string; generation: number; expires_at: string }>`
          SELECT owner, generation, expires_at FROM wl_leases WHERE run_id = ${runId}
        `.pipe(Effect.mapError(fail("acquireLease")));

          const existing = rows[0];
          if (existing !== undefined && existing.owner !== owner && existing.expires_at > at) {
            return Option.none();
          }

          const generation = (existing?.generation ?? 0) + 1;
          yield* sql`
          INSERT INTO wl_leases (run_id, owner, generation, expires_at)
          VALUES (${runId}, ${owner}, ${generation}, ${expiresAt})
          ON CONFLICT (run_id) DO UPDATE
          SET owner = ${owner}, generation = ${generation}, expires_at = ${expiresAt}
        `.pipe(Effect.mapError(fail("acquireLease.write")));

          return Option.some({ runId, owner, generation });
        },
      );

      const renewLease: RunStore["Service"]["renewLease"] = Effect.fnUntraced(
        function* (lease, ttlSeconds) {
          yield* assertLease(lease);
          const expiresAt = DateTime.formatIso(
            DateTime.addDuration(yield* DateTime.now, `${ttlSeconds} seconds`),
          );
          yield* sql`UPDATE wl_leases SET expires_at = ${expiresAt}
                   WHERE run_id = ${lease.runId} AND generation = ${lease.generation}`.pipe(
            Effect.mapError(fail("renewLease")),
          );
        },
      );

      const releaseLease: RunStore["Service"]["releaseLease"] = Effect.fnUntraced(
        function* (lease) {
          yield* sql`DELETE FROM wl_leases WHERE run_id = ${lease.runId} AND generation = ${lease.generation}`.pipe(
            Effect.mapError(fail("releaseLease")),
          );
        },
      );

      const recordIntent: RunStore["Service"]["recordIntent"] = Effect.fnUntraced(
        function* (input) {
          const at = yield* now;
          yield* sql`
          INSERT INTO wl_operations (
            operation_id, run_id, visit_id, attempt_id, kind, idempotency_key, dispatched_at
          ) VALUES (
            ${input.operationId}, ${input.runId}, ${input.visitId}, ${input.attemptId},
            ${input.kind}, ${input.idempotencyKey}, ${at}
          )
          ON CONFLICT (operation_id) DO NOTHING
        `.pipe(Effect.mapError(fail("recordIntent")));
        },
      );

      const acknowledgeOperation: RunStore["Service"]["acknowledgeOperation"] = Effect.fnUntraced(
        function* (operationId, handle) {
          const at = yield* now;
          yield* sql`UPDATE wl_operations SET acknowledged_at = ${at}, handle = ${handle}
                     WHERE operation_id = ${operationId}`.pipe(
            Effect.mapError(fail("acknowledgeOperation")),
          );
        },
      );

      const settleOperation: RunStore["Service"]["settleOperation"] = Effect.fnUntraced(
        function* (operationId, outcome) {
          const at = yield* now;
          yield* sql`UPDATE wl_operations SET settled_at = ${at}, outcome = ${outcome}
                   WHERE operation_id = ${operationId}`.pipe(
            Effect.mapError(fail("settleOperation")),
          );
        },
      );

      const toOperationRow = (row: {
        operation_id: string;
        run_id: string;
        visit_id: string;
        attempt_id: string;
        kind: string;
        dispatched_at: string;
        acknowledged_at: string | null;
        handle: string | null;
        settled_at: string | null;
        outcome: string | null;
      }): OperationRow => ({
        operationId: row.operation_id as OperationId,
        runId: row.run_id,
        visitId: row.visit_id,
        attemptId: row.attempt_id,
        kind: row.kind === "continue" ? "continue" : "start",
        dispatchedAt: row.dispatched_at,
        acknowledgedAt: row.acknowledged_at,
        handle: row.handle,
        settledAt: row.settled_at,
        outcome: row.outcome,
      });

      const findOperation: RunStore["Service"]["findOperation"] = Effect.fnUntraced(
        function* (operationId) {
          const rows = yield* sql<Parameters<typeof toOperationRow>[0]>`
          SELECT * FROM wl_operations WHERE operation_id = ${operationId}
        `.pipe(Effect.mapError(fail("findOperation")));
          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(toOperationRow(row));
        },
      );

      const unsettledOperations: RunStore["Service"]["unsettledOperations"] = Effect.fnUntraced(
        function* (runId) {
          const rows = yield* sql<Parameters<typeof toOperationRow>[0]>`
            SELECT * FROM wl_operations WHERE run_id = ${runId} AND settled_at IS NULL
            ORDER BY dispatched_at
          `.pipe(Effect.mapError(fail("unsettledOperations")));
          return rows.map(toOperationRow);
        },
      );

      const putEvidence: RunStore["Service"]["putEvidence"] = Effect.fnUntraced(
        function* (evidence) {
          const at = yield* now;
          yield* sql`
          INSERT INTO wl_evidence (run_id, visit_id, attempt_id, gate_id, recorded_at, outcome, document)
          VALUES (${evidence.runId}, ${evidence.visitId}, ${evidence.attemptId}, ${evidence.gateId},
                  ${at}, ${evidence.outcome}, ${canonicalJson(evidence)})
          ON CONFLICT (run_id, visit_id, attempt_id, gate_id) DO UPDATE
          SET recorded_at = ${at}, outcome = ${evidence.outcome}, document = ${canonicalJson(evidence)}
        `.pipe(Effect.mapError(fail("putEvidence")));
        },
      );

      const evidenceFor: RunStore["Service"]["evidenceFor"] = Effect.fnUntraced(
        function* (runId, visitId) {
          const rows = yield* sql<{ document: string }>`
          SELECT document FROM wl_evidence WHERE run_id = ${runId} AND visit_id = ${visitId}
        `.pipe(Effect.mapError(fail("evidenceFor")));

          return yield* Effect.forEach(rows, (row) =>
            decodeOrFail("evidenceFor.document", decodeEvidence(row.document)).pipe(
              Effect.map((value) => value as EvidenceRecord),
            ),
          );
        },
      );

      const recordLimitation: RunStore["Service"]["recordLimitation"] = Effect.fnUntraced(
        function* (runId, limitation) {
          const at = yield* now;
          yield* sql`
          INSERT INTO wl_limitations (run_id, stage_id, capability, detail, at)
          VALUES (${runId}, ${limitation.stageId}, ${limitation.capability}, ${limitation.detail}, ${at})
        `.pipe(Effect.mapError(fail("recordLimitation")));
        },
      );

      const limitationsFor: RunStore["Service"]["limitationsFor"] = Effect.fnUntraced(
        function* (runId) {
          const rows = yield* sql<{
            stage_id: string;
            capability: string;
            detail: string;
            at: string;
          }>`SELECT stage_id, capability, detail, at FROM wl_limitations WHERE run_id = ${runId} ORDER BY at`.pipe(
            Effect.mapError(fail("limitationsFor")),
          );

          return rows.map((row) => ({
            stageId: row.stage_id as StageLimitation["stageId"],
            capability: row.capability as StageLimitation["capability"],
            detail: row.detail,
            at: row.at,
          }));
        },
      );

      const saveCursor: RunStore["Service"]["saveCursor"] = Effect.fnUntraced(
        function* (runId, cursor) {
          const at = yield* now;
          yield* sql`
          INSERT INTO wl_cursors (run_id, cursor, updated_at) VALUES (${runId}, ${cursor}, ${at})
          ON CONFLICT (run_id) DO UPDATE SET cursor = ${cursor}, updated_at = ${at}
        `.pipe(Effect.mapError(fail("saveCursor")));
        },
      );

      const loadCursor: RunStore["Service"]["loadCursor"] = Effect.fnUntraced(function* (runId) {
        const rows = yield* sql<{ cursor: string }>`
          SELECT cursor FROM wl_cursors WHERE run_id = ${runId}
        `.pipe(Effect.mapError(fail("loadCursor")));
        const row = rows[0];
        return row === undefined ? Option.none() : Option.some(row.cursor);
      });

      const claimWorkspace: RunStore["Service"]["claimWorkspace"] = Effect.fnUntraced(
        function* (input) {
          const at = yield* now;
          yield* sql`
          INSERT INTO wl_workspaces (workspace_id, run_id, path, branch, base_revision, created_at)
          VALUES (${input.workspaceId}, ${input.runId}, ${input.path}, ${input.branch},
                  ${input.baseRevision}, ${at})
        `.pipe(Effect.mapError(fail("claimWorkspace")));
        },
      );

      const findWorkspace: RunStore["Service"]["findWorkspace"] = Effect.fnUntraced(
        function* (runId) {
          const rows = yield* sql<{
            workspace_id: string;
            run_id: string;
            path: string;
            branch: string;
            base_revision: string;
            disposed_at: string | null;
          }>`SELECT workspace_id, run_id, path, branch, base_revision, disposed_at
           FROM wl_workspaces WHERE run_id = ${runId}`.pipe(Effect.mapError(fail("findWorkspace")));

          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                workspaceId: row.workspace_id,
                runId: row.run_id,
                path: row.path,
                branch: row.branch,
                baseRevision: row.base_revision,
                disposedAt: row.disposed_at,
              });
        },
      );

      const disposeWorkspace: RunStore["Service"]["disposeWorkspace"] = Effect.fnUntraced(
        function* (runId) {
          const at = yield* now;
          yield* sql`UPDATE wl_workspaces SET disposed_at = ${at} WHERE run_id = ${runId}`.pipe(
            Effect.mapError(fail("disposeWorkspace")),
          );
        },
      );

      return RunStore.of({
        createRun,
        loadRun,
        commit,
        listRuns,
        acquireLease,
        renewLease,
        releaseLease,
        recordIntent,
        acknowledgeOperation,
        settleOperation,
        findOperation,
        unsettledOperations,
        putEvidence,
        evidenceFor,
        recordLimitation,
        limitationsFor,
        saveCursor,
        loadCursor,
        claimWorkspace,
        findWorkspace,
        disposeWorkspace,
      });
    }),
  );
}
