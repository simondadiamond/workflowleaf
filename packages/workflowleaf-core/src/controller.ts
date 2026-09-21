/**
 * The stage controller: pure transitions from one durable run state to the next.
 *
 * Nothing here dispatches, writes or waits. `decide` returns the next state and
 * the effects the worker should perform, so every rule in it can be tested
 * against a fabricated crash, a duplicate event or an exhausted budget without
 * a provider, a filesystem or a clock.
 *
 * Two rules shape most of what follows. A stage advances only on evidence the
 * controller asked a checker for, never on an executor saying it went well. And
 * an input that does not match the operation currently in flight is ignored,
 * because a replayed or out-of-order terminal event must not advance a run
 * twice.
 *
 * The controller contains no provider branching. If a `provider === "claude"`
 * test ever appears here, the abstraction has failed and the fix is in the
 * adapter.
 */
import type { ResolvedStage, RunPlan } from "./contracts.ts";
import { findStage, nextStageAfter } from "./contracts.ts";
import type { GateOutcome } from "./evidence.ts";
import type {
  AttemptId,
  DecisionId,
  Digest,
  GateId,
  Instant,
  OperationId,
  StageId,
  VisitId,
} from "./ids.ts";
import type { GateVerdict, InspectOutcome, StageLimitation, StageSettlement } from "./ports.ts";
import type { ExecutorCapabilities, PendingDecision, RunRecord, StageVisit } from "./state.ts";
import { currentVisit, isTerminal, visitById } from "./state.ts";

// ---------------------------------------------------------------- inputs

export type DecisionAnswer = "proceed" | "waive" | "abort";

export type ControllerInput =
  | { readonly type: "start" }
  | {
      readonly type: "dispatch-acknowledged";
      readonly operationId: OperationId;
      readonly handle: string;
    }
  | { readonly type: "settled"; readonly settlement: StageSettlement }
  | {
      readonly type: "continue-unavailable";
      readonly operationId: OperationId;
      readonly reason: string;
    }
  | {
      readonly type: "gates-evaluated";
      readonly visitId: VisitId;
      readonly verdicts: readonly GateVerdict[];
    }
  | {
      readonly type: "evidence-invalidated";
      readonly stageIds: readonly StageId[];
      readonly reason: string;
    }
  | {
      readonly type: "decision-answered";
      readonly decisionId: DecisionId;
      readonly answer: DecisionAnswer;
      readonly planDigest: string;
    }
  | {
      readonly type: "reconciled";
      readonly operationId: OperationId;
      readonly outcome: InspectOutcome;
    }
  | {
      /**
       * A stage declared that findings grew the story past this run's pull
       * request. Recording it is separate from asking about it: the question
       * is put when the run would otherwise move on to the next stage.
       */
      readonly type: "scope-split-declared";
      readonly digest: Digest;
      readonly detail: string;
    }
  | { readonly type: "cancel"; readonly reason: string }
  | { readonly type: "pause" }
  | { readonly type: "resume" };

// ---------------------------------------------------------------- effects

export type ControllerEffect =
  | {
      readonly type: "dispatch-stage";
      readonly stageId: StageId;
      readonly visitId: VisitId;
      readonly attemptId: AttemptId;
      readonly operationId: OperationId;
    }
  | {
      readonly type: "continue-stage";
      readonly stageId: StageId;
      readonly visitId: VisitId;
      readonly attemptId: AttemptId;
      readonly operationId: OperationId;
      readonly correction: string;
    }
  | {
      readonly type: "run-gates";
      readonly stageId: StageId;
      readonly visitId: VisitId;
      readonly attemptId: AttemptId;
      readonly gateIds: readonly GateId[];
    }
  | { readonly type: "raise-decision"; readonly decision: PendingDecision }
  | { readonly type: "interrupt"; readonly visitId: VisitId }
  | { readonly type: "record-limitation"; readonly limitation: StageLimitation }
  | {
      readonly type: "finish";
      readonly state: "succeeded" | "failed" | "cancelled";
      readonly reason: string;
    };

