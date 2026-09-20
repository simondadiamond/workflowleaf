/**
 * The playbook contract and the compiled run plan.
 *
 * A playbook says what must happen, what must be produced, and what evidence
 * is required. It never names a provider, a model or a harness: a playbook that
 * only runs on one of them is a bug in the playbook, not a feature of it.
 *
 * Two documents live here. `PlaybookDocument` is what a human edits and
 * `wl validate` checks. `RunPlan` is the immutable snapshot a run executes:
 * instructions inlined with their digests, skills resolved, gates pinned. Once
 * a run starts, editing the playbook cannot change what that run is doing.
 */
import * as Schema from "effect/Schema";

import { Digest, GateId, Instant, StageId } from "./ids.ts";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- gates

/**
 * A gate's type decides who is allowed to evaluate it. `command`, `file` and
 * `diff` are evaluated by code; `review` by a fresh model context, recorded as
 * judgment; `external` by an integration result bound to a specific commit,
 * deployment or resource version.
 */
export const GateKind = Schema.Literals(["command", "file", "diff", "review", "external"]);
export type GateKind = typeof GateKind.Type;

export const CommandGate = Schema.Struct({
  id: GateId,
  type: Schema.Literal("command"),
  executable: NonEmpty,
  args: Schema.Array(Schema.String),
  /** Relative to the run's worktree. Absolute paths and `..` are rejected. */
  cwd: Schema.optional(NonEmpty),
  timeoutMs: PositiveInt,
  expect: Schema.Struct({ exitCode: NonNegativeInt }),
  /** Optional structured result parsing, recorded as evidence alongside the exit code. */
  parse: Schema.optional(Schema.Literals(["tap", "none"])),
});
export type CommandGate = typeof CommandGate.Type;

export const FileGate = Schema.Struct({
  id: GateId,
  type: Schema.Literal("file"),
  path: NonEmpty,
  mustExist: Schema.Boolean,
  minBytes: Schema.optional(NonNegativeInt),
  /** Each line must appear somewhere in the file. A cheap structural assertion. */
  mustContain: Schema.optional(Schema.Array(NonEmpty)),
});
export type FileGate = typeof FileGate.Type;

export const DiffGate = Schema.Struct({
  id: GateId,
  type: Schema.Literal("diff"),
  /** Glob patterns the change is allowed to touch, checked against a pinned baseline. */
  allowedPaths: Schema.Array(NonEmpty),
  maxChangedFiles: Schema.optional(PositiveInt),
});
export type DiffGate = typeof DiffGate.Type;

export const ReviewGate = Schema.Struct({
  id: GateId,
  type: Schema.Literal("review"),
  rubric: NonEmpty,
  /** A review verdict is judgment. It is recorded as judgment, never as proof. */
  blockingSeverities: Schema.Array(NonEmpty),
});
export type ReviewGate = typeof ReviewGate.Type;

export const ExternalGate = Schema.Struct({
  id: GateId,
  type: Schema.Literal("external"),
  /** e.g. "pull-request-exists", "checks-green", "canary-passed". */
  check: NonEmpty,
  /** What the result must be bound to, so yesterday's green cannot satisfy today's gate. */
  boundTo: Schema.Literals(["head-sha", "deployed-revision", "resource-version"]),
});
export type ExternalGate = typeof ExternalGate.Type;

export const GateDefinition = Schema.Union([
  CommandGate,
  FileGate,
  DiffGate,
  ReviewGate,
  ExternalGate,
]);
export type GateDefinition = typeof GateDefinition.Type;

/** Gates code can decide on its own. The rest need a model or an integration. */
export function isDeterministicGate(gate: GateDefinition): boolean {
  return gate.type === "command" || gate.type === "file" || gate.type === "diff";
}

// ---------------------------------------------------------------- stages

/**
 * `agent` runs a provider context. `check` runs deterministic code with no
 * model at all. `decision` stops for a human. `watch` waits on an external
 * condition. Spending an agent on work a `check` stage can do is the most
 * common way these pipelines get slow and unreliable at the same time.
 */
export const StageKind = Schema.Literals(["agent", "check", "decision", "watch"]);
export type StageKind = typeof StageKind.Type;

export const CorrectionPolicy = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("same-context"),
    maxAttempts: PositiveInt,
    /**
     * What to do when the executor cannot continue the existing context.
     * `fresh-with-evidence` restarts the stage with the failure evidence and
     * records the lost continuity; `needs-decision` stops and asks.
     */
    onLostContext: Schema.Literals(["fresh-with-evidence", "needs-decision"]),
  }),
  Schema.Struct({
    mode: Schema.Literal("route-to"),
    stage: StageId,
    maxCycles: PositiveInt,
  }),
  Schema.Struct({ mode: Schema.Literal("none") }),
]);
export type CorrectionPolicy = typeof CorrectionPolicy.Type;

