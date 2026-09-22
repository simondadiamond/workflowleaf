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
 */
import type { GateDefinition } from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { complete } from "./exec.ts";
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

const PullRequestState = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          state: Schema.String,
          headRefOid: Schema.String,
          reviewDecision: Schema.NullOr(Schema.String),
          reviewRequests: Schema.Struct({ totalCount: Schema.Int }),
          reviewThreads: Schema.Struct({ nodes: Schema.Array(ReviewThread) }),
          commits: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                commit: Schema.Struct({
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
      commits(last: 1) {
        nodes {
          commit {
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
}

function summarizeChecks(pr: PullRequestState): CheckSummary {
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const pending: string[] = [];
  const failing: string[] = [];

  for (const check of contexts) {
    if (check.__typename === "StatusContext") {
      const name = check.context ?? "status";
      if (check.state === "PENDING" || check.state === "EXPECTED") pending.push(name);
      else if (check.state !== "SUCCESS") failing.push(`${name} (${String(check.state)})`);
      continue;
    }
    const name = check.name ?? "check";
    if (check.status !== "COMPLETED") pending.push(name);
    else if (!PASSING_CONCLUSIONS.has(check.conclusion ?? "")) {
      failing.push(`${name} (${String(check.conclusion)})`);
    }
  }
  return { pending, failing };
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

  return {
    state: "satisfied",
    boundValue: bound,
    detail: "Checks green, no unresolved review threads, no reviewer outstanding.",
  };
}

/** `owner/name` of the repository `gh` resolves from the worktree's remote. */
const repositoryOf = Effect.fnUntraced(function* (cwd: string) {
  const result = yield* complete(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    cwd,
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

  const repository = yield* repositoryOf(input.workspacePath);
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
  });
});
