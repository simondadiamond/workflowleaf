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
  ContinueOutcome,
  ExecutorCapabilities,
  ExecutorPort,
  InspectOutcome,
  OperationId,
  StageHandle,
  StageRequest,
  StageSettlement,
} from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  applyStreamItem,
  initialWatch,
  settlementOf,
  type StreamItem,
  type WatchState,
} from "./mapEvents.ts";

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
  readonly runtimeMode: "full-access" | "read-only";
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

  startStage(request: StageRequest): Promise<StageHandle> {
    const options = this.#options;
    const threadId = threadIdFor(request);
    const messageId = `${request.operationId}-msg`;
    const createCommandId = `${request.operationId}-create`;
    const turnCommandId = `${request.operationId}-turn`;

    return this.#run(
      "startStage",
      Effect.gen(function* () {
        const createdAt = options.now();

        // The thread is created against the worktree the run already owns.
        // `bootstrap` is deliberately omitted: letting T3 prepare a worktree
        // per stage would give each stage its own working directory.
        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          command: {
            type: "thread.create",
            commandId: createCommandId,
            threadId,
            projectId: options.projectId,
            title: `WorkflowLeaf ${request.stage.contract.id}`,
            modelSelection: { instanceId: options.instanceId, model: options.model },
            runtimeMode: options.runtimeMode,
            interactionMode: "default",
            branch: options.branch,
            worktreePath: options.worktreePath,
            createdAt,
          },
        } as never);

        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          command: {
            type: "thread.turn.start",
            commandId: turnCommandId,
            threadId,
            message: { messageId, role: "user", text: request.input, attachments: [] },
            runtimeMode: options.runtimeMode,
            interactionMode: "default",
            createdAt,
          },
        } as never);

        return {
          operationId: request.operationId,
          handle: encodeHandle({ threadId, messageId, commandId: turnCommandId }),
        } satisfies StageHandle;
      }),
    ).then((handle) => {
      this.#threads.set(request.operationId as string, handle.handle);
      return handle;
    });
  }

  continueStage(handle: StageHandle, correction: string): Promise<ContinueOutcome> {
    const decoded = decodeHandle(handle.handle);
    if (decoded === null) {
      return Promise.resolve({ kind: "lost-context", reason: "The stage handle is unreadable." });
    }

    const options = this.#options;
    const messageId = `${handle.operationId}-msg`;
    const commandId = `${handle.operationId}-turn`;

    return this.#run(
      "continueStage",
      Effect.gen(function* () {
        // Another turn on the same thread. T3 keeps the provider session, so
        // the stage continues rather than starting over.
        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          command: {
            type: "thread.turn.start",
            commandId,
            threadId: decoded.threadId,
            message: { messageId, role: "user", text: correction, attachments: [] },
            runtimeMode: options.runtimeMode,
            interactionMode: "default",
            createdAt: options.now(),
          },
        } as never);

        return {
          kind: "continued",
          handle: {
            operationId: handle.operationId,
            handle: encodeHandle({ threadId: decoded.threadId, messageId, commandId }),
          },
        } satisfies ContinueOutcome;
      }),
    );
  }

  interrupt(handle: StageHandle): Promise<void> {
    const decoded = decodeHandle(handle.handle);
    if (decoded === null) return Promise.resolve();

    const options = this.#options;
    return this.#run(
      "interrupt",
      Effect.gen(function* () {
        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          command: {
            type: "thread.turn.interrupt",
            commandId: `${handle.operationId}-interrupt`,
            threadId: decoded.threadId,
            createdAt: options.now(),
          },
        } as never);
      }),
    ).then(() => undefined);
  }

  awaitSettlement(handle: StageHandle): Promise<StageSettlement> {
    const decoded = decodeHandle(handle.handle);
    if (decoded === null) {
      return Promise.reject(new Error("The stage handle is unreadable."));
    }
    return this.#watch(handle.operationId, decoded, 0);
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
