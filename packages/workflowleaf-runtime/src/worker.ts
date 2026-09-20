/**
 * The worker: the only thing that turns controller decisions into effects.
 *
 * The controller decides, the store records, the worker acts. The order is not
 * decorative. Intent is persisted before an executor is told anything, and the
 * result of every gate is recorded before it is allowed to influence a
 * transition, so a crash anywhere in the loop leaves a state that can be
 * reconciled rather than guessed at.
 *
 * A worker holds a lease on the run for as long as it drives it. Losing the
 * lease stops the loop; it does not race the new owner.
 */
import {
  decide,
  findStage,
  satisfies,
  type ControllerEffect,
  type ControllerInput,
  type Digest,
  type ExecutorPort,
  type GateVerdict,
  type IdSource,
  type RunId,
  type RunPlan,
  type RunRecord,
  type StageHandle,
  type StageRequest,
  type VisitId,
} from "@t3tools/workflowleaf-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { evaluateGate, type GateContext } from "./gates.ts";
import { compileStagePrompt } from "./prompt.ts";
import { skillsForPaths } from "./skillCatalog.ts";
import { RunStore, type Lease } from "./store/RunStore.ts";
import { takeSnapshot, type SnapshotManifest } from "./workspaces.ts";

export class WorkerError extends Schema.TaggedError<WorkerError>()("WlWorkerError", {
  message: Schema.String,
}) {}

