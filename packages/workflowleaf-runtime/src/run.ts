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
  currentVisit,
  initialRun,
  type ControllerInput,
  type DecisionPort,
  type DecisionRequest,
  type ExecutorPort,
  type IdSource,
  type RunId,
  type RunPlan,
  type RunRecord,
  type StageHandle,
} from "@t3tools/workflowleaf-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AssistedExecutor } from "./adapters/assisted.ts";
import { connect } from "./adapters/t3/connection.ts";
import { T3DecisionThread } from "./adapters/t3/decisions.ts";
import { T3Executor } from "./adapters/t3/executor.ts";
import { digestOf } from "./digest.ts";
import { revParse } from "./git.ts";
import { loadPlaybook } from "./load.ts";
import { executorToken, workflowleafHome, type Profile } from "./profile.ts";
import { openDraftPullRequest } from "./pullRequest.ts";
import { RunStore, type Lease } from "./store/RunStore.ts";
import {
  cancel,
  DEFAULT_QUIET,
  drive,
  type DriveResult,
  ExecutorFailed,
  type ProgressSink,
  type WorkerDeps,
} from "./worker.ts";
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

/**
 * Where a profile's runs ask for decisions. A T3 profile asks on a thread of
 * its own; one with no provider behind it has nowhere to ask but the terminal.
 */
export const decisionPortFor = Effect.fnUntraced(function* (profile: Profile) {
  if (profile.executor.kind === "fake") return null;
  const token = yield* executorToken(profile.executor);
  const client = yield* connect(profile.executor.origin, token);
  return new T3DecisionThread({
    client,
    runEffect: (effect) => Effect.runPromise(effect),
    projectId: profile.executor.projectId,
    instanceId: profile.executor.provider,
    model: profile.executor.model ?? "default",
    now: () => DateTime.formatIso(DateTime.nowUnsafe()),
  }) as DecisionPort;
});

/** The question a run is waiting on, as a decision port needs it. Null when it waits on none. */
const decisionRequestFor = Effect.fnUntraced(function* (runId: RunId) {
  const store = yield* RunStore;
  const loaded = yield* store.loadRun(runId);
  if (Option.isNone(loaded)) return null;
  const record = loaded.value.record;
  const workspace = yield* store.findWorkspace(runId);
  if (record.decision === null || Option.isNone(workspace)) return null;
  return {
    runId,
    decision: record.decision,
    workspacePath: workspace.value.path,
    branch: workspace.value.branch,
    pullRequestUrl: record.pullRequest?.url ?? null,
  } satisfies DecisionRequest;
});

/**
 * Asks for the decision a run stopped on, once. A failure to ask is reported
 * and swallowed: the decision is on the record either way, and `wl decide`
 * still answers it.
 */
export const askForDecision = Effect.fnUntraced(function* (
  runId: RunId,
  port: DecisionPort | null,
) {
  if (port === null) return false;
  const store = yield* RunStore;
  const request = yield* decisionRequestFor(runId);
  if (request === null) return false;
  const row = yield* store.findDecision(request.decision.decisionId);
  if (Option.isSome(row) && row.value.askedAt !== null) return true;
  const asked = yield* Effect.tryPromise(() => port.ask(request)).pipe(
    Effect.as(true),
    Effect.catchCause(() => Effect.succeed(false)),
  );
  if (asked) yield* store.markDecisionAsked(request.decision.decisionId);
  return asked;
});

/**
 * The answer given on the decision's thread, as the input that applies it, or
 * nothing. With `wait`, blocks until someone answers there.
 */
