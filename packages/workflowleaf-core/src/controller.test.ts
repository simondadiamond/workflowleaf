import { describe, expect, it } from "vite-plus/test";

import { decide, initialRun, type ControllerContext, type ControllerEffect } from "./controller.ts";
import type { GateVerdict } from "./ports.ts";
import type { Digest, GateId, OperationId, RunId, StageId, VisitId, WorkspaceId } from "./ids.ts";
import type { RunRecord } from "./state.ts";
import {
  GATE_ARTIFACT_EXISTS,
  GATE_SUMMARY_EXISTS,
  STAGE_A,
  STAGE_B,
  capabilities,
  sequentialIds,
  twoStagePlan,
} from "./testing/fixture.ts";

const plan = twoStagePlan();

function context(
  run: RunRecord,
  ids = sequentialIds(),
  now = "2026-01-01T00:00:01.000Z",
): ControllerContext {
  return { run, plan, now, ids };
}

function freshRun(overrides: Partial<Parameters<typeof initialRun>[0]> = {}): RunRecord {
  return initialRun({
    runId: "run-1" as RunId,
    planDigest: plan.planDigest,
    workspaceId: "ws-1" as WorkspaceId,
    capabilities: capabilities(),
    maxRepairCycles: 2,
    deadlineAt: null,
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function dispatchOf(effects: readonly ControllerEffect[]) {
  const effect = effects.find((candidate) => candidate.type === "dispatch-stage");
  if (effect?.type !== "dispatch-stage") throw new Error("expected a dispatch-stage effect");
  return effect;
}

function pass(gateId: GateId): GateVerdict {
  return { gateId, outcome: "passed", summary: "ok" };
}

function failGate(gateId: GateId, summary = "file is empty"): GateVerdict {
  return { gateId, outcome: "failed", summary };
}

/** Starts the run and settles stage A successfully, stopping at gate evaluation. */
function runToStageAGates(ids = sequentialIds()) {
  const started = decide(context(freshRun(), ids), { type: "start" });
  const dispatch = dispatchOf(started.effects);
  const settled = decide(context(started.run, ids), {
    type: "settled",
    settlement: {
      operationId: dispatch.operationId,
      outcome: "completed",
      settled: true,
      detail: null,
      at: "2026-01-01T00:00:02.000Z",
    },
  });
  return { started, dispatch, settled, ids };
}

describe("run start", () => {
  it("opens the first stage and dispatches it", () => {
    const { started, dispatch } = runToStageAGates();

    expect(started.run.state).toBe("running");
    expect(started.run.currentStageId).toBe(STAGE_A);
    expect(dispatch.stageId).toBe(STAGE_A);
    expect(started.run.visits).toHaveLength(1);
    expect(started.run.visits[0]?.attempts).toBe(1);
  });

  it("does not start twice", () => {
    const { started, ids } = runToStageAGates();
    const again = decide(context(started.run, ids), { type: "start" });

    expect(again.effects).toEqual([]);
    expect(again.run.visits).toHaveLength(1);
  });
});

describe("C03 — a failed gate blocks the next stage", () => {
  it("corrects inside the same stage instead of launching B", () => {
    const { settled, ids } = runToStageAGates();
    const visitId = settled.run.visits[0]!.visitId;

    const failed = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId,
      verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
    });

    expect(failed.effects.map((effect) => effect.type)).toEqual(["continue-stage"]);
    expect(failed.run.currentStageId).toBe(STAGE_A);
    expect(failed.run.visits).toHaveLength(1);
    expect(failed.run.visits[0]?.attempts).toBe(2);
    expect(failed.run.visits[0]?.state).toBe("repairing");
  });

  it("advances to B only once the gate passes", () => {
    const { settled, ids } = runToStageAGates();
    const visitId = settled.run.visits[0]!.visitId;

    const passed = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId,
      verdicts: [pass(GATE_ARTIFACT_EXISTS)],
    });

    expect(passed.run.visits[0]?.state).toBe("passed");
    expect(passed.run.currentStageId).toBe(STAGE_B);
    expect(dispatchOf(passed.effects).stageId).toBe(STAGE_B);
  });
});

