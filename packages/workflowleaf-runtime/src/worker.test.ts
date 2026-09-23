// @effect-diagnostics nodeBuiltinImport:off
// The stand-in executor writes to the worktree the way a provider would, which
// has to happen synchronously inside a Promise-returning port.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  decide,
  initialRun,
  type AnswerOutcome,
  type ContinueOutcome,
  type ExecutorCapabilities,
  type ExecutorPort,
  type InspectOutcome,
  type OperationId,
  type ProviderRequest,
  type RunId,
  type RunPlan,
  type StageHandle,
  type StageRequest,
  type StageSettlement,
  type WorkspaceId,
} from "@t3tools/workflowleaf-core";
import {
  capabilities,
  commandGatePlan,
  LAZY_SKILL,
  lazySkillPlan,
  sequentialIds,
  twoStagePlan,
} from "@t3tools/workflowleaf-core/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { git } from "./git.ts";
import { readLearningLog } from "./learningLog.ts";
import { PullRequestError } from "./pullRequest.ts";
import { replayRun } from "./replay.ts";
import { idSourceFor } from "./run.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerMemory } from "./store/Sqlite.ts";
import { cancel, drive, ExecutorFailed, SCOPE_SPLIT_PATH, type RunProgress } from "./worker.ts";
import { ensureWorkspace } from "./workspaces.ts";

const plan: RunPlan = twoStagePlan();
const commandPlan: RunPlan = commandGatePlan();

