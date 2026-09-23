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
  type PendingDecision,
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
import { digestOf } from "../digest.ts";
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
  /** The story this run delivers. Runs of the same story share it; run ids do not. */
  readonly story: string;
  readonly profileName: string;
  readonly origin: RunOrigin;
  readonly repoRoot: string;
  readonly baseRevision: string;
}

export interface LoadedRun {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly story: string;
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

export interface DecisionRow {
  readonly decisionId: string;
  readonly runId: string;
  readonly visitId: string | null;
  readonly kind: string;
  readonly detail: string;
  readonly raisedAt: string;
  /** When a person was asked on a surface they already watch. Null if never. */
  readonly askedAt: string | null;
  readonly answeredAt: string | null;
  readonly answer: string | null;
  /** `cli` or `thread`: where the answer was given. */
  readonly answeredVia: string | null;
}

/**
 * Something a run noticed that is not a gate's business: whether it matters is
 * a person's call, so it is recorded to reach one and never changes the run.
 * `stage` means the stage wrote it; anything else names the code that saw it.
 */
export interface Finding {
  readonly runId: RunId;
  readonly stageId: string;
  readonly source: string;
  readonly detail: string;
}

export interface RecordedFinding extends Finding {
  readonly at: string;
}

export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly runId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly disposedAt: string | null;
}

export interface TransitionRow {
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  /** The controller input, as canonical JSON. */
  readonly input: string;
  /** The effects it produced, as canonical JSON. */
  readonly effects: string;
  /** The run's revision once this transition was committed. */
  readonly revision: number;
}

interface TransitionColumns {
  readonly run_id: string;
  readonly seq: number;
  readonly at: string;
  readonly input: string;
  readonly effects: string;
  readonly revision: number;
}

