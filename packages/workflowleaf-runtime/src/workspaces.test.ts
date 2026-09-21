import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { initialRun, type RunId, type RunPlan, type WorkspaceId } from "@t3tools/workflowleaf-core";
import { capabilities, twoStagePlan } from "@t3tools/workflowleaf-core/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { git } from "./git.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerMemory } from "./store/Sqlite.ts";
import { changedPaths, ensureWorkspace, takeSnapshot } from "./workspaces.ts";

const plan: RunPlan = twoStagePlan();

const testLayer = RunStore.layer.pipe(
  Layer.provide(layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

/** A throwaway repository with one commit, so worktrees have something to branch from. */
const makeRepo = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const repo = path.join(root, "repo");
  yield* fs.makeDirectory(repo, { recursive: true });

  yield* git(repo, ["init", "-q", "-b", "main"]);
  yield* git(repo, ["config", "user.email", "fixture@example.com"]);
  yield* git(repo, ["config", "user.name", "Fixture"]);
  yield* fs.writeFileString(path.join(repo, "README.md"), "# fixture\n");
  yield* fs.writeFileString(path.join(repo, ".gitignore"), "ignored.txt\n");
  yield* git(repo, ["add", "."]);
  yield* git(repo, ["commit", "-qm", "initial"]);

  const head = (yield* git(repo, ["rev-parse", "HEAD"])).trim();
  return { root, repo, head, worktreeRoot: path.join(root, "worktrees") };
});

const seedRun = Effect.fnUntraced(function* (
  runId: string,
  repoRoot: string,
  baseRevision: string,
) {
  const store = yield* RunStore;
  const record = initialRun({
    runId: runId as RunId,
    planDigest: plan.planDigest,
    workspaceId: "pending" as WorkspaceId,
    capabilities: capabilities(),
    maxRepairCycles: 2,
    deadlineAt: null,
    now: "2026-01-01T00:00:00.000Z",
  });
  yield* store.createRun({
    record,
    plan,
    story: "story",
    profileName: "test",
    origin: { trigger: "manual", by: "test" },
    repoRoot,
    baseRevision,
  });
});

it.layer(testLayer)("workspaces", (it) => {
  it.effect("creates one worktree per run and reattaches to it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo, head, worktreeRoot } = yield* makeRepo();
      yield* seedRun("run-ws-1", repo, head);

      const first = yield* ensureWorkspace({
        runId: "run-ws-1" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });
      assert.isTrue(yield* fs.exists(first.path));

      // A restarted worker must reattach, not create a second checkout.
      const second = yield* ensureWorkspace({
        runId: "run-ws-1" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });
      assert.strictEqual(second.path, first.path);
      assert.strictEqual(second.workspaceId, first.workspaceId);
    }).pipe(Effect.scoped),
  );

  it.effect("stops rather than recreating a worktree that was deleted underneath it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo, head, worktreeRoot } = yield* makeRepo();
      yield* seedRun("run-ws-gone", repo, head);

      const workspace = yield* ensureWorkspace({
        runId: "run-ws-gone" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });
      yield* fs.remove(workspace.path, { recursive: true });

      const outcome = yield* ensureWorkspace({
        runId: "run-ws-gone" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      }).pipe(Effect.result);

      assert.strictEqual(outcome._tag, "Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("covers uncommitted and untracked files, which is most of what a gate reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, head, worktreeRoot } = yield* makeRepo();
      yield* seedRun("run-snap", repo, head);

      const workspace = yield* ensureWorkspace({
        runId: "run-snap" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });

      const before = yield* takeSnapshot(workspace.path, "t0");
      yield* fs.writeFileString(path.join(workspace.path, "artifact.md"), "written by a stage\n");
      const after = yield* takeSnapshot(workspace.path, "t1");

      assert.notStrictEqual(after.snapshotId, before.snapshotId);
      assert.deepStrictEqual([...changedPaths(before, after)], ["artifact.md"]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores files git is told to ignore", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, head, worktreeRoot } = yield* makeRepo();
      yield* seedRun("run-ignored", repo, head);

      const workspace = yield* ensureWorkspace({
        runId: "run-ignored" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });

      const before = yield* takeSnapshot(workspace.path, "t0");
      yield* fs.writeFileString(path.join(workspace.path, "ignored.txt"), "noise\n");
      const after = yield* takeSnapshot(workspace.path, "t1");

      assert.strictEqual(after.snapshotId, before.snapshotId);
    }).pipe(Effect.scoped),
  );

  it.effect("records what it excluded so a reader knows what was not looked at", () =>
    Effect.gen(function* () {
      const { repo, head, worktreeRoot } = yield* makeRepo();
      yield* seedRun("run-exclusions", repo, head);

      const workspace = yield* ensureWorkspace({
        runId: "run-exclusions" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });

      const snapshot = yield* takeSnapshot(workspace.path, "t0");
      assert.include([...snapshot.exclusions], "node_modules/");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a deletion as a change", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, head, worktreeRoot } = yield* makeRepo();
      yield* seedRun("run-deleted", repo, head);

      const workspace = yield* ensureWorkspace({
        runId: "run-deleted" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });

      const before = yield* takeSnapshot(workspace.path, "t0");
      yield* fs.remove(path.join(workspace.path, "README.md"));
      const after = yield* takeSnapshot(workspace.path, "t1");

      assert.deepStrictEqual([...changedPaths(before, after)], ["README.md"]);
    }).pipe(Effect.scoped),
  );

  it.effect("gives the same snapshot id for identical content", () =>
    Effect.gen(function* () {
      const { repo, head, worktreeRoot } = yield* makeRepo();
      yield* seedRun("run-stable", repo, head);

      const workspace = yield* ensureWorkspace({
        runId: "run-stable" as RunId,
        repoRoot: repo,
        worktreeRoot,
        baseRevision: head,
      });

      const first = yield* takeSnapshot(workspace.path, "t0");
      const second = yield* takeSnapshot(workspace.path, "t1");

      assert.strictEqual(first.snapshotId, second.snapshotId);
    }).pipe(Effect.scoped),
  );
});
