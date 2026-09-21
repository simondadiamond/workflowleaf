import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { commitEmpty, git, pushBranch, revParse } from "./git.ts";

/** A worktree on `story-1`, with `origin` pointing at a bare repository. */
const setUpRepository = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = yield* fs.makeTempDirectoryScoped();
  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");

  yield* git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  yield* git(root, ["clone", "-q", remote, local]);
  yield* git(local, ["config", "user.email", "fixture@example.com"]);
  yield* git(local, ["config", "user.name", "Fixture"]);
  yield* fs.writeFileString(path.join(local, "README.md"), "# fixture\n");
  yield* git(local, ["add", "."]);
  yield* git(local, ["commit", "-qm", "initial"]);
  yield* pushBranch(local, "origin", "main");
  yield* git(local, ["checkout", "-q", "-b", "story-1"]);

  return { root, remote, local };
});

it.layer(NodeServices.layer)("the branch a run's pull request is opened from", (it) => {
  it.effect("commits with nothing to commit, so the branch can be opened immediately", () =>
    Effect.gen(function* () {
      const { local } = yield* setUpRepository();
      const before = yield* revParse(local, "HEAD");

      const after = yield* commitEmpty(local, "issue-7: reviewable-pull-request");

      assert.notStrictEqual(after, before);
      const log = yield* git(local, ["log", "-1", "--format=%s"]);
      assert.strictEqual(log.trim(), "issue-7: reviewable-pull-request");
      const status = yield* git(local, ["status", "--porcelain"]);
      assert.strictEqual(status.trim(), "");
    }).pipe(Effect.scoped),
  );

  it.effect("pushes the one branch it was asked to push", () =>
    Effect.gen(function* () {
      const { local, remote } = yield* setUpRepository();
      yield* commitEmpty(local, "issue-7: reviewable-pull-request");
      yield* git(local, ["checkout", "-q", "-b", "story-2"]);
      yield* git(local, ["checkout", "-q", "story-1"]);

      yield* pushBranch(local, "origin", "story-1");

      const branches = yield* git(remote, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ]);
      assert.deepStrictEqual(branches.trim().split("\n").sort(), ["main", "story-1"]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails rather than overwriting work someone else pushed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, remote, local } = yield* setUpRepository();

      yield* commitEmpty(local, "ours");
      yield* pushBranch(local, "origin", "story-1");

      // Someone else moves the branch on.
      const other = path.join(root, "other");
      yield* git(root, ["clone", "-q", "-b", "story-1", remote, other]);
      yield* git(other, ["config", "user.email", "other@example.com"]);
      yield* git(other, ["config", "user.name", "Other"]);
      yield* fs.writeFileString(path.join(other, "theirs.md"), "theirs\n");
      yield* git(other, ["add", "."]);
      yield* git(other, ["commit", "-qm", "theirs"]);
      yield* pushBranch(other, "origin", "story-1");

      // Ours diverges and is pushed again.
      yield* git(local, ["reset", "-q", "--hard", "HEAD~1"]);
      yield* commitEmpty(local, "ours again");

      const outcome = yield* Effect.result(pushBranch(local, "origin", "story-1"));
      assert.strictEqual(outcome._tag, "Failure");

      const theirs = yield* git(remote, ["log", "-1", "--format=%s", "story-1"]);
      assert.strictEqual(theirs.trim(), "theirs");
    }).pipe(Effect.scoped),
  );
});
