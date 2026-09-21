import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  initialRun,
  type AttemptId,
  type Digest,
  type EvidenceRecord,
  type GateId,
  type OperationId,
  type RunId,
  type RunPlan,
  type RunRecord,
  type SnapshotId,
  type StageId,
  type VisitId,
  type WorkspaceId,
} from "@t3tools/workflowleaf-core";
import { capabilities, twoStagePlan } from "@t3tools/workflowleaf-core/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RunStore } from "./RunStore.ts";
import { layerMemory } from "./Sqlite.ts";

const plan: RunPlan = twoStagePlan();

const testLayer = RunStore.layer.pipe(
  Layer.provide(layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

function freshRecord(runId = "run-1"): RunRecord {
  return initialRun({
    runId: runId as RunId,
    planDigest: plan.planDigest,
    workspaceId: "ws-1" as WorkspaceId,
    capabilities: capabilities(),
    maxRepairCycles: 2,
    deadlineAt: null,
    now: "2026-01-01T00:00:00.000Z",
  });
}

const seedRun = Effect.fnUntraced(function* (runId = "run-1") {
  const store = yield* RunStore;
  const record = freshRecord(runId);
  yield* store.createRun({
    record,
    plan,
    story: "story",
    profileName: "test",
    origin: { trigger: "manual", by: "test" },
    repoRoot: "/repo",
    baseRevision: "abc123",
  });
  return record;
});

const leaseFor = Effect.fnUntraced(function* (runId: string, owner: string) {
  const store = yield* RunStore;
  const lease = yield* store.acquireLease(runId as RunId, owner, 60);
  if (Option.isNone(lease)) return yield* Effect.die(`${owner} could not take the lease`);
  return lease.value;
});

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    runId: "run-1" as RunId,
    visitId: "visit-1" as VisitId,
    attemptId: "attempt-1" as AttemptId,
    gateId: "artifact-has-content" as GateId,
    gateDigest: "gate-v1" as Digest,
    snapshotId: "snap-1" as SnapshotId,
    inputDigests: [{ path: "artifact.md", digest: "a-v1" as Digest }],
    tool: "node",
    toolVersion: "24.20.0",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "passed",
    detail: { kind: "file", exists: true, bytes: 120, missingContent: [] },
    logRef: null,
    mutatedDuringCheck: false,
    ...overrides,
  };
}