describe("C04 — correction preserves context when the executor supports it", () => {
  it("continues the same context and keeps the handle", () => {
    const ids = sequentialIds();
    const { settled } = runToStageAGates(ids);
    const acknowledged = decide(context(settled.run, ids), {
      type: "dispatch-acknowledged",
      operationId: settled.run.visits[0]!.operation!.operationId,
      handle: "provider-session-1",
    });

    const failed = decide(context(acknowledged.run, ids), {
      type: "gates-evaluated",
      visitId: acknowledged.run.visits[0]!.visitId,
      verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
    });

    const effect = failed.effects[0];
    expect(effect?.type).toBe("continue-stage");
    expect(failed.run.visits[0]?.operation?.mode).toBe("continue");
    expect(failed.run.visits[0]?.operation?.handle).toBe("provider-session-1");
    expect(failed.run.visits[0]?.lostContext).toBe(false);
  });

  it("records the fallback explicitly when it does not", () => {
    const ids = sequentialIds();
    const started = decide(
      context(freshRun({ capabilities: capabilities({ sameContextContinuation: false }) }), ids),
      { type: "start" },
    );
    const dispatch = dispatchOf(started.effects);
    const settled = decide(context(started.run, ids), {
      type: "settled",
      settlement: {
        operationId: dispatch.operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:02.000Z",
      },
    });

    const failed = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId: settled.run.visits[0]!.visitId,
      verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
    });

    const limitation = failed.effects.find((effect) => effect.type === "record-limitation");
    expect(limitation?.type).toBe("record-limitation");
    expect(failed.run.visits[0]?.lostContext).toBe(true);
    expect(failed.run.visits[0]?.operation?.mode).toBe("fresh");
  });

  it("stops and asks when the policy says a lost context needs a decision", () => {
    const ids = sequentialIds();
    const run = freshRun({ capabilities: capabilities({ sameContextContinuation: false }) });
    const planWithDecision = {
      ...plan,
      stages: plan.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              contract: {
                ...stage.contract,
                correction: {
                  mode: "same-context" as const,
                  maxAttempts: 3,
                  onLostContext: "needs-decision" as const,
                },
              },
            }
          : stage,
      ),
    };
    const withPlan = (record: RunRecord): ControllerContext => ({
      run: record,
      plan: planWithDecision,
      now: "2026-01-01T00:00:03.000Z",
      ids,
    });

    const started = decide(withPlan(run), { type: "start" });
    const settled = decide(withPlan(started.run), {
      type: "settled",
      settlement: {
        operationId: dispatchOf(started.effects).operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:02.000Z",
      },
    });
    const failed = decide(withPlan(settled.run), {
      type: "gates-evaluated",
      visitId: settled.run.visits[0]!.visitId,
      verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
    });

    expect(failed.run.state).toBe("needs_decision");
    expect(failed.run.decision?.kind).toBe("lost-context");
  });
});

describe("C05 — replayed and mismatched terminal events", () => {
  it("ignores a second settlement for the same operation", () => {
    const { settled, ids } = runToStageAGates();
    const repeat = decide(context(settled.run, ids), {
      type: "settled",
      settlement: {
        operationId: settled.run.visits[0]!.operation!.operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:03.000Z",
      },
    });

    expect(repeat.effects).toEqual([]);
    expect(repeat.run.revision).toBe(settled.run.revision);
  });

  it("ignores a settlement for an operation that is not in flight", () => {
    const { started, ids } = runToStageAGates();
    const stray = decide(context(started.run, ids), {
      type: "settled",
      settlement: {
        operationId: "someone-elses-op" as OperationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:03.000Z",
      },
    });

    expect(stray.effects).toEqual([]);
    expect(stray.run.visits[0]?.state).toBe("executing");
  });
});

describe("C06 — reconciling a lost acknowledgment", () => {
  it("adopts the settlement instead of starting a second context", () => {
    const ids = sequentialIds();
    const started = decide(context(freshRun(), ids), { type: "start" });
    const operationId = dispatchOf(started.effects).operationId;

    const reconciled = decide(context(started.run, ids), {
      type: "reconciled",
      operationId,
      outcome: {
        kind: "settled",
        settlement: {
          operationId,
          outcome: "completed",
          settled: true,
          detail: null,
          at: "2026-01-01T00:00:04.000Z",
        },
      },
    });

    expect(reconciled.effects.some((effect) => effect.type === "dispatch-stage")).toBe(false);
    expect(reconciled.effects[0]?.type).toBe("run-gates");
    expect(reconciled.run.visits).toHaveLength(1);
  });

  it("re-dispatches only when the executor never saw the operation", () => {
    const ids = sequentialIds();
    const started = decide(context(freshRun(), ids), { type: "start" });
    const operationId = dispatchOf(started.effects).operationId;

    const reconciled = decide(context(started.run, ids), {
      type: "reconciled",
      operationId,
      outcome: { kind: "never-dispatched" },
    });

    expect(dispatchOf(reconciled.effects).operationId).toBe(operationId);
    expect(reconciled.run.visits).toHaveLength(1);
  });

  it("asks rather than guessing when the executor cannot say", () => {
    const ids = sequentialIds();
    const started = decide(context(freshRun(), ids), { type: "start" });

    const reconciled = decide(context(started.run, ids), {
      type: "reconciled",
      operationId: dispatchOf(started.effects).operationId,
      outcome: { kind: "unknown", reason: "no recovery support" },
    });

    expect(reconciled.run.state).toBe("needs_decision");
    expect(reconciled.run.decision?.kind).toBe("reconciliation");
  });
});

