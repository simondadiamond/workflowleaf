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
 *
 * And a run is one story delivered as one pull request. The id says which
 * story and which attempt at it, the pull request is opened before any stage
 * runs, and both are on the record from the first write.
 */
import {
  initialRun,
  type ControllerInput,
  type ExecutorPort,
  type IdSource,
  type RunId,
  type RunPlan,
  type RunRecord,
} from "@t3tools/workflowleaf-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AssistedExecutor } from "./adapters/assisted.ts";
import { connect } from "./adapters/t3/connection.ts";
import { T3Executor } from "./adapters/t3/executor.ts";
import { digestOf } from "./digest.ts";
import { revParse } from "./git.ts";
import { loadPlaybook } from "./load.ts";
import { executorToken, workflowleafHome, type Profile } from "./profile.ts";
import { openDraftPullRequest } from "./pullRequest.ts";
import { RunStore, type Lease } from "./store/RunStore.ts";
import { drive, type DriveResult, type ProgressSink, type WorkerDeps } from "./worker.ts";
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

/**
 * The id of the next run of a story.
 *
 * A story that turns out to need two pull requests gets two runs, so the story
 * alone cannot be the id. The ordinal is what separates them, and it keeps the
 * two sorted next to each other wherever runs are listed.
 */
export const nextRunId = Effect.fnUntraced(function* (story: string) {
  const store = yield* RunStore;
  const existing = yield* store.countRunsForStory(story);
  return `${story}-${String(existing + 1)}` as RunId;
});

/** Where a run executes: the worktree it owns and how to recall past dispatches. */
export interface ExecutorBinding {
  readonly workspacePath: string;
  readonly branch: string;
}

/**
 * The executor a profile asks for, bound to this run's worktree.
 *
 * The T3 connection is scoped to the caller, so a run that ends closes its
 * socket. Assisted mode needs no binding and is the honest fallback when no
 * provider is reachable.
 */
export const executorFor = Effect.fnUntraced(function* (
  profile: Profile,
  binding: ExecutorBinding | null,
) {
  if (profile.executor.kind === "fake") return new AssistedExecutor() as ExecutorPort;

  if (binding === null) {
    return yield* new RunError({
      message: "A T3 executor needs the run's worktree, which is only known once the run exists.",
    });
  }

  const store = yield* RunStore;
  const token = yield* executorToken(profile.executor);
  const client = yield* connect(profile.executor.origin, token);

  return new T3Executor({
    client,
    runEffect: (effect) => Effect.runPromise(effect),
    projectId: profile.executor.projectId,
    instanceId: profile.executor.provider,
    model: profile.executor.model ?? "default",
    runtimeMode: profile.executor.runtimeMode,
    worktreePath: binding.workspacePath,
    branch: binding.branch,
    // Recovery reads the handle from the store rather than from memory, so a
    // worker that has just started can still ask what its predecessor did.
    handleFor: (operationId) =>
      Effect.runPromise(
        store.findOperation(operationId).pipe(
          Effect.map((found) => (Option.isSome(found) ? found.value.handle : null)),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
      ),
    now: () => DateTime.formatIso(DateTime.nowUnsafe()),
  }) as ExecutorPort;
});

/** Appended as the run moves, under the run's directory. Readable while another process drives it. */
export const PROGRESS_LOG = "progress.log";

export const runDirFor = Effect.fnUntraced(function* (runId: string) {
  const path = yield* Path.Path;
  return path.join(yield* workflowleafHome(), "runs", runId);
});

export interface StartRunInput {
  readonly runId: RunId;
  /** The story this run delivers. Several runs of one story share it. */
  readonly story: string;
  readonly profile: Profile;
  readonly playbookDir: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly baseRef: string;
  readonly owner: string;
  /** Optional: told what the run is doing while it does it. */
  readonly progress?: ProgressSink | undefined;
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

  // The worktree comes first: an executor is bound to the directory its stages
  // will run in, and the run record should name a workspace that exists.
  const workspace = yield* ensureWorkspace({
    runId: input.runId,
    repoRoot: input.profile.repoRoot,
    worktreeRoot: input.profile.worktreeRoot,
    baseRevision,
  });

  // Before any stage runs: the run's pull request is what the work is scoped
  // to, so it exists from the start rather than appearing at the end.
  const pullRequest = yield* openPullRequestFor({
    profile: input.profile,
    story: input.story,
    runId: input.runId,
    outcome: loaded.value.plan.outcome,
    workspacePath: workspace.path,
    branch: workspace.branch,
    openedAt: compiledAt,
  });

  const executor = yield* executorFor(input.profile, {
    workspacePath: workspace.path,
    branch: workspace.branch,
  });
  const capabilities = yield* Effect.promise(() => executor.capabilities());

  yield* store.createRun({
    record: initialRun({
      runId: input.runId,
      planDigest: loaded.value.plan.planDigest,
      workspaceId: workspace.workspaceId,
      pullRequest,
      capabilities,
      maxRepairCycles: input.profile.budgets.maxRepairCycles,
      deadlineAt: null,
      now: compiledAt,
    }),
    plan: loaded.value.plan,
    story: input.story,
    profileName: input.profile.name,
    origin: { trigger: "manual", by: input.owner },
    repoRoot: input.profile.repoRoot,
    baseRevision,
  });

  const runDir = yield* runDirFor(input.runId as string);
  const result = yield* holdingLease(input.runId, input.owner, (lease) =>
    drive({
      runId: input.runId,
      deps: {
        executor,
        ids: idSourceFor(input.runId as string, 0),
        workspacePath: workspace.path,
        logDir: path.join(runDir, "logs"),
        owner: input.owner,
        leaseSeconds: 300,
        progress: input.progress,
        progressLog: path.join(runDir, PROGRESS_LOG),
        baseRevision,
        reviewer: input.profile.reviewer,
        ghConfigDir: input.profile.ghConfigDir,
      },
      lease,
      initial: [{ type: "start" }],
    }),
  );

  return { plan: loaded.value.plan, result } satisfies StartedRun;
});

