/**
 * Starting and resuming runs.
 *
 * This is where a playbook, a profile and an executor become a run. Two
 * decisions live here and nowhere else.
 *
 * Capabilities are read from the executor at run creation and stored on the
 * run, so every later decision is made against what this executor can actually
 * do rather than against what the playbook hoped for.
 *
 * A run owns its worktree from the moment it is created, so nothing downstream
 * has to decide where the work happens.
 */
import {
  initialRun,
  type ControllerInput,
  type ExecutorPort,
  type IdSource,
  type RunId,
  type RunPlan,
} from "@t3tools/workflowleaf-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AssistedExecutor } from "./adapters/assisted.ts";
import { digestOf } from "./digest.ts";
import { revParse } from "./git.ts";
import { loadPlaybook } from "./load.ts";
import { workflowleafHome, type Profile } from "./profile.ts";
import { RunStore, type Lease } from "./store/RunStore.ts";
import { drive, type DriveResult, type WorkerDeps } from "./worker.ts";
import { ensureWorkspace } from "./workspaces.ts";

export class RunError extends Schema.TaggedError<RunError>()("WlRunError", {
  message: Schema.String,
}) {}

/** Ids derived from the run and a counter, so a resumed run does not collide with itself. */
export function idSourceFor(runId: string, seed: number): IdSource {
  let visits = seed;
  let attempts = seed;
  let operations = seed;
  let decisions = seed;
  const make = (kind: string, index: number) =>
    `${kind}-${digestOf(`${runId}:${kind}:${index}`).slice(7, 19)}`;
  return {
    visitId: () => make("visit", ++visits) as never,
    attemptId: () => make("attempt", ++attempts) as never,
    operationId: () => make("op", ++operations) as never,
    decisionId: () => make("decision", ++decisions) as never,
  };
}

/** The executor a profile asks for. Assisted mode is the honest fallback. */
export const executorFor = Effect.fnUntraced(function* (profile: Profile) {
  if (profile.executor.kind === "fake") return new AssistedExecutor() as ExecutorPort;
  return yield* new RunError({
    message: `The ${profile.executor.kind} executor is not wired up in this build. Use an assisted profile, or finish the adapter.`,
  });
});

const runDirFor = Effect.fnUntraced(function* (runId: string) {
  const path = yield* Path.Path;
  return path.join(yield* workflowleafHome(), "runs", runId);
});

export interface StartRunInput {
  readonly runId: RunId;
  readonly profile: Profile;
  readonly playbookDir: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly baseRef: string;
  readonly executor: ExecutorPort;
  readonly owner: string;
}

export interface StartedRun {
  readonly plan: RunPlan;
  readonly result: DriveResult;
}

export const startRun = Effect.fnUntraced(function* (input: StartRunInput) {
  const store = yield* RunStore;
  const path = yield* Path.Path;

  const compiledAt = DateTime.formatIso(yield* DateTime.now);
  const loaded = yield* loadPlaybook({
    playbookDir: input.playbookDir,
    repoRoot: input.profile.repoRoot,
    skillRoots: input.profile.skillRoots,
    inputs: input.inputs,
    compiledAt,
  });

  if (!loaded.ok) {
    return yield* new RunError({
      message: loaded.diagnostics
        .map((one) => `${one.source}: ${one.field}: ${one.message}`)
        .join("\n"),
    });
  }

  const baseRevision = yield* revParse(input.profile.repoRoot, input.baseRef);
  const capabilities = yield* Effect.promise(() => input.executor.capabilities());

  yield* store.createRun({
    record: initialRun({
      runId: input.runId,
      planDigest: loaded.value.plan.planDigest,
      workspaceId: "pending" as never,
      capabilities,
      maxRepairCycles: input.profile.budgets.maxRepairCycles,
      deadlineAt: null,
      now: compiledAt,
    }),
    plan: loaded.value.plan,
    profileName: input.profile.name,
    origin: { trigger: "manual", by: input.owner },
    repoRoot: input.profile.repoRoot,
    baseRevision,
  });

  const workspace = yield* ensureWorkspace({
    runId: input.runId,
    repoRoot: input.profile.repoRoot,
    worktreeRoot: input.profile.worktreeRoot,
    baseRevision,
  });

  // The workspace id is only known once the worktree exists, so the run record
  // written above is corrected before anything is dispatched into it.
  const created = yield* store.loadRun(input.runId);
  if (Option.isNone(created)) {
    return yield* new RunError({ message: `Run ${input.runId} vanished during creation.` });
  }

  const lease = yield* takeLease(input.runId, input.owner);
  yield* store.commit({
    previous: created.value.record,
    next: {
      ...created.value.record,
      workspaceId: workspace.workspaceId,
      revision: created.value.record.revision + 1,
      updatedAt: compiledAt,
    },
    transitionInput: { type: "workspace-attached", path: workspace.path },
    effects: [],
    lease,
  });

  const result = yield* drive({
    runId: input.runId,
    deps: {
      executor: input.executor,
      ids: idSourceFor(input.runId as string, 0),
      workspacePath: workspace.path,
      logDir: path.join(yield* runDirFor(input.runId as string), "logs"),
      owner: input.owner,
      leaseSeconds: 300,
    },
    lease,
    initial: [{ type: "start" }],
  });

  return { plan: loaded.value.plan, result } satisfies StartedRun;
});

