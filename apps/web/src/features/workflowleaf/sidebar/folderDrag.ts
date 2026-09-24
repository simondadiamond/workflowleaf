import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";

// A folder row takes part in the sidebar's sortable list as if it were one
// thread row, so the drag machinery orders it with the threads. These turn
// that order back into thread keys and order-key writes.

/**
 * Replaces each folder id in a dropped order with its threads. A folder's
 * threads that are listed on their own (an open folder) keep their listed
 * places, except for the folder being moved, whose threads all go where its
 * row was dropped.
 */
export function expandFolderOrder(
  order: readonly string[],
  membersOf: (id: string) => readonly string[] | undefined,
  movingFolderId: string | null,
): string[] {
  const listed = new Set(order.filter((id) => membersOf(id) === undefined));
  const moving = new Set(movingFolderId === null ? [] : (membersOf(movingFolderId) ?? []));
  const expanded: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    expanded.push(id);
  };
  for (const id of order) {
    const members = membersOf(id);
    if (members === undefined) {
      if (!moving.has(id)) add(id);
      continue;
    }
    for (const member of members) {
      if (id === movingFolderId || !listed.has(member)) add(member);
    }
  }
  return expanded;
}

/**
 * Order-key writes that put a folder's threads where `order` says, placed
 * one after another with the active list's own planner. The last write per
 * thread wins when a keyless neighbor makes the planner rewrite the list.
 */
export function planFolderMove(input: {
  readonly order: readonly string[];
  readonly members: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const keys = new Map(input.keysById);
  const writes = new Map<string, string>();
  for (const member of input.members) {
    for (const { id, orderKey } of planPinnedReorder({
      orderedIds: input.order,
      keysById: keys,
      movedId: member,
    })) {
      keys.set(id, orderKey);
      writes.set(id, orderKey);
    }
  }
  return [...writes].flatMap(([id, orderKey]) =>
    input.keysById.get(id) === orderKey ? [] : [{ id, orderKey }],
  );
}
