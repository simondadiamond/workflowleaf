// @effect-diagnostics nodeBuiltinImport:off
// The stand-in executor writes to the worktree the way a provider would, which
// has to happen synchronously inside a Promise-returning port.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  initialRun,
  type ContinueOutcome,
  type ExecutorCapabilities,
  type ExecutorPort,
  type InspectOutcome,
  type OperationId,
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
  sequentialIds,
  twoStagePlan,
} from "@t3tools/workflowleaf-core/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { git } from "./git.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerMemory } from "./store/Sqlite.ts";
import { drive, SCOPE_SPLIT_PATH, type RunProgress } from "./worker.ts";
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
    NodeFs.writeFileSync(NodePath.join(workspacePath, relativePath), content);
  };

/** Writes into a directory the stage may not have created yet. */
const writeUnder =
  (relativePath: string, content: string): Action =>
  (workspacePath) => {
    const target = NodePath.join(workspacePath, relativePath);
    NodeFs.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFs.writeFileSync(target, content);
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
}

const setUpRun = Effect.fnUntraced(function* (
  runId: string,
  runCapabilities: ExecutorCapabilities = capabilities(),
  runPlan: RunPlan = plan,
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
  });

  const lease = yield* store.acquireLease(runId as RunId, "worker-a", 60);
  if (Option.isNone(lease)) return yield* Effect.die("could not take the lease");

  return { repo, head, workspace, lease: lease.value, logDir: path.join(root, "logs") };
});

const ARTIFACT = "a paragraph that is comfortably longer than eight bytes\n";
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
        seen.map((event) => `${event.kind} ${event.stageId}`),
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
});