export const answeredOnThread = Effect.fnUntraced(function* (
  runId: RunId,
  port: DecisionPort | null,
  wait: boolean,
) {
  if (port === null) return [] as ControllerInput[];
  const store = yield* RunStore;
  const request = yield* decisionRequestFor(runId);
  if (request === null) return [] as ControllerInput[];
  const row = yield* store.findDecision(request.decision.decisionId);
  if (Option.isNone(row) || row.value.askedAt === null) return [] as ControllerInput[];

  const answer = yield* Effect.tryPromise(() => port.answer(request, wait)).pipe(
    Effect.catchCause(() => Effect.succeed(null)),
  );
  if (answer === null) return [] as ControllerInput[];
  yield* store.markDecisionAnswered(request.decision.decisionId, answer, "thread");
  return [
    {
      type: "decision-answered",
      decisionId: request.decision.decisionId,
      answer,
      planDigest: request.decision.planDigest,
    },
  ] as ControllerInput[];
});

/**
 * Records an answer given from the terminal and takes the thread's question
 * down, so it does not keep asking for something already decided.
 */
export const answeredFromCli = Effect.fnUntraced(function* (
  runId: RunId,
  answer: string,
  port: DecisionPort | null,
) {
  const store = yield* RunStore;
  const request = yield* decisionRequestFor(runId);
  if (request === null) return;
  const row = yield* store.findDecision(request.decision.decisionId);
  yield* store.markDecisionAnswered(request.decision.decisionId, answer, "cli");
  if (port !== null && Option.isSome(row) && row.value.askedAt !== null) {
    yield* Effect.tryPromise(() => port.withdraw(request)).pipe(Effect.ignore);
  }
});

/**
 * The executor and the context of the stage a run is in, for reaching the
 * provider while the stage is still running. Null when no stage is in flight.
 */
export const stageInFlight = Effect.fnUntraced(function* (runId: RunId, profile: Profile) {
  const store = yield* RunStore;
  const loaded = yield* store.loadRun(runId);
  if (Option.isNone(loaded)) return yield* new RunError({ message: `No run ${runId}.` });
  const workspace = yield* store.findWorkspace(runId);
  const visit = currentVisit(loaded.value.record);
  const operation = visit?.operation ?? null;
  if (Option.isNone(workspace) || operation === null) return null;
  // The run record learns the handle only once the stage settles. The
  // operation row has it from the moment the executor acknowledged the
  // dispatch, which is when a provider can start asking.
  const row = yield* store.findOperation(operation.operationId);
  const handle = Option.isSome(row) ? row.value.handle : operation.handle;
  if (handle === null) return null;
  const executor = yield* executorFor(profile, {
    workspacePath: workspace.value.path,
    branch: workspace.value.branch,
  });
  return {
    executor,
    stageId: visit!.stageId as string,
    handle: { operationId: operation.operationId, handle } satisfies StageHandle,
  };
});

/** Appended as the run moves, under the run's directory. Readable while another process drives it. */
export const PROGRESS_LOG = "progress.log";

export const runDirFor = Effect.fnUntraced(function* (runId: string) {
  const path = yield* Path.Path;
  return path.join(yield* workflowleafHome(), "runs", runId);
});

/**
 * Notes in the run's progress log that its start has begun.
 *
 * `startRun` opens the worktree and the pull request before the run record
 * exists, and that can take several seconds. Without this line, `status`
 * reports that there is no such run while its pull request is already open.
 */
const markStarting = Effect.fnUntraced(
  function* (runId: string, at: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runDir = yield* runDirFor(runId);
    yield* fs.makeDirectory(runDir, { recursive: true });
    yield* fs.writeFileString(path.join(runDir, PROGRESS_LOG), `${at} run starting\n`, {
      flag: "a",
    });
  },
  Effect.catchCause(() => Effect.void),
);

/**
 * For a run with no record, the last progress line its start wrote, if a
 * start has begun. A start that failed leaves the line too, so the caller
 * shows when it was written rather than claiming the run is on its way.
 */