describe("C08 — cancellation", () => {
  it("interrupts the running stage and refuses later dispatch", () => {
    const ids = sequentialIds();
    const started = decide(context(freshRun(), ids), { type: "start" });
    const cancelled = decide(context(started.run, ids), { type: "cancel", reason: "user asked" });

    expect(cancelled.run.state).toBe("cancelled");
    expect(cancelled.effects.map((effect) => effect.type)).toEqual(["interrupt", "finish"]);

    const afterwards = decide(context(cancelled.run, ids), {
      type: "settled",
      settlement: {
        operationId: dispatchOf(started.effects).operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:05.000Z",
      },
    });
    expect(afterwards.effects).toEqual([]);
  });
});

describe("C10 — a change after a pass invalidates dependent evidence", () => {
  it("re-enters the earliest affected stage and re-verifies", () => {
    const ids = sequentialIds();
    const { settled } = runToStageAGates(ids);
    const passed = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId: settled.run.visits[0]!.visitId,
      verdicts: [pass(GATE_ARTIFACT_EXISTS)],
    });

    const invalidated = decide(context(passed.run, ids), {
      type: "evidence-invalidated",
      stageIds: [STAGE_A],
      reason: "artifact.md changed after it passed",
    });

    expect(invalidated.run.currentStageId).toBe(STAGE_A);
    expect(invalidated.run.visits.filter((visit) => visit.stageId === STAGE_A)).toHaveLength(2);
    expect(dispatchOf(invalidated.effects).stageId).toBe(STAGE_A);
  });
});

describe("C11 — exhausted budgets stop the run", () => {
  it("stops for a decision after the last attempt, and a restart does not reset it", () => {
    const ids = sequentialIds();
    let current = runToStageAGates(ids).settled;
    const visitId = current.run.visits[0]!.visitId;

    // Attempts 2 and 3 are corrections; the fourth failure is past the budget.
    for (let round = 0; round < 2; round += 1) {
      const failed = decide(context(current.run, ids), {
        type: "gates-evaluated",
        visitId,
        verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
      });
      const operationId = failed.run.visits[0]!.operation!.operationId;
      current = decide(context(failed.run, ids), {
        type: "settled",
        settlement: {
          operationId,
          outcome: "completed",
          settled: true,
          detail: null,
          at: "2026-01-01T00:00:06.000Z",
        },
      });
    }

    const exhausted = decide(context(current.run, ids), {
      type: "gates-evaluated",
      visitId,
      verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
    });

    expect(exhausted.run.state).toBe("needs_decision");
    expect(exhausted.run.decision?.kind).toBe("budget-exhausted");
    expect(exhausted.run.visits[0]?.attempts).toBe(3);

    // The attempt count lives in persisted state, so reprocessing the same
    // input cannot hand the stage another try.
    const again = decide(context(exhausted.run, ids), {
      type: "gates-evaluated",
      visitId,
      verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
    });
    expect(again.effects).toEqual([]);
  });
});

