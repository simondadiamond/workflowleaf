/**
 * A thin git service.
 *
 * WorkflowLeaf owns the run's worktree and the branch its pull request is
 * opened from, so it needs git for five things: create the worktree, list what
 * is in it, remove it, make the commit the branch is opened with, and push
 * that branch. It never resets, rebases or force-pushes; on a non-fast-forward
 * rejection the push fails and a human reconciles.
 */
import * as Effect from "effect/Effect";

import { capture } from "./exec.ts";

export { CommandFailed as GitError } from "./exec.ts";

export const git = (cwd: string, args: readonly string[]) => capture("git", args, cwd);

/** NUL-separated output split into entries. Paths with spaces survive this; lines do not. */
export function splitNul(payload: string): string[] {
  return payload.split("\0").filter((entry) => entry.length > 0);
}

export const revParse = Effect.fnUntraced(function* (cwd: string, ref: string) {
  return (yield* git(cwd, ["rev-parse", ref])).trim();
});

/**
 * The commit a run's branch is opened with.
 *
 * A pull request needs a commit the base does not have. Allowing an empty one
 * is what lets the pull request exist from the first moment of the run rather
 * than appearing once an agent has produced something.
 */
export const commitEmpty = Effect.fnUntraced(function* (cwd: string, message: string) {
  yield* git(cwd, ["commit", "--allow-empty", "-m", message]);
  return yield* revParse(cwd, "HEAD");
});

/**
 * Fetches a remote branch and returns the ref a run should branch from.
 *
 * The explicit refspec updates `<remote>/<branch>` whatever the remote's
 * configured refspecs are, so a run never starts from a stale copy of it.
 */
export const fetchBase = Effect.fnUntraced(function* (cwd: string, remote: string, branch: string) {
  yield* git(cwd, [
    "fetch",
    "--quiet",
    remote,
    `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
  ]);
  return `${remote}/${branch}`;
});

/** Pushes one branch by explicit refspec. Never forced. */
export const pushBranch = (cwd: string, remote: string, branch: string) =>
  git(cwd, ["push", "--set-upstream", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
