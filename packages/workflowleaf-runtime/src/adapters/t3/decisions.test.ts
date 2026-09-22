import { describe, expect, it } from "vite-plus/test";
import type { DecisionId, DecisionRequest, RunId } from "@t3tools/workflowleaf-core";

import { answerFromActivities, decisionPrompt } from "./decisions.ts";

const asked = { kind: "user-input.requested", payload: { requestId: "r1", questions: [] } };
const resolved = (answers: unknown) => ({
  kind: "user-input.resolved",
  payload: { requestId: "r1", answers },
});

describe("reading a decision off its thread", () => {
  it("takes the option the person selected, keyed however the provider keys it", () => {
    const question =
      "issue-3-1 needs a decision (budget-exhausted). Stage build used all 3 attempts.";
    expect(answerFromActivities([asked, resolved({ [question]: "waive" })])).toBe("waive");
    expect(answerFromActivities([asked, resolved({ q1: ["Abort"] })])).toBe("abort");
  });

  it("reads no answer while the question is open", () => {
    expect(answerFromActivities([asked])).toBeNull();
  });

  it("reads a dismissed question or a free-text reply as no answer, never as a choice", () => {
    expect(answerFromActivities([asked, resolved({})])).toBeNull();
    expect(answerFromActivities([asked, resolved({ q1: "let me think about it" })])).toBeNull();
    expect(
      answerFromActivities([asked, { kind: "user-input.resolved", payload: { requestId: "r1" } }]),
    ).toBeNull();
  });
});

describe("the decision prompt", () => {
  it("names the run, the decision and the three answers the reader understands", () => {
    const request: DecisionRequest = {
      runId: "issue-3-1" as RunId,
      decision: {
        decisionId: "decision-1" as DecisionId,
        kind: "scope-split",
        detail: "The retry fix needs its own pull request.",
        raisedAt: "2026-01-01T00:00:00.000Z",
        planDigest: "sha256:plan" as never,
      },
      workspacePath: "/worktrees/issue-3-1",
      branch: "workflowleaf/issue-3-1",
      pullRequestUrl: "https://github.com/o/r/pull/4",
    };
    const prompt = decisionPrompt(request);
    expect(prompt).toContain("WL-DECISION: issue-3-1/decision-1");
    expect(prompt).toContain("The retry fix needs its own pull request.");
    for (const label of ["proceed", "waive", "abort"]) expect(prompt).toContain(`  - ${label}:`);
    expect(prompt).toContain("wl decide issue-3-1 <answer>");
  });
});