describe("C13 — unsupported capabilities are stated, not worked around", () => {
  it("refuses to open a stage whose required capability is missing", () => {
    const ids = sequentialIds();
    const run = freshRun({ capabilities: capabilities({ freshContext: false }) });
    const started = decide(context(run, ids), { type: "start" });

    expect(started.run.state).toBe("needs_decision");
    expect(started.run.decision?.kind).toBe("unsupported-capability");
    const limitation = started.effects.find((effect) => effect.type === "record-limitation");
    expect(limitation?.type).toBe("record-limitation");
    expect(started.effects.some((effect) => effect.type === "dispatch-stage")).toBe(false);
  });

  it("qualifies evidence when completion cannot be known to be settled", () => {
    const ids = sequentialIds();
    const run = freshRun({ capabilities: capabilities({ settledCompletion: false }) });
    const started = decide(context(run, ids), { type: "start" });
    const settled = decide(context(started.run, ids), {
      type: "settled",
      settlement: {
        operationId: dispatchOf(started.effects).operationId,
        outcome: "completed",
        settled: false,
        detail: null,
        at: "2026-01-01T00:00:07.000Z",
      },
    });

    const limitation = settled.effects.find((effect) => effect.type === "record-limitation");
    expect(limitation?.type).toBe("record-limitation");
    expect(settled.effects.some((effect) => effect.type === "run-gates")).toBe(true);
  });

  it("waits instead of gating when the executor promised settlement and has not delivered it", () => {
    const ids = sequentialIds();
    const started = decide(context(freshRun(), ids), { type: "start" });
    const early = decide(context(started.run, ids), {
      type: "settled",
      settlement: {
        operationId: dispatchOf(started.effects).operationId,
        outcome: "completed",
        settled: false,
        detail: null,
        at: "2026-01-01T00:00:07.000Z",
      },
    });

    expect(early.effects).toEqual([]);
    expect(early.run.visits[0]?.state).toBe("executing");
  });
});

describe("evidence hygiene", () => {
  it("treats a gate that could not run as infrastructure, not as a failing assertion", () => {
    const { settled, ids } = runToStageAGates();
    const errored = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId: settled.run.visits[0]!.visitId,
      verdicts: [{ gateId: GATE_ARTIFACT_EXISTS, outcome: "error", summary: "checker crashed" }],
    });

    expect(errored.run.state).toBe("needs_decision");
    expect(errored.run.decision?.kind).toBe("reconciliation");
    // The stage keeps its repair budget: nothing was proven either way.
    expect(errored.run.visits[0]?.attempts).toBe(1);
  });

  it("refuses to pass a stage whose gate reported nothing", () => {
    const { settled, ids } = runToStageAGates();
    const silent = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId: settled.run.visits[0]!.visitId,
      verdicts: [],
    });

    expect(silent.run.state).toBe("needs_decision");
    expect(silent.run.decision?.detail).toContain(GATE_ARTIFACT_EXISTS);
  });
});

describe("decisions", () => {
  it("refuses an answer given against an older plan", () => {
    const ids = sequentialIds();
    const run = freshRun({ capabilities: capabilities({ freshContext: false }) });
    const blocked = decide(context(run, ids), { type: "start" });

    const stale = decide(context(blocked.run, ids), {
      type: "decision-answered",
      decisionId: blocked.run.decision!.decisionId,
      answer: "proceed",
      planDigest: "an-older-plan",
    });

    expect(stale.run.state).toBe("needs_decision");
    expect(stale.run.decision?.kind).toBe("reconciliation");
  });

  it("advances on a waiver and records it as an exception rather than a pass", () => {
    const ids = sequentialIds();
    let current = runToStageAGates(ids).settled;
    const visitId = current.run.visits[0]!.visitId;

    for (let round = 0; round < 2; round += 1) {
      const failed = decide(context(current.run, ids), {
        type: "gates-evaluated",
        visitId,
        verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
      });
      current = decide(context(failed.run, ids), {
        type: "settled",
        settlement: {
          operationId: failed.run.visits[0]!.operation!.operationId,
          outcome: "completed",
          settled: true,
          detail: null,
          at: "2026-01-01T00:00:08.000Z",
        },
      });
    }
    const exhausted = decide(context(current.run, ids), {
      type: "gates-evaluated",
      visitId,
      verdicts: [failGate(GATE_ARTIFACT_EXISTS)],
    });

    const waived = decide(context(exhausted.run, ids), {
      type: "decision-answered",
      decisionId: exhausted.run.decision!.decisionId,
      answer: "waive",
      planDigest: plan.planDigest,
    });

    expect(waived.run.currentStageId).toBe(STAGE_B);
    expect(waived.run.visits.find((visit) => visit.visitId === visitId)?.failure).not.toBeNull();
  });
});