export interface Decision {
  readonly run: RunRecord;
  readonly effects: readonly ControllerEffect[];
}

export interface IdSource {
  visitId(): VisitId;
  attemptId(): AttemptId;
  operationId(): OperationId;
  decisionId(): DecisionId;
}

export interface ControllerContext {
  readonly run: RunRecord;
  readonly plan: RunPlan;
  readonly now: Instant;
  readonly ids: IdSource;
}

// ---------------------------------------------------------------- helpers

/** Gate outcomes that let a stage advance. Everything else needs correcting. */
export const SATISFYING: readonly GateOutcome[] = ["passed", "waived"];

function touch(run: RunRecord, now: Instant, patch: Partial<RunRecord>): RunRecord {
  return { ...run, ...patch, revision: run.revision + 1, updatedAt: now };
}

function replaceVisit(run: RunRecord, visit: StageVisit): StageVisit[] {
  return run.visits.map((existing) => (existing.visitId === visit.visitId ? visit : existing));
}

function noChange(run: RunRecord): Decision {
  return { run, effects: [] };
}

function requiredCapabilities(stage: ResolvedStage): readonly (keyof ExecutorCapabilities)[] {
  const names: Record<string, keyof ExecutorCapabilities> = {
    "fresh-context": "freshContext",
    "same-context-continuation": "sameContextContinuation",
    "settled-completion": "settledCompletion",
    interrupt: "interrupt",
    recovery: "recovery",
  };
  return stage.contract.requiresCapabilities.flatMap((name) => {
    const key = names[name];
    return key === undefined ? [] : [key];
  });
}

function raise(
  context: ControllerContext,
  kind: PendingDecision["kind"],
  detail: string,
  patch: Partial<RunRecord> = {},
): Decision {
  const decision: PendingDecision = {
    decisionId: context.ids.decisionId(),
    kind,
    detail,
    raisedAt: context.now,
    planDigest: context.run.planDigest,
  };
  return {
    run: touch(context.run, context.now, { ...patch, state: "needs_decision", decision }),
    effects: [{ type: "raise-decision", decision }],
  };
}

function deadlinePassed(context: ControllerContext): boolean {
  const deadline = context.run.budget.deadlineAt;
  return deadline !== null && context.now > deadline;
}

/**
 * Opens a stage. An agent stage is dispatched to the executor; a check stage
 * runs its gates with no model at all; a decision stage stops for a human; a
 * watch stage waits on its external gates.
 */
function enterStage(context: ControllerContext, stageId: StageId): Decision {
  const stage = findStage(context.plan, stageId);
  if (stage === undefined) {
    return {
      run: touch(context.run, context.now, {
        state: "failed",
        failure: `Unknown stage ${stageId}.`,
      }),
      effects: [{ type: "finish", state: "failed", reason: `Unknown stage ${stageId}.` }],
    };
  }

  if (deadlinePassed(context)) {
    return raise(
      context,
      "budget-exhausted",
      `Run deadline ${context.run.budget.deadlineAt} passed before ${stageId}.`,
    );
  }

  const missing = requiredCapabilities(stage).filter((key) => !context.run.capabilities[key]);
  if (missing.length > 0) {
    const detail = `Stage ${stageId} requires ${missing.join(", ")}, which this executor does not support.`;
    const decision = raise(context, "unsupported-capability", detail, { currentStageId: stageId });
    return {
      run: decision.run,
      effects: [
        {
          type: "record-limitation",
          limitation: { stageId, capability: missing[0]!, detail },
        },
        ...decision.effects,
      ],
    };
  }

  const visitId = context.ids.visitId();
  const attemptId = context.ids.attemptId();
  const gateIds = stage.gates.map((gate) => gate.definition.id);

  const base: StageVisit = {
    visitId,
    stageId,
    state: "pending",
    attempts: 0,
    startedAt: context.now,
    endedAt: null,
    operation: null,
    lostContext: false,
    pendingGates: gateIds,
    failure: null,
  };

  switch (stage.contract.kind) {
    case "decision": {
      const run = touch(context.run, context.now, {
        currentStageId: stageId,
        visits: [...context.run.visits, { ...base, state: "blocked" }],
      });
      return raise(
        { ...context, run },
        "business-judgment",
        `Stage ${stageId} needs a human decision.`,
      );
    }

    case "check": {
      const visit: StageVisit = { ...base, state: "checking", attempts: 1 };
      return {
        run: touch(context.run, context.now, {
          state: "running",
          currentStageId: stageId,
          visits: [...context.run.visits, visit],
        }),
        effects: [{ type: "run-gates", stageId, visitId, attemptId, gateIds }],
      };
    }

    case "watch": {
      const visit: StageVisit = { ...base, state: "checking", attempts: 1 };
      return {
        run: touch(context.run, context.now, {
          state: "waiting_external",
          currentStageId: stageId,
          visits: [...context.run.visits, visit],
        }),
        effects: [{ type: "run-gates", stageId, visitId, attemptId, gateIds }],
      };
    }

    case "agent": {
      const operationId = context.ids.operationId();
      const visit: StageVisit = {
        ...base,
        state: "executing",
        attempts: 1,
        operation: {
          operationId,
          attemptId,
          mode: "fresh",
          dispatchedAt: context.now,
          acknowledgedAt: null,
          handle: null,
        },
      };
      return {
        run: touch(context.run, context.now, {
          state: "running",
          currentStageId: stageId,
          visits: [...context.run.visits, visit],
        }),
        effects: [{ type: "dispatch-stage", stageId, visitId, attemptId, operationId }],
      };
    }
  }
}