/**
 * Opens the run's draft pull request, when the profile permits one.
 *
 * A profile without `createPullRequest` gets a run with no pull request rather
 * than a run that quietly opens one anyway; that is what the permission is.
 */
const openPullRequestFor = Effect.fnUntraced(function* (input: {
  readonly profile: Profile;
  readonly story: string;
  readonly runId: RunId;
  readonly outcome: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly openedAt: string;
}) {
  const config = input.profile.pullRequest;
  if (!input.profile.permissions.createPullRequest || config === undefined) return null;

  return yield* openDraftPullRequest({
    workspacePath: input.workspacePath,
    headBranch: input.branch,
    baseBranch: config.baseBranch,
    remote: config.remote,
    title: `${input.story}: ${input.outcome}`,
    body: [
      `WorkflowLeaf run \`${input.runId}\` for story \`${input.story}\`.`,
      "",
      "Draft until the run's stages and gates have passed. The run fills this in.",
    ].join("\n"),
    openedAt: input.openedAt,
    ghConfigDir: input.profile.ghConfigDir,
  });
});

/** How long a lease lasts without renewal. The holder renews it well inside this. */
const LEASE_SECONDS = 300;

const takeLease = Effect.fnUntraced(function* (runId: RunId, owner: string) {
  const store = yield* RunStore;
  const lease = yield* store.acquireLease(runId, owner, LEASE_SECONDS);
  if (Option.isNone(lease)) {
    return yield* new RunError({
      message: `Run ${runId} is held by another worker. Wait for it, or stop that worker.`,
    });
  }
  return lease.value as Lease;
});

/**
 * Drives a run while holding its lease, and gives the lease back afterwards.
 *
 * A stage can run for twenty minutes, longer than the lease lasts, so a
 * heartbeat renews it while the drive is in progress. Otherwise a second worker
 * could take over a run that is still being driven. The lease is released
 * however the drive ends. Otherwise the next `resume` would be refused until
 * the lease ran out, even though its holder had already exited.
 */
