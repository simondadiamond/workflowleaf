/**
 * The generic `implement-pr` playbook: it compiles against any repository, and
 * its checks read their configuration from the run's base revision.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { complete } from "./exec.ts";
import { git, revParse } from "./git.ts";
import { loadPlaybook } from "./load.ts";

const playbookDir = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.join(here, "..", "..", "..", "scripts", "workflowleaf", "playbooks", "implement-pr");
});

/** A repository with one commit declaring its commands. */
const makeRepo = Effect.fnUntraced(function* (commands: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* git(root, ["init", "-q", "-b", "main"]);
  yield* git(root, ["config", "user.email", "fixture@example.com"]);
  yield* git(root, ["config", "user.name", "Fixture"]);
  yield* fs.makeDirectory(path.join(root, ".workflowleaf"), { recursive: true });
  yield* fs.writeFileString(path.join(root, ".workflowleaf", "commands"), commands);
  yield* fs.writeFileString(path.join(root, "README.md"), "# fixture\n");
  yield* git(root, ["add", "."]);
  yield* git(root, ["commit", "-qm", "initial"]);
  return { root, base: yield* revParse(root, "HEAD") };
});

const repoCommand = Effect.fnUntraced(function* (cwd: string, base: string, name: string) {
  const script = `${yield* playbookDir()}/checks/repo-command.sh`;
  return yield* complete("/usr/bin/env", [`WORKFLOWLEAF_BASE_REVISION=${base}`, script, name], cwd);
});

it.layer(NodeServices.layer, { excludeTestServices: true })("the implement-pr playbook", (it) => {
  it.effect("compiles unchanged against two different repositories", () =>
    Effect.gen(function* () {
      const dir = yield* playbookDir();
      const inputs = { issue: "42", story: "Make the thing work." };
      for (const commands of ["test: npm test\n", "test: cargo test\n"]) {
        const { root } = yield* makeRepo(commands);
        const loaded = yield* loadPlaybook({
          playbookDir: dir,
          repoRoot: root,
          skillRoots: [],
          inputs,
          compiledAt: "2026-01-01T00:00:00.000Z",
        });
        if (!loaded.ok) {
          return assert.fail(
            loaded.diagnostics.map((one) => `${one.field}: ${one.message}`).join("\n"),
          );
        }
        assert.deepStrictEqual(
          loaded.value.plan.stages.map((stage) => stage.contract.id),
          ["plan", "build", "review", "deliver", "babysit"],
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("runs the command the base revision declares, whatever the worktree says", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, base } = yield* makeRepo("test: echo from-base; exit 3\n");
      // The stage under check tries to loosen its own gate.
      yield* fs.writeFileString(`${root}/.workflowleaf/commands`, "test: exit 0\n");

      const result = yield* repoCommand(root, base, "test");
      assert.strictEqual(result.exitCode, 3);
      assert.include(result.stdout, "from-base");
    }).pipe(Effect.scoped),
  );

  it.effect("fails with a message that says what to add when a command is not declared", () =>
    Effect.gen(function* () {
      const { root, base } = yield* makeRepo("lint: true\n");
      const result = yield* repoCommand(root, base, "test");
      assert.strictEqual(result.exitCode, 2);
      assert.include(result.stderr, 'declares no "test:" line');
    }).pipe(Effect.scoped),
  );
});