function describePullRequest(run: RunRecord): string {
  return run.pullRequest === null
    ? "the one pull request this run delivers"
    : `pull request #${String(run.pullRequest.number)}`;
}

function advance(context: ControllerContext, passedVisit: StageVisit): Decision {
  const visit: StageVisit = {
    ...passedVisit,
    state: "passed",
    endedAt: context.now,
    pendingGates: [],
  };
  const run = touch(context.run, context.now, { visits: replaceVisit(context.run, visit) });

  // A declared split is asked about here rather than the moment it is written:
  // the stage that noticed still gets to finish and have its gates checked,
  // and the run stops before it carries the wider scope into another stage.
  const split = run.scopeSplit;
  if (split !== null && split.acknowledgedAt === null) {
    return raise(
      { ...context, run },
      "scope-split",
      `This story has outgrown ${describePullRequest(run)}. Scope this run to that pull request and open a second run for the rest, or abort.\n${split.detail}`,
    );
  }

  const next = nextStageAfter(context.plan, passedVisit.stageId);
  if (next === null) {
    return {
      run: touch(run, context.now, { state: "succeeded", currentStageId: null }),
      effects: [{ type: "finish", state: "succeeded", reason: "All stages passed." }],
    };
  }

  return enterStage({ ...context, run }, next);
}

/** The correction text a repaired stage receives. Evidence, not encouragement. */
function correctionText(verdicts: readonly GateVerdict[]): string {
  const failed = verdicts.filter((verdict) => !SATISFYING.includes(verdict.outcome));
  const lines = failed.map(
    (verdict) => `- ${verdict.gateId} ${verdict.outcome}: ${verdict.summary}`,
  );
  return [`These exit gates did not pass. Fix the cause, do not restate the claim.`, ...lines].join(
    "\n",
  );
}

