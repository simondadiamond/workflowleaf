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
  SATISFYING,
  currentVisit,
  decide,
  findStage,
  satisfies,
  type ControllerEffect,
  type ControllerInput,
  type Digest,
  type ExecutorPort,
  type GateVerdict,
  type IdSource,
  type OperationId,
  type ResolvedStage,
  type RunId,
  type RunPlan,
  type RunRecord,
  type StageHandle,
  type StageId,
  type StageRequest,
  type StageSettlement,
  type VisitId,
  type VisitState,
} from "@t3tools/workflowleaf-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { digestOf } from "./digest.ts";
import { evaluateGate, type GateContext } from "./gates.ts";
import { compileStagePrompt } from "./prompt.ts";
import type { PullRequestError } from "./pullRequest.ts";
import type { ReviewerConfig } from "./reviewer.ts";
import { skillsForPaths } from "./skillCatalog.ts";
import { RunStore, type Lease } from "./store/RunStore.ts";
import {
  changedPaths,
  pathsChangedSince,
  takeSnapshot,
  type SnapshotManifest,
} from "./workspaces.ts";

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

/**
 * What the run just did, for whoever is watching it work.
 *
 * A stage can take twenty minutes, so a driver that reports only where the run
 * stopped tells a person nothing until it is over. These are the moments worth
 * seeing while it runs; the run record remains the durable account.
 */
export type RunProgress =
  | {
      readonly kind: "stage-started";
      readonly stageId: string;
      readonly attempt: number;
      /** A correction inside an existing context rather than a fresh visit. */
      readonly correcting: boolean;
    }
  | { readonly kind: "gates"; readonly stageId: string; readonly verdicts: readonly GateVerdict[] }
  | { readonly kind: "stage-settled"; readonly stageId: string; readonly state: VisitState }
  | {
      readonly kind: "pull-request-ready";
      readonly number: number;
      /** Why it could not be marked ready, or null when it was. */
      readonly failure: string | null;
    };

/** Where progress is reported to. Absent means nobody is watching. */
export type ProgressSink = (event: RunProgress) => Effect.Effect<void>;

export interface WorkerDeps {
  readonly executor: ExecutorPort;
  readonly ids: IdSource;
  readonly workspacePath: string;
  readonly logDir: string;
  readonly owner: string;
  readonly leaseSeconds: number;
  /** Optional: told what just happened, as it happens. Never affects the run. */
  readonly progress?: ProgressSink | undefined;
  /**
   * Where the same progress is appended as lines, so anything can read how far
   * a run has got while another process is still driving it.
   */
  readonly progressLog?: string | undefined;
  /** The revision the run branched from, for gates that judge the change since. */
  readonly baseRevision?: string | undefined;
  /** Who judges review gates. */
  readonly reviewer?: ReviewerConfig | undefined;
  /** The `gh` config directory for the run's repository, when the profile names one. */
  readonly ghConfigDir?: string | undefined;
  /**
   * How long the worktree must stay unchanged before gates may read it. Absent
   * means gates run as soon as the stage settles, which only tests want.
   */
  readonly quiet?: QuietWindow | undefined;
  /**
   * Marks the run's pull request ready for review. Called once the stage that
   * produces `pull-request` passes. Absent means the profile does not permit it.
   */
  readonly markReady?:
    | ((
        pullRequestNumber: number,
      ) => Effect.Effect<void, PullRequestError, ChildProcessSpawner.ChildProcessSpawner>)
    | undefined;
  /** The profile's `pullRequest.reviewWaitMinutes`, for `converged-on-head`. */
  readonly reviewWaitMinutes?: number | undefined;
}

/**
 * The worktree must go this long without a change before a gate reads it, and
 * a tree still changing after `timeoutMs` is reported instead of judged.
 */
export interface QuietWindow {
  readonly windowMs: number;
  readonly timeoutMs: number;
}

/**
 * What a real run waits for. Long enough to outlast a formatter or a hook that
 * fires as a turn ends, short enough not to be noticed, and a timeout past
 * which something is plainly still running in the worktree.
 */
export const DEFAULT_QUIET: QuietWindow = { windowMs: 2_000, timeoutMs: 180_000 };

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

