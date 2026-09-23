import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { commandGatePlan } from "@t3tools/workflowleaf-core/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";

import type { GateVerdict } from "@t3tools/workflowleaf-core";

import { formatProgress, playbookDirFor, wlCommand } from "./cli.ts";
import type { Profile } from "./profile.ts";
import { DEFAULT_REVIEWER } from "./reviewer.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerMemory } from "./store/Sqlite.ts";
import { gateDetails, progressLine } from "./worker.ts";

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
  const verdicts: GateVerdict[] = [
    { gateId: "tests" as never, outcome: "failed", summary: "exit 1, 2 failing\nstack trace" },
    { gateId: "lint" as never, outcome: "passed", summary: "exit 0" },
  ];
  const line = formatProgress({
    kind: "gates",
    stageId: "build",
    verdicts,
    details: gateDetails(undefined, verdicts),
  });

  assert.include(line, "tests failed, lint passed");
  assert.include(line, "exit 1, 2 failing");
  assert.notInclude(line, "stack trace");
});

// The same services bin.ts provides, over an empty in-memory store.
const cliServices = Layer.mergeAll(
  RunStore.layer.pipe(Layer.provide(layerMemory)),
  NodeHttpClient.layerUndici,
  NodeSocket.layerWebSocketConstructor,
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(cliServices)("wl errors", (it) => {
  it.effect("prints the grouped view without --json, the form every document names", () =>
    Effect.gen(function* () {
      const outcome = yield* Command.runWith(wlCommand, { version: "0.0.0" })([
        "errors",
        "--since",
        "1d",
      ]).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Success");
    }),
  );
});

it("the progress log says what an external gate saw, even when it passed", () => {
  const stage = commandGatePlan().stages[0]!;
  const external = {
    ...stage,
    gates: [
      ...stage.gates,
      {
        definition: {
          id: "converged" as never,
          type: "external" as const,
          check: "converged-on-head",
          boundTo: "head-sha" as const,
        },
        digest: "sha256:x" as never,
      },
    ],
  };
  const verdicts: GateVerdict[] = [
    { gateId: stage.gates[0]!.definition.id, outcome: "passed", summary: "exit 0" },
    {
      gateId: "converged" as never,
      outcome: "passed",
      summary: "converged-on-head: satisfied. Reviewed on this head by copilot.\nmore",
    },
  ];
  const line = progressLine("T", {
    kind: "gates",
    stageId: "babysit",
    verdicts,
    details: gateDetails(external as never, verdicts),
  });
  assert.include(
    line,
    "converged=passed [converged-on-head: satisfied. Reviewed on this head by copilot.]",
  );
  assert.notInclude(line, "exit 0");
  assert.notInclude(line, "more");
});