export const holdingLease = <A, E, R>(
  runId: RunId,
  owner: string,
  use: (lease: Lease) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const lease = yield* takeLease(runId, owner);
    const heartbeat = yield* Effect.forkChild(
      store
        .renewLease(lease, LEASE_SECONDS)
        .pipe(Effect.ignore, Effect.delay("60 seconds"), Effect.forever),
    );
    return yield* use(lease).pipe(
      Effect.ensuring(
        Fiber.interrupt(heartbeat).pipe(Effect.andThen(store.releaseLease(lease)), Effect.ignore),
      ),
    );
  });

export interface ResumeRunInput {
  readonly runId: RunId;
  readonly profile: Profile;
  readonly owner: string;
  readonly inputs: readonly ControllerInput[];
  readonly progress?: ProgressSink | undefined;
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

  const executor = yield* executorFor(input.profile, {
    workspacePath: workspace.value.path,
    branch: workspace.value.branch,
  });
  const runDir = yield* runDirFor(input.runId as string);
  const seed = yield* store.transitionCount(input.runId);
  return yield* holdingLease(input.runId, input.owner, (lease) =>
    drive({
      runId: input.runId,
      deps: {
        executor,
        // Seeded past every id the run has used, so a resumed run cannot mint
        // one that collides with its own history.
        ids: idSourceFor(input.runId as string, seed),
        workspacePath: workspace.value.path,
        logDir: path.join(runDir, "logs"),
        owner: input.owner,
        leaseSeconds: 300,
        progress: input.progress,
        progressLog: path.join(runDir, PROGRESS_LOG),
        baseRevision: loaded.value.baseRevision,
        reviewer: input.profile.reviewer,
        ghConfigDir: input.profile.ghConfigDir,
      },
      lease,
      initial: input.inputs,
    }),
  );
});

export interface PullRequestSummary {
  readonly number: number;
  readonly url: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly story: string;
  readonly state: string;
  /**
   * What the mutating commands want in `--revision`. Without it here, the only
   * way to use that flag would be to guess at the number it is there to check.
   */
  readonly revision: number;
  readonly stage: string | null;
  readonly attention: string | null;
  /** Null only for a run started under a profile that may not open one. */
  readonly pullRequest: PullRequestSummary | null;
  readonly playbook: string;
  readonly updatedAt: string;
}

function summaryOf(run: {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly story: string;
}): RunSummary {
  return {
    runId: run.record.runId as string,
    story: run.story,
    state: run.record.state,
    revision: run.record.revision,
    stage: run.record.currentStageId as string | null,
    attention:
      run.record.decision === null
        ? run.record.failure
        : `${run.record.decision.kind}: ${run.record.decision.detail}`,
    pullRequest:
      run.record.pullRequest === null
        ? null
        : { number: run.record.pullRequest.number, url: run.record.pullRequest.url },
    playbook: `${run.plan.playbookId}@${run.plan.playbookVersion}`,
    updatedAt: run.record.updatedAt,
  };
}

/** One line per run: what it is doing and, when it is stuck, why. */
export const summarizeRuns = Effect.fnUntraced(function* (state?: string) {
  const store = yield* RunStore;
  const runs = yield* store.listRuns(state === undefined ? undefined : { state });

  return runs.map(summaryOf);
});

export interface RunDetail extends RunSummary {
  readonly workspacePath: string | null;
  /** Set once a stage declared the story had outgrown this run's pull request. */
  readonly scopeSplit: {
    readonly detail: string;
    readonly declaredAt: string;
    readonly acknowledgedAt: string | null;
  } | null;
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
    ...summaryOf(loaded.value),
    workspacePath: Option.isSome(workspace) ? workspace.value.path : null,
    scopeSplit:
      record.scopeSplit === null
        ? null
        : {
            detail: record.scopeSplit.detail,
            declaredAt: record.scopeSplit.declaredAt,
            acknowledgedAt: record.scopeSplit.acknowledgedAt,
          },
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
