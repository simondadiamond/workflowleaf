/**
 * Budget accounting.
 *
 * Attempt and cycle limits are enforced in the controller, where they change
 * transitions. What lives here is the reporting side: how much of each budget a
 * run has used, and usage figures an executor may or may not have given us.
 *
 * Unknown usage stays unknown. Rendering a missing token count as 0 turns "the
 * executor did not tell us" into "this was free", which is the one reading that
 * is certainly wrong.
 */
import type { RunPlan } from "./contracts.ts";
import { findStage } from "./contracts.ts";
import type { StageId } from "./ids.ts";
import type { RunRecord } from "./state.ts";

export interface StageBudgetUsage {
  readonly stageId: StageId;
  readonly attemptsUsed: number;
  readonly attemptsAllowed: number;
  readonly visits: number;
}

export function stageBudgetUsage(run: RunRecord, plan: RunPlan): StageBudgetUsage[] {
  return plan.stages.map((stage) => {
    const visits = run.visits.filter((visit) => visit.stageId === stage.contract.id);
    return {
      stageId: stage.contract.id,
      attemptsUsed: visits.reduce((total, visit) => total + visit.attempts, 0),
      attemptsAllowed: stage.contract.budgets.attempts,
      visits: visits.length,
    };
  });
}

export function attemptsRemaining(run: RunRecord, plan: RunPlan, stageId: StageId): number | null {
  const stage = findStage(plan, stageId);
  if (stage === undefined) return null;
  const visit = [...run.visits].reverse().find((candidate) => candidate.stageId === stageId);
  if (visit === undefined) return stage.contract.budgets.attempts;
  const policy = stage.contract.correction;
  const limit =
    policy.mode === "same-context"
      ? Math.min(policy.maxAttempts, stage.contract.budgets.attempts)
      : stage.contract.budgets.attempts;
  return Math.max(0, limit - visit.attempts);
}

export function repairCyclesRemaining(run: RunRecord): number {
  return Math.max(0, run.budget.maxRepairCycles - run.budget.repairCycles);
}

/**
 * Usage an executor reported, per attempt. `null` means the executor did not
 * report it, which is different from zero and is presented as such.
 */
export interface AttemptUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface UsageTotal {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  /** Attempts whose usage the executor did not report. */
  readonly unreportedAttempts: number;
}

function addKnown(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

export function totalUsage(attempts: readonly AttemptUsage[]): UsageTotal {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  let unreportedAttempts = 0;

  for (const attempt of attempts) {
    if (attempt.inputTokens === null && attempt.outputTokens === null && attempt.costUsd === null) {
      unreportedAttempts += 1;
    }
    inputTokens = addKnown(inputTokens, attempt.inputTokens);
    outputTokens = addKnown(outputTokens, attempt.outputTokens);
    costUsd = addKnown(costUsd, attempt.costUsd);
  }

  return { inputTokens, outputTokens, costUsd, unreportedAttempts };
}

export function formatUsage(usage: UsageTotal): string {
  const tokens =
    usage.inputTokens === null && usage.outputTokens === null
      ? "tokens unknown"
      : `${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out`;
  const cost = usage.costUsd === null ? "cost unknown" : `$${usage.costUsd.toFixed(4)}`;
  const caveat =
    usage.unreportedAttempts === 0 ? "" : ` (${usage.unreportedAttempts} attempt(s) unreported)`;
  return `${tokens}, ${cost}${caveat}`;
}
