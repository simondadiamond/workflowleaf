/**
 * Opening the run's pull request.
 *
 * A run is one story and ends with one pull request, so the pull request is
 * opened by code at the start of the run rather than by an agent at the end of
 * it. Opening it first is what gives the run a stable, human-visible identity
 * while the work is still happening, and what makes "this story needs a second
 * one" a question with something concrete to ask about.
 *
 * It is a draft: a run in progress is not asking anyone to merge. The
 * host is `gh`, which reads the remote from the worktree it runs in; nothing
 * here knows a repository name.
 */
import type { PullRequestRef } from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { capture } from "./exec.ts";
import { commitEmpty, pushBranch } from "./git.ts";

export class PullRequestError extends Schema.TaggedError<PullRequestError>()("WlPullRequestError", {
  message: Schema.String,
}) {}

const ListedPullRequest = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  baseRefName: Schema.String,
});

const decodeListed = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(ListedPullRequest)),
);

/** The environment `gh` runs with: the profile's config directory, when it names one. */
export function ghEnvironment(ghConfigDir: string | undefined): Record<string, string> | undefined {
  return ghConfigDir === undefined ? undefined : { GH_CONFIG_DIR: ghConfigDir };
}

const gh = (cwd: string, args: readonly string[], ghConfigDir?: string) =>
  capture("gh", args, cwd, { env: ghEnvironment(ghConfigDir) }).pipe(
    Effect.mapError(
      (cause) =>
        new PullRequestError({
          message: `${cause.message}\nWorkflowLeaf opens the run's pull request with gh. Check that it is installed and authenticated for this repository.`,
        }),
    ),
  );

/** The open pull request for a branch, if one is already there. */
export const findOpenPullRequest = Effect.fnUntraced(function* (input: {
  readonly cwd: string;
  readonly headBranch: string;
  readonly ghConfigDir?: string | undefined;
}) {
  const payload = yield* gh(
    input.cwd,
    [
      "pr",
      "list",
      "--head",
      input.headBranch,
      "--state",
      "open",
      "--json",
      "number,url,baseRefName",
    ],
    input.ghConfigDir,
  );

  const decoded = decodeListed(payload.trim().length === 0 ? "[]" : payload);
  if (decoded._tag === "Failure") {
    return yield* new PullRequestError({
      message: `gh pr list returned something this cannot read: ${decoded.failure.message}`,
    });
  }
  return decoded.success[0] ?? null;
});

export interface OpenPullRequestInput {
  readonly workspacePath: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly remote: string;
  readonly title: string;
  readonly body: string;
  readonly openedAt: string;
  readonly ghConfigDir?: string | undefined;
}

/**
 * Opens the run's draft pull request, or reattaches to the one that is already
 * open for this branch.
 *
 * Reattaching matters more than it looks: a run whose creation failed after
 * the pull request was opened has to be startable again, and a second pull
 * request for the same branch is exactly the sprawl this is here to prevent.
 */
export const openDraftPullRequest = Effect.fnUntraced(function* (input: OpenPullRequestInput) {
  const existing = yield* findOpenPullRequest({
    cwd: input.workspacePath,
    headBranch: input.headBranch,
    ghConfigDir: input.ghConfigDir,
  });
  if (existing !== null) {
    return {
      number: existing.number,
      url: existing.url,
      headBranch: input.headBranch,
      baseBranch: existing.baseRefName,
      openedAt: input.openedAt,
    } satisfies PullRequestRef;
  }

  // A pull request needs a commit the base branch does not have. The run has
  // produced nothing yet, so this one is deliberately empty.
  yield* commitEmpty(input.workspacePath, input.title).pipe(
    Effect.mapError((cause) => new PullRequestError({ message: cause.message })),
  );
  yield* pushBranch(input.workspacePath, input.remote, input.headBranch).pipe(
    Effect.mapError((cause) => new PullRequestError({ message: cause.message })),
  );

  yield* gh(
    input.workspacePath,
    [
      "pr",
      "create",
      "--draft",
      "--base",
      input.baseBranch,
      "--head",
      input.headBranch,
      "--title",
      input.title,
      "--body",
      input.body,
    ],
    input.ghConfigDir,
  );

  const opened = yield* findOpenPullRequest({
    cwd: input.workspacePath,
    headBranch: input.headBranch,
    ghConfigDir: input.ghConfigDir,
  });
  if (opened === null) {
    return yield* new PullRequestError({
      message: `gh pr create reported success for ${input.headBranch}, but no open pull request is there. Look before starting another run.`,
    });
  }

  return {
    number: opened.number,
    url: opened.url,
    headBranch: input.headBranch,
    baseBranch: opened.baseRefName,
    openedAt: input.openedAt,
  } satisfies PullRequestRef;
});
