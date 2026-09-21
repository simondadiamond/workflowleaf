#!/usr/bin/env node
/**
 * Fork ownership and import-boundary gate.
 *
 *   node scripts/workflowleaf/check.ts
 *   node scripts/workflowleaf/check.ts --base <rev>
 *
 * Exits non-zero when the fork edits an upstream file that is not listed in
 * ownership.json, when the allow-list outgrows its cap, when a WorkflowLeaf
 * package imports across a boundary it is supposed to respect, when a commit
 * moves the layout without updating the orientation, or when T3 has come to
 * depend on WorkflowLeaf.
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

import { findEnablementViolations, formatEnablementReport, type Manifest } from "./enablement.ts";
import { findImportViolations, formatImportReport, type SourceFile } from "./imports.ts";
import {
  findOrientationViolations,
  formatOrientationReport,
  type CommitUnderReview,
} from "./orientation.ts";
import {
  findOwnershipViolations,
  findUpstreamCapViolation,
  formatOwnershipReport,
  isOwned,
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

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const resolves = (repoRoot: string, rev: string) =>
  git(repoRoot, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).pipe(
    Effect.as(true),
    Effect.catchTag("WlGitFailed", () => Effect.succeed(false)),
  );

/**
 * The trunk this branch will merge into. `origin/main` is the fork trunk and a
 * local `main` is routinely stale, so the remote ref wins when both exist.
 */
const ORIENTATION_BASE_CANDIDATES = ["origin/main", "main"] as const;

/**
 * Each commit in `base..HEAD` is judged on its own diff and its own message, so
 * one commit's escape hatch cannot excuse another. See orientation.ts.
 */
const checkOrientation = Effect.fnUntraced(function* (
  repoRoot: string,
  ownership: Ownership,
  explicitBase: string | undefined,
) {
  let base = explicitBase;
  if (base === undefined) {
    for (const candidate of ORIENTATION_BASE_CANDIDATES) {
      if (yield* resolves(repoRoot, candidate)) {
        base = candidate;
        break;
      }
    }
    if (base === undefined) {
      yield* Console.log(
        `workflowleaf orientation: skipped, no trunk to compare against (tried ${ORIENTATION_BASE_CANDIDATES.join(", ")}). Pass --orientation-base <rev>.`,
      );
      return false;
    }
  } else if (!(yield* resolves(repoRoot, base))) {
    // An explicit base that does not resolve is a broken invocation, not a
    // reason to pass. CI names its base, so CI cannot go quietly green.
    return yield* new OwnershipCheckFailed({
      report: `Orientation base ${base} is not in this repository.`,
    });
  }

  // Merges are skipped: their changes arrive from commits judged on their own.
  const shas = (yield* git(repoRoot, ["log", "--no-merges", "--format=%H", `${base}..HEAD`]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const commits: CommitUnderReview[] = [];
  for (const sha of shas) {
    commits.push({
      sha,
      subject: (yield* git(repoRoot, ["log", "-1", "--format=%s", sha])).trim(),
      message: yield* git(repoRoot, ["log", "-1", "--format=%B", sha]),
      changes: parseNameStatusZ(
        yield* git(repoRoot, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", sha]),
      ),
    });
  }

  const violations = findOrientationViolations(ownership.orientation, commits);
  yield* Console.log(formatOrientationReport(violations));
  return violations.length > 0;
});

/** Workspace manifests outside every owned prefix, decoded for the C14 rule. */
const checkEnablement = Effect.fnUntraced(function* (repoRoot: string, ownership: Ownership) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tracked = (yield* git(repoRoot, ["ls-files", "-z", "--", "*package.json"]))
    .split("\0")
    .filter((entry) => entry.length > 0);

  const manifests: Manifest[] = [];
  for (const relative of tracked) {
    if (isOwned(ownership, relative)) continue;
    const parsed = decodeJson(yield* fs.readFileString(path.join(repoRoot, relative)));
    if (parsed._tag === "Failure") continue;
    manifests.push({ path: relative, manifest: parsed.success });
  }

  const upstreamEdits: SourceFile[] = [];
  for (const entry of ownership.allowedUpstreamEdits) {
    const absolute = path.join(repoRoot, entry.path);
    if (!(yield* fs.exists(absolute))) continue;
    upstreamEdits.push({ path: entry.path, text: yield* fs.readFileString(absolute) });
  }

  const violations = findEnablementViolations(ownership.enablement, manifests, upstreamEdits);
  yield* Console.log(formatEnablementReport(violations));
  return violations.length > 0;
});

const checkOwnership = Effect.fnUntraced(function* (
  baseOverride: string | undefined,
  orientationBase: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, "..", "..");

  const parsed = decodeJson(yield* fs.readFileString(path.join(here, "ownership.json")));
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
  const capViolation = findUpstreamCapViolation(ownership);
  const sources = yield* collectSources(
    repoRoot,
    ownership.importBoundaries.map((boundary) => boundary.root),
  );
  const importViolations = findImportViolations(ownership.importBoundaries, sources);

  yield* Console.log(formatOwnershipReport(ownershipViolations));
  yield* Console.log(
    capViolation === undefined
      ? `workflowleaf upstream cap: ${ownership.allowedUpstreamEdits.length}/${ownership.maxUpstreamEdits} claimed`
      : `workflowleaf upstream cap: exceeded\n      ${capViolation}`,
  );
  yield* Console.log(formatImportReport(importViolations));

  const enablementFailed = yield* checkEnablement(repoRoot, ownership);
  const orientationFailed = yield* checkOrientation(repoRoot, ownership, orientationBase);

  yield* Console.log(
    `workflowleaf: ${changes.length} changed path(s) since ${base.slice(0, 12)}, ${upstreamEditCount(ownership, changes)} upstream-owned.`,
  );

  if (
    ownershipViolations.length > 0 ||
    capViolation !== undefined ||
    importViolations.length > 0 ||
    enablementFailed ||
    orientationFailed
  ) {
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
    orientationBase: Flag.String("orientation-base").pipe(
      Flag.withDescription(
        "Trunk the orientation rule diffs against. Defaults to origin/main, then main.",
      ),
      Flag.optional,
    ),
  },
  ({ base, orientationBase }) =>
    checkOwnership(Option.getOrUndefined(base), Option.getOrUndefined(orientationBase)),
).pipe(
  Command.withDescription(
    "Check fork ownership, import boundaries, orientation freshness and C14 enablement.",
  ),
);

if (import.meta.main) {
  Command.run(workflowleafCheckCommand, { version: "0.1.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
