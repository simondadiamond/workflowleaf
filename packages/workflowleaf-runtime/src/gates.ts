/**
 * The gate runner.
 *
 * Code runs the checks and code writes the result. A model's account of how the
 * build went never enters this file, and there is deliberately no way to ask
 * for a gate to be marked passed.
 *
 * Every result carries the snapshot it was produced against, the gate
 * definition's digest and the digests of the inputs it read, so the controller
 * can tell later whether the verdict still describes anything. A snapshot taken
 * before and after the check catches the case where the worktree moved while
 * the check was running: that result describes a tree that no longer exists.
 */
import {
  type AttemptId,
  type Digest,
  type EvidenceRecord,
  type GateDefinition,
  type GateOutcome,
  type GateResultDetail,
  type RunId,
  type VisitId,
} from "@t3tools/workflowleaf-core";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { canonicalJson } from "./canonical.ts";
import { digestOf } from "./digest.ts";
import { observeExternal, type ExternalState } from "./externalChecks.ts";
import { runReview, type ReviewerConfig } from "./reviewer.ts";
import { globToRegExp } from "./skillCatalog.ts";
import { changedPaths, takeSnapshot, type SnapshotManifest } from "./workspaces.ts";

export class GateError extends Schema.TaggedError<GateError>()("WlGateError", {
  gateId: Schema.String,
  message: Schema.String,
}) {}

export interface GateContext {
  readonly runId: RunId;
  readonly visitId: VisitId;
  readonly attemptId: AttemptId;
  readonly workspacePath: string;
  readonly gateDigest: Digest;
  /** Where gate logs are written. Large output does not belong in the record. */
  readonly logDir: string;
  /** The snapshot the stage's work produced, used as the baseline for diff gates. */
  readonly baseline: SnapshotManifest;
  /** The revision the run branched from. A review gate is shown the change since it. */
  readonly baseRevision?: string | undefined;
  /** The run's pull request. External gates are measured against it. */
  readonly pullRequestNumber?: number | null | undefined;
  /** Artifacts the stage consumed and produced, shown to a reviewer alongside the diff. */
  readonly artifacts?: readonly string[] | undefined;
  /** Who judges review gates. Absent means review gates cannot run here, and say so. */
  readonly reviewer?: ReviewerConfig | undefined;
  /** The `gh` config directory for this repository, when the profile names one. */
  readonly ghConfigDir?: string | undefined;
}

const TOOL_VERSION = "1";

/** What one gate evaluation observed, before it becomes an evidence record. */
interface GateRun {
  readonly detail: GateResultDetail;
  readonly outcome: GateOutcome;
  readonly logRef: string | null;
}

/**
 * A TAP-ish summary: how many assertions passed and failed.
 *
 * Deliberately forgiving about format. The counts are recorded as evidence
 * alongside the exit code; they never replace it, so a parser that misreads a
 * line cannot turn a failing run green.
 */
export function parseCounts(output: string): { passed: number | null; failed: number | null } {
  const summary = /(\d+)\s+passed[^\d]*(?:\|\s*)?(?:(\d+)\s+failed)?/i.exec(output);
  if (summary !== null) {
    return {
      passed: Number(summary[1]),
      failed: summary[2] === undefined ? 0 : Number(summary[2]),
    };
  }

  const tapOk = output.match(/^ok\s/gim)?.length ?? null;
  const tapNotOk = output.match(/^not ok\s/gim)?.length ?? null;
  if (tapOk === null && tapNotOk === null) return { passed: null, failed: null };
  return { passed: tapOk ?? 0, failed: tapNotOk ?? 0 };
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulated, chunk) => accumulated + chunk,
    ),
  );

/**
 * What a command gate is told about the run it is checking. The base revision
 * matters most: a check that reads its configuration from the base, rather than
 * from the worktree, cannot be loosened by the stage it is checking.
 */
export function gateEnvironment(context: GateContext): Record<string, string> {
  return {
    WORKFLOWLEAF_RUN_ID: context.runId as string,
    WORKFLOWLEAF_WORKTREE: context.workspacePath,
    ...(context.baseRevision === undefined
      ? {}
      : { WORKFLOWLEAF_BASE_REVISION: context.baseRevision }),
    ...(context.pullRequestNumber === undefined || context.pullRequestNumber === null
      ? {}
      : { WORKFLOWLEAF_PR_NUMBER: String(context.pullRequestNumber) }),
    ...(context.ghConfigDir === undefined ? {} : { GH_CONFIG_DIR: context.ghConfigDir }),
  };
}

