import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { initialRun, type RunId, type WorkspaceId } from "@t3tools/workflowleaf-core";
import { capabilities, twoStagePlan } from "@t3tools/workflowleaf-core/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { slugify } from "./cli.ts";
import { nextRunId } from "./run.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerMemory } from "./store/Sqlite.ts";

const plan = twoStagePlan();

const testLayer = RunStore.layer.pipe(
  Layer.provide(layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

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

const seed = Effect.fnUntraced(function* (runId: string, story: string) {
  const store = yield* RunStore;
  yield* store.createRun({
    record: record(runId),
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