const SETTLED_VISIT_STATES: readonly VisitState[] = ["passed", "failed", "blocked", "cancelled"];

/**
 * The visible moments in one committed transition.
 *
 * Read off the records either side of the commit rather than announced from
 * inside each branch of `perform`, so a watcher is told what was persisted and
 * nothing that was merely attempted.
 */
function progressFor(input: {
  readonly previous: RunRecord;
  readonly next: RunRecord;
  readonly transitionInput: ControllerInput;
  readonly effects: readonly ControllerEffect[];
}): readonly RunProgress[] {
  const events: RunProgress[] = [];
  const stageOf = (visitId: VisitId) =>
    input.next.visits.find((visit) => visit.visitId === visitId)?.stageId ?? null;

  if (input.transitionInput.type === "gates-evaluated") {
    const stageId = stageOf(input.transitionInput.visitId);
    if (stageId !== null) {
      events.push({ kind: "gates", stageId, verdicts: input.transitionInput.verdicts });
    }
  }

  for (const visit of input.next.visits) {
    const before = input.previous.visits.find((candidate) => candidate.visitId === visit.visitId);
    if (before?.state === visit.state) continue;
    if (!SETTLED_VISIT_STATES.includes(visit.state)) continue;
    events.push({ kind: "stage-settled", stageId: visit.stageId, state: visit.state });
  }

  for (const effect of input.effects) {
    if (effect.type !== "dispatch-stage" && effect.type !== "continue-stage") continue;
    const visit = input.next.visits.find((candidate) => candidate.visitId === effect.visitId);
    events.push({
      kind: "stage-started",
      stageId: effect.stageId,
      attempt: visit?.attempts ?? 1,
      correcting: effect.type === "continue-stage",
    });
  }

  return events;
}

/** One line per progress event, the same shape a person watching the terminal sees. */
export function progressLine(at: string, event: RunProgress): string {
  switch (event.kind) {
    case "stage-started":
      return `${at} ${event.stageId} ${event.correcting ? "correcting" : "started"} attempt=${String(event.attempt)}`;
    case "gates":
      return `${at} ${event.stageId} gates ${event.verdicts.map((verdict) => `${verdict.gateId}=${verdict.outcome}`).join(" ") || "none"}`;
    case "stage-settled":
      return `${at} ${event.stageId} ${event.state}`;
    case "pull-request-ready":
      return event.failure === null
        ? `${at} pull-request #${String(event.number)} marked ready`
        : `${at} pull-request #${String(event.number)} not marked ready: ${event.failure.split("\n")[0] ?? ""}`;
  }
}

/**
 * The pull request to mark ready after this transition: the run's own, when a
 * stage that produces `pull-request` has just passed. That is the delivery
 * being complete, and review bots that skip drafts only start after it.
 */
function deliveredPullRequest(input: {
  readonly previous: RunRecord;
  readonly next: RunRecord;
  readonly plan: RunPlan;
}): number | null {
  const number = input.next.pullRequest?.number ?? null;
  if (number === null) return null;
  const delivered = input.next.visits.some((visit) => {
    if (visit.state !== "passed") return false;
    const before = input.previous.visits.find((candidate) => candidate.visitId === visit.visitId);
    if (before?.state === "passed") return false;
    return (
      findStage(input.plan, visit.stageId)?.contract.produces.includes("pull-request") ?? false
    );
  });
  return delivered ? number : null;
}

/**
 * Appends progress to the run's log. A watcher that cannot write it must not
 * stop the run, so a failure here is swallowed rather than raised.
 */
const appendProgress = Effect.fnUntraced(
  function* (file: string, at: string, events: readonly RunProgress[]) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(
      file,
      events.map((event) => `${progressLine(at, event)}\n`).join(""),
      {
        flag: "a",
      },
    );
  },
  Effect.catchCause(() => Effect.void),
);

/**
 * Waits until nothing is writing to the worktree.
 *
 * An executor's settlement says its own turn is over. It cannot speak for a
 * process that turn started in the background, a hook, or a formatter, and a
 * gate that reads while any of those is still writing judges a tree that is
 * about to change. Two snapshots a quiet window apart must agree before gates
 * may run. The paths still changing when time runs out are returned, so the
 * run can say what would not settle.
 */
