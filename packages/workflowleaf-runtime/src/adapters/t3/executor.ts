/**
 * The T3 executor.
 *
 * One stage is one T3 thread. A fresh context is a new thread attached to the
 * run's existing worktree; a correction is another turn on the same thread,
 * which keeps the provider session and is therefore genuine same-context
 * repair rather than a reworded restart.
 *
 * Nothing above this file knows that T3 exists. Everything below it is T3's:
 * bootstrap, permissions, checkpointing, provider adapters. WorkflowLeaf edits
 * none of them.
 */
import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import type {
  AnswerOutcome,
  ContinueOutcome,
  ExecutorCapabilities,
  ExecutorPort,
  InspectOutcome,
  OperationId,
  ProviderDecision,
  ProviderRequest,
  StageHandle,
  StageRequest,
  StageSettlement,
} from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { T3ExecutorConfig } from "../../profile.ts";

import {
  applyStreamItem,
  initialWatch,
  settlementOf,
  type StreamItem,
  type WatchState,
} from "./mapEvents.ts";
import {
  answerOutcomeFrom,
  approvalsFrom,
  repliesTo,
  type ThreadActivity,
  type ThreadSession,
} from "./requests.ts";

interface ThreadView {
  readonly activities: readonly ThreadActivity[];
  readonly session: ThreadSession | null;
  readonly synchronized: boolean;
}

/** Folds a thread subscription into its activities and current session. */
function foldThread(view: ThreadView, item: unknown): ThreadView {
  const value = item as Record<string, unknown>;
  if (value.kind === "synchronized") return { ...view, synchronized: true };
  if (value.kind === "snapshot") {
    const thread = (
      value.snapshot as {
        thread?: { activities?: readonly ThreadActivity[]; session?: ThreadSession | null };
      }
    ).thread;
    return {
      ...view,
      activities: [...view.activities, ...(thread?.activities ?? [])],
      session: thread?.session ?? null,
    };
  }
  if (value.kind === "event") {
    const event = value.event as { type?: string; payload?: Record<string, unknown> };
    if (event.type === "thread.activity-appended") {
      const activity = event.payload?.activity as ThreadActivity | undefined;
      return activity === undefined
        ? view
        : { ...view, activities: [...view.activities, activity] };
    }
    if (event.type === "thread.session-set") {
      const session = event.payload?.session as ThreadSession | undefined;
      return session === undefined ? view : { ...view, session };
    }
  }
  return view;
}

/**
 * What the V1 seam actually provides.
 *
 * Reported from the seam, not from the provider's name. `settledCompletion` is
 * true because `thread.turn-diff-completed` fires after T3 captured the turn's
 * checkpoint, which is a stronger statement than "the model stopped talking".
 */
export const T3_V1_CAPABILITIES: ExecutorCapabilities = {
  freshContext: true,
  sameContextContinuation: true,
  settledCompletion: true,
  interrupt: true,
  recovery: true,
};

/** Everything needed to rejoin a thread, encoded so a restart can rebuild it. */
export interface T3Handle {
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
}

export function encodeHandle(handle: T3Handle): string {
  return `${handle.threadId}|${handle.messageId}|${handle.commandId}`;
}

export function decodeHandle(value: string): T3Handle | null {
  const [threadId, messageId, commandId] = value.split("|");
  if (threadId === undefined || messageId === undefined || commandId === undefined) return null;
  return { threadId, messageId, commandId };
}

export class T3ExecutorError extends Schema.TaggedError<T3ExecutorError>()("WlT3ExecutorError", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `T3 ${this.operation}: ${this.detail}`;
  }
}

export interface T3ExecutorOptions {
  readonly client: WsRpcProtocolClient;
  /**
   * Runs an Effect with the services this executor's caller already provides.
   * The port is Promise-shaped because the portable core must not depend on
   * Effect; this is the one place that bridge is crossed.
   */
  readonly runEffect: <A>(effect: Effect.Effect<A, T3ExecutorError>) => Promise<A>;
  readonly projectId: string;
  readonly instanceId: string;
  readonly model: string;
  readonly runtimeMode: T3ExecutorConfig["runtimeMode"];
  readonly worktreePath: string;
  readonly branch: string;
  /**
   * The handle recorded for an operation, read from the run store. Recovery
   * after a restart depends on this: without it, `inspect` could only answer
   * "unknown" for work the executor has no memory of.
   */
  readonly handleFor: (operationId: OperationId) => Promise<string | null>;
  readonly now: () => string;
}

