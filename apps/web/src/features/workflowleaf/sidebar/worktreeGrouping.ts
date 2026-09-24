// Folds the threads working on one change into one sidebar folder. A story
// run opens one thread per stage in its worktree, and the thread that started
// the run sits in another worktree, so the flat list grows by several rows per
// story. Threads are folded by pull request first, which joins the starting
// thread once it links the run's pull request, and by worktree otherwise.

interface GroupablePullRequest {
  readonly number: number;
  readonly url: string;
}

export interface WorktreeGroupableThread {
  readonly environmentId: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly linkedPullRequest?: GroupablePullRequest | null | undefined;
  readonly branchPullRequest?: GroupablePullRequest | null | undefined;
}

export type WorktreeGroupedEntry<T> =
  | { readonly kind: "thread"; readonly thread: T }
  | {
      readonly kind: "worktree";
      /** Stable across sections, so expanding a folder expands it everywhere. */
      readonly worktreeKey: string;
      readonly label: string;
      /** The pull request url, or the worktree path when there is none. */
      readonly detail: string;
      readonly threads: readonly T[];
      readonly expanded: boolean;
    };

function pullRequestOf(thread: WorktreeGroupableThread): GroupablePullRequest | null {
  return thread.linkedPullRequest ?? thread.branchPullRequest ?? null;
}

function worktreeKeyOf(thread: WorktreeGroupableThread): string | null {
  return thread.worktreePath === null
    ? null
    : `${thread.environmentId}\u0000${thread.worktreePath}`;
}

function folderLabel(
  threads: readonly WorktreeGroupableThread[],
  pullRequest: GroupablePullRequest | null,
): string {
  // The branch the pull request was opened from names the change best.
  const branch =
    threads.find(
      (thread) => pullRequest !== null && thread.branchPullRequest?.url === pullRequest.url,
    )?.branch ?? threads.find((thread) => thread.branch !== null)?.branch;
  if (branch) return branch;
  if (pullRequest) return `#${pullRequest.number}`;
  const worktreePath = threads.find((thread) => thread.worktreePath !== null)?.worktreePath ?? "";
  return worktreePath.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? worktreePath;
}

/**
 * Groups threads in list order. A folder takes the position of its first
 * thread, and its threads keep their relative order. A thread with neither a
 * pull request nor a worktree, and a folder of one, stay plain rows.
 */
export function groupThreadsByWorktree<T extends WorktreeGroupableThread>(
  threads: readonly T[],
  isExpanded: (worktreeKey: string, threads: readonly T[]) => boolean,
): WorktreeGroupedEntry<T>[] {
  // A worktree adopts the pull request any of its threads knows, so a stage
  // that ran before the link landed still joins the folder.
  const pullRequestByWorktree = new Map<string, GroupablePullRequest>();
  for (const thread of threads) {
    const worktreeKey = worktreeKeyOf(thread);
    const pullRequest = pullRequestOf(thread);
    if (worktreeKey !== null && pullRequest !== null && !pullRequestByWorktree.has(worktreeKey)) {
      pullRequestByWorktree.set(worktreeKey, pullRequest);
    }
  }
  const folderOf = (thread: T) => {
    const worktreeKey = worktreeKeyOf(thread);
    const pullRequest =
      pullRequestOf(thread) ??
      (worktreeKey === null ? undefined : pullRequestByWorktree.get(worktreeKey)) ??
      null;
    if (pullRequest !== null) return { key: `pr\u0000${pullRequest.url}`, pullRequest };
    return worktreeKey === null ? null : { key: worktreeKey, pullRequest: null };
  };

  const membersByKey = new Map<string, T[]>();
  for (const thread of threads) {
    const folder = folderOf(thread);
    if (folder === null) continue;
    const members = membersByKey.get(folder.key);
    if (members) members.push(thread);
    else membersByKey.set(folder.key, [thread]);
  }

  const entries: WorktreeGroupedEntry<T>[] = [];
  const emitted = new Set<string>();
  for (const thread of threads) {
    const folder = folderOf(thread);
    const members = folder === null ? undefined : membersByKey.get(folder.key);
    if (folder === null || members === undefined || members.length < 2) {
      entries.push({ kind: "thread", thread });
      continue;
    }
    if (emitted.has(folder.key)) continue;
    emitted.add(folder.key);
    entries.push({
      kind: "worktree",
      worktreeKey: folder.key,
      label: folderLabel(members, folder.pullRequest),
      detail: folder.pullRequest?.url ?? thread.worktreePath ?? "",
      threads: members,
      expanded: isExpanded(folder.key, members),
    });
  }
  return entries;
}

/** What a folder's dot can say, most urgent first. */
export const FOLDER_STATUSES = ["failed", "approval", "input", "done", "working"] as const;
export type FolderStatus = (typeof FOLDER_STATUSES)[number];

/**
 * The most urgent state among a folder's threads, so a collapsed folder
 * never hides a failure or a question. A failure outranks a question
 * because the run has stopped. Null when every thread is quiet.
 */
export function folderStatusOf(statuses: Iterable<FolderStatus | null>): FolderStatus | null {
  let worst: FolderStatus | null = null;
  for (const status of statuses) {
    if (status === null) continue;
    if (worst === null || FOLDER_STATUSES.indexOf(status) < FOLDER_STATUSES.indexOf(worst)) {
      worst = status;
    }
  }
  return worst;
}