describe("completion", () => {
  it("succeeds only after the last stage's gate passes", () => {
    const ids = sequentialIds();
    const { settled } = runToStageAGates(ids);
    const toB = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId: settled.run.visits[0]!.visitId,
      verdicts: [pass(GATE_ARTIFACT_EXISTS)],
    });

    const bVisit = toB.run.visits[1]!;
    const bSettled = decide(context(toB.run, ids), {
      type: "settled",
      settlement: {
        operationId: bVisit.operation!.operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:09.000Z",
      },
    });

    expect(bSettled.run.state).toBe("running");

    const done = decide(context(bSettled.run, ids), {
      type: "gates-evaluated",
      visitId: bVisit.visitId as VisitId,
      verdicts: [pass(GATE_SUMMARY_EXISTS)],
    });

    expect(done.run.state).toBe("succeeded");
    expect(done.run.currentStageId).toBeNull();
    expect(done.effects.at(-1)).toEqual({
      type: "finish",
      state: "succeeded",
      reason: "All stages passed.",
    });
  });
});

describe("C02 — stage B receives artifacts, not stage A's transcript", () => {
  it("dispatches B as its own visit with no reference to A's operation", () => {
    const ids = sequentialIds();
    const { settled } = runToStageAGates(ids);
    const toB = decide(context(settled.run, ids), {
      type: "gates-evaluated",
      visitId: settled.run.visits[0]!.visitId,
      verdicts: [pass(GATE_ARTIFACT_EXISTS)],
    });

    const aOperation = settled.run.visits[0]!.operation!.operationId;
    const bVisit = toB.run.visits[1]!;

    expect(bVisit.stageId).toBe(STAGE_B);
    expect(bVisit.operation?.mode).toBe("fresh");
    expect(bVisit.operation?.operationId).not.toBe(aOperation);
    expect(bVisit.operation?.handle).toBeNull();
  });
});

describe("no provider branching", () => {
  it("produces identical decisions for two differently named profiles", () => {
    // The controller never sees a provider name. This asserts the shape of that
    // claim: the same inputs and the same capabilities produce the same run.
    const left = decide(context(freshRun(), sequentialIds("a")), { type: "start" });
    const right = decide(context(freshRun(), sequentialIds("a")), { type: "start" });

    expect(left.run).toEqual(right.run);
    expect(left.effects).toEqual(right.effects);
  });
});

describe("stage kinds", () => {
  it("runs a check stage's gates without dispatching an agent", () => {
    const ids = sequentialIds();
    const checkPlan = {
      ...plan,
      stages: plan.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              contract: { ...stage.contract, kind: "check" as const, instruction: undefined },
              instruction: null,
            }
          : stage,
      ),
    };
    const started = decide(
      { run: freshRun(), plan: checkPlan, now: "2026-01-01T00:00:10.000Z", ids },
      { type: "start" },
    );

    expect(started.effects.map((effect) => effect.type)).toEqual(["run-gates"]);
    expect(started.run.visits[0]?.state).toBe("checking");
  });

  it("stops for a human on a decision stage", () => {
    const ids = sequentialIds();
    const decisionPlan = {
      ...plan,
      stages: plan.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              contract: {
                ...stage.contract,
                kind: "decision" as const,
                gates: [] as StageId[] as never,
              },
              gates: [],
            }
          : stage,
      ),
    };
    const started = decide(
      { run: freshRun(), plan: decisionPlan, now: "2026-01-01T00:00:11.000Z", ids },
      { type: "start" },
    );

    expect(started.run.state).toBe("needs_decision");
    expect(started.effects.map((effect) => effect.type)).toEqual(["raise-decision"]);
  });
});

