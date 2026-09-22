/**
 * The ports WorkflowLeaf owns.
 *
 * These are our semantics, not any harness's. Exactly one implementation per
 * port may know what T3, Claude or Codex are; everything above this file is
 * written as if none of them exist.
 *
 * Types only. Core states what it needs; the runtime supplies it.
 */
import type { ResolvedStage, RunPlan } from "./contracts.ts";
import type { EvidenceRecord, GateOutcome } from "./evidence.ts";
import type {
  AttemptId,
  Digest,
  GateId,
  Instant,
  OperationId,
  RunId,
  SnapshotId,
  StageId,
  VisitId,
  WorkspaceId,
} from "./ids.ts";
import type { DecisionAnswer } from "./controller.ts";
import type { ExecutorCapabilities, PendingDecision } from "./state.ts";

export interface StageRequest {
  readonly runId: RunId;
  readonly visitId: VisitId;
  readonly attemptId: AttemptId;
  readonly operationId: OperationId;
  readonly workspaceId: WorkspaceId;
  readonly stage: ResolvedStage;
  /** The compiled prompt. The controller decides what a stage may see. */
  readonly input: string;
}

export interface StageHandle {
  readonly operationId: OperationId;
  /** Executor-side identity, opaque above the adapter. */
  readonly handle: string;
}

/**
 * How a stage's execution ended, as WorkflowLeaf understands it.
 *
 * `settled` distinguishes "the model stopped talking" from "the executor and
 * its background writers are finished with the worktree". Running a gate
 * between those two points reads a tree that is still moving.
 */
export interface StageSettlement {
  readonly operationId: OperationId;
  readonly outcome: "completed" | "error" | "interrupted";
  readonly settled: boolean;
  readonly detail: string | null;
  readonly at: Instant;
}

export type ContinueOutcome =
  | { readonly kind: "continued"; readonly handle: StageHandle }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "lost-context"; readonly reason: string };

export type InspectOutcome =
  | { readonly kind: "never-dispatched" }
  | { readonly kind: "in-flight"; readonly handle: StageHandle }
  | { readonly kind: "settled"; readonly settlement: StageSettlement }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * A provider asking for permission in the middle of a stage, e.g. to run a
 * command when the profile's runtime mode requires approval.
 */
export interface ProviderRequest {
  readonly requestId: string;
  /** What the provider wants to do, in its own words. */
  readonly detail: string;
  readonly openedAt: Instant;
  /**
   * The provider can no longer receive an answer: its session ended, or it
   * already refused one as stale. An expired request is shown as expired and
   * never answered as if it were still live.
   */
  readonly expired: boolean;
}

export type ProviderDecision = "accept" | "decline";

export type AnswerOutcome =
  | { readonly kind: "answered" }
  | { readonly kind: "expired"; readonly reason: string }
  | { readonly kind: "not-pending"; readonly reason: string };

export interface ExecutorPort {
  capabilities(): Promise<ExecutorCapabilities>;
  startStage(request: StageRequest): Promise<StageHandle>;
  continueStage(handle: StageHandle, correction: string): Promise<ContinueOutcome>;
  /** Reconciles an uncertain dispatch after a disconnect or restart. */
  inspect(operationId: OperationId): Promise<InspectOutcome>;
  interrupt(handle: StageHandle): Promise<void>;
  /** Resolves when the executor has settled, including its background writers. */
  awaitSettlement(handle: StageHandle): Promise<StageSettlement>;
  /** Approvals the provider is waiting on in this stage's context, oldest first. */
  pendingRequests(handle: StageHandle): Promise<readonly ProviderRequest[]>;
  /** Answers one. An expired request is reported, never replayed. */
  answerRequest(
    handle: StageHandle,
    requestId: string,
    decision: ProviderDecision,
  ): Promise<AnswerOutcome>;
}

export interface WorkspacePort {
  /** One worktree per run, created once, attached to by every stage. */
  create(runId: RunId, baseRevision: string): Promise<{ workspaceId: WorkspaceId; path: string }>;
  /** Full relevant content, including uncommitted and untracked files. */
  snapshot(workspaceId: WorkspaceId): Promise<SnapshotId>;
  changedPaths(workspaceId: WorkspaceId, since: SnapshotId): Promise<readonly string[]>;
  dispose(workspaceId: WorkspaceId): Promise<void>;
}

export interface GateRequest {
  readonly runId: RunId;
  readonly visitId: VisitId;
  readonly attemptId: AttemptId;
  readonly gateId: GateId;
  readonly gateDigest: Digest;
  readonly workspaceId: WorkspaceId;
}

export interface GatePort {
  /** Runs one gate and returns what it observed. Never asks a model. */
  evaluate(request: GateRequest): Promise<EvidenceRecord>;
}

export interface ClockPort {
  now(): Instant;
}

export interface DigestPort {
  of(content: string): Digest;
}

export interface PersistencePort {
  /** Appends a transition and updates current state under an optimistic revision check. */
  commit(
    runId: RunId,
    expectedRevision: number,
    mutate: (previous: unknown) => unknown,
  ): Promise<void>;
  loadPlan(runId: RunId): Promise<RunPlan>;
  evidenceFor(runId: RunId, visitId: VisitId): Promise<readonly EvidenceRecord[]>;
}

export interface GateVerdict {
  readonly gateId: GateId;
  readonly outcome: GateOutcome;
  readonly summary: string;
}

export interface StageLimitation {
  readonly stageId: StageId;
  readonly capability: keyof ExecutorCapabilities;
  readonly detail: string;
}

export interface DecisionRequest {
  readonly runId: RunId;
  readonly decision: PendingDecision;
  /** Where the run works, so the question sits with the run's other threads. */
  readonly workspacePath: string;
  readonly branch: string;
  readonly pullRequestUrl: string | null;
}

/**
 * Asks a person for a decision where they already look for work waiting on
 * them, and reads back what they answered. The decision itself is recorded by
 * the run store; this is only where the question is put.
 */
export interface DecisionPort {
  /** Puts the question up. Asking the same decision twice is the caller's to avoid. */
  ask(request: DecisionRequest): Promise<void>;
  /** The answer given there, or null. With `wait`, resolves once one is given. */
  answer(request: DecisionRequest, wait: boolean): Promise<DecisionAnswer | null>;
  /** Takes the question down once it was answered somewhere else. */
  withdraw(request: DecisionRequest): Promise<void>;
}
