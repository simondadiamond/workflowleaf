import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import {
  initialRun,
  type DecisionAnswer,
  type DecisionId,
  type DecisionPort,
  type DecisionRequest,
  type RunId,
  type WorkspaceId,
} from "@t3tools/workflowleaf-core";
import { capabilities, twoStagePlan } from "@t3tools/workflowleaf-core/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { slugify } from "./cli.ts";
import {
  answeredFromCli,
  answeredOnThread,
  askForDecision,
  describeRun,
  holdingLease,
  nextRunId,
  startingRun,
  startRun,
  summarizeRuns,
} from "./run.ts";
import { DEFAULT_REVIEWER } from "./reviewer.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerMemory } from "./store/Sqlite.ts";

const plan = twoStagePlan();

const testLayer = Layer.mergeAll(
  RunStore.layer.pipe(Layer.provide(layerMemory)),
  NodeHttpClient.layerUndici,
  NodeSocket.layerWebSocketConstructor,
).pipe(Layer.provideMerge(NodeServices.layer));

const record = (runId: string) =>
  initialRun({
    runId: runId as RunId,
    planDigest: plan.planDigest,
    workspaceId: "ws-1" as WorkspaceId,
    capabilities: capabilities(),
    maxRepairCycles: 2,
    deadlineAt: null,
    now: "2026-01-01T00:00:00.000Z",
  });

const seed = Effect.fnUntraced(function* (runId: string, story: string, revision = 0) {
  const store = yield* RunStore;
  yield* store.createRun({
    record: { ...record(runId), revision },
    plan,
    story,
    profileName: "test",
    origin: { trigger: "manual", by: "test" },
    repoRoot: "/repo",
    baseRevision: "abc123",
  });
});

it.layer(testLayer)("run ids", (it) => {
  it.effect("the first run of a story takes the first ordinal", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* nextRunId("issue-42")) as string, "issue-42-1");
    }),
  );

  it.effect("a story that needs a second pull request gets a second run, not a collision", () =>
    Effect.gen(function* () {
      yield* seed("issue-43-1", "issue-43");
      assert.strictEqual((yield* nextRunId("issue-43")) as string, "issue-43-2");

      yield* seed("issue-43-2", "issue-43");
      assert.strictEqual((yield* nextRunId("issue-43")) as string, "issue-43-3");
    }),
  );

  it.effect("a run reports the revision it is actually on, not the one it started on", () =>
    Effect.gen(function* () {
      // A fresh run is on revision 0, so a summary that reported a constant
      // would look right. This one has moved.
      yield* seed("issue-46-1", "issue-46", 7);

      const summaries = yield* summarizeRuns();
      const summary = summaries.find((candidate) => candidate.runId === "issue-46-1");
      assert.strictEqual(summary?.revision, 7);

      // `wl status <run>` is where the skill reads the number it passes back
      // in `--revision`, so the detail has to carry it too.
      const detail = yield* describeRun("issue-46-1" as RunId);
      assert.strictEqual(Option.getOrUndefined(detail)?.revision, 7);
    }),
  );

  it.effect("a running run no worker holds is stale, and one being driven is not", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* store.createRun({
        record: { ...record("run-dead"), state: "running" },
        plan,
        story: "story-dead",
        profileName: "test",
        origin: { trigger: "manual", by: "test" },
        repoRoot: "/repo",
        baseRevision: "abc123",
      });
      yield* store.createRun({
        record: { ...record("run-live"), state: "running" },
        plan,
        story: "story-live",
        profileName: "test",
        origin: { trigger: "manual", by: "test" },
        repoRoot: "/repo",
        baseRevision: "abc123",
      });

      const staleness = (runs: readonly { runId: string; stale: boolean }[]) =>
        Object.fromEntries(
          runs
            .filter((run) => run.runId === "run-dead" || run.runId === "run-live")
            .map((run) => [run.runId, run.stale]),
        );

      yield* holdingLease("run-live" as RunId, "worker", () =>
        Effect.gen(function* () {
          assert.deepStrictEqual(staleness(yield* summarizeRuns()), {
            "run-dead": true,
            "run-live": false,
          });
          const detail = yield* describeRun("run-dead" as RunId);
          assert.include(Option.getOrUndefined(detail)?.attention ?? "", "resume or cancel");
        }),
      );
      // Once the drive ends, nothing is moving it either.
      assert.deepStrictEqual(staleness(yield* summarizeRuns()), {
        "run-dead": true,
        "run-live": true,
      });
    }),
  );

  it.effect("gives the lease back when a drive ends, however it ends", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seed("run-lease", "story-lease");

      yield* holdingLease("run-lease" as RunId, "first", () => Effect.void);
      const afterSuccess = yield* store.acquireLease("run-lease" as RunId, "second", 60);
      assert.isTrue(Option.isSome(afterSuccess));
      if (Option.isSome(afterSuccess)) yield* store.releaseLease(afterSuccess.value);

      yield* holdingLease("run-lease" as RunId, "third", () => Effect.fail("boom")).pipe(
        Effect.ignore,
      );
      const afterFailure = yield* store.acquireLease("run-lease" as RunId, "fourth", 60);
      assert.isTrue(Option.isSome(afterFailure));
    }),
  );

  it.effect("another story is counted separately", () =>
    Effect.gen(function* () {
      yield* seed("issue-44-1", "issue-44");
      assert.strictEqual((yield* nextRunId("issue-45")) as string, "issue-45-1");
    }),
  );
});