const runCommandGate = Effect.fnUntraced(function* (
  gate: Extract<GateDefinition, { type: "command" }>,
  context: GateContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const cwd =
    gate.cwd === undefined ? context.workspacePath : path.join(context.workspacePath, gate.cwd);

  const outcome = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Spawned directly with its argument list. Nothing here goes through a
    // shell, so a gate cannot grow a pipeline by accident.
    const child = yield* spawner.spawn(
      ChildProcess.make(gate.executable, [...gate.args], {
        cwd,
        env: gateEnvironment(context),
        extendEnv: true,
      }),
    );

    // The gate owns its own timeout and kills the process itself. Interrupting
    // the read would leave the check running while the run moved on, and a
    // signalled process reports no exit code at all, so that case is captured
    // rather than allowed to fail the gate as if an assertion had failed.
    const killed = yield* Ref.make(false);
    const killer = yield* Effect.forkChild(
      Effect.sleep(`${gate.timeoutMs} millis`).pipe(
        Effect.andThen(Ref.set(killed, true)),
        Effect.andThen(child.kill({ killSignal: "SIGKILL" })),
        Effect.ignore,
      ),
    );

    const [stdout, stderr, exit] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), Effect.result(child.exitCode)],
      { concurrency: "unbounded" },
    );
    yield* Fiber.interrupt(killer);

    return { stdout, stderr, exit, timedOut: yield* Ref.get(killed) };
  }).pipe(
    Effect.scoped,
    // A gate that cannot be started at all is a gate that could not run, which
    // the contract already distinguishes from one whose assertion failed.
    // Letting the spawn error escape would take the whole run down over a
    // mistyped executable, and record no verdict for the thing that broke.
    Effect.catchCause((cause) =>
      Effect.succeed({
        stdout: "",
        stderr: `${gate.executable} could not be started: ${Cause.pretty(cause)}`,
        exit: null,
        timedOut: false,
      }),
    ),
  );

  yield* fs.makeDirectory(context.logDir, { recursive: true });
  const logRef = path.join(context.logDir, `${gate.id}.${context.attemptId}.log`);
  yield* fs.writeFileString(
    logRef,
    `$ ${gate.executable} ${gate.args.join(" ")}\n\n${outcome.stdout}\n${outcome.stderr}`,
  );

  if (outcome.timedOut || outcome.exit === null || outcome.exit._tag === "Failure") {
    return {
      detail: {
        kind: "command",
        exitCode: null,
        timedOut: outcome.timedOut,
        passedCount: null,
        failedCount: null,
      },
      // The check could not run to completion, which is not the same as the
      // assertion inside it failing.
      outcome: "error",
      logRef,
    } satisfies GateRun;
  }

  const exitCode = Number(outcome.exit.success);
  const counts =
    gate.parse === "tap"
      ? parseCounts(`${outcome.stdout}\n${outcome.stderr}`)
      : { passed: null, failed: null };

  return {
    detail: {
      kind: "command",
      exitCode,
      timedOut: false,
      passedCount: counts.passed,
      failedCount: counts.failed,
    },
    outcome: exitCode === gate.expect.exitCode ? "passed" : "failed",
    logRef,
  } satisfies GateRun;
});

const runFileGate = Effect.fnUntraced(function* (
  gate: Extract<GateDefinition, { type: "file" }>,
  context: GateContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(context.workspacePath, gate.path);

  const minBytes = gate.minBytes ?? null;

  const exists = yield* fs.exists(target);
  if (!exists) {
    return {
      detail: { kind: "file", exists: false, bytes: null, missingContent: [], minBytes },
      outcome: gate.mustExist ? "failed" : "passed",
      logRef: null,
    } satisfies GateRun;
  }

  const text = yield* fs.readFileString(target);
  const bytes = new TextEncoder().encode(text).length;
  const missingContent = (gate.mustContain ?? []).filter((needle) => !text.includes(needle));
  const bigEnough = minBytes === null || bytes >= minBytes;

  return {
    detail: { kind: "file", exists: true, bytes, missingContent, minBytes },
    outcome: bigEnough && missingContent.length === 0 ? "passed" : "failed",
    logRef: null,
  } satisfies GateRun;
});

const runDiffGate = Effect.fnUntraced(function* (
  gate: Extract<GateDefinition, { type: "diff" }>,
  context: GateContext,
  current: SnapshotManifest,
) {
  const changed = changedPaths(context.baseline, current);
  const matchers = gate.allowedPaths.map(globToRegExp);
  const outsideScope = changed.filter((entry) => !matchers.some((matcher) => matcher.test(entry)));
  const tooMany = gate.maxChangedFiles !== undefined && changed.length > gate.maxChangedFiles;

  return {
    detail: { kind: "diff", changedFiles: changed, outsideScope },
    outcome: outsideScope.length === 0 && !tooMany ? "passed" : "failed",
    logRef: null,
  } satisfies GateRun;
});