it.layer(testLayer)("run store", (it) => {
  it.effect("round-trips a run and its immutable plan", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const record = yield* seedRun();

      const loaded = yield* store.loadRun(record.runId);
      assert.isTrue(Option.isSome(loaded));
      if (Option.isNone(loaded)) return;

      assert.strictEqual(loaded.value.record.runId, record.runId);
      assert.strictEqual(loaded.value.plan.planDigest, plan.planDigest);
      assert.strictEqual(loaded.value.baseRevision, "abc123");
    }),
  );

  it.effect("returns none for a run that does not exist", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      assert.isTrue(Option.isNone(yield* store.loadRun("nope" as RunId)));
    }),
  );

  it.effect("commits a transition and advances the revision", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const record = yield* seedRun("run-commit");
      const lease = yield* leaseFor("run-commit", "worker-a");

      const next: RunRecord = { ...record, state: "running", revision: 1, updatedAt: "t1" };
      yield* store.commit({
        previous: record,
        next,
        transitionInput: { type: "start" },
        effects: [],
        lease,
      });

      const loaded = yield* store.loadRun(record.runId);
      if (Option.isNone(loaded)) return yield* Effect.die("run vanished");
      assert.strictEqual(loaded.value.record.state, "running");
      assert.strictEqual(loaded.value.record.revision, 1);
    }),
  );

  it.effect("refuses a commit from a worker holding a stale revision", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const record = yield* seedRun("run-stale");
      const lease = yield* leaseFor("run-stale", "worker-a");

      const first: RunRecord = { ...record, state: "running", revision: 1, updatedAt: "t1" };
      yield* store.commit({
        previous: record,
        next: first,
        transitionInput: {},
        effects: [],
        lease,
      });

      // A worker that read revision 0 and is only deciding now.
      const stale: RunRecord = { ...record, state: "paused", revision: 1, updatedAt: "t2" };
      const outcome = yield* store
        .commit({ previous: record, next: stale, transitionInput: {}, effects: [], lease })
        .pipe(Effect.result);

      assert.strictEqual(outcome._tag, "Failure");
      const loaded = yield* store.loadRun(record.runId);
      if (Option.isNone(loaded)) return yield* Effect.die("run vanished");
      assert.strictEqual(loaded.value.record.state, "running");
    }),
  );

  it.effect("hands the lease to a second worker and fences the first", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const record = yield* seedRun("run-lease");
      const first = yield* leaseFor("run-lease", "worker-a");
      const second = yield* leaseFor("run-lease", "worker-a");

      assert.isAbove(second.generation, first.generation);

      const next: RunRecord = { ...record, revision: 1, updatedAt: "t1" };
      const outcome = yield* store
        .commit({ previous: record, next, transitionInput: {}, effects: [], lease: first })
        .pipe(Effect.result);

      assert.strictEqual(outcome._tag, "Failure");
    }),
  );

  it.effect("refuses a lease another live worker holds", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-contended");
      yield* leaseFor("run-contended", "worker-a");

      const stolen = yield* store.acquireLease("run-contended" as RunId, "worker-b", 60);
      assert.isTrue(Option.isNone(stolen));
    }),
  );

  it.effect("records dispatch intent before the executor is told anything", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-intent");

      yield* store.recordIntent({
        operationId: "op-1" as OperationId,
        runId: "run-intent" as RunId,
        visitId: "visit-1",
        attemptId: "attempt-1",
        kind: "start",
        idempotencyKey: "run-intent:visit-1:attempt-1",
      });

      const found = yield* store.findOperation("op-1" as OperationId);
      if (Option.isNone(found)) return yield* Effect.die("intent not recorded");
      assert.isNull(found.value.acknowledgedAt);
      assert.isNull(found.value.settledAt);
    }),
  );

  it.effect("keeps one row when the same intent is recorded twice", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-idem");
      const intent = {
        operationId: "op-idem" as OperationId,
        runId: "run-idem" as RunId,
        visitId: "visit-1",
        attemptId: "attempt-1",
        kind: "start" as const,
        idempotencyKey: "run-idem:visit-1:attempt-1",
      };

      yield* store.recordIntent(intent);
      yield* store.recordIntent(intent);

      assert.lengthOf(yield* store.unsettledOperations("run-idem" as RunId), 1);
    }),
  );

  it.effect("lists only operations that never settled, which is what recovery reconciles", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-recover");

      for (const id of ["op-a", "op-b"]) {
        yield* store.recordIntent({
          operationId: id as OperationId,
          runId: "run-recover" as RunId,
          visitId: "visit-1",
          attemptId: id,
          kind: "start",
          idempotencyKey: `run-recover:${id}`,
        });
      }
      yield* store.acknowledgeOperation("op-a" as OperationId, "handle-a");
      yield* store.settleOperation("op-a" as OperationId, "completed");

      const unsettled = yield* store.unsettledOperations("run-recover" as RunId);
      assert.deepStrictEqual(
        unsettled.map((row) => row.operationId as string),
        ["op-b"],
      );
    }),
  );

  it.effect("stores evidence per attempt and reads it back by visit", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-attempts");
      const base = evidence({ runId: "run-attempts" as RunId });

      yield* store.putEvidence(base);
      yield* store.putEvidence({ ...base, attemptId: "attempt-2" as AttemptId, outcome: "failed" });

      const records = yield* store.evidenceFor("run-attempts" as RunId, "visit-1" as VisitId);
      assert.lengthOf(records, 2);
    }),
  );

  it.effect("replaces evidence for the same attempt and gate rather than duplicating it", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-evidence");
      const base = evidence({ runId: "run-evidence" as RunId, outcome: "failed" });

      yield* store.putEvidence(base);
      yield* store.putEvidence({ ...base, outcome: "passed" });

      const records = yield* store.evidenceFor("run-evidence" as RunId, "visit-1" as VisitId);
      assert.lengthOf(records, 1);
      assert.strictEqual(records[0]?.outcome, "passed");
    }),
  );

  it.effect("records a capability limitation so a green run can be read as qualified", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-limits");

      yield* store.recordLimitation("run-limits" as RunId, {
        stageId: "produce" as StageId,
        capability: "sameContextContinuation",
        detail: "Correction restarted in a fresh context.",
      });

      const limitations = yield* store.limitationsFor("run-limits" as RunId);
      assert.lengthOf(limitations, 1);
      assert.strictEqual(limitations[0]?.capability, "sameContextContinuation");
    }),
  );

  it.effect("keeps one workspace per run", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-ws");

      yield* store.claimWorkspace({
        workspaceId: "ws-a",
        runId: "run-ws" as RunId,
        path: "/tmp/ws-a",
        branch: "wl/run-ws",
        baseRevision: "abc123",
      });

      const second = yield* store
        .claimWorkspace({
          workspaceId: "ws-b",
          runId: "run-ws" as RunId,
          path: "/tmp/ws-b",
          branch: "wl/run-ws-2",
          baseRevision: "abc123",
        })
        .pipe(Effect.result);

      assert.strictEqual(second._tag, "Failure");
      const found = yield* store.findWorkspace("run-ws" as RunId);
      if (Option.isNone(found)) return yield* Effect.die("workspace vanished");
      assert.strictEqual(found.value.path, "/tmp/ws-a");
    }),
  );

  it.effect("persists an event cursor so a reconnect replays from where it stopped", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedRun("run-cursor");

      yield* store.saveCursor("run-cursor" as RunId, "1042");
      yield* store.saveCursor("run-cursor" as RunId, "1099");

      const cursor = yield* store.loadCursor("run-cursor" as RunId);
      assert.deepStrictEqual(Option.getOrNull(cursor), "1099");
    }),
  );

  it.effect("filters the run list by state", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const a = yield* seedRun("run-list-a");
      yield* seedRun("run-list-b");
      const lease = yield* leaseFor("run-list-a", "worker-a");

      yield* store.commit({
        previous: a,
        next: { ...a, state: "succeeded", revision: 1, updatedAt: "t1" },
        transitionInput: {},
        effects: [],
        lease,
      });

      const done = yield* store.listRuns({ state: "succeeded" });
      assert.deepStrictEqual(
        done.map((run) => run.record.runId as string),
        ["run-list-a"],
      );
    }),
  );
});

