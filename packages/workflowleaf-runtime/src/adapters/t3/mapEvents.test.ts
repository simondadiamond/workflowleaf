import { assert, describe, it } from "@effect/vitest";

import {
  applyStreamItem,
  initialWatch,
  resumeCursor,
  settlementOf,
  type StreamItem,
  type WatchState,
} from "./mapEvents.ts";

const input = { messageId: "msg-1", commandId: "cmd-1" };

const event = (
  type: string,
  sequence: number,
  payload: Record<string, unknown> = {},
  commandId: string | null = null,
): StreamItem => ({ kind: "event", event: { type, sequence, commandId, payload } });

const snapshot = (
  turnId: string | null,
  state: "running" | "interrupted" | "completed" | "error",
  lastError: string | null = null,
): StreamItem => ({
  kind: "snapshot",
  snapshot: {
    thread: {
      latestTurn: turnId === null ? null : { turnId, state },
      session: { status: "ready", lastError },
    },
  },
});

function fold(items: readonly StreamItem[], from: WatchState = initialWatch()): WatchState {
  return items.reduce((state, item) => applyStreamItem(state, item, input), from);
}

// These fixtures are the shapes observed on a live T3 server on 2026-09-20,
// not shapes inferred from the schema. Our own message-sent arrives with a null
// turn id; the assistant's messages carry the real one; the session lives
// nested under the payload.
describe("adopting our turn", () => {
  it("stays unsettled until something says the turn ended", () => {
    const state = fold([
      event("thread.turn-start-requested", 1, {}, "cmd-1"),
      event("thread.message-sent", 2, { messageId: "msg-1", turnId: null }),
      event("thread.message-sent", 3, { messageId: "assistant:x", turnId: "turn-1" }),
    ]);

    assert.strictEqual(state.turnId, "turn-1");
    assert.isNull(settlementOf(state));
  });

  it("takes the turn id from the assistant's reply, since ours arrives null", () => {
    const state = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: null }),
      event("thread.message-sent", 2, { messageId: "assistant:x", turnId: "turn-1" }),
    ]);

    assert.strictEqual(state.ourMessageAt, 1);
    assert.strictEqual(state.turnId, "turn-1");
  });

  it("ignores an assistant message from a turn that started before ours", () => {
    const state = fold([
      event("thread.message-sent", 1, { messageId: "assistant:earlier", turnId: "turn-0" }),
      event("thread.message-sent", 2, { messageId: "msg-1", turnId: null }),
    ]);

    assert.isNull(state.turnId);
  });

  it("settles on the real event sequence a live turn produces", () => {
    // Captured from a live server: our message, session updates, the
    // assistant's replies, activity, then the checkpoint diff.
    const state = fold([
      event("thread.message-sent", 21721, { messageId: "msg-1", turnId: null }, "cmd-1"),
      event("thread.session-set", 21723, { session: { status: "running", lastError: null } }),
      event("thread.message-sent", 21726, { messageId: "assistant:a", turnId: "turn-1" }),
      event("thread.message-sent", 21727, { messageId: "assistant:a", turnId: "turn-1" }),
      event("thread.activity-appended", 21728, {}),
      event("thread.session-set", 21730, { session: { status: "ready", lastError: null } }),
      event("thread.turn-diff-completed", 21731, { turnId: "turn-1" }),
    ]);

    assert.strictEqual(state.turnId, "turn-1");
    assert.deepStrictEqual(settlementOf(state), {
      outcome: "completed",
      settled: true,
      detail: null,
    });
  });

  it("ignores another client's message on the same thread", () => {
    const state = fold([
      event("thread.message-sent", 1, { messageId: "someone-else", turnId: "turn-9" }),
    ]);

    assert.isNull(state.turnId);
    assert.isNull(state.ourMessageAt);
  });

  it("does not adopt a turn that finished before our message", () => {
    const state = fold([
      event("thread.turn-diff-completed", 1, { turnId: "turn-earlier" }),
      event("thread.message-sent", 2, { messageId: "msg-1", turnId: "turn-1" }),
    ]);

    assert.strictEqual(state.turnId, "turn-1");
    assert.isNull(settlementOf(state));
  });
});

describe("settlement", () => {
  it("settles on the diff for our turn, which means T3 finished writing too", () => {
    const state = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
      event("thread.turn-diff-completed", 2, { turnId: "turn-1" }),
    ]);

    assert.deepStrictEqual(settlementOf(state), {
      outcome: "completed",
      settled: true,
      detail: null,
    });
  });

  it("reports a session error as an error settlement", () => {
    const state = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
      event("thread.session-set", 2, {
        session: { status: "error", lastError: "provider exited" },
      }),
    ]);

    assert.deepStrictEqual(settlementOf(state), {
      outcome: "error",
      settled: true,
      detail: "provider exited",
    });
  });

  it("reports an interruption", () => {
    const state = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
      event("thread.turn-interrupt-requested", 2, {}),
    ]);

    assert.strictEqual(settlementOf(state)?.outcome, "interrupted");
  });

  it("learns a terminal state from a snapshot after a reconnect", () => {
    const connected = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
    ]);
    const reconnected = fold([snapshot("turn-1", "completed")], connected);

    assert.strictEqual(reconnected.outcome, "completed");
    // The diff has not arrived, so the turn finished talking and may still be
    // writing. Gates wait for that.
    assert.isFalse(reconnected.settled);
  });

  it("ignores a snapshot describing a different turn", () => {
    const connected = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
    ]);
    const other = fold([snapshot("turn-2", "completed")], connected);

    assert.isNull(other.outcome);
  });
});

describe("replay and ordering", () => {
  it("settles once when the terminal event is delivered twice", () => {
    const base = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
      event("thread.turn-diff-completed", 2, { turnId: "turn-1" }),
    ]);
    const replayed = fold([event("thread.turn-diff-completed", 2, { turnId: "turn-1" })], base);

    assert.deepStrictEqual(settlementOf(replayed), settlementOf(base));
    assert.strictEqual(replayed.cursor, base.cursor);
  });

  it("does not let a replayed error overwrite an already-settled completion", () => {
    const completed = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
      event("thread.turn-diff-completed", 2, { turnId: "turn-1" }),
    ]);
    const replayed = fold(
      [event("thread.turn-diff-completed", 2, { turnId: "turn-1" })],
      completed,
    );

    assert.strictEqual(replayed.outcome, "completed");
  });

  it("tracks the highest sequence as the resume cursor", () => {
    const state = fold([
      event("thread.message-sent", 7, { messageId: "msg-1", turnId: "turn-1" }),
      event("thread.activity-appended", 3, {}),
      event("thread.activity-appended", 11, {}),
    ]);

    assert.strictEqual(resumeCursor(state), 11);
  });

  it("does not let a later thread error rewrite a settled turn", () => {
    const state = fold([
      event("thread.message-sent", 1, { messageId: "msg-1", turnId: "turn-1" }),
      event("thread.turn-diff-completed", 2, { turnId: "turn-1" }),
      event("thread.session-set", 3, { session: { status: "error", lastError: "late noise" } }),
    ]);

    // The session going to error after the turn's diff landed belongs to
    // whatever happens next on that thread, not to this settled turn.
    assert.strictEqual(state.outcome, "completed");
    assert.strictEqual(settlementOf(state)?.settled, true);
  });
});