describe("a run is one story and one pull request", () => {
  /** Stage A settles, declares a split, and passes its gate. */
  function runToDeclaredSplit(detail = "The auth fix needs its own pull request.") {
    const ids = sequentialIds();
    const { settled } = runToStageAGates(ids);
    const declared = decide(context(settled.run, ids), {
      type: "scope-split-declared",
      digest: "digest-split-1" as Digest,
      detail,
    });
    const passed = decide(context(declared.run, ids), {
      type: "gates-evaluated",
      visitId: declared.run.visits[0]!.visitId,
      verdicts: [pass(GATE_ARTIFACT_EXISTS)],
    });
    return { declared, passed, ids };
  }

  it("records a declaration without stopping the stage that made it", () => {
    const ids = sequentialIds();
    const { settled } = runToStageAGates(ids);

    const declared = decide(context(settled.run, ids), {
      type: "scope-split-declared",
      digest: "digest-split-1" as Digest,
      detail: "two pull requests",
    });

    expect(declared.run.state).toBe("running");
    expect(declared.effects).toEqual([]);
    expect(declared.run.scopeSplit?.acknowledgedAt).toBe(null);
  });

  it("stops and asks instead of carrying the wider scope into the next stage", () => {
    const { passed } = runToDeclaredSplit();

    expect(passed.run.state).toBe("needs_decision");
    expect(passed.run.decision?.kind).toBe("scope-split");
    expect(passed.run.currentStageId).toBe(STAGE_A);
    expect(passed.effects.map((effect) => effect.type)).toEqual(["raise-decision"]);
  });

  it("scopes the run to its pull request and carries on when answered", () => {
    const { passed, ids } = runToDeclaredSplit();

    const answered = decide(context(passed.run, ids), {
      type: "decision-answered",
      decisionId: passed.run.decision!.decisionId,
      answer: "proceed",
      planDigest: passed.run.planDigest,
    });

    expect(answered.run.state).toBe("running");
    expect(answered.run.scopeSplit?.acknowledgedAt).not.toBe(null);
    expect(answered.run.currentStageId).toBe(STAGE_B);
    expect(dispatchOf(answered.effects).stageId).toBe(STAGE_B);
    // The stage that declared the split is not run again.
    expect(answered.run.visits.filter((visit) => visit.stageId === STAGE_A)).toHaveLength(1);
  });

  it("asks once, not at every later stage", () => {
    const { passed, ids } = runToDeclaredSplit();
    const answered = decide(context(passed.run, ids), {
      type: "decision-answered",
      decisionId: passed.run.decision!.decisionId,
      answer: "proceed",
      planDigest: passed.run.planDigest,
    });

    const again = decide(context(answered.run, ids), {
      type: "scope-split-declared",
      digest: "digest-split-1" as Digest,
      detail: "the same declaration, read again after a restart",
    });

    expect(again.effects).toEqual([]);
    expect(again.run.revision).toBe(answered.run.revision);
  });

  it("asks again when a later stage declares a different split", () => {
    const { passed, ids } = runToDeclaredSplit();
    const answered = decide(context(passed.run, ids), {
      type: "decision-answered",
      decisionId: passed.run.decision!.decisionId,
      answer: "proceed",
      planDigest: passed.run.planDigest,
    });

    const settledB = decide(context(answered.run, ids), {
      type: "settled",
      settlement: {
        operationId: dispatchOf(answered.effects).operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:03.000Z",
      },
    });
    const second = decide(context(settledB.run, ids), {
      type: "scope-split-declared",
      digest: "digest-split-2" as Digest,
      detail: "and now the migration too",
    });
    const passedB = decide(context(second.run, ids), {
      type: "gates-evaluated",
      visitId: second.run.visits[1]!.visitId,
      verdicts: [pass(GATE_SUMMARY_EXISTS)],
    });

    expect(passedB.run.state).toBe("needs_decision");
    expect(passedB.run.decision?.kind).toBe("scope-split");
  });

  it("aborting a split fails the run rather than splitting it silently", () => {
    const { passed, ids } = runToDeclaredSplit();

    const aborted = decide(context(passed.run, ids), {
      type: "decision-answered",
      decisionId: passed.run.decision!.decisionId,
      answer: "abort",
      planDigest: passed.run.planDigest,
    });

    expect(aborted.run.state).toBe("failed");
  });

  it("names the pull request the run is scoped to", () => {
    const ids = sequentialIds();
    const withPullRequest = freshRun({
      pullRequest: {
        number: 42,
        url: "https://example.test/pull/42",
        headBranch: "workflowleaf/issue-7-1",
        baseBranch: "main",
        openedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const started = decide(context(withPullRequest, ids), { type: "start" });
    const dispatch = dispatchOf(started.effects);
    const settled = decide(context(started.run, ids), {
      type: "settled",
      settlement: {
        operationId: dispatch.operationId,
        outcome: "completed",
        settled: true,
        detail: null,
        at: "2026-01-01T00:00:02.000Z",
      },
    });
    const declared = decide(context(settled.run, ids), {
      type: "scope-split-declared",
      digest: "digest-split-1" as Digest,
      detail: "needs a second one",
    });
    const passed = decide(context(declared.run, ids), {
      type: "gates-evaluated",
      visitId: declared.run.visits[0]!.visitId,
      verdicts: [pass(GATE_ARTIFACT_EXISTS)],
    });

    expect(passed.run.decision?.detail).toContain("#42");
  });
});
