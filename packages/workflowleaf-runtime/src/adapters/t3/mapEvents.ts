/**
 * Turning a T3 thread subscription into one stage settlement.
 *
 * This is the delicate part of the V1 seam. T3's domain event stream has no
 * turn-terminal event: `thread.turn-start-requested` exists, nothing announces
 * that the turn finished. What does exist is `thread.turn-diff-completed`,
 * which fires after T3 has captured the turn's checkpoint, and that is a
 * stronger signal than "the model stopped talking" because it also means T3's
 * own background writers are done with the worktree.
 *
 * Correlation runs on ids we chose, not on ordering. The turn a stage owns is
 * adopted from the `thread.message-sent` event carrying our message id, so a
 * concurrent turn on the same thread cannot be mistaken for ours. Events are
 * deduplicated by sequence, so a replayed or out-of-order delivery settles
 * nothing twice.
 *
 * Everything here is pure, which is the only reason these rules can be tested
 * without a provider.
 */

export interface StreamItem {
  readonly kind: "snapshot" | "event" | "synchronized";
  readonly snapshot?: {
    readonly thread?: {
      readonly latestTurn?: {
        readonly turnId: string;
        readonly state: "running" | "interrupted" | "completed" | "error";
      } | null;
      readonly session?: { readonly status: string; readonly lastError: string | null } | null;
    };
  };
  readonly event?: {
    readonly type: string;
    readonly sequence: number;
    readonly commandId?: string | null;
    readonly payload?: Record<string, unknown>;
  };
}

export interface WatchState {
  /** Sequence of our own message-sent event. Nothing before it is ours. */
  readonly ourMessageAt: number | null;
  readonly turnId: string | null;
  readonly outcome: "completed" | "error" | "interrupted" | null;
  /** True once T3 has finished writing for this turn, not merely finished talking. */
  readonly settled: boolean;
  readonly detail: string | null;
  readonly cursor: number;
  readonly seen: ReadonlySet<number>;
}

export function initialWatch(): WatchState {
  return {
    ourMessageAt: null,
    turnId: null,
    outcome: null,
    settled: false,
    detail: null,
    cursor: 0,
    seen: new Set<number>(),
  };
}

export interface WatchInput {
  readonly messageId: string;
  readonly commandId: string;
}

function withSequence(state: WatchState, sequence: number): WatchState {
  const seen = new Set(state.seen);
  seen.add(sequence);
  return { ...state, seen, cursor: Math.max(state.cursor, sequence) };
}

/**
 * Folds one stream item into the watch state.
 *
 * A snapshot can supply the terminal state of an already-adopted turn, which is
 * how a reconnect learns what happened while the socket was down.
 */
export function applyStreamItem(
  state: WatchState,
  item: StreamItem,
  input: WatchInput,
): WatchState {
  if (item.kind === "snapshot") {
    const latest = item.snapshot?.thread?.latestTurn ?? null;
    if (latest === null) return state;

    // Only adopt from a snapshot once our own turn id is known; otherwise a
    // snapshot taken before our turn started would hand us someone else's.
    if (state.turnId !== null && latest.turnId === state.turnId && latest.state !== "running") {
      return {
        ...state,
        outcome: latest.state,
        detail: item.snapshot?.thread?.session?.lastError ?? state.detail,
      };
    }
    return state;
  }

  if (item.kind !== "event" || item.event === undefined) return state;
  const event = item.event;
  if (state.seen.has(event.sequence)) return state;

  // Once the turn has settled, nothing that arrives afterwards belongs to it.
  // A late error on the thread is the next turn's business, not a reason to
  // rewrite a verdict the run may already have acted on.
  if (state.settled) return withSequence(state, event.sequence);

  const next = withSequence(state, event.sequence);
  const payload = event.payload ?? {};

  switch (event.type) {
    case "thread.message-sent": {
      if (payload.messageId !== input.messageId) return next;
      const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
      return {
        ...next,
        ourMessageAt: next.ourMessageAt ?? event.sequence,
        turnId: next.turnId ?? turnId,
      };
    }

    case "thread.turn-start-requested": {
      // The request event carries our command id but no turn id; it only tells
      // us the dispatch was accepted.
      if (event.commandId !== input.commandId) return next;
      return { ...next, ourMessageAt: next.ourMessageAt ?? event.sequence };
    }

    case "thread.turn-diff-completed": {
      const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
      if (turnId === null) return next;
      // Adopt the turn here when the message-sent event did not carry one yet,
      // but only for a turn that started after our own message.
      const ours = next.turnId === null ? next.ourMessageAt !== null : turnId === next.turnId;
      if (!ours) return next;
      return { ...next, turnId, outcome: next.outcome ?? "completed", settled: true };
    }

    case "thread.turn-interrupt-requested": {
      if (next.ourMessageAt === null) return next;
      return {
        ...next,
        outcome: "interrupted",
        settled: true,
        detail: "The turn was interrupted.",
      };
    }

    case "thread.session-set": {
      if (next.ourMessageAt === null) return next;
      const status = typeof payload.status === "string" ? payload.status : null;
      if (status !== "error") return next;
      const lastError = typeof payload.lastError === "string" ? payload.lastError : null;
      return { ...next, outcome: "error", settled: true, detail: lastError };
    }

    default:
      return next;
  }
}

/**
 * The settlement, or `null` while the turn is still in flight.
 *
 * `settled` is reported separately from `outcome` on purpose: a completed turn
 * whose diff has not been captured yet has finished talking and has not
 * finished writing, and running a gate between those two points reads a tree
 * something else is still touching.
 */
export function settlementOf(
  state: WatchState,
): {
  readonly outcome: "completed" | "error" | "interrupted";
  readonly settled: boolean;
  readonly detail: string | null;
} | null {
  if (state.outcome === null) return null;
  return { outcome: state.outcome, settled: state.settled, detail: state.detail };
}

/** Where to resume a subscription after a disconnect, with overlap deduplicated by sequence. */
export function resumeCursor(state: WatchState): number {
  return state.cursor;
}