export const awaitQuiet = Effect.fnUntraced(function* (workspacePath: string, quiet: QuietWindow) {
  const snapshot = Effect.gen(function* () {
    return yield* takeSnapshot(workspacePath, DateTime.formatIso(yield* DateTime.now));
  });

  let previous = yield* snapshot;
  let changing: readonly string[] = [];
  for (let waited = 0; waited < quiet.timeoutMs; waited += quiet.windowMs) {
    yield* Effect.sleep(`${quiet.windowMs} millis`);
    const next = yield* snapshot;
    if (next.snapshotId === previous.snapshotId) return { quiet: true, changing: [] };
    changing = changedPaths(previous, next);
    previous = next;
  }
  return { quiet: false, changing };
});

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

  // No gate reads the worktree until it has stopped changing. A tree that
  // never settles is not judged: every gate reports that it could not run,
  // which stops the run for a person rather than spending the stage's attempts.
  if (input.deps.quiet !== undefined) {
    const settled = yield* awaitQuiet(input.deps.workspacePath, input.deps.quiet);
    if (!settled.quiet) {
      const summary = `the worktree was still changing after ${String(input.deps.quiet.timeoutMs)}ms, so no gate ran: ${settled.changing.slice(0, 10).join(", ")}`;
      return stage.gates
        .filter((pinned) => input.gateIds.includes(pinned.definition.id))
        .map((pinned): GateVerdict => ({
          gateId: pinned.definition.id,
          outcome: "error",
          summary,
        }));
    }
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
      baseRevision: input.deps.baseRevision,
      pullRequestNumber: input.record.pullRequest?.number ?? null,
      artifacts: artifactPaths([...stage.contract.consumes, ...stage.contract.produces]),
      reviewer: input.deps.reviewer,
      ghConfigDir: input.deps.ghConfigDir,
      reviewWaitMinutes: input.deps.reviewWaitMinutes,
    };

    const evidence = yield* evaluateGate(pinned.definition, context);
    yield* store.putEvidence(evidence);

    const summary = summarize(evidence.detail);
    const tail = SATISFYING.includes(evidence.outcome)
      ? null
      : yield* failureOutput(evidence.logRef);

    verdicts.push({
      gateId: pinned.definition.id,
      outcome: evidence.outcome,
      summary: tail === null ? summary : `${summary}\n${tail}`,
    });
  }

  return verdicts as readonly GateVerdict[];
});

/**
 * The names in a stage's `consumes` and `produces` that are files. Run inputs
 * and abstract outputs such as `diff` are not.
 */
function artifactPaths(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => name.includes("/") || name.includes(".")))];
}

/**
 * How much of a failing gate's output is worth carrying into the correction.
 * Enough for a stack trace or a handful of assertion failures, and not so much
 * that a chatty test runner becomes the prompt.
 */
const GATE_OUTPUT_TAIL = 4000;

/**
 * The tail of what a failing gate printed.
 *
 * The gate runner already writes stdout and stderr to a log. Without this the
 * stage being corrected is told `exit 1` and nothing else, which for the gates
 * a real playbook uses (tests, typecheck, lint) is not something anyone can
 * act on. Evidence stays small; the correction reads the log that exists.
 */
const failureOutput = Effect.fnUntraced(function* (logRef: string | null) {
  if (logRef === null) return null;
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs.readFileString(logRef).pipe(Effect.catchCause(() => Effect.succeed("")));
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  return trimmed.length <= GATE_OUTPUT_TAIL
    ? trimmed
    : `…\n${trimmed.slice(trimmed.length - GATE_OUTPUT_TAIL)}`;
});

/**
 * What a failed file gate wanted, in words the stage being corrected can act on.
 *
 * A count is not evidence. "missing 1 required fragment(s)" leaves the stage
 * guessing which one, and a file that is merely too short reads as a clean pass
 * with a byte count attached. Both are named here instead.
 */