function repairSameContext(
  context: ControllerContext,
  stage: ResolvedStage,
  visit: StageVisit,
  verdicts: readonly GateVerdict[],
): Decision {
  const policy = stage.contract.correction;
  if (policy.mode !== "same-context") return noChange(context.run);

  const limit = Math.min(policy.maxAttempts, stage.contract.budgets.attempts);
  if (visit.attempts >= limit) {
    return raise(
      context,
      "budget-exhausted",
      `Stage ${visit.stageId} used all ${limit} attempts. Last failures:\n${correctionText(verdicts)}`,
      {
        visits: replaceVisit(context.run, {
          ...visit,
          state: "failed",
          endedAt: context.now,
          failure: correctionText(verdicts),
        }),
      },
    );
  }

  const attemptId = context.ids.attemptId();
  const operationId = context.ids.operationId();
  const correction = correctionText(verdicts);

  if (context.run.capabilities.sameContextContinuation) {
    const next: StageVisit = {
      ...visit,
      state: "repairing",
      attempts: visit.attempts + 1,
      operation: {
        operationId,
        attemptId,
        mode: "continue",
        dispatchedAt: context.now,
        acknowledgedAt: null,
        handle: visit.operation?.handle ?? null,
      },
    };
    return {
      run: touch(context.run, context.now, {
        state: "running",
        visits: replaceVisit(context.run, next),
      }),
      effects: [
        {
          type: "continue-stage",
          stageId: visit.stageId,
          visitId: visit.visitId,
          attemptId,
          operationId,
          correction,
        },
      ],
    };
  }

  if (policy.onLostContext === "needs-decision") {
    return raise(
      context,
      "lost-context",
      `Stage ${visit.stageId} failed a gate and this executor cannot continue its context.`,
    );
  }

  // Fall back to a fresh context carrying the evidence, and record that the
  // stage lost its continuity so the gap log sees it rather than inferring it.
  const next: StageVisit = {
    ...visit,
    state: "repairing",
    attempts: visit.attempts + 1,
    lostContext: true,
    operation: {
      operationId,
      attemptId,
      mode: "fresh",
      dispatchedAt: context.now,
      acknowledgedAt: null,
      handle: null,
    },
  };
  return {
    run: touch(context.run, context.now, {
      state: "running",
      visits: replaceVisit(context.run, next),
    }),
    effects: [
      {
        type: "record-limitation",
        limitation: {
          stageId: visit.stageId,
          capability: "sameContextContinuation",
          detail:
            "Correction restarted the stage in a fresh context carrying the failure evidence.",
        },
      },
      {
        type: "continue-stage",
        stageId: visit.stageId,
        visitId: visit.visitId,
        attemptId,
        operationId,
        correction,
      },
    ],
  };
}

function routeBack(
  context: ControllerContext,
  stage: ResolvedStage,
  visit: StageVisit,
  verdicts: readonly GateVerdict[],
): Decision {
  const policy = stage.contract.correction;
  if (policy.mode !== "route-to") return noChange(context.run);

  const failedVisit: StageVisit = {
    ...visit,
    state: "failed",
    endedAt: context.now,
    failure: correctionText(verdicts),
  };
  const run = touch(context.run, context.now, { visits: replaceVisit(context.run, failedVisit) });

  if (run.budget.repairCycles >= run.budget.maxRepairCycles) {
    return raise(
      { ...context, run },
      "budget-exhausted",
      `Run used all ${run.budget.maxRepairCycles} backward repair cycles. Last failures:\n${correctionText(verdicts)}`,
    );
  }

  const withCycle = touch(run, context.now, {
    budget: { ...run.budget, repairCycles: run.budget.repairCycles + 1 },
  });
  return enterStage({ ...context, run: withCycle }, policy.stage);
}

// ---------------------------------------------------------------- transitions

