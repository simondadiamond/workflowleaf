import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  satisfies,
  type AttemptId,
  type Digest,
  type GateDefinition,
  type GateId,
  type RunId,
  type VisitId,
} from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  evaluateGate,
  externalEvidence,
  parseCounts,
  reviewEvidence,
  waiverEvidence,
  type GateContext,
} from "./gates.ts";
import { git } from "./git.ts";
import { takeSnapshot } from "./workspaces.ts";

/** A worktree-shaped directory: a git repo with one commit, used directly. */
const makeWorkspace = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const workspace = path.join(root, "work");
  yield* fs.makeDirectory(workspace, { recursive: true });

  yield* git(workspace, ["init", "-q", "-b", "main"]);
  yield* git(workspace, ["config", "user.email", "fixture@example.com"]);
  yield* git(workspace, ["config", "user.name", "Fixture"]);
  yield* fs.writeFileString(path.join(workspace, "README.md"), "# fixture\n");
  yield* git(workspace, ["add", "."]);
  yield* git(workspace, ["commit", "-qm", "initial"]);

  return { root, workspace, logDir: path.join(root, "logs") };
});

const contextFor = Effect.fnUntraced(function* (workspace: string, logDir: string) {
  return {
    runId: "run-1" as RunId,
    visitId: "visit-1" as VisitId,
    attemptId: "attempt-1" as AttemptId,
    workspacePath: workspace,
    gateDigest: "gate-v1" as Digest,
    logDir,
    baseline: yield* takeSnapshot(workspace, "t0"),
  } satisfies GateContext;
});

/** Quotes a path for embedding in a child process's inline script. */
const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const fileGate: Extract<GateDefinition, { type: "file" }> = {
  id: "artifact-has-content" as GateId,
  type: "file",
  path: "artifact.md",
  mustExist: true,
  minBytes: 8,
};

