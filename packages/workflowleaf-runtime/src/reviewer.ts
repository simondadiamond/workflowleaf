/**
 * The review gate's judge.
 *
 * A review gate asks a question code cannot answer, so a model answers it. That
 * model is never the one that did the work: it is a separate process, started
 * by code, given the diff and the stage's artifacts, and asked one criterion at
 * a time. Its answer is read against a schema and recorded as judgment. The
 * stage being reviewed never sees the call and cannot influence it.
 *
 * The command is the profile's to choose. The default is a fresh `claude -p`
 * with read-only tools and no user settings, which is independent of the stage
 * context and cheap enough to run per criterion. Anything that reads a prompt
 * on stdin and prints the verdict JSON (or an envelope carrying it) works, so a
 * Codex or other reviewer is a profile change rather than a code change.
 */
import type { GateDefinition } from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { canonicalJson } from "./canonical.ts";
import { complete } from "./exec.ts";
import { git, splitNul } from "./git.ts";

export interface ReviewerConfig {
  readonly executable: string;
  /**
   * Arguments. `${schema}` is replaced with the verdict JSON Schema inline and
   * `${schemaFile}` with the path of a file holding it, for reviewers that take
   * one or the other.
   */
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export const DEFAULT_REVIEWER: ReviewerConfig = {
  executable: "claude",
  args: [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    "${schema}",
    "--tools",
    "Read",
    "Grep",
    "Glob",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--system-prompt",
    "You are an independent code reviewer. You did not write this change. Judge it only against the criterion you are given, and answer only through the structured output.",
  ],
  timeoutMs: 300_000,
};

export interface ReviewFinding {
  readonly severity: string;
  readonly summary: string;
  readonly failureScenario: string;
}

const Verdict = Schema.Struct({
  satisfied: Schema.Boolean,
  severity: Schema.String,
  summary: Schema.String,
  failureScenario: Schema.String,
});
type Verdict = typeof Verdict.Type;

const decodeVerdictValue = Schema.decodeUnknownResult(Verdict);
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** The severities a reviewer may choose from: the gate's blocking ones, plus one that is not. */
export function severitiesFor(gate: Extract<GateDefinition, { type: "review" }>): string[] {
  return [...new Set([...gate.blockingSeverities, "note"])];
}

export function verdictSchema(severities: readonly string[]): unknown {
  return {
    type: "object",
    properties: {
      satisfied: {
        type: "boolean",
        description: "True when the change meets the criterion.",
      },
      severity: {
        type: "string",
        enum: severities,
        description: "How serious an unmet criterion is. Ignored when satisfied.",
      },
      summary: { type: "string", description: "What you found, in one or two sentences." },
      failureScenario: {
        type: "string",
        description:
          "When unmet: the concrete inputs or state that produce the problem, and the wrong output or crash that results. Empty when satisfied.",
      },
    },
    required: ["satisfied", "severity", "summary", "failureScenario"],
    additionalProperties: false,
  };
}

export function reviewerArgs(
  config: ReviewerConfig,
  schemaJson: string,
  schemaFile: string,
): string[] {
  return config.args.map((arg) =>
    arg.replaceAll("${schemaFile}", schemaFile).replaceAll("${schema}", schemaJson),
  );
}

function tryVerdict(value: unknown): Verdict | null {
  const decoded = decodeVerdictValue(value);
  return decoded._tag === "Success" ? decoded.success : null;
}

function tryJson(text: string): unknown {
  const decoded = decodeJson(text.trim());
  return decoded._tag === "Success" ? decoded.success : undefined;
}

/**
 * Reads a verdict out of whatever the reviewer printed.
 *
 * Accepts the verdict itself, a `claude -p --output-format json` envelope
 * (`structured_output`, or `result` holding the verdict as text), or the last
 * line that parses as a verdict. Nothing else counts: a reviewer that did not
 * answer in the schema has not answered.
 */
export function decodeVerdict(stdout: string): Verdict | null {
  const whole = tryJson(stdout);
  const direct = tryVerdict(whole);
  if (direct !== null) return direct;

  if (typeof whole === "object" && whole !== null) {
    const envelope = whole as Record<string, unknown>;
    const structured = tryVerdict(envelope.structured_output);
    if (structured !== null) return structured;
    if (typeof envelope.result === "string") {
      const inner = tryVerdict(tryJson(envelope.result));
      if (inner !== null) return inner;
    }
  }

  const lines = stdout.split("\n").toReversed();
  for (const line of lines) {
    const verdict = tryVerdict(tryJson(line));
    if (verdict !== null) return verdict;
  }
  return null;
}

/** Enough diff to judge a story-sized change; more than this is read from the worktree. */
const DIFF_LIMIT = 150_000;
const ARTIFACT_LIMIT = 40_000;

function capped(text: string, limit: number, what: string): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… ${what} truncated at ${String(limit)} characters. Read the files in the worktree for the rest.`;
}

export interface ReviewMaterial {
  readonly diff: string;
  readonly artifacts: readonly { readonly path: string; readonly text: string }[];
}

/**
 * What the reviewer is shown: the change since the run's base revision,
 * including files not yet committed or tracked, and the artifacts the stage
 * consumed and produced. WorkflowLeaf's own run files are excluded from the
 * diff and shown as artifacts instead.
 */
export const reviewMaterial = Effect.fnUntraced(function* (input: {
  readonly workspacePath: string;
  readonly baseRevision: string;
  readonly artifacts: readonly string[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tracked = yield* git(input.workspacePath, [
    "diff",
    "--no-color",
    input.baseRevision,
    "--",
    ".",
    ":(exclude).workflowleaf",
  ]);
  const untracked = splitNul(
    yield* git(input.workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ).filter((entry) => !entry.startsWith(".workflowleaf/"));

  const added: string[] = [];
  for (const entry of untracked) {
    const text = yield* fs
      .readFileString(path.join(input.workspacePath, entry))
      .pipe(Effect.catchCause(() => Effect.succeed("<unreadable>")));
    added.push(`--- new, untracked: ${entry}\n${text}`);
  }

  const artifacts: { path: string; text: string }[] = [];
  for (const name of input.artifacts) {
    const file = path.join(input.workspacePath, name);
    const exists = yield* fs.exists(file).pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) continue;
    const info = yield* fs.stat(file);
    if (info.type !== "File") continue;
    const text = yield* fs.readFileString(file);
    artifacts.push({ path: name, text: capped(text, ARTIFACT_LIMIT, name) });
  }

  return {
    diff: capped([tracked, ...added].join("\n"), DIFF_LIMIT, "The diff"),
    artifacts,
  } satisfies ReviewMaterial;
});

export function criterionPrompt(input: {
  readonly rubric: string;
  readonly criterion: string;
  readonly severities: readonly string[];
  readonly blocking: readonly string[];
  readonly material: ReviewMaterial;
}): string {
  const sections = [
    "You are reviewing a change you did not write. Your working directory is its worktree; read any file you need. Do not modify anything.",
    `## The rubric this review applies\n\n${input.rubric.trim()}`,
    `## The one criterion to judge\n\n${input.criterion.trim()}`,
    [
      "## How to answer",
      "",
      "Answer through the structured output only.",
      "- `satisfied`: true when the change meets this criterion. Judge this criterion alone.",
      `- \`severity\`: one of ${input.severities.map((one) => `\`${one}\``).join(", ")}. ${input.blocking.map((one) => `\`${one}\``).join(" and ")} block the change; use them only for a real defect.`,
      "- `failureScenario`: when unmet, the concrete inputs or state that trigger the problem and the wrong result. A finding without one is an opinion.",
      "Verify claims against the code, not against what a description says it does.",
    ].join("\n"),
  ];

  for (const artifact of input.material.artifacts) {
    sections.push(`## Artifact \`${artifact.path}\`\n\n${artifact.text}`);
  }
  sections.push(
    `## The change\n\n\`\`\`diff\n${input.material.diff.trim() || "(no changes)"}\n\`\`\``,
  );

  return sections.join("\n\n");
}