/**
 * Narrows a T3 stream item to the handful of fields settlement depends on.
 *
 * The event reducer is written against this shape rather than T3's schema, so
 * upstream adding a field to a payload cannot ripple into WorkflowLeaf's rules.
 */
function toStreamItem(item: unknown): StreamItem {
  const value = item as Record<string, unknown>;

  if (value.kind === "snapshot") {
    const thread = (value.snapshot as { thread?: Record<string, unknown> } | undefined)?.thread;
    const latestTurn = thread?.latestTurn as
      | { turnId: string; state: "running" | "interrupted" | "completed" | "error" }
      | null
      | undefined;
    const session = thread?.session as
      | { status: string; lastError: string | null }
      | null
      | undefined;

    return {
      kind: "snapshot",
      snapshot: { thread: { latestTurn: latestTurn ?? null, session: session ?? null } },
    };
  }

  if (value.kind === "event") {
    const event = value.event as Record<string, unknown> | undefined;
    return {
      kind: "event",
      event: {
        type: String(event?.type ?? ""),
        sequence: Number(event?.sequence ?? 0),
        commandId: typeof event?.commandId === "string" ? event.commandId : null,
        payload: (event?.payload ?? {}) as Record<string, unknown>,
      },
    };
  }

  return { kind: "synchronized" };
}

/** Ids T3 accepts, derived from ours so a retry addresses the same thread. */
function threadIdFor(request: StageRequest): string {
  return `wl-${request.runId}-${request.visitId}`;
}

export class T3Executor implements ExecutorPort {
  #options: T3ExecutorOptions;
  #threads = new Map<string, string>();
  /**
   * The settlement watch for an operation, started before that operation was
   * dispatched. See `#watch`: a subscription attached afterwards never sees the
   * event that identifies our turn.
   */
  #watches = new Map<string, Promise<StageSettlement>>();

  constructor(options: T3ExecutorOptions) {
    this.#options = options;
  }

