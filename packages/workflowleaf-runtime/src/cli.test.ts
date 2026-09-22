import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { formatProgress, playbookDirFor } from "./cli.ts";
import type { Profile } from "./profile.ts";
import { DEFAULT_REVIEWER } from "./reviewer.ts";

const profile = (defaultPlaybook?: string): Profile => ({
  name: "fixture",
  executor: { kind: "fake" },
  repoRoot: "/repo",
  worktreeRoot: "/worktrees",
  ...(defaultPlaybook === undefined ? {} : { defaultPlaybook }),
  skillRoots: [],
  reviewer: DEFAULT_REVIEWER,
  budgets: { maxRepairCycles: 2, runDeadlineMs: null },
  permissions: {
    createPullRequest: false,
    commentOnPullRequest: false,
    merge: false,
    deploy: false,
    liveCanary: false,
  },
});

it.layer(NodeServices.layer)("which playbook a command means", (it) => {
  it.effect(
    "falls back to the profile, so a portable playbook keeps its path out of the caller",
    () =>
      Effect.gen(function* () {
        const resolved = yield* playbookDirFor(Option.none(), profile("/playbooks/t1"));
        assert.strictEqual(resolved, "/playbooks/t1");
      }),
  );

  it.effect(
    "prefers the one typed on the command line, because a repository has more than one",
    () =>
      Effect.gen(function* () {
        const resolved = yield* playbookDirFor(
          Option.some("/playbooks/t2"),
          profile("/playbooks/t1"),
        );
        assert.strictEqual(resolved, "/playbooks/t2");
      }),
  );

  it.effect("refuses rather than guesses when neither names one", () =>
    Effect.gen(function* () {
      const outcome = yield* playbookDirFor(Option.none(), profile()).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
    }),
  );
});

it("a failing gate's verdict carries its first line of detail", () => {
  const line = formatProgress({
    kind: "gates",
    stageId: "build",
    verdicts: [
      { gateId: "tests" as never, outcome: "failed", summary: "exit 1, 2 failing\nstack trace" },
      { gateId: "lint" as never, outcome: "passed", summary: "exit 0" },
    ],
  });

  assert.include(line, "tests failed, lint passed");
  assert.include(line, "exit 1, 2 failing");
  assert.notInclude(line, "stack trace");
});