const pullRequest = (number: number) => ({
  number,
  url: `https://example.test/pull/${String(number)}`,
  headBranch: "workflowleaf/issue-7-1",
  baseBranch: "main",
  openedAt: "2026-01-01T00:00:00.000Z",
});

const seedStoryRun = Effect.fnUntraced(function* (input: {
  readonly runId: string;
  readonly story: string;
  readonly pullRequestNumber?: number;
}) {
  const store = yield* RunStore;
  const record: RunRecord = {
    ...freshRecord(input.runId),
    pullRequest:
      input.pullRequestNumber === undefined ? null : pullRequest(input.pullRequestNumber),
  };
  yield* store.createRun({
    record,
    plan,
    story: input.story,
    profileName: "test",
    origin: { trigger: "manual", by: "test" },
    repoRoot: "/repo",
    baseRevision: "abc123",
  });
  return record;
});

it.layer(testLayer)("a run is a story and a pull request", (it) => {
  it.effect("counts the runs a story already has, so the next one gets the next ordinal", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedStoryRun({ runId: "issue-7-1", story: "issue-7" });
      yield* seedStoryRun({ runId: "issue-7-2", story: "issue-7" });
      yield* seedStoryRun({ runId: "issue-8-1", story: "issue-8" });

      assert.strictEqual(yield* store.countRunsForStory("issue-7"), 2);
      assert.strictEqual(yield* store.countRunsForStory("issue-8"), 1);
      assert.strictEqual(yield* store.countRunsForStory("issue-9"), 0);
    }),
  );

  it.effect("finds the run that owns a pull request", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* seedStoryRun({ runId: "issue-11-1", story: "issue-11", pullRequestNumber: 101 });
      yield* seedStoryRun({ runId: "issue-11-2", story: "issue-11", pullRequestNumber: 102 });

      const found = yield* store.findRunByPullRequest(102);
      assert.isTrue(Option.isSome(found));
      assert.strictEqual(Option.getOrThrow(found).record.runId as string, "issue-11-2");
      assert.strictEqual(Option.getOrThrow(found).story, "issue-11");

      assert.isTrue(Option.isNone(yield* store.findRunByPullRequest(999)));
    }),
  );

  it.effect("keeps the pull request lookup in step with the run it is committed on", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const record = yield* seedStoryRun({ runId: "issue-12-1", story: "issue-12" });
      const lease = yield* leaseFor("issue-12-1", "worker-a");

      assert.isTrue(Option.isNone(yield* store.findRunByPullRequest(77)));

      yield* store.commit({
        previous: record,
        next: { ...record, pullRequest: pullRequest(77), revision: 1, updatedAt: "t1" },
        transitionInput: {},
        effects: [],
        lease,
      });

      const found = yield* store.findRunByPullRequest(77);
      assert.strictEqual(Option.getOrThrow(found).record.runId as string, "issue-12-1");
    }),
  );
});