const testLayer = RunStore.layer.pipe(
  Layer.provide(layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

type Action = (workspacePath: string) => void;

const write =
  (relativePath: string, content: string): Action =>
  (workspacePath) => {
    NodeFS.writeFileSync(NodePath.join(workspacePath, relativePath), content);
  };

/** Writes into a directory the stage may not have created yet. */
const writeUnder =
  (relativePath: string, content: string): Action =>
  (workspacePath) => {
    const target = NodePath.join(workspacePath, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  };

const doNothing: Action = () => {};

/**
 * An executor that writes into the worktree, so the gates in these tests check
 * real files rather than a story about them. Each stage gets a list of actions,
 * one per time it is asked to run; the last entry repeats.
 */
class WritingExecutor implements ExecutorPort {
  readonly starts: string[] = [];
  readonly continues: { stageId: string; correction: string }[] = [];
  readonly prompts: string[] = [];

  #actions: Readonly<Record<string, readonly Action[]>>;
  #capabilities: ExecutorCapabilities;
  #calls = new Map<string, number>();
  #outcomes: Readonly<Record<string, StageSettlement["outcome"]>>;
  #continuation: ContinueOutcome["kind"];
  #settled: boolean;
  #inspectAs: InspectOutcome["kind"];
  #stageByHandle = new Map<string, string>();
  #workspacePath: string;

  constructor(options: {
    readonly workspacePath: string;
    readonly actions: Readonly<Record<string, readonly Action[]>>;
    readonly capabilities?: Partial<ExecutorCapabilities>;
    readonly outcomes?: Readonly<Record<string, StageSettlement["outcome"]>>;
    readonly continuation?: ContinueOutcome["kind"];
    readonly settled?: boolean;
    readonly inspectAs?: InspectOutcome["kind"];
  }) {
    this.#workspacePath = options.workspacePath;
    this.#actions = options.actions;
    this.#capabilities = capabilities(options.capabilities ?? {});
    this.#outcomes = options.outcomes ?? {};
    this.#continuation = options.continuation ?? "continued";
    this.#settled = options.settled ?? true;
    this.#inspectAs = options.inspectAs ?? "settled";
  }

  capabilities(): Promise<ExecutorCapabilities> {
    return Promise.resolve(this.#capabilities);
  }

  #perform(stageId: string): void {
    const actions = this.#actions[stageId] ?? [doNothing];
    const index = this.#calls.get(stageId) ?? 0;
    this.#calls.set(stageId, index + 1);
    (actions[Math.min(index, actions.length - 1)] ?? doNothing)(this.#workspacePath);
  }

  startStage(request: StageRequest): Promise<StageHandle> {
    const stageId = request.stage.contract.id as string;
    this.starts.push(stageId);
    this.prompts.push(request.input);
    this.#perform(stageId);
    const handle = `session-${stageId}-${request.operationId}`;
    this.#stageByHandle.set(handle, stageId);
    return Promise.resolve({ operationId: request.operationId, handle });
  }

  continueStage(handle: StageHandle, correction: string): Promise<ContinueOutcome> {
    if (this.#continuation !== "continued") {
      return Promise.resolve({ kind: this.#continuation, reason: "scripted" } as ContinueOutcome);
    }
    const stageId = this.#stageByHandle.get(handle.handle) ?? "unknown";
    this.continues.push({ stageId, correction });
    this.#perform(stageId);
    return Promise.resolve({ kind: "continued", handle });
  }

  inspect(operationId: OperationId): Promise<InspectOutcome> {
    if (this.#inspectAs === "unknown") {
      return Promise.resolve({ kind: "unknown", reason: "no recovery support" });
    }
    if (this.#inspectAs === "never-dispatched") {
      return Promise.resolve({ kind: "never-dispatched" });
    }
    return Promise.resolve({
      kind: "settled",
      settlement: {
        operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:00.000Z",
      },
    });
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  awaitSettlement(handle: StageHandle): Promise<StageSettlement> {
    const stageId = this.#stageByHandle.get(handle.handle) ?? "unknown";
    return Promise.resolve({
      operationId: handle.operationId,
      outcome: this.#outcomes[stageId] ?? "completed",
      settled: this.#settled,
      detail: null,
      at: "2026-01-01T00:00:00.000Z",
    });
  }

  pendingRequests(): Promise<readonly ProviderRequest[]> {
    return Promise.resolve([]);
  }

  answerRequest(): Promise<AnswerOutcome> {
    return Promise.resolve({
      kind: "not-pending",
      reason: "This executor has no provider to ask.",
    });
  }
}

/** An executor whose server is gone. It records what it was asked, then refuses. */
class FailingExecutor implements ExecutorPort {
  readonly calls: string[] = [];

  #refuse(call: string): Promise<never> {
    this.calls.push(call);
    return Promise.reject(new Error("socket ticket refused"));
  }

  capabilities(): Promise<ExecutorCapabilities> {
    return this.#refuse("capabilities");
  }
  startStage(request: StageRequest): Promise<StageHandle> {
    return this.#refuse(`startStage ${request.stage.contract.id as string}`);
  }
  continueStage(handle: StageHandle): Promise<ContinueOutcome> {
    return this.#refuse(`continueStage ${handle.handle}`);
  }
  inspect(operationId: OperationId): Promise<InspectOutcome> {
    return this.#refuse(`inspect ${operationId as string}`);
  }
  interrupt(handle: StageHandle): Promise<void> {
    return this.#refuse(`interrupt ${handle.handle}`);
  }
  awaitSettlement(handle: StageHandle): Promise<StageSettlement> {
    return this.#refuse(`awaitSettlement ${handle.handle}`);
  }
  pendingRequests(): Promise<readonly ProviderRequest[]> {
    return this.#refuse("pendingRequests");
  }
  answerRequest(): Promise<AnswerOutcome> {
    return this.#refuse("answerRequest");
  }
}

const setUpRun = Effect.fnUntraced(function* (
  runId: string,
  runCapabilities: ExecutorCapabilities = capabilities(),
  runPlan: RunPlan = plan,
  pullRequestNumber: number | null = null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* RunStore;

  const root = yield* fs.makeTempDirectoryScoped();
  const repo = path.join(root, "repo");
  yield* fs.makeDirectory(repo, { recursive: true });
  yield* git(repo, ["init", "-q", "-b", "main"]);
  yield* git(repo, ["config", "user.email", "fixture@example.com"]);
  yield* git(repo, ["config", "user.name", "Fixture"]);
  yield* fs.writeFileString(path.join(repo, "README.md"), "# fixture\n");
  yield* git(repo, ["add", "."]);
  yield* git(repo, ["commit", "-qm", "initial"]);
  const head = (yield* git(repo, ["rev-parse", "HEAD"])).trim();

  yield* store.createRun({
    record: initialRun({
      runId: runId as RunId,
      planDigest: runPlan.planDigest,
      workspaceId: "pending" as WorkspaceId,
      capabilities: runCapabilities,
      maxRepairCycles: 2,
      deadlineAt: null,
      now: "2026-01-01T00:00:00.000Z",
      pullRequest:
        pullRequestNumber === null
          ? null
          : {
              number: pullRequestNumber,
              url: `https://example.test/pull/${String(pullRequestNumber)}`,
              headBranch: `workflowleaf/${runId}`,
              baseBranch: "main",
              openedAt: "2026-01-01T00:00:00.000Z",
            },
    }),
    plan: runPlan,
    story: "story",
    profileName: "test",
    origin: { trigger: "manual", by: "test" },
    repoRoot: repo,
    baseRevision: head,
  });

  const workspace = yield* ensureWorkspace({
    runId: runId as RunId,
    repoRoot: repo,
    worktreeRoot: path.join(root, "worktrees"),
    baseRevision: head,
    branchPrefix: "workflowleaf",
  });

  const lease = yield* store.acquireLease(runId as RunId, "worker-a", 60);
  if (Option.isNone(lease)) return yield* Effect.die("could not take the lease");

  return { repo, head, workspace, lease: lease.value, logDir: path.join(root, "logs") };
});

const ARTIFACT = "a paragraph that is comfortably longer than eight bytes\n";

/** The two-stage plan, with its first stage delivering the pull request. */
const deliverPlan: RunPlan = {
  ...plan,
  stages: plan.stages.map((stage) =>
    stage.contract.id === "produce"
      ? {
          ...stage,
          contract: { ...stage.contract, produces: [...stage.contract.produces, "pull-request"] },
        }
      : stage,
  ),
};
const SUMMARY = "one sentence.\n";

it.layer(testLayer, { excludeTestServices: true })("worker", (it) => {
  it.effect("corrects inside the first stage and only then opens the second", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-happy");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          // The first attempt produces nothing, so the file gate fails.
          produce: [doNothing, write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      const result = yield* drive({
        runId: "run-happy" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.strictEqual(result.record.state, "succeeded");
      assert.deepStrictEqual(executor.starts, ["produce", "summarize"]);
      assert.lengthOf(executor.continues, 1);
      assert.strictEqual(executor.continues[0]?.stageId, "produce");
      assert.include(executor.continues[0]?.correction ?? "", "artifact-has-content");
    }).pipe(Effect.scoped),
  );

  it.effect("appends progress to a file anyone can read while the run is driven", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workspace, lease, logDir } = yield* setUpRun("run-progress-log");
      const progressLog = path.join(logDir, "..", "progress.log");
      let seenMidRun = "";

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [doNothing, write("artifact.md", ARTIFACT)],
          summarize: [
            (workspacePath) => {
              // Read from "outside" while the second stage is still running.
              seenMidRun = NodeFS.readFileSync(progressLog, "utf8");
              write("summary.md", SUMMARY)(workspacePath);
            },
          ],
        },
      });

      yield* drive({
        runId: "run-progress-log" as RunId,
        deps: {
          executor,
          ids: sequentialIds("p"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
          progressLog,
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.include(seenMidRun, "summarize started attempt=1");
      assert.include(seenMidRun, "produce gates artifact-has-content=failed");
      const finished = yield* fs.readFileString(progressLog);
      assert.include(finished, "summarize passed");
    }).pipe(Effect.scoped),
  );

  it.effect("stops and asks when a stage says the story outgrew one pull request", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-scope-split");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [
            (workspacePath) => {
              write("artifact.md", ARTIFACT)(workspacePath);
              writeUnder(
                SCOPE_SPLIT_PATH,
                "The retry fix needs its own pull request.\n",
              )(workspacePath);
            },
          ],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      const result = yield* drive({
        runId: "run-scope-split" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.strictEqual(result.stopped, "needs-decision");
      assert.strictEqual(result.record.decision?.kind, "scope-split");
      assert.include(result.record.scopeSplit?.detail ?? "", "retry fix");
      // The stage that declared it still finished and had its gate checked.
      assert.strictEqual(result.record.visits[0]?.state, "passed");
      // The next stage never launched.
      assert.deepStrictEqual(executor.starts, ["produce"]);
    }).pipe(Effect.scoped),
  );

  it.effect("carries on to the next stage once the split is answered", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-scope-split-answered");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [
            (workspacePath) => {
              write("artifact.md", ARTIFACT)(workspacePath);
              writeUnder(SCOPE_SPLIT_PATH, "and the migration too\n")(workspacePath);
            },
          ],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      const deps = {
        executor,
        ids: sequentialIds("w"),
        workspacePath: workspace.path,
        logDir,
        owner: "worker-a",
        leaseSeconds: 60,
      };

      const stopped = yield* drive({
        runId: "run-scope-split-answered" as RunId,
        deps,
        lease,
        initial: [{ type: "start" }],
      });

      const result = yield* drive({
        runId: "run-scope-split-answered" as RunId,
        deps,
        lease,
        initial: [
          {
            type: "decision-answered",
            decisionId: stopped.record.decision!.decisionId,
            answer: "proceed",
            planDigest: stopped.record.planDigest,
          },
        ],
      });

      assert.strictEqual(result.record.state, "succeeded");
      assert.deepStrictEqual(executor.starts, ["produce", "summarize"]);
      // The declaration is still on disk, and re-reading it does not re-ask.
      assert.strictEqual(result.record.decision, null);
      assert.isNotNull(result.record.scopeSplit?.acknowledgedAt ?? null);
    }).pipe(Effect.scoped),
  );

  it.effect("tells the corrected stage what the gate wanted, not just that it failed", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-correction-detail");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          // Short enough to fail the gate's minimum, long enough that a count
          // of missing fragments would say nothing at all.
          produce: [write("artifact.md", "tiny\n"), write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      yield* drive({
        runId: "run-correction-detail" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      const correction = executor.continues[0]?.correction ?? "";
      assert.include(correction, "5 bytes");
      assert.include(correction, "shorter than the required 8");
    }).pipe(Effect.scoped),
  );

  it.effect("carries a failing command gate's output into the correction", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun(
        "run-command-gate",
        capabilities(),
        commandPlan,
      );

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        // The gate wants `ok.txt`, which the first attempt does not produce.
        actions: { produce: [doNothing, write("ok.txt", "ok\n")] },
      });

      const result = yield* drive({
        runId: "run-command-gate" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.strictEqual(result.record.state, "succeeded");
      assert.lengthOf(executor.continues, 1);
      // `exit 1` on its own is not something a stage can act on. What the check
      // printed is the part that makes the correction a correction.
      assert.include(executor.continues[0]?.correction ?? "", "ok.txt is missing");
    }).pipe(Effect.scoped),
  );

  it.effect("gives the second stage artifacts, not the first stage's transcript", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-prompts");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      yield* drive({
        runId: "run-prompts" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      const summarizePrompt = executor.prompts[1] ?? "";
      assert.include(summarizePrompt, "WL-STAGE: run-prompts/summarize");
      assert.include(summarizePrompt, "`artifact.md`");
      assert.notInclude(summarizePrompt, "Do the produce stage");
    }).pipe(Effect.scoped),
  );

  it.effect("records evidence for every gate it ran", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const { workspace, lease, logDir } = yield* setUpRun("run-evidence");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      const result = yield* drive({
        runId: "run-evidence" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      for (const visit of result.record.visits) {
        const evidence = yield* store.evidenceFor("run-evidence" as RunId, visit.visitId);
        assert.isAbove(evidence.length, 0, `no evidence for ${visit.stageId}`);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("stops for a decision when a stage runs out of attempts", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-exhausted");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        // Never produces the artifact, so the gate never passes.
        actions: { produce: [doNothing] },
      });

      const result = yield* drive({
        runId: "run-exhausted" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.strictEqual(result.record.state, "needs_decision");
      assert.strictEqual(result.record.decision?.kind, "budget-exhausted");
      assert.notInclude(executor.starts, "summarize");
    }).pipe(Effect.scoped),
  );

  it.effect("records a limitation when the executor cannot continue a context", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      // The run records the capabilities its executor reported, so the
      // controller decides against what this executor can actually do.
      const { workspace, lease, logDir } = yield* setUpRun(
        "run-nocontinue",
        capabilities({ sameContextContinuation: false }),
      );

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        capabilities: { sameContextContinuation: false },
        actions: {
          produce: [doNothing, write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      const result = yield* drive({
        runId: "run-nocontinue" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      const limitations = yield* store.limitationsFor("run-nocontinue" as RunId);
      assert.isAbove(limitations.length, 0);
      assert.strictEqual(limitations[0]?.capability, "sameContextContinuation");
      assert.strictEqual(result.record.state, "succeeded");
    }).pipe(Effect.scoped),
  );

  it.effect("reconciles an unsettled operation on restart instead of dispatching again", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const { workspace, lease, logDir } = yield* setUpRun("run-restart");

      // A previous worker dispatched and died before recording a settlement.
      yield* store.recordIntent({
        operationId: "op-orphan" as OperationId,
        runId: "run-restart" as RunId,
        visitId: "w-visit-1",
        attemptId: "w-attempt-1",
        kind: "start",
        idempotencyKey: "run-restart:w-visit-1:w-attempt-1",
      });

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      yield* drive({
        runId: "run-restart" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      const orphan = yield* store.findOperation("op-orphan" as OperationId);
      if (Option.isNone(orphan)) return yield* Effect.die("the orphan vanished");
      assert.isNotNull(orphan.value.settledAt);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to drive a run whose lease it no longer holds", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const { workspace, lease, logDir } = yield* setUpRun("run-fenced");

      // The run was picked up again while this worker was idle, which bumps
      // the lease generation and fences the handle this worker is holding.
      yield* store.acquireLease("run-fenced" as RunId, "worker-a", 60);

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: { produce: [write("artifact.md", ARTIFACT)] },
      });

      const outcome = yield* drive({
        runId: "run-fenced" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      }).pipe(Effect.result);

      assert.strictEqual(outcome._tag, "Failure");
      assert.deepStrictEqual(executor.starts, []);
    }).pipe(Effect.scoped),
  );

  it.effect("stops on cancellation and dispatches nothing afterwards", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-cancel");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: { produce: [write("artifact.md", ARTIFACT)] },
      });

      const result = yield* drive({
        runId: "run-cancel" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "cancel", reason: "user asked" }],
      });

      assert.strictEqual(result.record.state, "cancelled");
      assert.deepStrictEqual(executor.starts, []);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "cancels a run with a lost dispatch without starting it again or reaching the executor",
    () =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        const { lease } = yield* setUpRun("run-cancel-stale");

        // The run was started and its worker died with the first stage in flight:
        // the dispatch is on record and nothing ever settled it.
        const loaded = yield* store.loadRun("run-cancel-stale" as RunId);
        if (Option.isNone(loaded)) return yield* Effect.die("no run");
        const started = decide(
          {
            run: loaded.value.record,
            plan,
            now: "2026-01-01T00:00:00.000Z",
            ids: sequentialIds("s"),
          },
          { type: "start" },
        );
        yield* store.commit({
          previous: loaded.value.record,
          next: started.run,
          transitionInput: { type: "start" },
          effects: started.effects,
          lease,
        });
        const dispatch = started.effects.find((effect) => effect.type === "dispatch-stage");
        if (dispatch?.type !== "dispatch-stage") return yield* Effect.die("no dispatch");
        yield* store.recordIntent({
          operationId: dispatch.operationId,
          runId: "run-cancel-stale" as RunId,
          visitId: dispatch.visitId as string,
          attemptId: dispatch.attemptId as string,
          kind: "start",
          idempotencyKey: "run-cancel-stale:first",
        });
        yield* store.acknowledgeOperation(dispatch.operationId, "thread-of-a-dead-server");

        // The executor the run was started on is gone: every call fails.
        const executor = new FailingExecutor();
        const result = yield* cancel({
          runId: "run-cancel-stale" as RunId,
          reason: "dead experiment",
          lease,
          ids: sequentialIds("c"),
          interrupt: (handle) =>
            Effect.tryPromise({
              try: () => executor.interrupt(handle),
              catch: (cause) =>
                new ExecutorFailed({ operation: "interrupt", detail: String(cause) }),
            }),
        });

        assert.strictEqual(result.record.state, "cancelled");
        assert.strictEqual(result.stopped, "finished");
        assert.deepStrictEqual(executor.calls, ["interrupt thread-of-a-dead-server"]);
        const after = yield* store.loadRun("run-cancel-stale" as RunId);
        if (Option.isNone(after)) return yield* Effect.die("no run");
        assert.strictEqual(after.value.record.state, "cancelled");
        assert.lengthOf(yield* store.unsettledOperations("run-cancel-stale" as RunId), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("records what a stage found and did not fix, once, and clears the file", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workspace, lease, logDir } = yield* setUpRun("run-findings");
      const note = "checks/mapped-tests.sh misses top-level functions/*.js files.\n";

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [
            (at) => {
              write("artifact.md", ARTIFACT)(at);
              writeUnder(".workflowleaf/findings.md", note)(at);
            },
          ],
          // The next stage writes the same note again, as a stage that read the
          // same broken check would.
          summarize: [
            (at) => {
              write("summary.md", SUMMARY)(at);
              writeUnder(".workflowleaf/findings.md", note)(at);
            },
          ],
        },
      });

      const result = yield* drive({
        runId: "run-findings" as RunId,
        deps: {
          executor,
          ids: sequentialIds("f"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
          permissions: { commentOnPullRequest: false, merge: false },
        },
        lease,
        initial: [{ type: "start" }],
      });

      // Not a gate: the run finishes as it would have without the note.
      assert.strictEqual(result.record.state, "succeeded");
      const findings = yield* store.findingsFor("run-findings" as RunId);
      assert.deepStrictEqual(
        findings.map((finding) => [finding.stageId, finding.source, finding.detail]),
        [["produce", "stage", note.trim()]],
      );
      assert.isFalse(yield* fs.exists(path.join(workspace.path, ".workflowleaf/findings.md")));
      assert.include(executor.prompts[0] ?? "", ".workflowleaf/findings.md");
      // The profile's permissions reach every dispatched stage.
      for (const prompt of executor.prompts) {
        assert.include(prompt, "Do not comment on or review any pull request");
      }

      const logged = yield* readLearningLog("");
      assert.isTrue(
        logged.some(
          (entry) =>
            entry.kind === "finding" &&
            entry.runId === "run-findings" &&
            entry.stageId === "produce",
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports a file changed through a symlink that leaves the worktree", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workspace, lease, logDir } = yield* setUpRun("run-escape");

      // As FBM's post-checkout hook does: the worktree's .claude is the main
      // checkout's, so an edit through it lands in a directory git never reads.
      const shared = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(shared, "hooks"));
      yield* fs.writeFileString(path.join(shared, "hooks", "map.sh"), "old\n");
      yield* fs.writeFileString(path.join(shared, "untouched.md"), "same\n");
      // Claude Code keeps other checkouts under .claude/worktrees; they are not
      // this run's, and a busy one must not be reported against it.
      yield* fs.makeDirectory(path.join(shared, "worktrees", "other"), { recursive: true });
      yield* fs.writeFileString(path.join(shared, "worktrees", "other", ".git"), "gitdir: x\n");
      yield* fs.writeFileString(path.join(shared, "worktrees", "other", "busy.txt"), "1\n");
      yield* fs.symlink(shared, path.join(workspace.path, ".claude"));

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [
            (at) => {
              write("artifact.md", ARTIFACT)(at);
              write(".claude/hooks/map.sh", "new\n")(at);
              write(".claude/worktrees/other/busy.txt", "2\n")(at);
            },
          ],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      const result = yield* drive({
        runId: "run-escape" as RunId,
        deps: {
          executor,
          ids: sequentialIds("e"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.strictEqual(result.record.state, "succeeded");
      const findings = yield* store.findingsFor("run-escape" as RunId);
      assert.deepStrictEqual(
        findings.map((finding) => [finding.stageId, finding.source]),
        [["produce", "outside-worktree"]],
      );
      const detail = findings[0]?.detail ?? "";
      assert.include(detail, ".claude/hooks/map.sh");
      assert.include(detail, path.join(yield* fs.realPath(shared), "hooks", "map.sh"));
      assert.notInclude(detail, "untouched.md");
      assert.notInclude(detail, "busy.txt");
    }).pipe(Effect.scoped),
  );

  it.effect("reports every stage and gate verdict while it drives, not only at the end", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-progress");

      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          // The first attempt produces nothing, so a watcher should see the
          // failing gate and the correction, not just a stage that took a while.
          produce: [doNothing, write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });

      const seen: RunProgress[] = [];

      yield* drive({
        runId: "run-progress" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
          progress: (event) =>
            Effect.sync(() => {
              seen.push(event);
            }),
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.deepStrictEqual(
        seen.map((event) => `${event.kind} ${"stageId" in event ? event.stageId : event.number}`),
        [
          "stage-started produce",
          "gates produce",
          "stage-started produce",
          "gates produce",
          "stage-settled produce",
          "stage-started summarize",
          "gates summarize",
          "stage-settled summarize",
        ],
      );

      const gates = seen.filter((event) => event.kind === "gates");
      assert.deepStrictEqual(
        gates.map((event) => event.verdicts.map((verdict) => verdict.outcome)),
        [["failed"], ["passed"], ["passed"]],
      );

      const corrections = seen.filter(
        (event) => event.kind === "stage-started" && event.correcting,
      );
      assert.lengthOf(corrections, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("replays a finished run's history to exactly the state it recorded", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-replay");
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [doNothing, write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });
      yield* drive({
        runId: "run-replay" as RunId,
        deps: {
          executor,
          ids: idSourceFor("run-replay", 0),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      const report = yield* replayRun("run-replay" as RunId);
      assert.isNull(report.divergence);
      assert.isAbove(report.transitions, 6);
    }).pipe(Effect.scoped),
  );

  it.effect("replays across a stop for a decision and the drive that answered it", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-replay-decision");
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [
            (workspacePath) => {
              write("artifact.md", ARTIFACT)(workspacePath);
              writeUnder(SCOPE_SPLIT_PATH, "and the migration too\n")(workspacePath);
            },
          ],
          summarize: [write("summary.md", SUMMARY)],
        },
      });
      const deps = {
        executor,
        ids: idSourceFor("run-replay-decision", 0),
        workspacePath: workspace.path,
        logDir,
        owner: "worker-a",
        leaseSeconds: 60,
      };
      const stopped = yield* drive({
        runId: "run-replay-decision" as RunId,
        deps,
        lease,
        initial: [{ type: "start" }],
      });
      // A resumed run mints its ids from a new seed, as `wl resume` does.
      yield* drive({
        runId: "run-replay-decision" as RunId,
        deps: { ...deps, ids: idSourceFor("run-replay-decision", 5) },
        lease,
        initial: [
          {
            type: "decision-answered",
            decisionId: stopped.record.decision!.decisionId,
            answer: "proceed",
            planDigest: stopped.record.planDigest,
          },
        ],
      });

      const report = yield* replayRun("run-replay-decision" as RunId);
      assert.isNull(report.divergence);
    }).pipe(Effect.scoped),
  );

  it.effect("fails at the first transition a changed controller would decide differently", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-replay-changed");
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [doNothing, write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });
      yield* drive({
        runId: "run-replay-changed" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      // A controller that lets a failing gate through: the past run corrected
      // `produce`, this one would have moved straight on to `summarize`.
      const lenient: typeof decide = (context, input) =>
        decide(
          context,
          input.type === "gates-evaluated"
            ? {
                ...input,
                verdicts: input.verdicts.map((verdict) => ({ ...verdict, outcome: "passed" })),
              }
            : input,
        );

      const report = yield* replayRun("run-replay-changed" as RunId, lenient);
      assert.strictEqual(report.divergence?.what, "effects");
      assert.strictEqual(report.divergence?.seq, 4);
      assert.include(report.divergence?.recorded ?? "", "continue-stage");
      assert.include(report.divergence?.replayed ?? "", "summarize");
    }).pipe(Effect.scoped),
  );

  it.effect("fails on a changed final state even when every effect still matches", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-replay-state");
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });
      yield* drive({
        runId: "run-replay-state" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
        },
        lease,
        initial: [{ type: "start" }],
      });

      // Spends a repair cycle on every transition and says nothing about it.
      const leaky: typeof decide = (context, input) => {
        const decision = decide(context, input);
        const budget = {
          ...decision.run.budget,
          repairCycles: decision.run.budget.repairCycles + 1,
        };
        return { ...decision, run: { ...decision.run, budget } };
      };

      const report = yield* replayRun("run-replay-state" as RunId, leaky);
      assert.strictEqual(report.divergence?.what, "state");
      assert.isNull(report.divergence?.seq ?? null);
      assert.include(report.divergence?.replayed ?? "", "repairCycles");
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes a stage that changed paths needing a skill before its gates run", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun(
        "run-lazy-skill",
        capabilities(),
        lazySkillPlan(),
      );
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [
            (workspacePath) => {
              write("artifact.md", ARTIFACT)(workspacePath);
              writeUnder("db/001-add-column.sql", "ALTER TABLE t ADD c int;\n")(workspacePath);
            },
            doNothing,
          ],
          summarize: [write("summary.md", SUMMARY)],
        },
      });
      const seen: RunProgress[] = [];

      const result = yield* drive({
        runId: "run-lazy-skill" as RunId,
        deps: {
          executor,
          ids: sequentialIds("s"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
          progress: (event) =>
            Effect.sync(() => {
              seen.push(event);
            }),
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.strictEqual(result.record.state, "succeeded");
      // The first prompt could not know: nothing under db/ existed yet.
      assert.notInclude(executor.prompts[0] ?? "", "/skills/migrations");
      // The refresh names the skill, and the gates ran only after it.
      assert.lengthOf(executor.continues, 1);
      assert.include(executor.continues[0]?.correction ?? "", "/skills/migrations/SKILL.md");
      assert.deepStrictEqual(
        seen
          .slice(0, 3)
          .map((event) => `${event.kind} ${"stageId" in event ? event.stageId : event.number}`),
        ["stage-started produce", "stage-started produce", "gates produce"],
      );
      // The next stage is given it up front, chosen from what the run changed.
      assert.include(
        executor.prompts[1] ?? "",
        `\`${LAZY_SKILL}\` (selected from the paths this run has changed)`,
      );
      assert.deepStrictEqual(result.record.visits[0]?.skills, [LAZY_SKILL]);
      assert.strictEqual(result.record.visits[0]?.attempts, 1);
    }).pipe(Effect.scoped),
  );

  /**
   * A stage that ends its turn while a process it started keeps writing: a
   * line appended every 40ms, `lines` times, or until stopped when null.
   */
  const backgroundWriter = (lines: number | null) => {
    const children: NodeChildProcess.ChildProcess[] = [];
    const loop =
      lines === null
        ? "while true; do echo line >> artifact.md; sleep 0.04; done"
        : `i=0; while [ $i -lt ${String(lines)} ]; do echo line >> artifact.md; i=$((i+1)); sleep 0.04; done`;
    const action: Action = (workspacePath) => {
      children.push(NodeChildProcess.spawn("sh", ["-c", loop], { cwd: workspacePath }));
    };
    return { action, stop: () => children.forEach((child) => child.kill()) };
  };

  it.effect("holds the gates until a background writer the stage left running has finished", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-quiet");
      const writer = backgroundWriter(10);
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: { produce: [writer.action, doNothing], summarize: [write("summary.md", SUMMARY)] },
      });

      const result = yield* drive({
        runId: "run-quiet" as RunId,
        deps: {
          executor,
          ids: sequentialIds("q"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
          quiet: { windowMs: 150, timeoutMs: 5_000 },
        },
        lease,
        initial: [{ type: "start" }],
      }).pipe(Effect.ensuring(Effect.sync(writer.stop)));

      assert.strictEqual(result.record.state, "succeeded");
      // Judged once, on the finished file: no correction for a race the stage
      // did not lose.
      assert.lengthOf(executor.continues, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("stops for a person when the worktree never stops changing", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun("run-never-quiet");
      const writer = backgroundWriter(null);
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: { produce: [writer.action] },
      });

      const result = yield* drive({
        runId: "run-never-quiet" as RunId,
        deps: {
          executor,
          ids: sequentialIds("n"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
          quiet: { windowMs: 60, timeoutMs: 300 },
        },
        lease,
        initial: [{ type: "start" }],
      }).pipe(Effect.ensuring(Effect.sync(writer.stop)));

      assert.strictEqual(result.stopped, "needs-decision");
      assert.strictEqual(result.record.decision?.kind, "reconciliation");
      assert.include(result.record.decision?.detail ?? "", "still changing");
      assert.include(result.record.decision?.detail ?? "", "artifact.md");
      // No attempt was spent on it.
      assert.strictEqual(result.record.visits[0]?.attempts, 1);
      assert.lengthOf(executor.continues, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "marks the pull request ready once the delivering stage passes, before the next stage starts",
    () =>
      Effect.gen(function* () {
        const { workspace, lease, logDir } = yield* setUpRun(
          "run-ready",
          capabilities(),
          deliverPlan,
          17,
        );
        const executor = new WritingExecutor({
          workspacePath: workspace.path,
          actions: {
            // The first attempt fails its gate: nothing is delivered until it passes.
            produce: [doNothing, write("artifact.md", ARTIFACT)],
            summarize: [write("summary.md", SUMMARY)],
          },
        });
        const marked: { number: number; startedBefore: string[] }[] = [];
        const seen: string[] = [];

        const result = yield* drive({
          runId: "run-ready" as RunId,
          deps: {
            executor,
            ids: sequentialIds("w"),
            workspacePath: workspace.path,
            logDir,
            owner: "worker-a",
            leaseSeconds: 60,
            markReady: (number) =>
              Effect.sync(() => {
                marked.push({ number, startedBefore: [...executor.starts] });
              }),
            progress: (event) =>
              Effect.sync(() => {
                seen.push(`${event.kind} ${"stageId" in event ? event.stageId : event.number}`);
              }),
          },
          lease,
          initial: [{ type: "start" }],
        });

        assert.strictEqual(result.record.state, "succeeded");
        assert.deepStrictEqual(marked, [{ number: 17, startedBefore: ["produce"] }]);
        assert.deepStrictEqual(seen.slice(-5), [
          "stage-settled produce",
          "pull-request-ready 17",
          "stage-started summarize",
          "gates summarize",
          "stage-settled summarize",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("reports a pull request it could not mark ready, and keeps going", () =>
    Effect.gen(function* () {
      const { workspace, lease, logDir } = yield* setUpRun(
        "run-ready-fails",
        capabilities(),
        deliverPlan,
        18,
      );
      const executor = new WritingExecutor({
        workspacePath: workspace.path,
        actions: {
          produce: [write("artifact.md", ARTIFACT)],
          summarize: [write("summary.md", SUMMARY)],
        },
      });
      const seen: RunProgress[] = [];

      const result = yield* drive({
        runId: "run-ready-fails" as RunId,
        deps: {
          executor,
          ids: sequentialIds("w"),
          workspacePath: workspace.path,
          logDir,
          owner: "worker-a",
          leaseSeconds: 60,
          markReady: () => Effect.fail(new PullRequestError({ message: "gh: not permitted" })),
          progress: (event) =>
            Effect.sync(() => {
              seen.push(event);
            }),
        },
        lease,
        initial: [{ type: "start" }],
      });

      assert.strictEqual(result.record.state, "succeeded");
      const ready = seen.find((event) => event.kind === "pull-request-ready");
      assert.deepStrictEqual(ready, {
        kind: "pull-request-ready",
        number: 18,
        failure: "gh: not permitted",
      });
    }).pipe(Effect.scoped),
  );
});