export class ExecutorFailed extends Schema.TaggedError<ExecutorFailed>()("WlExecutorFailed", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Executor ${this.operation} failed: ${this.detail}`;
  }
}

const fromExecutor = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ExecutorFailed({
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export interface WorkerDeps {
  readonly executor: ExecutorPort;
  readonly ids: IdSource;
  readonly workspacePath: string;
  readonly logDir: string;
  readonly owner: string;
  readonly leaseSeconds: number;
}

/** Why the worker stopped. `idle` means the run is waiting on something outside it. */
export type StopReason = "finished" | "needs-decision" | "paused" | "waiting-external" | "idle";

export interface DriveResult {
  readonly record: RunRecord;
  readonly stopped: StopReason;
  readonly transitions: number;
}

function stopReasonFor(record: RunRecord): StopReason | null {
  switch (record.state) {
    case "succeeded":
    case "failed":
    case "cancelled":
      return "finished";
    case "needs_decision":
      return "needs-decision";
    case "paused":
      return "paused";
    case "waiting_external":
      return "waiting-external";
    default:
      return null;
  }
}

/**
 * Runs the deterministic gates of one visit and returns a verdict per gate.
 *
 * Evidence is written before the verdicts go anywhere near the controller, so
 * a crash between "checked" and "advanced" loses the advance, not the check.
 */
const runGates = Effect.fnUntraced(function* (input: {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly visitId: VisitId;
  readonly attemptId: string;
  readonly gateIds: readonly string[];
  readonly deps: WorkerDeps;
  readonly baseline: SnapshotManifest;
}) {
  const store = yield* RunStore;
  const visit = input.record.visits.find((candidate) => candidate.visitId === input.visitId);
  const stage = visit === undefined ? undefined : findStage(input.plan, visit.stageId);
  if (stage === undefined) {
    return [] as readonly GateVerdict[];
  }

  const verdicts: GateVerdict[] = [];

  for (const gateId of input.gateIds) {
    const pinned = stage.gates.find((candidate) => candidate.definition.id === gateId);
    if (pinned === undefined) continue;

    const context: GateContext = {
      runId: input.record.runId,
      visitId: input.visitId,
      attemptId: input.attemptId as never,
      workspacePath: input.deps.workspacePath,
      gateDigest: pinned.digest,
      logDir: input.deps.logDir,
      baseline: input.baseline,
    };

    const evidence = yield* evaluateGate(pinned.definition, context);
    yield* store.putEvidence(evidence);

    verdicts.push({
      gateId: pinned.definition.id,
      outcome: evidence.outcome,
      summary: summarize(evidence.detail),
    });
  }

  return verdicts as readonly GateVerdict[];
});

function summarize(detail: { readonly kind: string } & Record<string, unknown>): string {
  switch (detail.kind) {
    case "command":
      return detail.timedOut === true
        ? "the check timed out"
        : `exit ${String(detail.exitCode)}${detail.failedCount === null ? "" : `, ${String(detail.failedCount)} failing`}`;
    case "file":
      return detail.exists === true
        ? `${String(detail.bytes)} bytes, missing ${(detail.missingContent as string[]).length} required fragment(s)`
        : "the file does not exist";
    case "diff":
      return `${(detail.changedFiles as string[]).length} changed, ${(detail.outsideScope as string[]).length} outside the plan`;
    case "review":
      return `${(detail.findings as unknown[]).length} finding(s)`;
    case "external":
      return `${String(detail.check)}: ${String(detail.state)}`;
    default:
      return "";
  }
}

const stageRequestFor = Effect.fnUntraced(function* (input: {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly effect: Extract<ControllerEffect, { type: "dispatch-stage" | "continue-stage" }>;
  readonly deps: WorkerDeps;
}) {
  const stage = findStage(input.plan, input.effect.stageId);
  if (stage === undefined) {
    return yield* new WorkerError({ message: `Plan has no stage ${input.effect.stageId}.` });
  }

  // Path-triggered skills are chosen from what this stage is about to touch,
  // not from what the run looked like when it was compiled.
  const extra = skillsForPaths(stage.contract.skills.lazyRules, [...stage.contract.produces]);
  const extraSkills = extra.flatMap((id) => {
    const found = stage.lazySkills.find((skill) => skill.id === id);
    return found === undefined ? [] : [{ id: found.id, path: found.path }];
  });

  const prompt = compileStagePrompt({
    runId: input.record.runId as string,
    stage,
    plan: input.plan,
    workspacePath: input.deps.workspacePath,
    extraSkills,
    correction: input.effect.type === "continue-stage" ? input.effect.correction : null,
  });

  return {
    runId: input.record.runId,
    visitId: input.effect.visitId,
    attemptId: input.effect.attemptId,
    operationId: input.effect.operationId,
    workspaceId: input.record.workspaceId,
    stage,
    input: prompt,
  } satisfies StageRequest;
});

/**
 * Performs one controller effect and returns the input it produced, if any.
 *
 * Each branch persists what it did before reporting it, which is what makes
 * the loop restartable at any point.
 */
const perform = Effect.fnUntraced(function* (input: {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly effect: ControllerEffect;
  readonly deps: WorkerDeps;
  readonly baseline: SnapshotManifest;
}) {
  const store = yield* RunStore;
  const { effect, deps } = input;

  switch (effect.type) {
    case "dispatch-stage": {
      yield* store.recordIntent({
        operationId: effect.operationId,
        runId: input.record.runId,
        visitId: effect.visitId as string,
        attemptId: effect.attemptId as string,
        kind: "start",
        idempotencyKey: `${input.record.runId}:${effect.visitId}:${effect.attemptId}`,
      });

      const request = yield* stageRequestFor({ ...input, effect });
      const handle = yield* fromExecutor("startStage", () => deps.executor.startStage(request));
      yield* store.acknowledgeOperation(effect.operationId, handle.handle);

      const settlement = yield* fromExecutor("awaitSettlement", () =>
        deps.executor.awaitSettlement(handle),
      );
      yield* store.settleOperation(effect.operationId, settlement.outcome);

      return [
        {
          type: "dispatch-acknowledged",
          operationId: effect.operationId,
          handle: handle.handle,
        },
        { type: "settled", settlement },
      ] as readonly ControllerInput[];
    }

    case "continue-stage": {
      yield* store.recordIntent({
        operationId: effect.operationId,
        runId: input.record.runId,
        visitId: effect.visitId as string,
        attemptId: effect.attemptId as string,
        kind: "continue",
        idempotencyKey: `${input.record.runId}:${effect.visitId}:${effect.attemptId}`,
      });

      const visit = input.record.visits.find((candidate) => candidate.visitId === effect.visitId);
      const previousHandle = visit?.operation?.handle ?? null;

      if (previousHandle === null) {
        // No live context to continue, so this is a fresh dispatch carrying the
        // correction. The controller already recorded the lost continuity.
        const request = yield* stageRequestFor({ ...input, effect });
        const handle = yield* fromExecutor("startStage", () => deps.executor.startStage(request));
        yield* store.acknowledgeOperation(effect.operationId, handle.handle);
        const settlement = yield* fromExecutor("awaitSettlement", () =>
          deps.executor.awaitSettlement(handle),
        );
        yield* store.settleOperation(effect.operationId, settlement.outcome);
        return [{ type: "settled", settlement }] as readonly ControllerInput[];
      }

      const handle: StageHandle = { operationId: effect.operationId, handle: previousHandle };
      const outcome = yield* fromExecutor("continueStage", () =>
        deps.executor.continueStage(handle, effect.correction),
      );

      if (outcome.kind !== "continued") {
        return [
          {
            type: "continue-unavailable",
            operationId: effect.operationId,
            reason: outcome.reason,
          },
        ] as readonly ControllerInput[];
      }

      yield* store.acknowledgeOperation(effect.operationId, outcome.handle.handle);
      const settlement = yield* fromExecutor("awaitSettlement", () =>
        deps.executor.awaitSettlement(outcome.handle),
      );
      yield* store.settleOperation(effect.operationId, settlement.outcome);
      return [{ type: "settled", settlement }] as readonly ControllerInput[];
    }

    case "run-gates": {
      const verdicts = yield* runGates({
        record: input.record,
        plan: input.plan,
        visitId: effect.visitId,
        attemptId: effect.attemptId as string,
        gateIds: effect.gateIds as readonly string[],
        deps,
        baseline: input.baseline,
      });
      return [
        { type: "gates-evaluated", visitId: effect.visitId, verdicts },
      ] as readonly ControllerInput[];
    }

    case "record-limitation": {
      yield* store.recordLimitation(input.record.runId, effect.limitation);
      return [] as readonly ControllerInput[];
    }

    case "raise-decision":
    case "interrupt":
    case "finish":
      return [] as readonly ControllerInput[];
  }
});

/**
 * Reconciles operations that were dispatched and never settled.
 *
 * The absence of a local acknowledgment does not mean nothing happened. Each
 * one is inspected against the executor before the run is allowed to move.
 */
export const reconcile = Effect.fnUntraced(function* (input: {
  readonly record: RunRecord;
  readonly deps: WorkerDeps;
}) {
  const store = yield* RunStore;
  const unsettled = yield* store.unsettledOperations(input.record.runId);
  const inputs: ControllerInput[] = [];

  for (const operation of unsettled) {
    const outcome = yield* fromExecutor("inspect", () =>
      input.deps.executor.inspect(operation.operationId),
    );
    if (outcome.kind === "settled") {
      yield* store.settleOperation(operation.operationId, outcome.settlement.outcome);
    }
    inputs.push({ type: "reconciled", operationId: operation.operationId, outcome });
  }

  return inputs as readonly ControllerInput[];
});

/**
 * Drives a run until it finishes or needs something the worker cannot supply.
 *
 * `maxTransitions` bounds the loop so a controller bug cannot spin forever; a
 * run that hits it is reported rather than left looking busy.
 */
export const drive = Effect.fnUntraced(function* (input: {
  readonly runId: RunId;
  readonly deps: WorkerDeps;
  readonly lease: Lease;
  readonly initial?: readonly ControllerInput[];
  readonly maxTransitions?: number;
}) {
  const store = yield* RunStore;
  const limit = input.maxTransitions ?? 200;

  const loaded = yield* store.loadRun(input.runId);
  if (Option.isNone(loaded)) {
    return yield* new WorkerError({ message: `No run ${input.runId}.` });
  }

  let record = loaded.value.record;
  const plan = loaded.value.plan;

  const pending: ControllerInput[] = [
    ...(yield* reconcile({ record, deps: input.deps })),
    ...(input.initial ?? []),
  ];

  let transitions = 0;

  while (pending.length > 0) {
    if (transitions >= limit) {
      return { record, stopped: "idle", transitions } satisfies DriveResult;
    }

    const next = pending.shift()!;
    const now = DateTime.formatIso(yield* DateTime.now);
    const decision = decide({ run: record, plan, now, ids: input.deps.ids }, next);

    if (decision.run.revision === record.revision && decision.effects.length === 0) {
      // The controller ignored this input, which is its answer to a replayed or
      // out-of-order event. Nothing to persist.
      continue;
    }

    yield* store.commit({
      previous: record,
      next: decision.run,
      transitionInput: next,
      effects: decision.effects,
      lease: input.lease,
    });
    record = decision.run;
    transitions += 1;

    const baseline = yield* takeSnapshot(input.deps.workspacePath, now);

    for (const effect of decision.effects) {
      pending.push(...(yield* perform({ record, plan, effect, deps: input.deps, baseline })));
    }

    const stopped = stopReasonFor(record);
    if (stopped !== null) return { record, stopped, transitions } satisfies DriveResult;
  }

  return {
    record,
    stopped: stopReasonFor(record) ?? "idle",
    transitions,
  } satisfies DriveResult;
});

/** Whether a visit's recorded evidence still satisfies every gate of its stage. */
export const evidenceStillHolds = Effect.fnUntraced(function* (input: {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly visitId: VisitId;
  readonly snapshot: SnapshotManifest;
}) {
  const store = yield* RunStore;
  const visit = input.record.visits.find((candidate) => candidate.visitId === input.visitId);
  const stage = visit === undefined ? undefined : findStage(input.plan, visit.stageId);
  if (stage === undefined) return false;

  const records = yield* store.evidenceFor(input.record.runId, input.visitId);
  const inputDigests = new Map<string, Digest>(
    input.snapshot.files.map((file) => [file.path, file.digest]),
  );

  return stage.gates.every((gate) => {
    const latest = records.filter((record) => record.gateId === gate.definition.id).at(-1);
    return satisfies(latest, {
      snapshotId: input.snapshot.snapshotId,
      gateDigest: gate.digest,
      inputDigests,
    });
  });
});