it("a story id becomes something usable as a branch and a directory", () => {
  assert.strictEqual(slugify("Issue 42"), "issue-42");
  assert.strictEqual(slugify("  Retry/Backoff: the timeout  "), "retry-backoff-the-timeout");
  assert.strictEqual(slugify("issue-42"), "issue-42");
});

/** Stands in for the T3 thread a decision is asked on. */
class RecordingDecisions implements DecisionPort {
  readonly asked: DecisionRequest[] = [];
  readonly withdrawn: DecisionRequest[] = [];
  readonly reply: DecisionAnswer | null;
  readonly failToAsk: boolean;
  constructor(reply: DecisionAnswer | null, failToAsk = false) {
    this.reply = reply;
    this.failToAsk = failToAsk;
  }
  ask(request: DecisionRequest): Promise<void> {
    if (this.failToAsk) return Promise.reject(new Error("socket closed"));
    this.asked.push(request);
    return Promise.resolve();
  }
  answer(): Promise<DecisionAnswer | null> {
    return Promise.resolve(this.reply);
  }
  withdraw(request: DecisionRequest): Promise<void> {
    this.withdrawn.push(request);
    return Promise.resolve();
  }
}

/** A run stopped on a decision, with its worktree and the recorded question. */
const seedStopped = Effect.fnUntraced(function* (runId: string) {
  const store = yield* RunStore;
  const decision = {
    decisionId: `decision-${runId}` as DecisionId,
    kind: "budget-exhausted" as const,
    detail: "Stage build used all 3 attempts.",
    raisedAt: "2026-01-01T00:00:01.000Z",
    planDigest: plan.planDigest,
  };
  yield* store.createRun({
    record: { ...record(runId), state: "needs_decision", decision },
    plan,
    story: runId,
    profileName: "test",
    origin: { trigger: "manual", by: "test" },
    repoRoot: "/repo",
    baseRevision: "abc123",
  });
  yield* store.claimWorkspace({
    workspaceId: `ws-${runId}`,
    runId: runId as RunId,
    path: `/worktrees/${runId}`,
    branch: `workflowleaf/${runId}`,
    baseRevision: "abc123",
  });
  yield* store.recordDecision({ runId: runId as RunId, visitId: "visit-1", decision });
  return decision;
});