function summarizeFile(detail: Record<string, unknown>): string {
  if (detail.exists !== true) return "the file does not exist";

  const bytes = detail.bytes as number | null;
  const minBytes = (detail.minBytes ?? null) as number | null;
  const missing = detail.missingContent as readonly string[];

  const parts = [`${String(bytes)} bytes`];
  if (minBytes !== null && bytes !== null && bytes < minBytes) {
    parts.push(`shorter than the required ${String(minBytes)}`);
  }
  if (missing.length > 0) {
    parts.push(`missing ${missing.map((needle) => `"${needle}"`).join(", ")}`);
  }
  return parts.join("; ");
}

/**
 * A review verdict as the stage being corrected needs it: every finding, its
 * severity and the failure scenario that makes it a finding rather than an
 * opinion. A count alone would send the stage back to guess.
 */
function summarizeReview(detail: Record<string, unknown>): string {
  const findings = detail.findings as readonly {
    severity: string;
    summary: string;
    failureScenario: string;
  }[];
  if (findings.length === 0) return "no findings";
  return [
    `${String(findings.length)} finding(s)`,
    ...findings.map(
      (finding) =>
        `- [${finding.severity}] ${finding.summary}${finding.failureScenario.length > 0 ? `\n  Failure scenario: ${finding.failureScenario}` : ""}`,
    ),
  ].join("\n");
}

function summarize(detail: { readonly kind: string } & Record<string, unknown>): string {
  switch (detail.kind) {
    case "command":
      return detail.timedOut === true
        ? "the check timed out"
        : `exit ${String(detail.exitCode)}${detail.failedCount === null ? "" : `, ${String(detail.failedCount)} failing`}`;
    case "file":
      return summarizeFile(detail);
    case "diff": {
      const outside = detail.outsideScope as string[];
      return `${(detail.changedFiles as string[]).length} changed, ${outside.length} outside the plan${outside.length === 0 ? "" : `: ${outside.join(", ")}`}`;
    }
    case "review":
      return summarizeReview(detail);
    case "external":
      return `${String(detail.check)}: ${String(detail.state)}${detail.detail === null || detail.detail === undefined ? "" : `. ${String(detail.detail)}`}`;
    default:
      return "";
  }
}

/**
 * Where a stage says the story has outgrown this run's pull request.
 *
 * Only the stage doing the work can see that a finding grew the story, so it
 * writes the reason here and code picks it up. It sits under `.workflowleaf/`,
 * which snapshots exclude, so declaring a split does not disturb any gate.
 */
export const SCOPE_SPLIT_PATH = ".workflowleaf/scope-split.md";

/**
 * Reads a scope-split declaration, if the stage left one.
 *
 * Read after every settlement rather than once at the end: the finding that
 * grows a story usually turns up while the work is being done, and the run
 * should ask before it carries the wider scope any further.
 */
const scopeSplitDeclared = Effect.fnUntraced(function* (workspacePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(workspacePath, SCOPE_SPLIT_PATH);

  if (!(yield* fs.exists(file).pipe(Effect.catchCause(() => Effect.succeed(false))))) return [];

  const text = yield* fs.readFileString(file).pipe(Effect.catchCause(() => Effect.succeed("")));
  const detail = text.trim();
  if (detail.length === 0) return [];

  return [
    { type: "scope-split-declared", digest: digestOf(detail), detail },
  ] as readonly ControllerInput[];
});

/**
 * The path-triggered skills a stage calls for right now.
 *
 * Chosen from the paths the run has actually changed, plus what the stage
 * declares it produces, so a later stage gets the skills its predecessors'
 * changes need and a stage that has just written a file is caught needing one.
 * A worktree git cannot read yields the declared outputs alone rather than
 * stopping the run.
 */
const skillsCalledFor = Effect.fnUntraced(function* (stage: ResolvedStage, deps: WorkerDeps) {
  const rules = stage.contract.skills.lazyRules;
  if (rules.length === 0) return [] as string[];
  const changed = yield* pathsChangedSince(deps.workspacePath, deps.baseRevision ?? "HEAD").pipe(
    Effect.catchCause(() => Effect.succeed([] as string[])),
  );
  return skillsForPaths(rules, [...stage.contract.produces, ...changed]);
});