const toTransitionRow = (row: TransitionColumns): TransitionRow => ({
  runId: row.run_id,
  seq: row.seq,
  at: row.at,
  input: row.input,
  effects: row.effects,
  revision: row.revision,
});

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
    /** How many runs this story already has. The next one takes the following ordinal. */
    readonly countRunsForStory: (story: string) => Effect.Effect<number, RunStoreError>;
    /**
     * How many transitions a run has committed. Each transition mints at most
     * one id of each kind, so this is a safe seed for a resumed run's ids.
     */
    readonly transitionCount: (runId: RunId) => Effect.Effect<number, RunStoreError>;
    /** Every committed transition since an instant, oldest first, across runs. */
    readonly transitionsSince: (
      since: string,
    ) => Effect.Effect<readonly TransitionRow[], RunStoreError>;
    /** One run's committed transitions, in the order they were committed. */
    readonly transitionsFor: (
      runId: RunId,
    ) => Effect.Effect<readonly TransitionRow[], RunStoreError>;
    /** Every evidence record since an instant whose outcome did not satisfy its gate. */
    readonly failedEvidenceSince: (
      since: string,
    ) => Effect.Effect<readonly EvidenceRecord[], RunStoreError>;
    /** Every recorded limitation since an instant, across runs. */
    readonly limitationsSince: (
      since: string,
    ) => Effect.Effect<
      readonly (StageLimitation & { readonly runId: string; readonly at: string })[],
      RunStoreError
    >;
    readonly findRunByPullRequest: (
      number: number,
    ) => Effect.Effect<Option.Option<LoadedRun>, RunStoreError>;

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
    /** The runs some worker holds an unexpired lease on right now. */
    readonly leasedRuns: () => Effect.Effect<ReadonlySet<string>, RunStoreError>;

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

    /** Records a raised decision against the visit that raised it. Idempotent. */
    readonly recordDecision: (input: {
      readonly runId: RunId;
      readonly visitId: string | null;
      readonly decision: PendingDecision;
    }) => Effect.Effect<void, RunStoreError>;
    readonly markDecisionAsked: (decisionId: string) => Effect.Effect<void, RunStoreError>;
    readonly markDecisionAnswered: (
      decisionId: string,
      answer: string,
      via: "cli" | "thread",
    ) => Effect.Effect<void, RunStoreError>;
    readonly findDecision: (
      decisionId: string,
    ) => Effect.Effect<Option.Option<DecisionRow>, RunStoreError>;

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

    /** Records a finding once; the same text for the same run again is a no-op. */
    readonly recordFinding: (finding: Finding) => Effect.Effect<void, RunStoreError>;
    readonly findingsFor: (
      runId: RunId,
    ) => Effect.Effect<readonly RecordedFinding[], RunStoreError>;
    readonly findingsSince: (
      since: string,
    ) => Effect.Effect<readonly RecordedFinding[], RunStoreError>;

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
        story: string;
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
            story: row.story,
            profileName: row.profile_name,
            repoRoot: row.repo_root,
            baseRevision: row.base_revision,
          } satisfies LoadedRun;
        });

      const createRun: RunStore["Service"]["createRun"] = Effect.fnUntraced(function* (input) {
        yield* sql`
          INSERT INTO wl_runs (
            run_id, plan_digest, workspace_id, state, revision, document, plan,
            story, pull_request_number, profile_name, origin, repo_root, base_revision,
            created_at, updated_at
          ) VALUES (
            ${input.record.runId}, ${input.record.planDigest}, ${input.record.workspaceId},
            ${input.record.state}, ${input.record.revision}, ${canonicalJson(input.record)},
            ${canonicalJson(input.plan)}, ${input.story},
            ${input.record.pullRequest?.number ?? null}, ${input.profileName},
            ${canonicalJson(input.origin)}, ${input.repoRoot}, ${input.baseRevision},
            ${input.record.createdAt}, ${input.record.updatedAt}
          )
        `.pipe(Effect.mapError(fail("createRun")));
      });

      const loadRun: RunStore["Service"]["loadRun"] = Effect.fnUntraced(function* (runId) {
        const rows = yield* sql<{
          document: string;
          plan: string;
          story: string;
          profile_name: string;
          repo_root: string;
          base_revision: string;
        }>`SELECT document, plan, story, profile_name, repo_root, base_revision
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
                story: string;
                profile_name: string;
                repo_root: string;
                base_revision: string;
              }>`SELECT document, plan, story, profile_name, repo_root, base_revision
                 FROM wl_runs ORDER BY updated_at DESC`.pipe(Effect.mapError(fail("listRuns")))
            : yield* sql<{
                document: string;
                plan: string;
                story: string;
                profile_name: string;
                repo_root: string;
                base_revision: string;
              }>`SELECT document, plan, story, profile_name, repo_root, base_revision
                 FROM wl_runs WHERE state = ${filter.state} ORDER BY updated_at DESC`.pipe(
                Effect.mapError(fail("listRuns")),
              );

        return yield* Effect.forEach(rows, readRun);
      });

      const countRunsForStory: RunStore["Service"]["countRunsForStory"] = Effect.fnUntraced(
        function* (story) {
          const rows = yield* sql<{ total: number }>`
            SELECT COUNT(*) AS total FROM wl_runs WHERE story = ${story}
          `.pipe(Effect.mapError(fail("countRunsForStory")));
          return rows[0]?.total ?? 0;
        },
      );

      const transitionCount: RunStore["Service"]["transitionCount"] = Effect.fnUntraced(
        function* (runId) {
          const rows = yield* sql<{ total: number }>`
            SELECT COUNT(*) AS total FROM wl_transitions WHERE run_id = ${runId}
          `.pipe(Effect.mapError(fail("transitionCount")));
          return rows[0]?.total ?? 0;
        },
      );

      const transitionsSince: RunStore["Service"]["transitionsSince"] = Effect.fnUntraced(
        function* (since) {
          const rows = yield* sql<TransitionColumns>`
            SELECT run_id, seq, at, input, effects, revision FROM wl_transitions
            WHERE at >= ${since} ORDER BY at, run_id, seq`.pipe(
            Effect.mapError(fail("transitionsSince")),
          );
          return rows.map(toTransitionRow);
        },
      );

      const transitionsFor: RunStore["Service"]["transitionsFor"] = Effect.fnUntraced(
        function* (runId) {
          const rows = yield* sql<TransitionColumns>`
            SELECT run_id, seq, at, input, effects, revision FROM wl_transitions
            WHERE run_id = ${runId} ORDER BY seq`.pipe(Effect.mapError(fail("transitionsFor")));
          return rows.map(toTransitionRow);
        },
      );

      const failedEvidenceSince: RunStore["Service"]["failedEvidenceSince"] = Effect.fnUntraced(
        function* (since) {
          const rows = yield* sql<{ document: string }>`
            SELECT document FROM wl_evidence
            WHERE recorded_at >= ${since} AND outcome NOT IN ('passed', 'waived')
            ORDER BY recorded_at
          `.pipe(Effect.mapError(fail("failedEvidenceSince")));
          return yield* Effect.forEach(rows, (row) =>
            decodeOrFail("failedEvidenceSince.document", decodeEvidence(row.document)).pipe(
              Effect.map((value) => value as EvidenceRecord),
            ),
          );
        },
      );

      const limitationsSince: RunStore["Service"]["limitationsSince"] = Effect.fnUntraced(
        function* (since) {
          const rows = yield* sql<{
            run_id: string;
            stage_id: string;
            capability: string;
            detail: string;
            at: string;
          }>`SELECT run_id, stage_id, capability, detail, at FROM wl_limitations
             WHERE at >= ${since} ORDER BY at`.pipe(Effect.mapError(fail("limitationsSince")));
          return rows.map((row) => ({
            runId: row.run_id,
            stageId: row.stage_id as StageLimitation["stageId"],
            capability: row.capability as StageLimitation["capability"],
            detail: row.detail,
            at: row.at,
          }));
        },
      );

      const findRunByPullRequest: RunStore["Service"]["findRunByPullRequest"] = Effect.fnUntraced(
        function* (number) {
          const rows = yield* sql<{
            document: string;
            plan: string;
            story: string;
            profile_name: string;
            repo_root: string;
            base_revision: string;
          }>`SELECT document, plan, story, profile_name, repo_root, base_revision
             FROM wl_runs WHERE pull_request_number = ${number}
             ORDER BY updated_at DESC`.pipe(Effect.mapError(fail("findRunByPullRequest")));

          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(yield* readRun(row));
        },
      );

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
              pull_request_number = ${input.next.pullRequest?.number ?? null},
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

      const leasedRuns: RunStore["Service"]["leasedRuns"] = Effect.fnUntraced(function* () {
        const at = yield* now;
        const rows = yield* sql<{ run_id: string }>`
          SELECT run_id FROM wl_leases WHERE expires_at > ${at}
        `.pipe(Effect.mapError(fail("leasedRuns")));
        return new Set(rows.map((row) => row.run_id)) as ReadonlySet<string>;
      });

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

      const recordDecision: RunStore["Service"]["recordDecision"] = Effect.fnUntraced(
        function* (input) {
          yield* sql`
            INSERT INTO wl_decisions (decision_id, run_id, visit_id, kind, detail, plan_digest, raised_at)
            VALUES (${input.decision.decisionId}, ${input.runId}, ${input.visitId},
                    ${input.decision.kind}, ${input.decision.detail},
                    ${input.decision.planDigest}, ${input.decision.raisedAt})
            ON CONFLICT (decision_id) DO NOTHING
          `.pipe(Effect.mapError(fail("recordDecision")));
        },
      );

      const markDecisionAsked: RunStore["Service"]["markDecisionAsked"] = Effect.fnUntraced(
        function* (decisionId) {
          const at = yield* now;
          yield* sql`UPDATE wl_decisions SET asked_at = ${at}
                     WHERE decision_id = ${decisionId} AND asked_at IS NULL`.pipe(
            Effect.mapError(fail("markDecisionAsked")),
          );
        },
      );

      const markDecisionAnswered: RunStore["Service"]["markDecisionAnswered"] = Effect.fnUntraced(
        function* (decisionId, answer, via) {
          const at = yield* now;
          yield* sql`UPDATE wl_decisions
                     SET answered_at = ${at}, answer = ${answer}, answered_via = ${via}
                     WHERE decision_id = ${decisionId} AND answered_at IS NULL`.pipe(
            Effect.mapError(fail("markDecisionAnswered")),
          );
        },
      );

      const findDecision: RunStore["Service"]["findDecision"] = Effect.fnUntraced(
        function* (decisionId) {
          const rows = yield* sql<{
            decision_id: string;
            run_id: string;
            visit_id: string | null;
            kind: string;
            detail: string;
            raised_at: string;
            asked_at: string | null;
            answered_at: string | null;
            answer: string | null;
            answered_via: string | null;
          }>`SELECT decision_id, run_id, visit_id, kind, detail, raised_at, asked_at,
                    answered_at, answer, answered_via
             FROM wl_decisions WHERE decision_id = ${decisionId}`.pipe(
            Effect.mapError(fail("findDecision")),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                decisionId: row.decision_id,
                runId: row.run_id,
                visitId: row.visit_id,
                kind: row.kind,
                detail: row.detail,
                raisedAt: row.raised_at,
                askedAt: row.asked_at,
                answeredAt: row.answered_at,
                answer: row.answer,
                answeredVia: row.answered_via,
              } satisfies DecisionRow);
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

      const recordFinding: RunStore["Service"]["recordFinding"] = Effect.fnUntraced(
        function* (finding) {
          const at = yield* now;
          yield* sql`
          INSERT INTO wl_findings (run_id, stage_id, source, digest, detail, at)
          VALUES (${finding.runId}, ${finding.stageId}, ${finding.source},
                  ${digestOf(`${finding.source}:${finding.detail}`)}, ${finding.detail}, ${at})
          ON CONFLICT (run_id, digest) DO NOTHING
        `.pipe(Effect.mapError(fail("recordFinding")));
        },
      );

      type FindingColumns = {
        run_id: string;
        stage_id: string;
        source: string;
        detail: string;
        at: string;
      };
      const toFinding = (row: FindingColumns): RecordedFinding => ({
        runId: row.run_id as RunId,
        stageId: row.stage_id,
        source: row.source,
        detail: row.detail,
        at: row.at,
      });

      const findingsFor: RunStore["Service"]["findingsFor"] = Effect.fnUntraced(function* (runId) {
        const rows = yield* sql<FindingColumns>`
          SELECT run_id, stage_id, source, detail, at FROM wl_findings
           WHERE run_id = ${runId} ORDER BY at
        `.pipe(Effect.mapError(fail("findingsFor")));
        return rows.map(toFinding);
      });

      const findingsSince: RunStore["Service"]["findingsSince"] = Effect.fnUntraced(
        function* (since) {
          const rows = yield* sql<FindingColumns>`
          SELECT run_id, stage_id, source, detail, at FROM wl_findings
           WHERE at >= ${since} ORDER BY at
        `.pipe(Effect.mapError(fail("findingsSince")));
          return rows.map(toFinding);
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
        countRunsForStory,
        transitionCount,
        transitionsSince,
        transitionsFor,
        failedEvidenceSince,
        limitationsSince,
        findRunByPullRequest,
        acquireLease,
        renewLease,
        releaseLease,
        leasedRuns,
        recordIntent,
        acknowledgeOperation,
        settleOperation,
        findOperation,
        unsettledOperations,
        recordDecision,
        markDecisionAsked,
        markDecisionAnswered,
        findDecision,
        putEvidence,
        evidenceFor,
        recordLimitation,
        limitationsFor,
        recordFinding,
        findingsFor,
        findingsSince,
        saveCursor,
        loadCursor,
        claimWorkspace,
        findWorkspace,
        disposeWorkspace,
      });
    }),
  );
}