const takeLease = Effect.fnUntraced(function* (runId: RunId, owner: string) {
  const store = yield* RunStore;
  const lease = yield* store.acquireLease(runId, owner, 300);
  if (Option.isNone(lease)) {
    return yield* new RunError({
      message: `Run ${runId} is held by another worker. Wait for it, or stop that worker.`,
    });
  }
  return lease.value as Lease;
});

export interface ResumeRunInput {
  readonly runId: RunId;
  readonly executor: ExecutorPort;
  readonly owner: string;
  readonly inputs: readonly ControllerInput[];
}

/** Picks a run back up: reattaches to its worktree, reconciles, then drives. */
export const resumeRun = Effect.fnUntraced(function* (input: ResumeRunInput) {
  const store = yield* RunStore;
  const path = yield* Path.Path;

  const loaded = yield* store.loadRun(input.runId);
  if (Option.isNone(loaded)) {
    return yield* new RunError({ message: `No run ${input.runId}.` });
  }

  const workspace = yield* store.findWorkspace(input.runId);
  if (Option.isNone(workspace)) {
    return yield* new RunError({ message: `Run ${input.runId} has no workspace on record.` });
  }

  const lease = yield* takeLease(input.runId, input.owner);

  return yield* drive({
    runId: input.runId,
    deps: {
      executor: input.executor,
      ids: idSourceFor(input.runId as string, loaded.value.record.visits.length),
      workspacePath: workspace.value.path,
      logDir: path.join(yield* runDirFor(input.runId as string), "logs"),
      owner: input.owner,
      leaseSeconds: 300,
    },
    lease,
    initial: input.inputs,
  });
});

export interface RunSummary {
  readonly runId: string;
  readonly state: string;
  readonly stage: string | null;
  readonly attention: string | null;
  readonly playbook: string;
  readonly updatedAt: string;
}

/** One line per run: what it is doing and, when it is stuck, why. */
export const summarizeRuns = Effect.fnUntraced(function* (state?: string) {
  const store = yield* RunStore;
  const runs = yield* store.listRuns(state === undefined ? undefined : { state });

  return runs.map((run): RunSummary => ({
    runId: run.record.runId as string,
    state: run.record.state,
    stage: run.record.currentStageId as string | null,
    attention:
      run.record.decision === null
        ? run.record.failure
        : `${run.record.decision.kind}: ${run.record.decision.detail}`,
    playbook: `${run.plan.playbookId}@${run.plan.playbookVersion}`,
    updatedAt: run.record.updatedAt,
  }));
});

export interface RunDetail extends RunSummary {
  readonly workspacePath: string | null;
  readonly visits: readonly {
    readonly stageId: string;
    readonly state: string;
    readonly attempts: number;
    readonly lostContext: boolean;
  }[];
  readonly limitations: readonly { readonly stageId: string; readonly detail: string }[];
}

export const describeRun = Effect.fnUntraced(function* (runId: RunId) {
  const store = yield* RunStore;
  const loaded = yield* store.loadRun(runId);
  if (Option.isNone(loaded)) return Option.none<RunDetail>();

  const workspace = yield* store.findWorkspace(runId);
  const limitations = yield* store.limitationsFor(runId);
  const record = loaded.value.record;

  return Option.some({
    runId: record.runId as string,
    state: record.state,
    stage: record.currentStageId as string | null,
    attention:
      record.decision === null
        ? record.failure
        : `${record.decision.kind}: ${record.decision.detail}`,
    playbook: `${loaded.value.plan.playbookId}@${loaded.value.plan.playbookVersion}`,
    updatedAt: record.updatedAt,
    workspacePath: Option.isSome(workspace) ? workspace.value.path : null,
    visits: record.visits.map((visit) => ({
      stageId: visit.stageId as string,
      state: visit.state,
      attempts: visit.attempts,
      lostContext: visit.lostContext,
    })),
    limitations: limitations.map((limitation) => ({
      stageId: limitation.stageId as string,
      detail: limitation.detail,
    })),
  } satisfies RunDetail);
});
