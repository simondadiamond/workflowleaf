/**
 * Running a command and keeping everything it said.
 *
 * Gates stream their output to a log because it can be large and is read
 * later. The commands here are small and their output is read immediately, so
 * they are captured whole and a non-zero exit carries stderr with it.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("WlCommandFailed", {
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `${this.executable} ${this.args.join(" ")} in ${this.cwd} exited ${this.exitCode}: ${this.stderr.trim()}`;
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

export const capture = Effect.fnUntraced(function* (
  executable: string,
  args: readonly string[],
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(executable, args, { cwd }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new CommandFailed({ executable, args, cwd, exitCode, stderr });
  }
  return stdout;
}, Effect.scoped);