export const SkillSelection = Schema.Struct({
  required: Schema.Array(NonEmpty),
  lazy: Schema.Array(NonEmpty),
  /** Path-triggered skills, re-evaluated against the paths a later stage actually touches. */
  lazyRules: Schema.Array(Schema.Struct({ paths: NonEmpty, load: NonEmpty })),
});
export type SkillSelection = typeof SkillSelection.Type;

export const StageContract = Schema.Struct({
  id: StageId,
  kind: StageKind,
  /** Path to the stage's instruction file, relative to the playbook directory. */
  instruction: Schema.optional(NonEmpty),
  consumes: Schema.Array(NonEmpty),
  produces: Schema.Array(NonEmpty),
  context: Schema.Struct({ files: Schema.Array(NonEmpty) }),
  skills: SkillSelection,
  gates: Schema.Array(GateId),
  correction: CorrectionPolicy,
  budgets: Schema.Struct({
    attempts: PositiveInt,
    wallClockMs: Schema.optional(PositiveInt),
  }),
  /**
   * Executor capabilities this stage needs. Declared so an executor that lacks
   * one produces an explicit limitation instead of quietly degrading.
   */
  requiresCapabilities: Schema.Array(
    Schema.Literals([
      "fresh-context",
      "same-context-continuation",
      "settled-completion",
      "interrupt",
      "recovery",
    ]),
  ),
});
export type StageContract = typeof StageContract.Type;

export const PlaybookPolicy = Schema.Struct({
  /** Actions that always stop for a human, whatever the gates say. */
  humanRequired: Schema.Array(NonEmpty),
});
export type PlaybookPolicy = typeof PlaybookPolicy.Type;

export const PlaybookDocument = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  id: NonEmpty,
  name: NonEmpty,
  /** Quoted in YAML on purpose: `version: 0.10` is not the same as `"0.10"`. */
  version: NonEmpty,
  outcome: NonEmpty,
  inputs: Schema.Array(NonEmpty),
  stages: Schema.Array(StageContract),
  gates: Schema.Array(GateDefinition),
  policy: PlaybookPolicy,
});
export type PlaybookDocument = typeof PlaybookDocument.Type;

// ---------------------------------------------------------------- run plan

export const ResolvedSkill = Schema.Struct({
  id: NonEmpty,
  path: NonEmpty,
  digest: Digest,
});
export type ResolvedSkill = typeof ResolvedSkill.Type;

export const ResolvedStage = Schema.Struct({
  contract: StageContract,
  /** Inlined instruction text plus its digest, so a later edit cannot change this run. */
  instruction: Schema.NullOr(Schema.Struct({ text: Schema.String, digest: Digest })),
  contextFiles: Schema.Array(Schema.Struct({ path: NonEmpty, digest: Digest })),
  requiredSkills: Schema.Array(ResolvedSkill),
  lazySkills: Schema.Array(ResolvedSkill),
  gates: Schema.Array(Schema.Struct({ definition: GateDefinition, digest: Digest })),
});
export type ResolvedStage = typeof ResolvedStage.Type;

/**
 * The immutable thing a run executes. Everything a stage needs is pinned here
 * by content, so "the playbook changed mid-run" is not a class of bug that can
 * happen. Nothing provider-specific belongs in this document; the execution
 * profile carries that and is persisted separately.
 */
export const RunPlan = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  planDigest: Digest,
  playbookId: NonEmpty,
  playbookVersion: NonEmpty,
  outcome: NonEmpty,
  inputs: Schema.Record(Schema.String, Schema.String),
  stages: Schema.Array(ResolvedStage),
  policy: PlaybookPolicy,
  compiledAt: Instant,
});
export type RunPlan = typeof RunPlan.Type;

export function stageIds(plan: RunPlan): StageId[] {
  return plan.stages.map((stage) => stage.contract.id);
}

export function findStage(plan: RunPlan, id: StageId): ResolvedStage | undefined {
  return plan.stages.find((stage) => stage.contract.id === id);
}

export function nextStageAfter(plan: RunPlan, id: StageId): StageId | null {
  const index = plan.stages.findIndex((stage) => stage.contract.id === id);
  if (index === -1) return null;
  return plan.stages[index + 1]?.contract.id ?? null;
}