export function decide(context: ControllerContext, input: ControllerInput): Decision {
  const { run } = context;

  if (isTerminal(run.state)) return noChange(run);

  switch (input.type) {
    case "start": {
      if (run.state !== "queued") return noChange(run);
      const first = context.plan.stages[0];
      if (first === undefined) {
        return {
          run: touch(run, context.now, { state: "failed", failure: "Plan has no stages." }),
          effects: [{ type: "finish", state: "failed", reason: "Plan has no stages." }],
        };
      }
      return enterStage(context, first.contract.id);
    }

    case "dispatch-acknowledged": {
      const visit = currentVisit(run);
      if (visit?.operation == null || visit.operation.operationId !== input.operationId) {
        return noChange(run);
      }
      const next: StageVisit = {
        ...visit,
        operation: { ...visit.operation, acknowledgedAt: context.now, handle: input.handle },
      };
      return { run: touch(run, context.now, { visits: replaceVisit(run, next) }), effects: [] };
    }

    case "settled":
      return onSettled(context, input.settlement);

    case "continue-unavailable": {
      const visit = currentVisit(run);
      if (visit?.operation == null || visit.operation.operationId !== input.operationId) {
        return noChange(run);
      }
      return raise(context, "lost-context", `Stage ${visit.stageId}: ${input.reason}`, {
        visits: replaceVisit(run, { ...visit, lostContext: true, state: "blocked" }),
      });
    }

    case "gates-evaluated":
      return onGates(context, input.visitId, input.verdicts);

    case "evidence-invalidated":
      return onEvidenceInvalidated(context, input.stageIds, input.reason);

    case "decision-answered":
      return onDecisionAnswered(context, input.decisionId, input.answer, input.planDigest);

    case "reconciled":
      return onReconciled(context, input.operationId, input.outcome);

    case "scope-split-declared": {
      // The same declaration read again after a restart is not a new question.
      if (run.scopeSplit !== null && run.scopeSplit.digest === input.digest) return noChange(run);
      return {
        run: touch(run, context.now, {
          scopeSplit: {
            digest: input.digest,
            detail: input.detail,
            declaredAt: context.now,
            acknowledgedAt: null,
          },
        }),
        effects: [],
      };
    }

    case "cancel": {
      const visit = currentVisit(run);
      const effects: ControllerEffect[] = [];
      let visits = run.visits;
      if (visit !== undefined && (visit.state === "executing" || visit.state === "repairing")) {
        effects.push({ type: "interrupt", visitId: visit.visitId });
        visits = replaceVisit(run, { ...visit, state: "cancelled", endedAt: context.now });
      }
      effects.push({ type: "finish", state: "cancelled", reason: input.reason });
      return {
        run: touch(run, context.now, { state: "cancelled", visits, failure: input.reason }),
        effects,
      };
    }

    case "pause": {
      if (run.state !== "running" && run.state !== "waiting_external") return noChange(run);
      return { run: touch(run, context.now, { state: "paused" }), effects: [] };
    }

    case "resume": {
      if (run.state !== "paused") return noChange(run);
      return { run: touch(run, context.now, { state: "running" }), effects: [] };
    }
  }
}

function onSettled(context: ControllerContext, settlement: StageSettlement): Decision {
  const { run } = context;
  const visit = currentVisit(run);

  // A replayed or late terminal event for an operation that is no longer the
  // one in flight advances nothing.
  if (visit?.operation == null || visit.operation.operationId !== settlement.operationId) {
    return noChange(run);
  }
  if (visit.state !== "executing" && visit.state !== "repairing") return noChange(run);

  const stage = findStage(context.plan, visit.stageId);
  if (stage === undefined) return noChange(run);

  const effects: ControllerEffect[] = [];

  if (!settlement.settled) {
    if (run.capabilities.settledCompletion) {
      // The executor claims it can report settlement and has not. Waiting is
      // the worker's job; the run stays where it is.
      return noChange(run);
    }
    effects.push({
      type: "record-limitation",
      limitation: {
        stageId: visit.stageId,
        capability: "settledCompletion",
        detail:
          "Gates ran without a settled-completion signal. Evidence is qualified: a background writer may still have been active.",
      },
    });
  }

  if (settlement.outcome === "interrupted") {
    const blocked: StageVisit = {
      ...visit,
      state: "blocked",
      endedAt: context.now,
      failure: settlement.detail,
    };
    const decision = raise(context, "ambiguity", `Stage ${visit.stageId} was interrupted.`, {
      visits: replaceVisit(run, blocked),
    });
    return { run: decision.run, effects: [...effects, ...decision.effects] };
  }

  if (settlement.outcome === "error") {
    const verdicts: readonly GateVerdict[] = [
      {
        gateId: "executor" as GateId,
        outcome: "error",
        summary: settlement.detail ?? "The executor reported an error.",
      },
    ];
    const repaired = repair(context, stage, visit, verdicts);
    return { run: repaired.run, effects: [...effects, ...repaired.effects] };
  }

  const gateIds = stage.gates.map((gate) => gate.definition.id);

  if (gateIds.length === 0) {
    const advanced = advance(context, visit);
    return { run: advanced.run, effects: [...effects, ...advanced.effects] };
  }

  const checking: StageVisit = { ...visit, state: "checking", pendingGates: gateIds };
  return {
    run: touch(run, context.now, { visits: replaceVisit(run, checking) }),
    effects: [
      ...effects,
      {
        type: "run-gates",
        stageId: visit.stageId,
        visitId: visit.visitId,
        attemptId: visit.operation.attemptId,
        gateIds,
      },
    ],
  };
}