it.layer(testLayer)("decisions asked on a thread", (it) => {
  it.effect("asks once, however many times the run stops on the same decision", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const decision = yield* seedStopped("ask-once");
      const port = new RecordingDecisions(null);

      assert.isTrue(yield* askForDecision("ask-once" as RunId, port));
      assert.isTrue(yield* askForDecision("ask-once" as RunId, port));
      assert.lengthOf(port.asked, 1);
      assert.strictEqual(port.asked[0]?.workspacePath, "/worktrees/ask-once");

      const row = yield* store.findDecision(decision.decisionId);
      assert.isNotNull(Option.getOrUndefined(row)?.askedAt ?? null);
      assert.strictEqual(Option.getOrUndefined(row)?.visitId, "visit-1");
    }),
  );

  it.effect("does not record a question it failed to put up", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const decision = yield* seedStopped("ask-fails");
      assert.isFalse(
        yield* askForDecision("ask-fails" as RunId, new RecordingDecisions(null, true)),
      );
      const row = yield* store.findDecision(decision.decisionId);
      assert.isNull(Option.getOrUndefined(row)?.askedAt ?? null);
    }),
  );

  it.effect("turns the answer given on the thread into the input that resumes the run", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const decision = yield* seedStopped("answered-there");
      const port = new RecordingDecisions("waive");
      yield* askForDecision("answered-there" as RunId, port);

      const inputs = yield* answeredOnThread("answered-there" as RunId, port, false);
      assert.deepStrictEqual(inputs, [
        {
          type: "decision-answered",
          decisionId: decision.decisionId,
          answer: "waive",
          planDigest: plan.planDigest,
        },
      ]);
      const row = yield* store.findDecision(decision.decisionId);
      assert.strictEqual(Option.getOrUndefined(row)?.answeredVia, "thread");
    }),
  );

  it.effect("reads nothing from a thread it never asked on, or one not yet answered", () =>
    Effect.gen(function* () {
      yield* seedStopped("never-asked");
      assert.deepStrictEqual(
        yield* answeredOnThread("never-asked" as RunId, new RecordingDecisions("proceed"), false),
        [],
      );

      yield* seedStopped("unanswered");
      const port = new RecordingDecisions(null);
      yield* askForDecision("unanswered" as RunId, port);
      assert.deepStrictEqual(yield* answeredOnThread("unanswered" as RunId, port, false), []);
    }),
  );

  it.effect("takes the thread's question down when the terminal answered it", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const decision = yield* seedStopped("answered-here");
      const port = new RecordingDecisions(null);
      yield* askForDecision("answered-here" as RunId, port);

      yield* answeredFromCli("answered-here" as RunId, "abort", port);
      assert.lengthOf(port.withdrawn, 1);
      const row = yield* store.findDecision(decision.decisionId);
      assert.strictEqual(Option.getOrUndefined(row)?.answer, "abort");
      assert.strictEqual(Option.getOrUndefined(row)?.answeredVia, "cli");
    }),
  );
});

it.layer(testLayer, { excludeTestServices: true })("a run that is still starting", (it) => {
  it.effect("says so before its record exists, instead of there being no such run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const fixtures = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        "test",
        "fixtures",
      );
      const inHome = Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ WORKFLOWLEAF_HOME: home })),
      );

      // The repository has the playbook's context files but is not a git
      // repository, so the start fails at the first slow step, which is where a
      // real start is still opening its worktree and pull request with no
      // record written.
      const repo = path.join(home, "repo");
      yield* fs.copy(path.join(fixtures, "repo"), repo);
      const started = yield* startRun({
        runId: "issue-9-1" as RunId,
        story: "issue-9",
        profile: {
          name: "fixture",
          executor: { kind: "fake" },
          repoRoot: repo,
          worktreeRoot: path.join(home, "worktrees"),
          skillRoots: [path.join(fixtures, "skills")],
          reviewer: DEFAULT_REVIEWER,
          budgets: { maxRepairCycles: 2, runDeadlineMs: null },
          permissions: {
            createPullRequest: false,
            commentOnPullRequest: false,
            merge: false,
            liveCanary: false,
          },
        },
        playbookDir: path.join(fixtures, "playbooks", "two-stage"),
        inputs: { topic: "a made-up topic" },
        baseRef: "HEAD",
        owner: "test",
      }).pipe(inHome, Effect.result);
      assert.strictEqual(started._tag, "Failure");

      assert.isTrue(Option.isNone(yield* describeRun("issue-9-1" as RunId)));
      const starting = yield* startingRun("issue-9-1").pipe(inHome);
      assert.include(Option.getOrUndefined(starting) ?? "", "run starting");
      assert.isTrue(Option.isNone(yield* startingRun("issue-10-1").pipe(inHome)));
    }).pipe(Effect.scoped),
  );
});