export class ReviewerFailed extends Schema.TaggedError<ReviewerFailed>()("WlReviewerFailed", {
  message: Schema.String,
}) {}

export interface ReviewOutcome {
  readonly findings: readonly ReviewFinding[];
  readonly criteriaJudged: number;
  readonly logRef: string;
}

/**
 * Judges every criterion of one review gate, each in its own reviewer process.
 *
 * Any criterion the reviewer failed to answer fails the whole evaluation with
 * `ReviewerFailed`, which the gate runner records as "could not run". A partial
 * review is not a review.
 */
export const runReview = Effect.fnUntraced(function* (input: {
  readonly gate: Extract<GateDefinition, { type: "review" }>;
  readonly reviewer: ReviewerConfig;
  readonly workspacePath: string;
  readonly baseRevision: string;
  readonly artifacts: readonly string[];
  readonly logDir: string;
  readonly attemptId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const severities = severitiesFor(input.gate);
  const schemaJson = canonicalJson(verdictSchema(severities));
  yield* fs.makeDirectory(input.logDir, { recursive: true });
  const schemaFile = path.join(input.logDir, `${input.gate.id}.schema.json`);
  yield* fs.writeFileString(schemaFile, schemaJson);
  const args = reviewerArgs(input.reviewer, schemaJson, schemaFile);

  const material = yield* reviewMaterial(input);
  const criteria =
    input.gate.criteria !== undefined && input.gate.criteria.length > 0
      ? input.gate.criteria
      : [input.gate.rubric];

  const judged = yield* Effect.forEach(
    criteria,
    (criterion, index) =>
      Effect.gen(function* () {
        const prompt = criterionPrompt({
          rubric: input.gate.rubric,
          criterion,
          severities,
          blocking: input.gate.blockingSeverities,
          material,
        });
        const result = yield* complete(
          input.reviewer.executable,
          args,
          input.workspacePath,
          prompt,
        ).pipe(
          Effect.timeoutOption(`${input.reviewer.timeoutMs} millis`),
          Effect.catchCause((cause) =>
            Effect.fail(
              new ReviewerFailed({
                message: `${input.reviewer.executable} could not be started: ${String(cause)}`,
              }),
            ),
          ),
        );
        return { index, criterion, result };
      }),
    { concurrency: 4 },
  );

  const findings: ReviewFinding[] = [];
  const log: string[] = [`$ ${input.reviewer.executable} ${args.join(" ")}`];
  const failures: string[] = [];

  for (const { index, criterion, result } of judged) {
    log.push(`\n## criterion ${String(index + 1)}: ${criterion}`);
    if (result._tag === "None") {
      failures.push(`criterion ${String(index + 1)} timed out`);
      log.push("timed out");
      continue;
    }
    log.push(
      `exit ${String(result.value.exitCode)}\n${result.value.stdout}\n${result.value.stderr}`,
    );
    const verdict = result.value.exitCode === 0 ? decodeVerdict(result.value.stdout) : null;
    if (verdict === null) {
      failures.push(
        `criterion ${String(index + 1)} got no verdict (exit ${String(result.value.exitCode)})`,
      );
      continue;
    }
    if (!verdict.satisfied) {
      findings.push({
        severity: severities.includes(verdict.severity) ? verdict.severity : "note",
        summary: `${criterion.trim().split("\n")[0]}: ${verdict.summary}`,
        failureScenario: verdict.failureScenario,
      });
    }
  }

  const logRef = path.join(input.logDir, `${input.gate.id}.${input.attemptId}.review.log`);
  yield* fs.writeFileString(logRef, log.join("\n"));

  if (failures.length > 0) {
    return yield* new ReviewerFailed({
      message: `The reviewer did not answer: ${failures.join("; ")}. See ${logRef}.`,
    });
  }

  return { findings, criteriaJudged: criteria.length, logRef } satisfies ReviewOutcome;
});