/**
 * What a stage that just settled reports before its settlement: the skills its
 * changes call for, so the controller can refresh it before any gate runs.
 * Only a completed turn is judged; an error or an interruption is handled as
 * one.
 */
const discoveredSkills = Effect.fnUntraced(function* (input: {
  readonly plan: RunPlan;
  readonly stageId: StageId;
  readonly operationId: OperationId;
  readonly outcome: StageSettlement["outcome"];
  readonly deps: WorkerDeps;
}) {
  const stage = findStage(input.plan, input.stageId);
  if (stage === undefined || input.outcome !== "completed") return [] as ControllerInput[];
  const skills = yield* skillsCalledFor(stage, input.deps);
  return skills.length === 0
    ? ([] as ControllerInput[])
    : ([
        { type: "skills-discovered", operationId: input.operationId, skills },
      ] as ControllerInput[]);
});

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

  const extra = yield* skillsCalledFor(stage, input.deps);
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
    correction: input.effect.correction ?? null,
    ghConfigDir: input.deps.ghConfigDir,
  });

  return {
    request: {
      runId: input.record.runId,
      visitId: input.effect.visitId,
      attemptId: input.effect.attemptId,
      operationId: input.effect.operationId,
      workspaceId: input.record.workspaceId,
      stage,
      input: prompt,
    } satisfies StageRequest,
    skills: extraSkills.map((skill) => skill.id),
  };
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

      const { request, skills } = yield* stageRequestFor({ ...input, effect });
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
          ...(skills.length === 0 ? {} : { skills }),
        },
        ...(yield* discoveredSkills({
          plan: input.plan,
          stageId: effect.stageId,
          operationId: effect.operationId,
          outcome: settlement.outcome,
          deps,
        })),
        { type: "settled", settlement },
        ...(yield* scopeSplitDeclared(deps.workspacePath)),
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
        const { request, skills } = yield* stageRequestFor({ ...input, effect });
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
            ...(skills.length === 0 ? {} : { skills }),
          },
          ...(yield* discoveredSkills({
            plan: input.plan,
            stageId: effect.stageId,
            operationId: effect.operationId,
            outcome: settlement.outcome,
            deps,
          })),
          { type: "settled", settlement },
          ...(yield* scopeSplitDeclared(deps.workspacePath)),
        ] as readonly ControllerInput[];
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
      return [
        ...(yield* discoveredSkills({
          plan: input.plan,
          stageId: effect.stageId,
          operationId: effect.operationId,
          outcome: settlement.outcome,
          deps,
        })),
        { type: "settled", settlement },
        ...(yield* scopeSplitDeclared(deps.workspacePath)),
      ] as readonly ControllerInput[];
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

    case "raise-decision": {
      // Recorded against the visit that raised it, so the question and its
      // answer outlive whatever surface the person was asked on.
      const visit = currentVisit(input.record);
      yield* store.recordDecision({
        runId: input.record.runId,
        visitId: (visit?.visitId as string | undefined) ?? null,
        decision: effect.decision,
      });
      return [] as readonly ControllerInput[];
    }

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

    const events = [
      ...progressFor({
        previous: record,
        next: decision.run,
        transitionInput: next,
        effects: decision.effects,
      }),
    ];

    // Before the next stage's effects run, so a watch stage that follows the
    // delivery reads a pull request reviewers can already see. A failure is
    // reported, not raised: the watch then waits, and says it is a draft.
    const delivered = deliveredPullRequest({ previous: record, next: decision.run, plan });
    if (delivered !== null && input.deps.markReady !== undefined) {
      const marked = yield* input.deps.markReady(delivered).pipe(Effect.result);
      // Listed before the next stage starts, which is when it happened.
      const next = events.findIndex((event) => event.kind === "stage-started");
      events.splice(next === -1 ? events.length : next, 0, {
        kind: "pull-request-ready",
        number: delivered,
        failure: marked._tag === "Success" ? null : marked.failure.message,
      });
    }

    for (const event of events) {
      if (input.deps.progress !== undefined) yield* input.deps.progress(event);
    }
    if (input.deps.progressLog !== undefined && events.length > 0) {
      yield* appendProgress(input.deps.progressLog, now, events);
    }

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