export const startingRun = Effect.fnUntraced(
  function* (runId: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(yield* runDirFor(runId), PROGRESS_LOG);
    if (!(yield* fs.exists(file))) return Option.none<string>();
    const lines = (yield* fs.readFileString(file)).split("\n").filter((line) => line.length > 0);
    return Option.fromUndefinedOr(lines.at(-1));
  },
  Effect.catchCause(() => Effect.succeed(Option.none<string>())),
);

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

  yield* markStarting(input.runId as string, compiledAt);
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
        quiet: DEFAULT_QUIET,
      },
      lease,
      initial: [{ type: "start" }],
    }),
  );

  if (result.stopped === "needs-decision") {
    yield* askForDecision(input.runId, yield* decisionPortFor(input.profile));
  }

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
  /** When the run is waiting on a decision asked on a thread, wait for its answer there. */
  readonly waitForAnswer?: boolean | undefined;
}

/**
 * Picks a run back up: reattaches to its worktree, reconciles, then drives.
 *
 * A run stopped on a decision that was asked on a thread takes the answer
 * given there, so answering the question is what resumes it.
 */
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
  const answered =
    loaded.value.record.state === "needs_decision" &&
    !input.inputs.some((one) => one.type === "decision-answered")
      ? yield* answeredOnThread(
          input.runId,
          yield* decisionPortFor(input.profile),
          input.waitForAnswer ?? false,
        )
      : [];
  const seed = yield* store.transitionCount(input.runId);
  const result = yield* holdingLease(input.runId, input.owner, (lease) =>
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
        quiet: DEFAULT_QUIET,
      },
      lease,
      initial: answered.length > 0 ? answered : input.inputs,
    }),
  );

  if (result.stopped === "needs-decision") {
    yield* askForDecision(input.runId, yield* decisionPortFor(input.profile));
  }
  return result;
});

/**
 * Cancels a run. The executor is reached only to stop a stage still in
 * flight, and a run whose executor is gone still cancels.
 */
export const cancelRun = Effect.fnUntraced(function* (input: {
  readonly runId: RunId;
  readonly profile: Profile;
  readonly owner: string;
  readonly reason: string;
  readonly progress?: ProgressSink | undefined;
}) {
  const store = yield* RunStore;
  const path = yield* Path.Path;
  const workspace = yield* store.findWorkspace(input.runId);
  const runDir = yield* runDirFor(input.runId as string);
  const seed = yield* store.transitionCount(input.runId);

  const interrupt = (handle: StageHandle) =>
    Option.isNone(workspace)
      ? Effect.void
      : Effect.scoped(
          Effect.gen(function* () {
            const executor = yield* executorFor(input.profile, {
              workspacePath: workspace.value.path,
              branch: workspace.value.branch,
            });
            yield* Effect.tryPromise(() => executor.interrupt(handle));
          }),
        ).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            (cause) => new ExecutorFailed({ operation: "interrupt", detail: cause.message }),
          ),
        );

  return yield* holdingLease(input.runId, input.owner, (lease) =>
    cancel({
      runId: input.runId,
      reason: input.reason,
      lease,
      ids: idSourceFor(input.runId as string, seed),
      interrupt,
      progress: input.progress,
      progressLog: path.join(runDir, PROGRESS_LOG),
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
  /**
   * A run in `running` that no worker holds a lease on. Nothing will move it
   * until someone resumes or cancels it, so it should not look like live work.
   */
  readonly stale: boolean;
  readonly stage: string | null;
  readonly attention: string | null;
  /** Null only for a run started under a profile that may not open one. */
  readonly pullRequest: PullRequestSummary | null;
  readonly playbook: string;
  readonly updatedAt: string;
}

function summaryOf(
  run: {
    readonly record: RunRecord;
    readonly plan: RunPlan;
    readonly story: string;
  },
  leased: ReadonlySet<string>,
): RunSummary {
  const stale = run.record.state === "running" && !leased.has(run.record.runId as string);
  return {
    runId: run.record.runId as string,
    story: run.story,
    state: run.record.state,
    revision: run.record.revision,
    stale,
    stage: run.record.currentStageId as string | null,
    attention: stale
      ? `no worker has held this run since ${run.record.updatedAt}; resume or cancel it`
      : run.record.decision === null
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
  const leased = yield* store.leasedRuns();

  return runs.map((run) => summaryOf(run, leased));
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
    ...summaryOf(loaded.value, yield* store.leasedRuns()),
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
