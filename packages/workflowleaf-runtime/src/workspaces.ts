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
  yield* ignoreRunFiles(target);

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
 * Hides `.workflowleaf/` from git in a run's worktree, with a `.gitignore`
 * that ignores the directory's untracked contents and itself.
 *
 * Stages write their plan and review there, and a playbook check that wants a
 * clean tree sees them as untracked files. Without this, issue-1598-1's
 * deliver stage got past `worktree-clean` by adding the directory to the
 * repository's shared `info/exclude`, which every checkout of it reads. Files
 * the repository already tracks there, such as `.workflowleaf/commands`, are
 * unaffected, and a repository that tracks its own `.workflowleaf/.gitignore`
 * keeps it.
 */
const ignoreRunFiles = Effect.fnUntraced(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(worktree, ".workflowleaf", ".gitignore");
  if (yield* fs.exists(file)) return;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    "# Written by WorkflowLeaf: run files, not repository content.\n*\n",
  );
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
    // A symlink is its link text, as git stores it. Reading through it would
    // fail on a link to a directory, and what is behind an outward link is
    // `outsideTheWorktree`'s job.
    const link = yield* fs.readLink(absolute).pipe(Effect.option);
    if (Option.isSome(link)) {
      files.push({ path: entry, digest: digestOf(`symlink:${link.value}`) });
      continue;
    }
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
 * The most files watched behind one symlink. A link to something larger is
 * reported as unwatched rather than read on every turn.
 */
const OUTSIDE_FILE_LIMIT = 5_000;

/** Directory names never walked, inside the worktree or behind a link. */
const UNWALKED = new Set(SNAPSHOT_EXCLUSIONS.map((prefix) => prefix.replace(/\/$/, "")));

/**
 * What sits behind the symlinks that lead out of the worktree.
 *
 * A snapshot, a diff gate and a reviewer all read the worktree through git, so
 * a file an agent edits through a link to another checkout changes nowhere they
 * look (workflowleaf#49: FBM links a story worktree's `.claude` to the main
 * checkout). This finds every such link and digests what is behind it, so two
 * readings either side of a turn show what changed out there. Links under an
 * excluded directory such as `node_modules` are not followed, and a directory
 * with its own `.git` is another checkout and is not walked.
 */
export const outsideTheWorktree = Effect.fnUntraced(
  function* (workspacePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(workspacePath);
    const isLink = (file: string) =>
      fs.readLink(file).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
    const typeOf = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => info.type),
        Effect.catchCause(() => Effect.succeed("Unknown" as const)),
      );
    const isCheckout = (directory: string) =>
      fs.exists(path.join(directory, ".git")).pipe(Effect.catchCause(() => Effect.succeed(false)));

    const links: { path: string; target: string }[] = [];
    const walkWorktree = (relative: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const directory = path.join(workspacePath, relative);
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(Effect.catchCause(() => Effect.succeed([] as string[])));
        for (const name of entries.sort()) {
          if (UNWALKED.has(name)) continue;
          const entry = relative === "" ? name : path.join(relative, name);
          const absolute = path.join(workspacePath, entry);
          if (yield* isLink(absolute)) {
            const target = yield* fs
              .realPath(absolute)
              .pipe(Effect.catchCause(() => Effect.succeed(null)));
            if (target !== null && target !== root && !target.startsWith(`${root}${path.sep}`)) {
              links.push({ path: entry, target });
            }
            continue;
          }
          if ((yield* typeOf(absolute)) !== "Directory") continue;
          if (yield* isCheckout(absolute)) continue;
          yield* walkWorktree(entry);
        }
      });
    yield* walkWorktree("");

    const files = new Map<string, Digest>();
    const unwatched: string[] = [];
    for (const link of links) {
      if ((yield* typeOf(link.target)) !== "Directory") {
        const bytes = yield* fs.readFile(link.target).pipe(Effect.option);
        if (Option.isSome(bytes)) files.set(link.path, digestOf(bytes.value));
        continue;
      }
      let count = 0;
      const walkTarget = (relative: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const entries = yield* fs
            .readDirectory(path.join(link.target, relative))
            .pipe(Effect.catchCause(() => Effect.succeed([] as string[])));
          for (const name of entries.sort()) {
            if (UNWALKED.has(name)) continue;
            const entry = relative === "" ? name : path.join(relative, name);
            const absolute = path.join(link.target, entry);
            if (yield* isLink(absolute)) continue;
            const type = yield* typeOf(absolute);
            if (type === "Directory") {
              // Another checkout (Claude Code keeps its worktrees under
              // `.claude/worktrees/`) is its own repository, not this one's.
              if (yield* isCheckout(absolute)) continue;
              if (!(yield* walkTarget(entry))) return false;
              continue;
            }
            if (type !== "File") continue;
            if (++count > OUTSIDE_FILE_LIMIT) return false;
            const bytes = yield* fs.readFile(absolute).pipe(Effect.option);
            if (Option.isSome(bytes)) {
              files.set(path.join(link.path, entry), digestOf(bytes.value));
            }
          }
          return true;
        });
      if (!(yield* walkTarget(""))) unwatched.push(link.path);
    }

    return { links, files, unwatched };
  },
  // Watching outside the worktree is a report, never a reason a run stops.
  Effect.catchCause(() =>
    Effect.succeed({
      links: [] as { path: string; target: string }[],
      files: new Map<string, Digest>(),
      unwatched: [] as string[],
    }),
  ),
);

export type OutsideTheWorktree = Effect.Success<ReturnType<typeof outsideTheWorktree>>;

/**
 * What changed behind the worktree's outward links between two readings, as a
 * finding a person can act on, or null when nothing did.
 */
export function outsideChanges(
  before: OutsideTheWorktree,
  after: OutsideTheWorktree,
): string | null {
  const changed = new Set<string>();
  for (const [file, digest] of after.files) {
    if (before.files.get(file) !== digest) changed.add(file);
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changed.add(file);
  }
  if (changed.size === 0) return null;

  const targets = [...before.links, ...after.links];
  const lines = [...changed].sort().map((file) => {
    const link = targets.find((one) => file === one.path || file.startsWith(`${one.path}/`));
    const behind = link === undefined ? "" : ` (${link.target}${file.slice(link.path.length)})`;
    return `- ${file}${behind}`;
  });
  return [
    "These files changed during the stage behind symlinks that lead out of the worktree. No snapshot, diff gate or reviewer reads them, and the change is not in the pull request. Something outside the run may also have written them.",
    ...lines,
  ].join("\n");
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
