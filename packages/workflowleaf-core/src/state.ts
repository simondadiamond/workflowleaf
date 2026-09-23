/**
 * Durable run state.
 *
 * If the process died right now, this is what a reader would find, and it has
 * to be enough to say what the run was doing without reconstructing it from
 * logs. Every field here is persisted; nothing important lives only in memory.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AttemptId,
  DecisionId,
  Digest,
  GateId,
  Instant,
  OperationId,
  RunId,
  StageId,
  VisitId,
  WorkspaceId,
} from "./ids.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RunState = Schema.Literals([
  "queued",
  "running",
  "waiting_external",
  "needs_decision",
  "paused",
  "recovering",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RunState = typeof RunState.Type;

export const VisitState = Schema.Literals([
  "pending",
  "executing",
  "checking",
  "repairing",
  "passed",
  "failed",
  "blocked",
  "cancelled",
]);
export type VisitState = typeof VisitState.Type;

export const TERMINAL_RUN_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/**
 * What an executor can actually do for the selected profile. Never inferred
 * from a provider's name: an executor that says it continues a context and
 * does not is worse than one that says it cannot.
 */
export const ExecutorCapabilities = Schema.Struct({
  freshContext: Schema.Boolean,
  sameContextContinuation: Schema.Boolean,
  /** A completion signal that means the executor is finished writing, not just talking. */
  settledCompletion: Schema.Boolean,
  interrupt: Schema.Boolean,
  /** Can answer "did operation X happen?" after a disconnect. */
  recovery: Schema.Boolean,
});
export type ExecutorCapabilities = typeof ExecutorCapabilities.Type;

/**
 * A dispatch in flight. Written before the dispatch leaves, so a crash between
 * "sent" and "acknowledged" leaves a record to reconcile against rather than
 * an absence to misread as "nothing happened".
 */
export const Operation = Schema.Struct({
  operationId: OperationId,
  attemptId: AttemptId,
  mode: Schema.Literals(["fresh", "continue"]),
  dispatchedAt: Instant,
  acknowledgedAt: Schema.NullOr(Instant),
  /** Executor-side handle, opaque to everything above the adapter. */
  handle: Schema.NullOr(Schema.String),
});
export type Operation = typeof Operation.Type;

export const StageVisit = Schema.Struct({
  visitId: VisitId,
  stageId: StageId,
  state: VisitState,
  /** Cognitive attempts. A transport retry of the same operation does not count. */
  attempts: NonNegativeInt,
  startedAt: Instant,
  endedAt: Schema.NullOr(Instant),
  operation: Schema.NullOr(Operation),
  /** Set when a correction had to start a new context because continuation was unavailable. */
  lostContext: Schema.Boolean,
  /** Gates still outstanding for this visit, in declaration order. */
  pendingGates: Schema.Array(GateId),
  /**
   * Path-triggered skills this visit has been given, at dispatch or by a
   * refresh. A skill the stage's changes call for that is not here forces a
   * refresh before its gates run. Visits recorded before this field decode
   * with none.
   */
  skills: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  failure: Schema.NullOr(Schema.String),
});
export type StageVisit = typeof StageVisit.Type;

export const PendingDecision = Schema.Struct({
  decisionId: DecisionId,
  kind: Schema.Literals([
    "approval",
    "ambiguity",
    "policy-exception",
    "waiver",
    "destructive-operation",
    "business-judgment",
    "budget-exhausted",
    "lost-context",
    "unsupported-capability",
    "reconciliation",
    "scope-split",
  ]),
  detail: Schema.String,
  raisedAt: Instant,
  /**
   * The plan the question was asked about. An answer given against an older
   * plan cannot authorize work that has changed since.
   */
  planDigest: Digest,
});
export type PendingDecision = typeof PendingDecision.Type;

/**
 * The pull request a run delivers into.
 *
 * A run is one story and ends with one pull request, so this is part of the
 * run's identity rather than something the last stage reports. It is recorded
 * when the pull request is opened, which is at the start of the run.
 */
export const PullRequestRef = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  url: Schema.String.check(Schema.isNonEmpty()),
  /** The branch the run pushes. The run's worktree is checked out on it. */
  headBranch: Schema.String.check(Schema.isNonEmpty()),
  baseBranch: Schema.String.check(Schema.isNonEmpty()),
  openedAt: Instant,
});
export type PullRequestRef = typeof PullRequestRef.Type;

/**
 * A stage's declaration that findings grew the story past this pull request.
 *
 * Only the stage doing the work can notice this, so it declares it and code
 * detects the declaration; nothing infers a split from the size of a diff. The
 * digest binds the question to the declaration's content, so acknowledging one
 * split does not silently acknowledge a later, different one.
 */
export const ScopeSplit = Schema.Struct({
  digest: Digest,
  detail: Schema.String,
  declaredAt: Instant,
  acknowledgedAt: Schema.NullOr(Instant),
});
export type ScopeSplit = typeof ScopeSplit.Type;

export const RunBudget = Schema.Struct({
  /** Backward repair cycles used across the whole run. */
  repairCycles: NonNegativeInt,
  maxRepairCycles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadlineAt: Schema.NullOr(Instant),
});
export type RunBudget = typeof RunBudget.Type;

export const RunRecord = Schema.Struct({
  runId: RunId,
  planDigest: Digest,
  workspaceId: WorkspaceId,
  /**
   * The pull request this run delivers into. Null only while none was opened.
   * Records written before this field existed decode with none, rather than
   * making every listing of the store fail on one old row.
   */
  pullRequest: Schema.NullOr(PullRequestRef).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** Set once a stage declares the story has outgrown that pull request. Defaults as above. */
  scopeSplit: Schema.NullOr(ScopeSplit).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  state: RunState,
  /** Optimistic concurrency. One writer owns a run; this is how a stale one is caught. */
  revision: NonNegativeInt,
  currentStageId: Schema.NullOr(StageId),
  visits: Schema.Array(StageVisit),
  budget: RunBudget,
  capabilities: ExecutorCapabilities,
  decision: Schema.NullOr(PendingDecision),
  failure: Schema.NullOr(Schema.String),
  createdAt: Instant,
  updatedAt: Instant,
});
export type RunRecord = typeof RunRecord.Type;

export function currentVisit(run: RunRecord): StageVisit | undefined {
  for (let index = run.visits.length - 1; index >= 0; index -= 1) {
    const visit = run.visits[index];
    if (visit !== undefined && visit.stageId === run.currentStageId) return visit;
  }
  return undefined;
}

export function visitById(run: RunRecord, visitId: VisitId): StageVisit | undefined {
  return run.visits.find((visit) => visit.visitId === visitId);
}

/** How many times the run has entered this stage. Bounds backward repair loops. */
export function visitCount(run: RunRecord, stageId: StageId): number {
  return run.visits.filter((visit) => visit.stageId === stageId).length;
}