const runReviewGate = Effect.fnUntraced(function* (
  gate: Extract<GateDefinition, { type: "review" }>,
  context: GateContext,
) {
  const couldNotRun = (why: string, logRef: string | null = null): GateRun => ({
    detail: {
      kind: "review",
      findings: [{ severity: "error", summary: why, failureScenario: "" }],
      criteriaJudged: 0,
    },
    outcome: "error",
    logRef,
  });

  if (context.reviewer === undefined) {
    return couldNotRun("No reviewer is configured, so this review gate cannot be judged.");
  }
  if (context.baseRevision === undefined) {
    return couldNotRun("The run's base revision is unknown, so there is no change to review.");
  }

  const reviewed = yield* runReview({
    gate,
    reviewer: context.reviewer,
    workspacePath: context.workspacePath,
    baseRevision: context.baseRevision,
    artifacts: context.artifacts ?? [],
    logDir: context.logDir,
    attemptId: context.attemptId as string,
  }).pipe(
    Effect.map((outcome) => ({ ok: true as const, outcome })),
    // A reviewer that could not be started or did not answer is a gate that
    // could not run. It must never surface as a pass, and never take the run
    // down with it.
    Effect.catchCause((cause) =>
      Effect.succeed({ ok: false as const, why: Cause.pretty(cause).split("\n")[0] ?? "" }),
    ),
  );

  if (!reviewed.ok) return couldNotRun(reviewed.why);

  const { findings, criteriaJudged, logRef } = reviewed.outcome;
  const blocking = findings.filter((finding) => gate.blockingSeverities.includes(finding.severity));
  return {
    detail: { kind: "review", findings: [...findings], criteriaJudged },
    outcome: blocking.length === 0 ? "passed" : "failed",
    logRef,
  } satisfies GateRun;
});

const EXTERNAL_OUTCOME: Record<ExternalState, GateOutcome> = {
  satisfied: "passed",
  unsatisfied: "failed",
  pending: "pending",
  // A result nobody can attribute to this run's head is a failure a stage can
  // fix by pushing, never a pass.
  unattributed: "failed",
  unavailable: "error",
};

const runExternalGate = Effect.fnUntraced(function* (
  gate: Extract<GateDefinition, { type: "external" }>,
  context: GateContext,
) {
  const observed = yield* observeExternal({
    gate,
    workspacePath: context.workspacePath,
    pullRequestNumber: context.pullRequestNumber ?? null,
    ghConfigDir: context.ghConfigDir,
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        state: "unavailable" as const,
        boundValue: null,
        detail: `The check could not run: ${Cause.pretty(cause).split("\n")[0] ?? ""}`,
      }),
    ),
  );

  return {
    detail: {
      kind: "external",
      check: gate.check,
      boundValue: observed.boundValue,
      state: observed.state,
      detail: observed.detail,
    },
    outcome: EXTERNAL_OUTCOME[observed.state],
    logRef: null,
  } satisfies GateRun;
});

/**
 * Runs one gate and records what it observed.
 *
 * Command, file and diff gates are decided by code. A review gate is judged by
 * the profile's reviewer, a separate model process that never saw the stage's
 * context. An external gate reads the run's pull request. Either one that
 * cannot run says so as `error`: returning a pass for a check nothing performed
 * is the failure this whole layer exists to prevent.
 */
export const evaluateGate = Effect.fnUntraced(function* (
  gate: GateDefinition,
  context: GateContext,
) {
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const before = yield* takeSnapshot(context.workspacePath, startedAt);

  const result: GateRun = yield* (() => {
    switch (gate.type) {
      case "command":
        return runCommandGate(gate, context);
      case "file":
        return runFileGate(gate, context);
      case "diff":
        return runDiffGate(gate, context, before);
      case "review":
        return runReviewGate(gate, context);
      case "external":
        return runExternalGate(gate, context);
    }
  })();

  const endedAt = DateTime.formatIso(yield* DateTime.now);
  const after = yield* takeSnapshot(context.workspacePath, endedAt);
  const mutatedDuringCheck = after.snapshotId !== before.snapshotId;

  // Only the paths the gate could plausibly have read are recorded as inputs,
  // so an unrelated edit does not invalidate an unrelated verdict.
  const inputDigests = inputsFor(gate, before);

  return {
    runId: context.runId,
    visitId: context.visitId,
    attemptId: context.attemptId,
    gateId: gate.id,
    gateDigest: context.gateDigest,
    snapshotId: before.snapshotId,
    inputDigests,
    tool: gateTool(gate, context),
    toolVersion: TOOL_VERSION,
    startedAt,
    endedAt,
    // A pass produced against a tree that moved underneath it is not a pass.
    outcome: mutatedDuringCheck && result.outcome === "passed" ? "stale" : result.outcome,
    detail: result.detail,
    logRef: result.logRef,
    mutatedDuringCheck,
  } satisfies EvidenceRecord;
});

