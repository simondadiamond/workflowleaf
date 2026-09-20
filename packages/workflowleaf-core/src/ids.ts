import * as Schema from "effect/Schema";

const TrimmedNonEmpty = Schema.String.check(Schema.isNonEmpty());

const entityId = <Brand extends string>(brand: Brand) => TrimmedNonEmpty.pipe(Schema.brand(brand));

/** One execution of a playbook. */
export const RunId = entityId("WlRunId");
export type RunId = typeof RunId.Type;

/** A stage's identity inside a playbook. Stable across runs. */
export const StageId = entityId("WlStageId");
export type StageId = typeof StageId.Type;

/**
 * One entry into a stage. A run that routes back to `implement` visits it a
 * second time; the visit, not the stage, is what carries attempts and gates.
 */
export const VisitId = entityId("WlVisitId");
export type VisitId = typeof VisitId.Type;

/**
 * One agent or gate attempt inside a visit. A transport retry of the same
 * dispatch reuses the attempt; a new cognitive try creates a new one.
 */
export const AttemptId = entityId("WlAttemptId");
export type AttemptId = typeof AttemptId.Type;

/**
 * Identity of one dispatch to an executor, chosen before dispatch so a lost
 * acknowledgment can be reconciled instead of guessed at.
 */
export const OperationId = entityId("WlOperationId");
export type OperationId = typeof OperationId.Type;

export const GateId = entityId("WlGateId");
export type GateId = typeof GateId.Type;

export const DecisionId = entityId("WlDecisionId");
export type DecisionId = typeof DecisionId.Type;

/** The worktree a run owns. Every stage of the run executes in this one. */
export const WorkspaceId = entityId("WlWorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

/**
 * Content hash of something the run depends on: an instruction file, a gate
 * definition, a skill script, the compiled plan. Computed by the runtime;
 * core only ever compares them.
 */
export const Digest = entityId("WlDigest");
export type Digest = typeof Digest.Type;

/**
 * Identity of the worktree's full relevant content at a point in time,
 * including uncommitted and untracked files. Not a git revision.
 */
export const SnapshotId = entityId("WlSnapshotId");
export type SnapshotId = typeof SnapshotId.Type;

/** ISO 8601 timestamp. Core never produces one; it receives them as input. */
export const Instant = TrimmedNonEmpty;
export type Instant = typeof Instant.Type;
