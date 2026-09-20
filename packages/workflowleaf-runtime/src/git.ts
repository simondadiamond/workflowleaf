/**
 * A thin git service.
 *
 * WorkflowLeaf owns the run's worktree, so it needs git for exactly three
 * things: create the worktree, list what is in it, and remove it. Nothing here
 * commits, pushes or resets; a run's changes are the agent's to make.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class GitError extends Schema.TaggedError<GitError>()("WlGitError", {
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `git ${this.args.join(" ")} in ${this.cwd} exited ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulated, chunk) => accumulated + chunk,
    ),
  );

export const git = Effect.fnUntraced(function* (cwd: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) return yield* new GitError({ args, cwd, exitCode, stderr });
  return stdout;
}, Effect.scoped);

/** NUL-separated output split into entries. Paths with spaces survive this; lines do not. */
export function splitNul(payload: string): string[] {
  return payload.split("\0").filter((entry) => entry.length > 0);
}

export const revParse = Effect.fnUntraced(function* (cwd: string, ref: string) {
  return (yield* git(cwd, ["rev-parse", ref])).trim();
});