function gateTool(gate: GateDefinition, context: GateContext): string {
  if (gate.type === "command") return gate.executable;
  if (gate.type === "review") return `review:${context.reviewer?.executable ?? "none"}`;
  if (gate.type === "external") return `external:${gate.check}`;
  return `workflowleaf:${gate.type}`;
}

function inputsFor(
  gate: GateDefinition,
  snapshot: SnapshotManifest,
): readonly { readonly path: string; readonly digest: Digest }[] {
  switch (gate.type) {
    case "file": {
      const file = snapshot.files.find((entry) => entry.path === gate.path);
      return file === undefined ? [] : [file];
    }
    case "diff":
    case "command":
    case "review":
      // A command gate or a reviewer can read anything in the worktree, so the
      // whole snapshot is its input. That is what makes any change invalidate
      // its verdict.
      return snapshot.files;
    default:
      return [];
  }
}

/**
 * Records a reviewer's findings as judgment.
 *
 * A review verdict is a person or a model reading a diff. It is stored the same
 * way as a command result so the controller treats it uniformly, but the detail
 * says plainly what kind of thing it is.
 */
export function reviewEvidence(input: {
  readonly context: GateContext;
  readonly gate: Extract<GateDefinition, { type: "review" }>;
  readonly findings: readonly { severity: string; summary: string; failureScenario: string }[];
  readonly snapshotId: EvidenceRecord["snapshotId"];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly reviewer: string;
}): EvidenceRecord {
  const blocking = input.findings.filter((finding) =>
    input.gate.blockingSeverities.includes(finding.severity),
  );

  return {
    runId: input.context.runId,
    visitId: input.context.visitId,
    attemptId: input.context.attemptId,
    gateId: input.gate.id,
    gateDigest: input.context.gateDigest,
    snapshotId: input.snapshotId,
    inputDigests: [],
    tool: `review:${input.reviewer}`,
    toolVersion: TOOL_VERSION,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    outcome: blocking.length === 0 ? "passed" : "failed",
    detail: { kind: "review", findings: [...input.findings] },
    logRef: null,
    mutatedDuringCheck: false,
  };
}

/**
 * Records an integration result, bound to the thing it was measured against.
 *
 * A green check against another commit, or a canary against yesterday's
 * deployment, proves nothing about this run. An unattributable result is
 * recorded as `unattributed` and does not satisfy the gate.
 */
export function externalEvidence(input: {
  readonly context: GateContext;
  readonly gate: Extract<GateDefinition, { type: "external" }>;
  readonly boundValue: string | null;
  readonly expectedBoundValue: string | null;
  readonly satisfied: boolean;
  readonly detail: string | null;
  readonly snapshotId: EvidenceRecord["snapshotId"];
  readonly startedAt: string;
  readonly endedAt: string;
}): EvidenceRecord {
  const attributed =
    input.boundValue !== null &&
    input.expectedBoundValue !== null &&
    input.boundValue === input.expectedBoundValue;

  const state = !attributed ? "unattributed" : input.satisfied ? "satisfied" : "unsatisfied";

  return {
    runId: input.context.runId,
    visitId: input.context.visitId,
    attemptId: input.context.attemptId,
    gateId: input.gate.id,
    gateDigest: input.context.gateDigest,
    snapshotId: input.snapshotId,
    inputDigests: [],
    tool: `external:${input.gate.check}`,
    toolVersion: TOOL_VERSION,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    outcome: state === "satisfied" ? "passed" : "failed",
    detail: {
      kind: "external",
      check: input.gate.check,
      boundValue: input.boundValue,
      state,
      detail:
        state === "unattributed"
          ? `Result could not be attributed to ${input.gate.boundTo} ${input.expectedBoundValue ?? "<unknown>"}.`
          : input.detail,
    },
    logRef: null,
    mutatedDuringCheck: false,
  };
}

/** Records a human waiver against the exact plan and gate it was granted for. */
export function waiverEvidence(input: {
  readonly evidence: EvidenceRecord;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}): EvidenceRecord {
  return {
    ...input.evidence,
    outcome: "waived",
    tool: `waiver:${input.by}`,
    endedAt: input.at,
    logRef: input.evidence.logRef,
    detail: input.evidence.detail,
  };
}

/** The digest a run pins a gate by. Key order cannot change it. */
export const gateDigestOf = (gate: GateDefinition): Digest => digestOf(canonicalJson(gate));