  /**
   * Runs one protocol interaction, tagging any failure with the operation it
   * came from. The RPC client's own error channel is deliberately widened here
   * rather than leaked: nothing above this class should have to know the shape
   * of a T3 transport error.
   */
  #run<A, E>(operation: string, effect: Effect.Effect<A, E>): Promise<A> {
    return this.#options.runEffect(
      effect.pipe(
        Effect.mapError((cause) => new T3ExecutorError({ operation, detail: String(cause) })),
      ),
    );
  }

  capabilities(): Promise<ExecutorCapabilities> {
    return Promise.resolve(T3_V1_CAPABILITIES);
  }

  /**
   * Attaches the settlement watch, waits for it, then starts the turn.
   *
   * Both halves of that order are load-bearing, and each one was learned from a
   * hang rather than from the handler. A subscription opened after the dispatch
   * finds our own `thread.message-sent` already folded into the snapshot and
   * has nothing left to correlate the turn by. A subscription opened before the
   * thread exists yields no items at all, so waiting for it to attach never
   * returns. The thread is created first, the watch second, the turn last.
   */
  #startTurn(input: {
    readonly operationId: OperationId;
    readonly handle: T3Handle;
    readonly text: string;
  }) {
    const options = this.#options;
    const begin = () => this.#beginWatch(input.operationId, input.handle);
    const remember = (settlement: Promise<StageSettlement>) => {
      this.#watches.set(input.operationId as string, settlement);
      this.#threads.set(input.operationId as string, encodeHandle(input.handle));
    };

    return Effect.gen(function* () {
      const watching = begin();
      remember(watching.settlement);
      yield* Effect.promise(() => watching.attached);

      yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.turn.start",
        commandId: input.handle.commandId,
        threadId: input.handle.threadId,
        message: {
          messageId: input.handle.messageId,
          role: "user",
          text: input.text,
          attachments: [],
        },
        runtimeMode: options.runtimeMode,
        interactionMode: "default",
        createdAt: options.now(),
      } as never);

      return {
        operationId: input.operationId,
        handle: encodeHandle(input.handle),
      } satisfies StageHandle;
    });
  }

  startStage(request: StageRequest): Promise<StageHandle> {
    const options = this.#options;
    const handle: T3Handle = {
      threadId: threadIdFor(request),
      messageId: `${request.operationId}-msg`,
      commandId: `${request.operationId}-turn`,
    };
    const createCommandId = `${request.operationId}-create`;
    const startTurn = () =>
      this.#startTurn({ operationId: request.operationId, handle, text: request.input });

    return this.#run(
      "startStage",
      Effect.gen(function* () {
        // The thread is created against the worktree the run already owns.
        // `bootstrap` is deliberately omitted: letting T3 prepare a worktree
        // per stage would give each stage its own working directory.
        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.create",
          commandId: createCommandId,
          threadId: handle.threadId,
          projectId: options.projectId,
          title: `WorkflowLeaf ${request.stage.contract.id}`,
          modelSelection: { instanceId: options.instanceId, model: options.model },
          runtimeMode: options.runtimeMode,
          interactionMode: "default",
          branch: options.branch,
          worktreePath: options.worktreePath,
          createdAt: options.now(),
        } as never);

        return yield* startTurn();
      }),
    );
  }

  continueStage(handle: StageHandle, correction: string): Promise<ContinueOutcome> {
    const decoded = decodeHandle(handle.handle);
    if (decoded === null) {
      return Promise.resolve({ kind: "lost-context", reason: "The stage handle is unreadable." });
    }

    // Another turn on the same thread. T3 keeps the provider session, so the
    // stage continues rather than starting over. The thread already exists, so
    // the watch goes up before this turn is dispatched, exactly as it does for
    // the first one.
    return this.#run(
      "continueStage",
      this.#startTurn({
        operationId: handle.operationId,
        handle: {
          threadId: decoded.threadId,
          messageId: `${handle.operationId}-msg`,
          commandId: `${handle.operationId}-turn`,
        },
        text: correction,
      }),
    ).then((started) => ({ kind: "continued", handle: started }) satisfies ContinueOutcome);
  }

  interrupt(handle: StageHandle): Promise<void> {
    const decoded = decodeHandle(handle.handle);
    if (decoded === null) return Promise.resolve();

    const options = this.#options;
    return this.#run(
      "interrupt",
      Effect.gen(function* () {
        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.turn.interrupt",
          commandId: `${handle.operationId}-interrupt`,
          threadId: decoded.threadId,
          createdAt: options.now(),
        } as never);
      }),
    ).then(() => undefined);
  }

  awaitSettlement(handle: StageHandle): Promise<StageSettlement> {
    // The watch was attached before the dispatch; this is where its result is
    // collected. A handle with no watch is one this executor did not dispatch.
    const started = this.#watches.get(handle.operationId as string);
    if (started !== undefined) return started;

    const decoded = decodeHandle(handle.handle);
    if (decoded === null) {
      return Promise.reject(new Error("The stage handle is unreadable."));
    }
    return this.#watch(handle.operationId, decoded, 0);
  }

  /**
   * Reads a thread's activities and session: its snapshot and catch-up, and
   * then live events for as long as `until` has not been met.
   */
  #readThread(
    operation: string,
    threadId: string,
    until: (view: ThreadView) => boolean = (view) => view.synchronized,
  ): Promise<ThreadView> {
    const options = this.#options;
    return this.#run(
      operation,
      Effect.gen(function* () {
        const empty: ThreadView = { activities: [], session: null, synchronized: false };
        const final = yield* options.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
          threadId,
          requestCompletionMarker: true,
        } as never).pipe(Stream.scan(empty, foldThread), Stream.takeUntil(until), Stream.runLast);
        return final._tag === "Some" ? final.value : empty;
      }),
    );
  }

  pendingRequests(handle: StageHandle): Promise<readonly ProviderRequest[]> {
    const decoded = decodeHandle(handle.handle);
    if (decoded === null) return Promise.resolve([]);
    return this.#readThread("pendingRequests", decoded.threadId).then((view) =>
      approvalsFrom(view.activities, view.session),
    );
  }

  /**
   * Answers one approval, and reports what the provider made of it.
   *
   * An expired request is reported without sending anything: answering it
   * would ask T3 to replay a callback the provider no longer holds. Otherwise
   * the answer is sent and the thread is read until T3 records either the
   * resolution or the provider's refusal.
   */
  answerRequest(
    handle: StageHandle,
    requestId: string,
    decision: ProviderDecision,
  ): Promise<AnswerOutcome> {
    const decoded = decodeHandle(handle.handle);
    if (decoded === null) {
      return Promise.resolve({ kind: "not-pending", reason: "The stage handle is unreadable." });
    }
    const options = this.#options;
    const threadId = decoded.threadId;

    return this.#readThread("answerRequest", threadId).then(async (before) => {
      const request = approvalsFrom(before.activities, before.session).find(
        (candidate) => candidate.requestId === requestId,
      );
      if (request === undefined) {
        return {
          kind: "not-pending",
          reason: `No approval ${requestId} is waiting on this stage.`,
        };
      }
      if (request.expired) {
        return {
          kind: "expired",
          reason:
            "The provider session that asked for this approval has ended, so it can no longer take an answer. Restart the stage to continue.",
        };
      }

      const seen = repliesTo(before.activities, requestId).length;
      await this.#run(
        "answerRequest",
        options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.approval.respond",
          commandId: `wl-answer-${requestId}-${String(seen)}`,
          threadId,
          requestId,
          decision,
          createdAt: options.now(),
        } as never),
      );
      const after = await this.#readThread(
        "answerRequest",
        threadId,
        (view) => answerOutcomeFrom(view.activities, requestId, seen) !== null,
      );
      return (
        answerOutcomeFrom(after.activities, requestId, seen) ?? {
          kind: "not-pending",
          reason: "The thread subscription ended before the provider replied.",
        }
      );
    });
  }

  /**
   * Opens the subscription and starts folding it, returning both a promise that
   * resolves once the stream is attached and the settlement promise itself.
   */
  #beginWatch(
    operationId: OperationId,
    handle: T3Handle,
  ): { attached: Promise<void>; settlement: Promise<StageSettlement> } {
    let markAttached: () => void = () => {};
    const attached = new Promise<void>((resolve) => {
      markAttached = resolve;
    });
    const settlement = this.#watch(operationId, handle, 0, markAttached);
    // A subscription that fails before it delivers anything would otherwise
    // leave the dispatch waiting on a signal that can no longer arrive. Let the
    // caller through and report the failure where it belongs, on settlement.
    settlement.then(markAttached, markAttached);
    return { attached, settlement };
  }

  /**
   * Reconciles an operation after a disconnect or restart.
   *
   * The handle comes from the run store rather than from memory, so a worker
   * that has just started can still ask what happened to work its predecessor
   * dispatched.
   */
  inspect(operationId: OperationId): Promise<InspectOutcome> {
    const remembered = this.#threads.get(operationId as string);
    const lookup =
      remembered === undefined ? this.#options.handleFor(operationId) : Promise.resolve(remembered);

    return lookup.then((value) => {
      if (value === null) return { kind: "never-dispatched" } as InspectOutcome;
      const decoded = decodeHandle(value);
      if (decoded === null) {
        return { kind: "unknown", reason: "The recorded handle is unreadable." } as InspectOutcome;
      }
      // Replay the thread from the beginning: the settlement either already
      // happened, in which case the stream says so, or it has not.
      return this.#watch(operationId, decoded, 0).then(
        (settlement): InspectOutcome => ({ kind: "settled", settlement }),
        (): InspectOutcome => ({
          kind: "unknown",
          reason: "The thread could not be read back.",
        }),
      );
    });
  }

  #watch(
    operationId: OperationId,
    handle: T3Handle,
    afterSequence: number,
    onAttached: () => void = () => {},
  ): Promise<StageSettlement> {
    const options = this.#options;
    const at = options.now();

    return this.#run(
      "awaitSettlement",
      Effect.gen(function* () {
        const stream = options.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
          threadId: handle.threadId,
          afterSequence,
        } as never);

        // Fold the subscription until the turn we own reports a settlement.
        // Overlapping replay is deduplicated by sequence inside the fold.
        const final = yield* stream.pipe(
          // The first item off the stream means the server has attached this
          // subscription; only then is it safe to dispatch into the thread.
          Stream.tap(() => Effect.sync(onAttached)),
          Stream.scan(initialWatch(), (state: WatchState, item: unknown) =>
            applyStreamItem(state, toStreamItem(item), {
              messageId: handle.messageId,
              commandId: handle.commandId,
            }),
          ),
          Stream.takeUntil((state) => {
            const settlement = settlementOf(state);
            return settlement !== null && settlement.settled;
          }),
          Stream.runLast,
        );

        const state = final._tag === "Some" ? final.value : initialWatch();
        const settlement = settlementOf(state);

        if (settlement === null) {
          // The stream ended without the turn settling. That is a fact about
          // the connection, not about the work, and it is reported as such.
          return {
            operationId,
            outcome: "error",
            settled: false,
            detail: "The thread subscription ended before the turn settled.",
            at,
          } satisfies StageSettlement;
        }

        return {
          operationId,
          outcome: settlement.outcome,
          settled: settlement.settled,
          detail: settlement.detail,
          at,
        } satisfies StageSettlement;
      }),
    );
  }
}
