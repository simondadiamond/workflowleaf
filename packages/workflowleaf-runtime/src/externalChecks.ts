/**
 * External gates: what GitHub says about the run's pull request.
 *
 * An external result proves something only about the revision it was measured
 * on, so every check here is bound to the pull request's head commit and
 * compared with the worktree's own HEAD. A green on a head the worktree has
 * moved past is `unattributed`, and satisfies nothing.
 *
 * Three outcomes matter to the controller. `satisfied` passes the gate.
 * `unsatisfied` is something a stage can fix, such as a failing check or an
 * unresolved review thread, and the summary lists each one so the correction
 * has something to act on. `pending` is something nobody can fix yet: checks
 * still running or a reviewer still to answer. The run waits and asks again.
 *
 * Convergence needs a review, not the absence of one. A pull request nobody has
 * looked at has no threads and no requested reviewers either, and on a
 * repository whose review bots skip drafts it also has only SKIPPED checks, so
 * "nothing outstanding" alone passed a draft no one reviewed (#42).
 */
import type { GateDefinition } from "@t3tools/workflowleaf-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { complete } from "./exec.ts";
import { ghEnvironment } from "./pullRequest.ts";
import { revParse } from "./git.ts";

export type ExternalState =
  | "satisfied"
  | "unsatisfied"
  | "pending"
  | "unattributed"
  | "unavailable";

export interface ExternalObservation {
  readonly state: ExternalState;
  /** The head commit the result was measured on, when one was read. */
  readonly boundValue: string | null;
  readonly detail: string;
}

/** Checks this runner knows. Anything else is reported as unavailable, never as a pass. */
export const KNOWN_EXTERNAL_CHECKS = [
  "pull-request-exists",
  "checks-green",
  "converged-on-head",
] as const;

const CheckContext = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

const ReviewThread = Schema.Struct({
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Int),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        body: Schema.String,
        author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
      }),
    ),
  }),
});

const SubmittedReview = Schema.Struct({
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
});

const PullRequestState = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          state: Schema.String,
          isDraft: Schema.Boolean,
          author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
          headRefOid: Schema.String,
          reviewDecision: Schema.NullOr(Schema.String),
          reviewRequests: Schema.Struct({ totalCount: Schema.Int }),
          reviewThreads: Schema.Struct({ nodes: Schema.Array(ReviewThread) }),
          reviews: Schema.Struct({ nodes: Schema.Array(SubmittedReview) }),
          timelineItems: Schema.Struct({
            nodes: Schema.Array(Schema.Struct({ createdAt: Schema.optional(Schema.String) })),
          }),
          commits: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                commit: Schema.Struct({
                  committedDate: Schema.String,
                  statusCheckRollup: Schema.NullOr(
                    Schema.Struct({
                      contexts: Schema.Struct({ nodes: Schema.Array(CheckContext) }),
                    }),
                  ),
                }),
              }),
            ),
          }),
        }),
      ),
    }),
  }),
});
export type PullRequestState = NonNullable<
  (typeof PullRequestState.Type)["data"]["repository"]["pullRequest"]
>;

