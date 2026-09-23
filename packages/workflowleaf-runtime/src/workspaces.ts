/**
 * One worktree per run.
 *
 * Every stage of a run executes in the same working directory; a fresh stage
 * means a fresh provider context, not a fresh checkout. WorkflowLeaf creates
 * the worktree itself and every stage attaches to it, so two systems can never
 * end up creating competing worktrees for one run.
 *
 * A snapshot is the full relevant content of that directory, including
 * uncommitted and untracked files. A git revision is not a snapshot: most of
 * what a gate reads during a run has never been committed.
 */
import type { Digest, RunId, SnapshotId, WorkspaceId } from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { canonicalJson } from "./canonical.ts";
import { digestOf } from "./digest.ts";
import { git, splitNul } from "./git.ts";
import { RunStore } from "./store/RunStore.ts";

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WlWorkspaceError", {
  message: Schema.String,
}) {}

/**
 * Paths a snapshot deliberately ignores. They change constantly for reasons
 * that have nothing to do with the work, and including them would make every
 * verdict stale a second after it was recorded. The list is recorded in the
 * manifest so a reader knows exactly what was not looked at.
 */
export const SNAPSHOT_EXCLUSIONS: readonly string[] = [
  ".git/",
  "node_modules/",
  ".t3/",
  ".workflowleaf/",
  "dist/",
  ".vite-plus/",
];

export interface SnapshotManifest {
  readonly snapshotId: SnapshotId;
  readonly takenAt: string;
  readonly exclusions: readonly string[];
  /** Every file the snapshot covers, sorted, with its content digest. */
  readonly files: readonly { readonly path: string; readonly digest: Digest }[];
}

function excluded(path: string): boolean {
  return SNAPSHOT_EXCLUSIONS.some(
    (prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix),
  );
}

export interface Workspace {
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly path: string;
  readonly branch: string;
  readonly baseRevision: string;
}

/**
 * Creates the run's worktree, or returns the one it already owns.
 *
 * Idempotent on purpose: a restarted worker must reattach rather than create a
 * second directory for the same run.
 */
export const ensureWorkspace = Effect.fnUntraced(function* (input: {
  readonly runId: RunId;
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly baseRevision: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* RunStore;

  const existing = yield* store.findWorkspace(input.runId);
  if (Option.isSome(existing) && existing.value.disposedAt === null) {
    if (!(yield* fs.exists(existing.value.path))) {
      return yield* new WorkspaceError({
        message: `Run ${input.runId} owns worktree ${existing.value.path}, which no longer exists. Resolve it by hand rather than silently creating a second one.`,
      });
    }
    return {
      workspaceId: existing.value.workspaceId as WorkspaceId,
      runId: input.runId,
      path: existing.value.path,
      branch: existing.value.branch,
      baseRevision: existing.value.baseRevision,
    } satisfies Workspace;
  }

  const branch = `workflowleaf/${input.runId}`;
  const target = path.join(input.worktreeRoot, input.runId as string);
  yield* fs.makeDirectory(input.worktreeRoot, { recursive: true });

  yield* git(input.repoRoot, ["worktree", "add", "-b", branch, target, input.baseRevision]);

  const workspaceId = digestOf(`${input.runId}:${target}`) as unknown as WorkspaceId;
  yield* store.claimWorkspace({
    workspaceId: workspaceId as string,
    runId: input.runId,
    path: target,
    branch,
    baseRevision: input.baseRevision,
  });

  return {
    workspaceId,
    runId: input.runId,
    path: target,
    branch,
    baseRevision: input.baseRevision,
  } satisfies Workspace;
});

/**
 * Every file in the worktree that the run cares about: tracked, modified and
 * untracked-but-not-ignored, each with its content digest.
 */
export const takeSnapshot = Effect.fnUntraced(function* (workspacePath: string, takenAt: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tracked = splitNul(yield* git(workspacePath, ["ls-files", "-z"]));
  const untracked = splitNul(
    yield* git(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );

  const paths = [...new Set([...tracked, ...untracked])].filter((entry) => !excluded(entry)).sort();

  const files: { path: string; digest: Digest }[] = [];
  for (const entry of paths) {
    const absolute = path.join(workspacePath, entry);
    // A file listed and then deleted between the two calls is simply absent.
    if (!(yield* fs.exists(absolute))) continue;
    files.push({ path: entry, digest: digestOf(yield* fs.readFile(absolute)) });
  }

  const snapshotId = digestOf(canonicalJson(files)) as unknown as SnapshotId;
  return {
    snapshotId,
    takenAt,
    exclusions: SNAPSHOT_EXCLUSIONS,
    files,
  } satisfies SnapshotManifest;
});

/** Paths whose content differs between two snapshots, including additions and removals. */
export function changedPaths(before: SnapshotManifest, after: SnapshotManifest): readonly string[] {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file.digest]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file.digest]));
  const changed = new Set<string>();

  for (const [path, digest] of afterByPath) {
    if (beforeByPath.get(path) !== digest) changed.add(path);
  }
  for (const path of beforeByPath.keys()) {
    if (!afterByPath.has(path)) changed.add(path);
  }

  return [...changed].sort();
}

/**
 * Every path the run has changed since it branched: committed on its branch,
 * modified, deleted or new and untracked. This is what path-triggered skills
 * are chosen from, because it is the shape the change actually has.
 */
export const pathsChangedSince = Effect.fnUntraced(function* (
  workspacePath: string,
  baseRevision: string,
) {
  const changed = splitNul(
    yield* git(workspacePath, ["diff", "--name-only", "--no-renames", "-z", baseRevision]),
  );
  const untracked = splitNul(
    yield* git(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  return [...new Set([...changed, ...untracked])].filter((entry) => !excluded(entry)).sort();
});

/**
 * Removes the run's worktree. The branch is left behind on purpose: it is the
 * record of what the run did, and deleting work is not this function's job.
 */
export const disposeWorkspace = Effect.fnUntraced(function* (input: {
  readonly runId: RunId;
  readonly repoRoot: string;
  readonly workspacePath: string;
}) {
  const store = yield* RunStore;
  yield* git(input.repoRoot, ["worktree", "remove", "--force", input.workspacePath]);
  yield* store.disposeWorkspace(input.runId);
});
