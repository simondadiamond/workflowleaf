#!/usr/bin/env node
/**
 * Fork ownership and import-boundary gate.
 *
 *   node scripts/workflowleaf/check.ts
 *   node scripts/workflowleaf/check.ts --base <rev>
 *
 * Exits non-zero when the fork edits an upstream file that is not listed in
 * ownership.json, or when a WorkflowLeaf package imports across a boundary it
 * is supposed to respect.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { findImportViolations, formatImportReport, type SourceFile } from "./imports.ts";
import {
  findOwnershipViolations,
  formatOwnershipReport,
  parseNameStatusZ,
  upstreamEditCount,
  type Change,
  type Ownership,
} from "./ownership.ts";

export class OwnershipCheckFailed extends Schema.TaggedError<OwnershipCheckFailed>()(
  "WlOwnershipCheckFailed",
  { report: Schema.String },
) {
  override get message(): string {
    return this.report;
  }
}

export class GitFailed extends Schema.TaggedError<GitFailed>()("WlGitFailed", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `git ${this.args.join(" ")} exited ${this.exitCode}: ${this.stderr.trim()}`;
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

const git = Effect.fnUntraced(function* (cwd: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new GitFailed({ args, exitCode, stderr });
  }
  return stdout;
}, Effect.scoped);

/**
 * Changes relative to the recorded upstream base, including work that is not
 * committed yet. A gate that only sees commits passes right up until the moment
 * it matters.
 */
const collectChanges = Effect.fnUntraced(function* (repoRoot: string, base: string) {
  const tracked = parseNameStatusZ(
    yield* git(repoRoot, ["diff", "--name-status", "-z", base, "--"]),
  );
  const untracked = (yield* git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry): Change => ({ path: entry, kind: "added" }));

  const seen = new Set<string>();
  return [...tracked, ...untracked].filter((change) => {
    const key = `${change.kind}:${change.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

const collectSources = Effect.fnUntraced(function* (repoRoot: string, roots: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: SourceFile[] = [];

  const walk = (relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const absolute = path.join(repoRoot, relative);
      // A boundary whose package does not exist yet is not a violation.
      if (!(yield* fs.exists(absolute))) return;

      for (const entry of yield* fs.readDirectory(absolute)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const child = `${relative}/${entry}`;
        const info = yield* fs.stat(path.join(repoRoot, child));
        if (info.type === "Directory") {
          yield* walk(child);
          continue;
        }
        if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry)) continue;
        files.push({ path: child, text: yield* fs.readFileString(path.join(repoRoot, child)) });
      }
    });

  for (const root of roots) yield* walk(root);
  return files;
});

const decodeOwnership = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const checkOwnership = Effect.fnUntraced(function* (baseOverride: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, "..", "..");

  const parsed = decodeOwnership(yield* fs.readFileString(path.join(here, "ownership.json")));
  if (parsed._tag === "Failure") {
    return yield* new OwnershipCheckFailed({ report: `ownership.json is not valid JSON.` });
  }
  const ownership = parsed.success as Ownership;
  const base = baseOverride ?? ownership.upstreamBase;

  const reachable = yield* git(repoRoot, ["cat-file", "-e", `${base}^{commit}`]).pipe(
    Effect.as(true),
    Effect.catchTag("WlGitFailed", () => Effect.succeed(false)),
  );
  if (!reachable) {
    return yield* new OwnershipCheckFailed({
      report: `Upstream base ${base} is not in this repository. Fetch it, or pass --base <rev>.`,
    });
  }

  const changes = yield* collectChanges(repoRoot, base);
  const ownershipViolations = findOwnershipViolations(ownership, changes);
  const sources = yield* collectSources(
    repoRoot,
    ownership.importBoundaries.map((boundary) => boundary.root),
  );
  const importViolations = findImportViolations(ownership.importBoundaries, sources);

  yield* Console.log(formatOwnershipReport(ownershipViolations));
  yield* Console.log(formatImportReport(importViolations));
  yield* Console.log(
    `workflowleaf: ${changes.length} changed path(s) since ${base.slice(0, 12)}, ${upstreamEditCount(ownership, changes)} upstream-owned.`,
  );

  if (ownershipViolations.length > 0 || importViolations.length > 0) {
    return yield* new OwnershipCheckFailed({ report: "Fork ownership check failed." });
  }
});

export const workflowleafCheckCommand = Command.make(
  "workflowleaf-check",
  {
    base: Flag.String("base").pipe(
      Flag.withDescription("Compare against this revision instead of the recorded upstream base."),
      Flag.optional,
    ),
  },
  ({ base }) => checkOwnership(Option.getOrUndefined(base)),
).pipe(Command.withDescription("Check fork ownership and WorkflowLeaf import boundaries."));

if (import.meta.main) {
  Command.run(workflowleafCheckCommand, { version: "0.1.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
