import { assert, describe, it } from "@effect/vitest";
import type { EvidenceRecord } from "@t3tools/workflowleaf-core";

import { groupByCause, learningEntries } from "./learningLog.ts";

function failedEvidence(runId: string, gateId: string, at: string): EvidenceRecord {
  return {
    runId,
    visitId: "visit-1",
    attemptId: "attempt-1",
    gateId,
    gateDigest: "gate",
    snapshotId: "snap",
    inputDigests: [],
    tool: "sh",
    toolVersion: "1",
    startedAt: at,
    endedAt: at,
    outcome: "failed",
    detail: { kind: "command", exitCode: 1, timedOut: false, passedCount: null, failedCount: 2 },
    logRef: `/logs/${runId}/${gateId}.log`,
    mutatedDuringCheck: false,
  } as never;
}

describe("the learning log", () => {
  it("groups recurring failures by cause, most frequent first, and counts people", () => {
    const entries = learningEntries({
      evidence: [
        failedEvidence("issue-1-1", "mapped-tests-pass", "2026-09-01T00:00:00.000Z"),
        failedEvidence("issue-2-1", "mapped-tests-pass", "2026-09-02T00:00:00.000Z"),
        failedEvidence("issue-2-1", "lint", "2026-09-02T00:00:01.000Z"),
      ],
      transitions: [
        {
          runId: "issue-2-1",
          seq: 4,
          at: "2026-09-02T00:00:02.000Z",
          input: '{"type":"gates-evaluated"}',
          effects:
            '[{"type":"raise-decision","decision":{"kind":"budget-exhausted","detail":"Stage build used all 3 attempts."}}]',
        },
        {
          runId: "issue-2-1",
          seq: 5,
          at: "2026-09-02T00:00:03.000Z",
          input:
            '{"type":"decision-answered","decisionId":"d-1","answer":"waive","planDigest":"p"}',
          effects: "[]",
        },
      ],
      limitations: [],
      runs: new Map(),
    });

    const groups = groupByCause(entries);
    assert.strictEqual(groups[0]?.cause, "gate mapped-tests-pass failed");
    assert.strictEqual(groups[0]?.count, 2);
    assert.deepStrictEqual(groups[0]?.runs, ["issue-1-1", "issue-2-1"]);
    assert.strictEqual(groups[0]?.latest.evidence, "/logs/issue-2-1/mapped-tests-pass.log");

    const answered = groups.find((group) => group.cause === "answered waive");
    assert.strictEqual(answered?.human, 1);
    const stopped = groups.find((group) => group.cause === "decision budget-exhausted");
    assert.include(stopped?.latest.detail ?? "", "used all 3 attempts");
  });
});
