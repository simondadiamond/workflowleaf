/**
 * The synthetic two-stage fixture.
 *
 * Stage A writes a small artifact, stage B summarizes it. A's file gate is
 * forced to fail once, so the interesting property is observable: B must not
 * launch until A's correction produced valid content.
 *
 * Everything here is public and made up. No private skill id, script or
 * repository path belongs in this file.
 */
import type { GateDefinition, RunPlan, StageContract } from "../contracts.ts";
import { SCHEMA_VERSION } from "../contracts.ts";
import type {
  AttemptId,
  DecisionId,
  Digest,
  GateId,
  OperationId,
  StageId,
  VisitId,
} from "../ids.ts";
import type { IdSource } from "../controller.ts";
import type { ExecutorCapabilities } from "../state.ts";

const digest = (value: string) => value as Digest;

export const STAGE_A = "produce" as StageId;
export const STAGE_B = "summarize" as StageId;
export const GATE_ARTIFACT_EXISTS = "artifact-has-content" as GateId;
export const GATE_SUMMARY_EXISTS = "summary-has-content" as GateId;

const artifactGate: GateDefinition = {
  id: GATE_ARTIFACT_EXISTS,
  type: "file",
  path: "artifact.md",
  mustExist: true,
  minBytes: 8,
};

const summaryGate: GateDefinition = {
  id: GATE_SUMMARY_EXISTS,
  type: "file",
  path: "summary.md",
  mustExist: true,
  minBytes: 4,
};

function stage(
  id: StageId,
  overrides: Partial<StageContract> & Pick<StageContract, "consumes" | "produces" | "gates">,
): StageContract {
  return {
    id,
    kind: "agent",
    instruction: `stages/${id}.md`,
    context: { files: [] },
    skills: { required: [], lazy: [], lazyRules: [] },
    correction: { mode: "same-context", maxAttempts: 3, onLostContext: "fresh-with-evidence" },
    budgets: { attempts: 3 },
    requiresCapabilities: ["fresh-context"],
    ...overrides,
  };
}

export interface FixtureOptions {
  /** Defaults to a fully capable executor. */
  readonly capabilities?: Partial<ExecutorCapabilities>;
}

export const FULL_CAPABILITIES: ExecutorCapabilities = {
  freshContext: true,
  sameContextContinuation: true,
  settledCompletion: true,
  interrupt: true,
  recovery: true,
};

export function capabilities(overrides: Partial<ExecutorCapabilities> = {}): ExecutorCapabilities {
  return { ...FULL_CAPABILITIES, ...overrides };
}

export function twoStagePlan(): RunPlan {
  const stages: StageContract[] = [
    stage(STAGE_A, {
      consumes: ["topic"],
      produces: ["artifact.md"],
      gates: [GATE_ARTIFACT_EXISTS],
    }),
    stage(STAGE_B, {
      consumes: ["artifact.md"],
      produces: ["summary.md"],
      gates: [GATE_SUMMARY_EXISTS],
    }),
  ];

  const definitions = new Map<string, GateDefinition>([
    [GATE_ARTIFACT_EXISTS as string, artifactGate],
    [GATE_SUMMARY_EXISTS as string, summaryGate],
  ]);

  return {
    schemaVersion: SCHEMA_VERSION,
    planDigest: digest("plan-two-stage-v1"),
    playbookId: "synthetic-two-stage",
    playbookVersion: "0.1",
    outcome: "summary",
    inputs: { topic: "a made-up topic" },
    stages: stages.map((contract) => ({
      contract,
      instruction: { text: `Do the ${contract.id} stage.`, digest: digest(`instr-${contract.id}`) },
      contextFiles: [],
      requiredSkills: [],
      lazySkills: [],
      gates: contract.gates.map((gateId) => ({
        definition: definitions.get(gateId as string)!,
        digest: digest(`gate-${gateId}`),
      })),
    })),
    policy: { humanRequired: ["merge"] },
    compiledAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Deterministic ids. A test that has to match on a random uuid is a test that
 * will eventually be rewritten to assert nothing.
 */
export function sequentialIds(prefix = "x"): IdSource {
  let visits = 0;
  let attempts = 0;
  let operations = 0;
  let decisions = 0;
  return {
    visitId: () => `${prefix}-visit-${++visits}` as VisitId,
    attemptId: () => `${prefix}-attempt-${++attempts}` as AttemptId,
    operationId: () => `${prefix}-op-${++operations}` as OperationId,
    decisionId: () => `${prefix}-decision-${++decisions}` as DecisionId,
  };
}