function repair(
  context: ControllerContext,
  stage: ResolvedStage,
  visit: StageVisit,
  verdicts: readonly GateVerdict[],
): Decision {
  switch (stage.contract.correction.mode) {
    case "same-context":
      return repairSameContext(context, stage, visit, verdicts);
    case "route-to":
      return routeBack(context, stage, visit, verdicts);
    case "none": {
      const failed: StageVisit = {
        ...visit,
        state: "failed",
        endedAt: context.now,
        failure: correctionText(verdicts),
      };
      const reason = `Stage ${visit.stageId} failed with no correction policy.`;
      return {
        run: touch(context.run, context.now, {
          state: "failed",
          visits: replaceVisit(context.run, failed),
          failure: reason,
        }),
        effects: [{ type: "finish", state: "failed", reason }],
      };
    }
  }
}

function onGates(
  context: ControllerContext,
  visitId: VisitId,
  verdicts: readonly GateVerdict[],
): Decision {
  const { run } = context;
  const visit = visitById(run, visitId);
  if (visit === undefined || visit.state !== "checking") return noChange(run);

  const stage = findStage(context.plan, visit.stageId);
  if (stage === undefined) return noChange(run);

  const expected = stage.gates.map((gate) => gate.definition.id as string);
  const reported = new Set(verdicts.map((verdict) => verdict.gateId as string));
  const missing = expected.filter((gateId) => !reported.has(gateId));

  // Missing evidence is never a pass.
  if (missing.length > 0) {
    return raise(
      context,
      "reconciliation",
      `Stage ${visit.stageId} reported no evidence for ${missing.join(", ")}.`,
      { visits: replaceVisit(run, { ...visit, state: "blocked", endedAt: context.now }) },
    );
  }

  // A gate that could not run is an infrastructure problem, not a failing
  // assertion, and it must not be spent out of the stage's repair budget.
  const errored = verdicts.filter((verdict) => verdict.outcome === "error");
  if (errored.length > 0) {
    return raise(
      context,
      "reconciliation",
      `Gate(s) could not run: ${errored.map((verdict) => `${verdict.gateId} (${verdict.summary})`).join("; ")}`,
      { visits: replaceVisit(run, { ...visit, state: "blocked", endedAt: context.now }) },
    );
  }

  const unsatisfied = verdicts.filter((verdict) => !SATISFYING.includes(verdict.outcome));
  if (unsatisfied.length === 0) return advance(context, visit);

  return repair(context, stage, visit, verdicts);
}

function onEvidenceInvalidated(
  context: ControllerContext,
  stageIds: readonly StageId[],
  reason: string,
): Decision {
  const { run } = context;
  const affected = new Set(stageIds.map(String));
  const order = context.plan.stages.map((stage) => stage.contract.id as string);

  const earliest = order.find((stageId) => affected.has(stageId));
  if (earliest === undefined) return noChange(run);

  // Every passed visit of an affected stage loses its verdict. The run
  // re-enters the earliest one and re-verifies rather than assuming.
  const visits = run.visits.map((visit) =>
    affected.has(visit.stageId as string) && visit.state === "passed"
      ? { ...visit, state: "pending" as const, failure: reason }
      : visit,
  );

  const cleared = touch(run, context.now, { visits, state: "running" });
  return enterStage({ ...context, run: cleared }, earliest as StageId);
}