// Real child processes and real timeouts: this block runs on the live clock,
// not the test clock, so a gate's own timeout actually fires.
it.layer(NodeServices.layer, { excludeTestServices: true })("gate runner", (it) => {
  it.effect("fails a file gate when the stage produced nothing", () =>
    Effect.gen(function* () {
      const { workspace, logDir } = yield* makeWorkspace();
      const evidence = yield* evaluateGate(fileGate, yield* contextFor(workspace, logDir));

      assert.strictEqual(evidence.outcome, "failed");
      assert.deepStrictEqual(evidence.detail, {
        kind: "file",
        exists: false,
        bytes: null,
        missingContent: [],
        minBytes: 8,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("fails a file gate on a file too small to be real output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workspace, logDir } = yield* makeWorkspace();
      yield* fs.writeFileString(path.join(workspace, "artifact.md"), "x\n");

      const evidence = yield* evaluateGate(fileGate, yield* contextFor(workspace, logDir));
      assert.strictEqual(evidence.outcome, "failed");
    }).pipe(Effect.scoped),
  );

  it.effect("passes a file gate and pins the file it read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workspace, logDir } = yield* makeWorkspace();
      yield* fs.writeFileString(
        path.join(workspace, "artifact.md"),
        "a real paragraph of output\n",
      );

      const evidence = yield* evaluateGate(fileGate, yield* contextFor(workspace, logDir));

      assert.strictEqual(evidence.outcome, "passed");
      assert.deepStrictEqual(
        evidence.inputDigests.map((input) => input.path),
        ["artifact.md"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports missing required content, not just presence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workspace, logDir } = yield* makeWorkspace();
      yield* fs.writeFileString(path.join(workspace, "artifact.md"), "plenty of words here\n");

      const evidence = yield* evaluateGate(
        { ...fileGate, mustContain: ["## Unify — planned vs happened"] },
        yield* contextFor(workspace, logDir),
      );

      assert.strictEqual(evidence.outcome, "failed");
      if (evidence.detail.kind !== "file") return;
      assert.lengthOf(evidence.detail.missingContent, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("passes a command gate on the expected exit code and writes a log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { workspace, logDir } = yield* makeWorkspace();

      const evidence = yield* evaluateGate(
        {
          id: "build" as GateId,
          type: "command",
          executable: "node",
          args: ["-e", "console.log('2 passed | 0 failed')"],
          timeoutMs: 30_000,
          expect: { exitCode: 0 },
          parse: "tap",
        },
        yield* contextFor(workspace, logDir),
      );

      assert.strictEqual(evidence.outcome, "passed");
      if (evidence.detail.kind !== "command") return;
      assert.strictEqual(evidence.detail.passedCount, 2);
      assert.strictEqual(evidence.detail.failedCount, 0);
      assert.isNotNull(evidence.logRef);
      assert.isTrue(yield* fs.exists(evidence.logRef!));
    }).pipe(Effect.scoped),
  );

  it.effect("tells a command gate the run's base revision, so it can read config from there", () =>
    Effect.gen(function* () {
      const { workspace, logDir } = yield* makeWorkspace();
      const evidence = yield* evaluateGate(
        {
          id: "sees-base" as GateId,
          type: "command",
          executable: "/bin/sh",
          args: ["-c", 'test "$WORKFLOWLEAF_BASE_REVISION" = "base-123" && test -n "$PATH"'],
          timeoutMs: 10_000,
          expect: { exitCode: 0 },
        },
        { ...(yield* contextFor(workspace, logDir)), baseRevision: "base-123" },
      );
      assert.strictEqual(evidence.outcome, "passed");
    }).pipe(Effect.scoped),
  );

  it.effect("fails a command gate on a non-zero exit, regardless of what it printed", () =>
    Effect.gen(function* () {
      const { workspace, logDir } = yield* makeWorkspace();

      const evidence = yield* evaluateGate(
        {
          id: "build" as GateId,
          type: "command",
          executable: "node",
          args: ["-e", "console.log('all good'); process.exit(3)"],
          timeoutMs: 30_000,
          expect: { exitCode: 0 },
        },
        yield* contextFor(workspace, logDir),
      );

      assert.strictEqual(evidence.outcome, "failed");
      if (evidence.detail.kind !== "command") return;
      assert.strictEqual(evidence.detail.exitCode, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("records a gate that cannot be started rather than taking the run down", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { workspace, logDir } = yield* makeWorkspace();

      const evidence = yield* evaluateGate(
        {
          id: "build" as GateId,
          // A playbook that ships its own check script and gets the path wrong
          // used to abort the whole run with an ENOENT from the spawner.
          type: "command",
          executable: "gates/not-a-real-script.sh",
          args: [],
          timeoutMs: 30_000,
          expect: { exitCode: 0 },
        },
        yield* contextFor(workspace, logDir),
      );

      assert.strictEqual(evidence.outcome, "error");
      if (evidence.detail.kind !== "command") return;
      assert.isNull(evidence.detail.exitCode);
      assert.isFalse(evidence.detail.timedOut);
      assert.isNotNull(evidence.logRef);
      assert.include(
        yield* fs.readFileString(evidence.logRef!),
        "gates/not-a-real-script.sh could not be started",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("records a timeout as infrastructure, not as a failing assertion", () =>
    Effect.gen(function* () {
      const { workspace, logDir } = yield* makeWorkspace();

      const evidence = yield* evaluateGate(
        {
          id: "slow" as GateId,
          type: "command",
          executable: "node",
          args: ["-e", "setTimeout(() => {}, 60000)"],
          timeoutMs: 250,
          expect: { exitCode: 0 },
        },
        yield* contextFor(workspace, logDir),
      );

      assert.strictEqual(evidence.outcome, "error");
      if (evidence.detail.kind !== "command") return;
      assert.isTrue(evidence.detail.timedOut);
    }).pipe(Effect.scoped),
  );

  it.effect("marks a pass stale when the worktree moved while the check ran", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { workspace, logDir } = yield* makeWorkspace();
      const target = path.join(workspace, "artifact.md");

      const evidence = yield* evaluateGate(
        {
          id: "writes-while-checking" as GateId,
          type: "command",
          executable: "node",
          args: [
            "-e",
            `require("node:fs").writeFileSync(${quoted(target)}, "written mid-check\\n")`,
          ],
          timeoutMs: 30_000,
          expect: { exitCode: 0 },
        },
        yield* contextFor(workspace, logDir),
      );

      assert.isTrue(evidence.mutatedDuringCheck);
      assert.strictEqual(evidence.outcome, "stale");
    }).pipe(Effect.scoped),
  );

  it.effect("fails a diff gate when the stage touched a file outside its plan", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workspace, logDir } = yield* makeWorkspace();
      const context = yield* contextFor(workspace, logDir);

      yield* fs.writeFileString(
        path.join(workspace, "unrelated.ts"),
        "export const surprise = 1;\n",
      );

      const evidence = yield* evaluateGate(
        {
          id: "diff-within-plan" as GateId,
          type: "diff",
          allowedPaths: ["src/**"],
        },
        context,
      );

      assert.strictEqual(evidence.outcome, "failed");
      if (evidence.detail.kind !== "diff") return;
      assert.deepStrictEqual([...evidence.detail.outsideScope], ["unrelated.ts"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to decide a review gate on its own", () =>
    Effect.gen(function* () {
      const { workspace, logDir } = yield* makeWorkspace();

      const evidence = yield* evaluateGate(
        {
          id: "no-blocking-findings" as GateId,
          type: "review",
          rubric: "Every finding names a concrete failure scenario.",
          blockingSeverities: ["block"],
        },
        yield* contextFor(workspace, logDir),
      );

      assert.strictEqual(evidence.outcome, "error");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to decide an external gate for a run with no pull request", () =>
    Effect.gen(function* () {
      const { workspace, logDir } = yield* makeWorkspace();

      const evidence = yield* evaluateGate(
        {
          id: "ci-green" as GateId,
          type: "external",
          check: "checks-green",
          boundTo: "head-sha",
        },
        yield* contextFor(workspace, logDir),
      );

      assert.strictEqual(evidence.outcome, "error");
      if (evidence.detail.kind !== "external") return;
      assert.strictEqual(evidence.detail.state, "unavailable");
    }).pipe(Effect.scoped),
  );
});

describe("judgment and integration evidence", () => {
  const context: GateContext = {
    runId: "run-1" as RunId,
    visitId: "visit-1" as VisitId,
    attemptId: "attempt-1" as AttemptId,
    workspacePath: "/tmp/work",
    gateDigest: "gate-v1" as Digest,
    logDir: "/tmp/logs",
    baseline: { snapshotId: "snap-1" as never, takenAt: "t0", exclusions: [], files: [] },
  };

  it("records a review verdict as judgment, with its findings", () => {
    const evidence = reviewEvidence({
      context,
      gate: {
        id: "no-blocking-findings" as GateId,
        type: "review",
        rubric: "r",
        blockingSeverities: ["block"],
      },
      findings: [{ severity: "nit", summary: "naming", failureScenario: "none" }],
      snapshotId: "snap-1" as never,
      startedAt: "t0",
      endedAt: "t1",
      reviewer: "fresh-context",
    });

    assert.strictEqual(evidence.outcome, "passed");
    assert.strictEqual(evidence.tool, "review:fresh-context");
  });

  it("blocks on a finding at a blocking severity", () => {
    const evidence = reviewEvidence({
      context,
      gate: {
        id: "no-blocking-findings" as GateId,
        type: "review",
        rubric: "r",
        blockingSeverities: ["block"],
      },
      findings: [{ severity: "block", summary: "drops the lock", failureScenario: "two writers" }],
      snapshotId: "snap-1" as never,
      startedAt: "t0",
      endedAt: "t1",
      reviewer: "fresh-context",
    });

    assert.strictEqual(evidence.outcome, "failed");
  });

  it("refuses an external result it cannot attribute to this revision", () => {
    const evidence = externalEvidence({
      context,
      gate: {
        id: "ci-green" as GateId,
        type: "external",
        check: "checks-green",
        boundTo: "head-sha",
      },
      boundValue: "deadbeef",
      expectedBoundValue: "cafebabe",
      satisfied: true,
      detail: "all checks green",
      snapshotId: "snap-1" as never,
      startedAt: "t0",
      endedAt: "t1",
    });

    assert.strictEqual(evidence.outcome, "failed");
    if (evidence.detail.kind !== "external") return;
    assert.strictEqual(evidence.detail.state, "unattributed");
  });

  it("accepts an external result bound to the revision under test", () => {
    const evidence = externalEvidence({
      context,
      gate: {
        id: "ci-green" as GateId,
        type: "external",
        check: "checks-green",
        boundTo: "head-sha",
      },
      boundValue: "cafebabe",
      expectedBoundValue: "cafebabe",
      satisfied: true,
      detail: "all checks green",
      snapshotId: "snap-1" as never,
      startedAt: "t0",
      endedAt: "t1",
    });

    assert.strictEqual(evidence.outcome, "passed");
  });

  it("keeps a waiver attributable to whoever granted it", () => {
    const failed = externalEvidence({
      context,
      gate: {
        id: "ci-green" as GateId,
        type: "external",
        check: "checks-green",
        boundTo: "head-sha",
      },
      boundValue: "cafebabe",
      expectedBoundValue: "cafebabe",
      satisfied: false,
      detail: "one flaky check",
      snapshotId: "snap-1" as never,
      startedAt: "t0",
      endedAt: "t1",
    });

    const waived = waiverEvidence({
      evidence: failed,
      by: "simon",
      reason: "known flake",
      at: "t2",
    });

    assert.strictEqual(waived.outcome, "waived");
    assert.strictEqual(waived.tool, "waiver:simon");
    assert.isTrue(
      satisfies(waived, {
        snapshotId: waived.snapshotId,
        gateDigest: waived.gateDigest,
        inputDigests: new Map(),
      }),
    );
  });
});

describe("result counts", () => {
  it("reads a passed/failed summary line", () => {
    assert.deepStrictEqual(parseCounts("Tests  215 passed | 3 failed (218)"), {
      passed: 215,
      failed: 3,
    });
  });

  it("falls back to counting TAP lines", () => {
    assert.deepStrictEqual(parseCounts("ok 1 a\nnot ok 2 b\nok 3 c\n"), { passed: 2, failed: 1 });
  });

  it("reports nothing rather than guessing when the output has no counts", () => {
    assert.deepStrictEqual(parseCounts("built in 3s\n"), { passed: null, failed: null });
  });
});
