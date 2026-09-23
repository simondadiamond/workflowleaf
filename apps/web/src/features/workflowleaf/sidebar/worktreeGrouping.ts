// Folds threads that share a worktree into one sidebar folder. A story run
// opens one thread per stage in the same worktree, so the flat list grows by
// several rows per story; the folder keeps it at one.

export interface WorktreeGroupableThread {
  readonly environmentId: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export type WorktreeGroupedEntry<T> =
  | { readonly kind: "thread"; readonly thread: T }
  | {
      readonly kind: "worktree";
      /** Stable across sections, so expanding a folder expands it everywhere. */
      readonly worktreeKey: string;
      readonly label: string;
      readonly worktreePath: string;
      readonly threads: readonly T[];
      readonly expanded: boolean;
    };

export function worktreeKeyOf(thread: WorktreeGroupableThread): string | null {
  return thread.worktreePath === null
    ? null
    : `${thread.environmentId}\u0000${thread.worktreePath}`;
}

function worktreeLabel(worktreePath: string, threads: readonly WorktreeGroupableThread[]): string {
  const branch = threads.find((thread) => thread.branch !== null)?.branch;
  if (branch) return branch;
  const segments = worktreePath.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? worktreePath;
}

/**
 * Groups threads by worktree in list order. A folder takes the position of
 * its first thread, and its threads keep their relative order. Threads with
 * no worktree, and worktrees with a single thread, stay plain rows.
 */
export function groupThreadsByWorktree<T extends WorktreeGroupableThread>(
  threads: readonly T[],
  isExpanded: (worktreeKey: string, threads: readonly T[]) => boolean,
): WorktreeGroupedEntry<T>[] {
  const membersByKey = new Map<string, T[]>();
  for (const thread of threads) {
    const key = worktreeKeyOf(thread);
    if (key === null) continue;
    const members = membersByKey.get(key);
    if (members) members.push(thread);
    else membersByKey.set(key, [thread]);
  }

  const entries: WorktreeGroupedEntry<T>[] = [];
  const emitted = new Set<string>();
  for (const thread of threads) {
    const key = worktreeKeyOf(thread);
    const members = key === null ? undefined : membersByKey.get(key);
    if (key === null || members === undefined || members.length < 2) {
      entries.push({ kind: "thread", thread });
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const worktreePath = thread.worktreePath!;
    entries.push({
      kind: "worktree",
      worktreeKey: key,
      label: worktreeLabel(worktreePath, members),
      worktreePath,
      threads: members,
      expanded: isExpanded(key, members),
    });
  }
  return entries;
}
