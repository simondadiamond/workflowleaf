import { describe, expect, it } from "vite-plus/test";

import {
  dependentOn,
  satisfies,
  stalenessOf,
  type CurrentInputs,
  type EvidenceRecord,
} from "./evidence.ts";
import type { AttemptId, Digest, GateId, RunId, SnapshotId, VisitId } from "./ids.ts";

const digest = (value: string) => value as Digest;

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    runId: "run-1" as RunId,
    visitId: "visit-1" as VisitId,
    attemptId: "attempt-1" as AttemptId,
    gateId: "mapped-tests-pass" as GateId,
    gateDigest: digest("gate-v1"),
    snapshotId: "snap-1" as SnapshotId,
    inputDigests: [{ path: "src/a.ts", digest: digest("a-v1") }],
    tool: "node",
    toolVersion: "24.20.0",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:10.000Z",
    outcome: "passed",
    detail: { kind: "command", exitCode: 0, timedOut: false, passedCount: 215, failedCount: 0 },
    logRef: "logs/mapped-tests-pass.1.log",
    mutatedDuringCheck: false,
    ...overrides,
  };
}

function current(overrides: Partial<CurrentInputs> = {}): CurrentInputs {
  return {
    snapshotId: "snap-1" as SnapshotId,
    gateDigest: digest("gate-v1"),
    inputDigests: new Map([["src/a.ts", digest("a-v1")]]),
    ...overrides,
  };
}

describe("evidence validity", () => {
  it("accepts a pass produced from the current inputs", () => {
    expect(stalenessOf(record(), current())).toBeNull();
    expect(satisfies(record(), current())).toBe(true);
  });

  it("rejects a pass once the worktree changed", () => {
    expect(stalenessOf(record(), current({ snapshotId: "snap-2" as SnapshotId }))).toBe(
      "snapshot-changed",
    );
    expect(satisfies(record(), current({ snapshotId: "snap-2" as SnapshotId }))).toBe(false);
  });

  it("rejects a pass once the gate itself was redefined", () => {
    expect(stalenessOf(record(), current({ gateDigest: digest("gate-v2") }))).toBe(
      "gate-redefined",
    );
  });

  it("rejects a pass once an input artifact changed", () => {
    const changed = current({ inputDigests: new Map([["src/a.ts", digest("a-v2")]]) });
    expect(stalenessOf(record(), changed)).toBe("input-changed");
  });

  it("rejects a result whose tree moved underneath it", () => {
    expect(stalenessOf(record({ mutatedDuringCheck: true }), current())).toBe(
      "mutated-during-check",
    );
  });

  it("treats missing evidence as unsatisfied, never as a pass", () => {
    expect(satisfies(undefined, current())).toBe(false);
  });

  it("treats a recorded waiver as satisfied", () => {
    expect(satisfies(record({ outcome: "waived" }), current())).toBe(true);
  });

  it("does not let a failure satisfy a gate", () => {
    expect(satisfies(record({ outcome: "failed" }), current())).toBe(false);
  });

  it("does not let an infrastructure error satisfy a gate", () => {
    expect(satisfies(record({ outcome: "error" }), current())).toBe(false);
  });

  it("checks every input digest, not just the first", () => {
    const twoInputs = record({
      inputDigests: [
        { path: "src/a.ts", digest: digest("a-v1") },
        { path: "src/b.ts", digest: digest("b-v1") },
      ],
    });
    const changed = current({
      inputDigests: new Map([
        ["src/a.ts", digest("a-v1")],
        ["src/b.ts", digest("b-v2")],
      ]),
    });

    expect(stalenessOf(twoInputs, changed)).toBe("input-changed");
  });
});

describe("downstream invalidation", () => {
  it("finds every verdict that read a repaired artifact", () => {
    const records = [
      record({
        gateId: "build" as GateId,
        inputDigests: [{ path: "src/a.ts", digest: digest("a-v1") }],
      }),
      record({
        gateId: "lint" as GateId,
        inputDigests: [{ path: "src/b.ts", digest: digest("b-v1") }],
      }),
    ];

    expect(dependentOn(records, ["src/a.ts"]).map((one) => one.gateId)).toEqual(["build"]);
  });

  it("returns nothing when the change touched no recorded input", () => {
    expect(dependentOn([record()], ["docs/readme.md"])).toEqual([]);
  });
});

describe("run records written by earlier versions", () => {
  it("decode without the pull request and scope split fields they predate", async () => {
    const { RunRecord } = await import("./state.ts");
    const { Schema } = await import("effect");
    const old = {
      runId: "wl5a",
      planDigest: "sha256:p",
      workspaceId: "ws",
      state: "succeeded",
      revision: 3,
      currentStageId: null,
      visits: [],
      budget: { repairCycles: 0, maxRepairCycles: 2, deadlineAt: null },
      capabilities: {
        freshContext: true,
        sameContextContinuation: true,
        settledCompletion: true,
        interrupt: true,
        recovery: true,
      },
      decision: null,
      failure: null,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    };
    const decoded = Schema.decodeUnknownSync(RunRecord)(old);
    expect(decoded.pullRequest).toBeNull();
    expect(decoded.scopeSplit).toBeNull();
  });
});