function onDecisionAnswered(
  context: ControllerContext,
  decisionId: DecisionId,
  answer: DecisionAnswer,
  planDigest: string,
): Decision {
  const { run } = context;
  const pending = run.decision;
  if (pending === null || pending.decisionId !== decisionId) return noChange(run);

  // An answer given against an older plan cannot authorize work that changed
  // after the question was asked.
  if (planDigest !== run.planDigest) {
    return raise(
      context,
      "reconciliation",
      `Decision ${decisionId} was answered against plan ${planDigest}, but the run is on ${run.planDigest}.`,
      { decision: null },
    );
  }

  if (answer === "abort") {
    const reason = `Run aborted at decision ${decisionId}.`;
    return {
      run: touch(run, context.now, { state: "failed", decision: null, failure: reason }),
      effects: [{ type: "finish", state: "failed", reason }],
    };
  }

  const visit = currentVisit(run);
  if (visit === undefined) return noChange(run);

  // A scope split is answered about the run, not about the stage that raised
  // it. Proceeding means "stay on this pull request", so the run carries on
  // from the visit that already passed rather than repeating it.
  if (pending.kind === "scope-split" && run.scopeSplit !== null) {
    const acknowledged = touch(run, context.now, {
      decision: null,
      state: "running",
      scopeSplit: { ...run.scopeSplit, acknowledgedAt: context.now },
    });
    return advance({ ...context, run: acknowledged }, visit);
  }

  const cleared = touch(run, context.now, { decision: null, state: "running" });

  if (answer === "waive") {
    // The human took responsibility for the outstanding gates. The waiver is
    // recorded against this visit and shown as an exception, not as a pass.
    return advance({ ...context, run: cleared }, visit);
  }

  return enterStage({ ...context, run: cleared }, visit.stageId);
}

function onReconciled(
  context: ControllerContext,
  operationId: OperationId,
  outcome: InspectOutcome,
): Decision {
  const { run } = context;
  const visit = currentVisit(run);
  if (visit?.operation == null || visit.operation.operationId !== operationId) return noChange(run);

  switch (outcome.kind) {
    case "in-flight":
      return {
        run: touch(run, context.now, {
          state: "running",
          visits: replaceVisit(run, {
            ...visit,
            operation: { ...visit.operation, handle: outcome.handle.handle },
          }),
        }),
        effects: [],
      };

    case "settled":
      return onSettled(
        { ...context, run: touch(run, context.now, { state: "running" }) },
        outcome.settlement,
      );

    case "never-dispatched":
      // Re-dispatching the same operation id is safe: the executor never saw it.
      return {
        run: touch(run, context.now, { state: "running" }),
        effects: [
          {
            type: "dispatch-stage",
            stageId: visit.stageId,
            visitId: visit.visitId,
            attemptId: visit.operation.attemptId,
            operationId,
          },
        ],
      };

    case "unknown":
      return raise(
        context,
        "reconciliation",
        `Cannot tell whether operation ${operationId} ran: ${outcome.reason}`,
      );
  }
}

/**
 * The run state a fresh run starts from. Supplied rather than constructed so
 * the store owns identity and the clock stays outside core.
 */
export function initialRun(input: {
  readonly runId: RunRecord["runId"];
  readonly planDigest: RunRecord["planDigest"];
  readonly workspaceId: RunRecord["workspaceId"];
  /** Null only when the profile does not permit opening one. */
  readonly pullRequest?: RunRecord["pullRequest"];
  readonly capabilities: ExecutorCapabilities;
  readonly maxRepairCycles: number;
  readonly deadlineAt: Instant | null;
  readonly now: Instant;
}): RunRecord {
  return {
    runId: input.runId,
    planDigest: input.planDigest,
    workspaceId: input.workspaceId,
    pullRequest: input.pullRequest ?? null,
    scopeSplit: null,
    state: "queued",
    revision: 0,
    currentStageId: null,
    visits: [],
    budget: {
      repairCycles: 0,
      maxRepairCycles: input.maxRepairCycles,
      deadlineAt: input.deadlineAt,
    },
    capabilities: input.capabilities,
    decision: null,
    failure: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
