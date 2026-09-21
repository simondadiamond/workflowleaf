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
import type { ExecutorCapabilities } from "./state.ts";

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

export interface ExecutorPort {
  capabilities(): Promise<ExecutorCapabilities>;
  startStage(request: StageRequest): Promise<StageHandle>;
  continueStage(handle: StageHandle, correction: string): Promise<ContinueOutcome>;
  /** Reconciles an uncertain dispatch after a disconnect or restart. */
  inspect(operationId: OperationId): Promise<InspectOutcome>;
  interrupt(handle: StageHandle): Promise<void>;
  /** Resolves when the executor has settled, including its background writers. */
  awaitSettlement(handle: StageHandle): Promise<StageSettlement>;
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
