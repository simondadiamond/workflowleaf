/**
 * Evidence and its validity rules.
 *
 * A verdict is only ever valid for the exact inputs it was produced from. The
 * failure this prevents is the quiet one: a gate passed at 10:02, the code
 * changed at 10:05, and the run advanced at 10:06 on a green that no longer
 * describes anything. Timestamps do not establish freshness; digests do.
 *
 * Nothing a model says is evidence. The controller invokes the checker and
 * records what the checker returned.
 */
import * as Schema from "effect/Schema";

import { AttemptId, Digest, GateId, Instant, RunId, SnapshotId, VisitId } from "./ids.ts";

/** `error` is "the check could not run", which is not the same as "the check failed". */
export const GateOutcome = Schema.Literals(["passed", "failed", "error", "stale", "waived"]);
export type GateOutcome = typeof GateOutcome.Type;

export const CommandResult = Schema.Struct({
  kind: Schema.Literal("command"),
  exitCode: Schema.NullOr(Schema.Int),
  /** Set when the process was killed for exceeding its timeout. */
  timedOut: Schema.Boolean,
  passedCount: Schema.NullOr(Schema.Int),
  failedCount: Schema.NullOr(Schema.Int),
});

export const FileResult = Schema.Struct({
  kind: Schema.Literal("file"),
  exists: Schema.Boolean,
  bytes: Schema.NullOr(Schema.Int),
  missingContent: Schema.Array(Schema.String),
  /**
   * The size the gate required. Without it a too-short file records as "142
   * bytes" with nothing missing, and neither a reader nor the stage being
   * corrected can tell what was wrong. Optional so evidence written before this
   * field existed still decodes.
   */
  minBytes: Schema.optional(Schema.NullOr(Schema.Int)),
});

export const DiffResult = Schema.Struct({
  kind: Schema.Literal("diff"),
  changedFiles: Schema.Array(Schema.String),
  outsideScope: Schema.Array(Schema.String),
});

export const ReviewResult = Schema.Struct({
  kind: Schema.Literal("review"),
  findings: Schema.Array(
    Schema.Struct({
      severity: Schema.String,
      summary: Schema.String,
      failureScenario: Schema.String,
    }),
  ),
});

export const ExternalResult = Schema.Struct({
  kind: Schema.Literal("external"),
  check: Schema.String,
  /** What the result is bound to. A green against another revision proves nothing. */
  boundValue: Schema.NullOr(Schema.String),
  state: Schema.Literals(["satisfied", "unsatisfied", "unattributed", "unavailable"]),
  detail: Schema.NullOr(Schema.String),
});

export const GateResultDetail = Schema.Union([
  CommandResult,
  FileResult,
  DiffResult,
  ReviewResult,
  ExternalResult,
]);
export type GateResultDetail = typeof GateResultDetail.Type;

export const EvidenceRecord = Schema.Struct({
  runId: RunId,
  visitId: VisitId,
  attemptId: AttemptId,
  gateId: GateId,
  /** The gate definition this verdict was produced against. */
  gateDigest: Digest,
  /** Worktree content at evaluation time, including uncommitted and untracked files. */
  snapshotId: SnapshotId,
  /** Digests of the artifacts the gate read, so an upstream repair invalidates this. */
  inputDigests: Schema.Array(Schema.Struct({ path: Schema.String, digest: Digest })),
  tool: Schema.String,
  toolVersion: Schema.String,
  startedAt: Instant,
  endedAt: Instant,
  outcome: GateOutcome,
  detail: GateResultDetail,
  /** Where the full log lives. Large output does not belong in the record. */
  logRef: Schema.NullOr(Schema.String),
  /**
   * Set when the worktree changed while the check was running. The result
   * describes a tree that no longer exists, so it cannot pass anything.
   */
  mutatedDuringCheck: Schema.Boolean,
});
export type EvidenceRecord = typeof EvidenceRecord.Type;

export interface CurrentInputs {
  readonly snapshotId: SnapshotId;
  readonly gateDigest: Digest;
  readonly inputDigests: ReadonlyMap<string, Digest>;
}

export type StaleReason =
  | "snapshot-changed"
  | "gate-redefined"
  | "input-changed"
  | "mutated-during-check";

/**
 * Why this evidence no longer describes the current state, or `null` if it
 * still does. Missing evidence is handled by the caller and is never a pass.
 */
export function stalenessOf(evidence: EvidenceRecord, current: CurrentInputs): StaleReason | null {
  if (evidence.mutatedDuringCheck) return "mutated-during-check";
  if (evidence.gateDigest !== current.gateDigest) return "gate-redefined";
  if (evidence.snapshotId !== current.snapshotId) return "snapshot-changed";

  for (const input of evidence.inputDigests) {
    if (current.inputDigests.get(input.path) !== input.digest) return "input-changed";
  }

  return null;
}

/**
 * The single question the controller asks before releasing a stage.
 *
 * `waived` counts as satisfied on purpose: a human took responsibility for it,
 * and the waiver is recorded against this plan and these inputs. It is shown as
 * an exception, never folded into a plain green.
 */
export function satisfies(evidence: EvidenceRecord | undefined, current: CurrentInputs): boolean {
  if (evidence === undefined) return false;
  if (stalenessOf(evidence, current) !== null) return false;
  return evidence.outcome === "passed" || evidence.outcome === "waived";
}

/**
 * Evidence that depended on a repaired artifact. A repair that rewrites an
 * earlier stage's output silently invalidates every downstream verdict that
 * read it; this is how the controller finds them.
 */
export function dependentOn(
  records: readonly EvidenceRecord[],
  changedPaths: readonly string[],
): EvidenceRecord[] {
  const changed = new Set(changedPaths);
  return records.filter((record) => record.inputDigests.some((input) => changed.has(input.path)));
}