const decodeState = Schema.decodeUnknownResult(Schema.fromJsonString(PullRequestState));

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
      author { login }
      headRefOid
      reviewDecision
      reviewRequests { totalCount }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) { nodes { body author { login } } }
        }
      }
      reviews(last: 100, states: [COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED]) {
        nodes { author { login } commit { oid } }
      }
      timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) {
        nodes { ... on ReadyForReviewEvent { createdAt } }
      }
      commits(last: 1) {
        nodes {
          commit {
            committedDate
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

interface CheckSummary {
  readonly pending: readonly string[];
  readonly failing: readonly string[];
  /** Checks that declined to run. Not a failure, and never evidence that anything was reviewed. */
  readonly skipped: readonly string[];
}

function summarizeChecks(pr: PullRequestState): CheckSummary {
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const pending: string[] = [];
  const failing: string[] = [];
  const skipped: string[] = [];

  for (const check of contexts) {
    if (check.__typename === "StatusContext") {
      const name = check.context ?? "status";
      if (check.state === "PENDING" || check.state === "EXPECTED") pending.push(name);
      else if (check.state !== "SUCCESS") failing.push(`${name} (${String(check.state)})`);
      continue;
    }
    const name = check.name ?? "check";
    if (check.status !== "COMPLETED") pending.push(name);
    else if (check.conclusion === "SKIPPED") skipped.push(name);
    else if (!PASSING_CONCLUSIONS.has(check.conclusion ?? "")) {
      failing.push(`${name} (${String(check.conclusion)})`);
    }
  }
  return { pending, failing, skipped };
}

function firstLine(text: string, limit = 240): string {
  const line =
    text
      .trim()
      .split("\n")
      .find((entry) => entry.trim().length > 0) ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/**
 * The verdict for one check against one pull request state. Pure, so each rule
 * is testable without GitHub.
 */
export function judgeExternal(input: {
  readonly check: string;
  readonly pr: PullRequestState | null;
  readonly localHead: string;
  /** When the check is judged, as epoch milliseconds. Only the review wait reads it. */
  readonly now?: number | undefined;
  /**
   * How long a ready pull request with nothing outstanding may go without a
   * review before converging anyway. Absent means it waits for a review.
   */
  readonly reviewWaitMinutes?: number | undefined;
}): ExternalObservation {
  const { pr } = input;
  if (pr === null || pr.state !== "OPEN") {
    return {
      state: "unsatisfied",
      boundValue: null,
      detail: pr === null ? "The run has no pull request." : `The pull request is ${pr.state}.`,
    };
  }

  if (pr.headRefOid !== input.localHead) {
    return {
      state: "unattributed",
      boundValue: pr.headRefOid,
      detail: `The pull request's head is ${pr.headRefOid.slice(0, 12)}, but the worktree is at ${input.localHead.slice(0, 12)}. Push the work, then check again.`,
    };
  }

  const bound = pr.headRefOid;
  if (input.check === "pull-request-exists") {
    return { state: "satisfied", boundValue: bound, detail: "Open, and its head is this run's." };
  }

  const checks = summarizeChecks(pr);
  if (checks.failing.length > 0) {
    return {
      state: "unsatisfied",
      boundValue: bound,
      detail: `Failing checks: ${checks.failing.join(", ")}.`,
    };
  }

  if (input.check === "checks-green") {
    return checks.pending.length > 0
      ? {
          state: "pending",
          boundValue: bound,
          detail: `Still running: ${checks.pending.join(", ")}.`,
        }
      : { state: "satisfied", boundValue: bound, detail: "Every check on the head passed." };
  }

  // converged-on-head: checks green, every live review thread resolved, and
  // nobody still asked to review.
  const open = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved && !thread.isOutdated);
  if (open.length > 0 || pr.reviewDecision === "CHANGES_REQUESTED") {
    const threads = open.map((thread) => {
      const comment = thread.comments.nodes[0];
      const where =
        thread.path === null ? "general" : `${thread.path}:${String(thread.line ?? "?")}`;
      return `- ${where} (${comment?.author?.login ?? "unknown"}): ${firstLine(comment?.body ?? "")}`;
    });
    return {
      state: "unsatisfied",
      boundValue: bound,
      detail: [
        `${String(open.length)} unresolved review thread(s)${pr.reviewDecision === "CHANGES_REQUESTED" ? ", and changes were requested" : ""}. Fix each, or answer it on the pull request if it is wrong, then push.`,
        ...threads,
      ].join("\n"),
    };
  }

  if (checks.pending.length > 0 || pr.reviewRequests.totalCount > 0) {
    const waiting = [
      ...(checks.pending.length > 0 ? [`checks still running: ${checks.pending.join(", ")}`] : []),
      ...(pr.reviewRequests.totalCount > 0
        ? [`${String(pr.reviewRequests.totalCount)} reviewer(s) yet to answer`]
        : []),
    ];
    return { state: "pending", boundValue: bound, detail: `Waiting: ${waiting.join("; ")}.` };
  }

  // Someone other than the author must have reviewed this head. The author's
  // own reviews do not count: replying to a thread from the run's account files
  // one, and a stage must not be able to satisfy its own gate.
  const author = pr.author?.login ?? null;
  const reviewers = [
    ...new Set(
      pr.reviews.nodes
        .filter((review) => review.commit?.oid === bound && review.author?.login !== author)
        .map((review) => review.author?.login ?? "unknown"),
    ),
  ];
  if (reviewers.length > 0) {
    return {
      state: "satisfied",
      boundValue: bound,
      detail: `Checks green, no unresolved review threads, reviewed on this head by ${reviewers.join(", ")}.`,
    };
  }

  const since = reviewableSince(pr);
  const wait = input.reviewWaitMinutes;
  if (since !== null && wait !== undefined && input.now !== undefined) {
    const waited = Math.floor((input.now - since) / 60_000);
    if (waited >= wait) {
      return {
        state: "satisfied",
        boundValue: bound,
        detail: `Checks green, no unresolved review threads. No review came in ${String(waited)} minute(s) after the head was up for review, and the profile waits ${String(wait)}.`,
      };
    }
  }

  const why = [
    pr.isDraft ? "it is a draft, and review bots commonly skip drafts" : null,
    checks.skipped.length > 0 ? `skipped, not reviewed: ${checks.skipped.join(", ")}` : null,
    wait !== undefined && !pr.isDraft
      ? `the profile converges without one after ${String(wait)} minute(s)`
      : null,
  ].filter((part) => part !== null);
  return {
    state: "pending",
    boundValue: bound,
    detail: `Waiting: nobody but the author has reviewed ${bound.slice(0, 12)} yet${why.length > 0 ? ` (${why.join("; ")})` : ""}.`,
  };
}

/**
 * When the head became reviewable: the later of its commit and the pull
 * request leaving draft. A draft is never reviewable, so it has no such time.
 */
function reviewableSince(pr: PullRequestState): number | null {
  if (pr.isDraft) return null;
  const times = [
    pr.commits.nodes[0]?.commit.committedDate,
    ...pr.timelineItems.nodes.map((item) => item.createdAt),
  ]
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => {
      const parsed = DateTime.make(value);
      return parsed._tag === "Some" ? [DateTime.toEpochMillis(parsed.value)] : [];
    });
  return times.length === 0 ? null : Math.max(...times);
}

/** `owner/name` of the repository `gh` resolves from the worktree's remote. */
const repositoryOf = Effect.fnUntraced(function* (cwd: string, ghConfigDir?: string) {
  const result = yield* complete(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    cwd,
    { env: ghEnvironment(ghConfigDir) },
  );
  const name = result.stdout.trim();
  if (result.exitCode !== 0 || !name.includes("/")) return null;
  const [owner, repo] = name.split("/");
  return { owner: owner!, name: repo! };
});

/**
 * Observes one external gate. Failures to reach GitHub come back as
 * `unavailable`, which the gate runner records as "could not run".
 */
export const observeExternal = Effect.fnUntraced(function* (input: {
  readonly gate: Extract<GateDefinition, { type: "external" }>;
  readonly workspacePath: string;
  readonly pullRequestNumber: number | null;
  readonly ghConfigDir?: string | undefined;
  readonly reviewWaitMinutes?: number | undefined;
}) {
  if (!(KNOWN_EXTERNAL_CHECKS as readonly string[]).includes(input.gate.check)) {
    return {
      state: "unavailable",
      boundValue: null,
      detail: `No integration evaluates "${input.gate.check}". Known checks: ${KNOWN_EXTERNAL_CHECKS.join(", ")}.`,
    } satisfies ExternalObservation;
  }
  if (input.gate.boundTo !== "head-sha") {
    return {
      state: "unavailable",
      boundValue: null,
      detail: `"${input.gate.check}" can only be bound to head-sha, not ${input.gate.boundTo}.`,
    } satisfies ExternalObservation;
  }

  // No pull request is not something a stage can correct: the profile either
  // did not permit one or opening it failed. The gate cannot run.
  if (input.pullRequestNumber === null) {
    return {
      state: "unavailable",
      boundValue: null,
      detail: `The run has no pull request, so "${input.gate.check}" has nothing to check.`,
    } satisfies ExternalObservation;
  }
  const localHead = yield* revParse(input.workspacePath, "HEAD");

  const repository = yield* repositoryOf(input.workspacePath, input.ghConfigDir);
  if (repository === null) {
    return {
      state: "unavailable",
      boundValue: null,
      detail: "gh could not resolve the repository from the worktree's remote.",
    } satisfies ExternalObservation;
  }

  const result = yield* complete(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${QUERY}`,
      "-F",
      `owner=${repository.owner}`,
      "-F",
      `name=${repository.name}`,
      "-F",
      `number=${String(input.pullRequestNumber)}`,
    ],
    input.workspacePath,
    { env: ghEnvironment(input.ghConfigDir) },
  );
  if (result.exitCode !== 0) {
    return {
      state: "unavailable",
      boundValue: null,
      detail: `gh api graphql exited ${String(result.exitCode)}: ${firstLine(result.stderr)}`,
    } satisfies ExternalObservation;
  }

  const decoded = decodeState(result.stdout);
  if (decoded._tag === "Failure") {
    return {
      state: "unavailable",
      boundValue: null,
      detail: `GitHub answered in a shape this cannot read: ${firstLine(decoded.failure.message)}`,
    } satisfies ExternalObservation;
  }

  return judgeExternal({
    check: input.gate.check,
    pr: decoded.success.data.repository.pullRequest,
    localHead,
    now: DateTime.toEpochMillis(yield* DateTime.now),
    reviewWaitMinutes: input.reviewWaitMinutes,
  });
});
