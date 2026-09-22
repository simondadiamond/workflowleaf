/**
 * A deterministic executor for tests.
 *
 * Every failure the real seam can produce has to be reproducible without a
 * provider: a dispatch whose acknowledgment is lost, a terminal event delivered
 * twice, a completion that arrives before the executor stopped writing, an
 * executor that cannot continue a context. Those are the cases the controller
 * exists for, and they are the ones a live run reproduces least reliably.
 */
import type {
  AnswerOutcome,
  ContinueOutcome,
  ExecutorPort,
  InspectOutcome,
  ProviderRequest,
  StageHandle,
  StageRequest,
  StageSettlement,
} from "../ports.ts";
import type { Instant, OperationId } from "../ids.ts";
import type { ExecutorCapabilities } from "../state.ts";
import { FULL_CAPABILITIES } from "./fixture.ts";

export interface ScriptedStage {
  /** `"lost-ack"` dispatches but never returns a handle to the caller. */
  readonly dispatch?: "ok" | "lost-ack";
  readonly outcome?: StageSettlement["outcome"];
  /** `false` models an executor still writing to the worktree after it stops talking. */
  readonly settled?: boolean;
  readonly detail?: string | null;
  /** How `continueStage` behaves for this stage's corrections. */
  readonly continuation?: "continued" | "unsupported" | "lost-context";
}

export interface FakeExecutorOptions {
  readonly capabilities?: Partial<ExecutorCapabilities>;
  /** Per stage id, in visit order. Later entries repeat the last one. */
  readonly script?: Readonly<Record<string, readonly ScriptedStage[]>>;
  readonly now?: Instant;
}

export interface DispatchLogEntry {
  readonly kind: "start" | "continue" | "interrupt";
  readonly operationId: OperationId;
  readonly stageId: string;
  readonly input: string;
}

export class FakeExecutor implements ExecutorPort {
  readonly log: DispatchLogEntry[] = [];

  #capabilities: ExecutorCapabilities;
  #script: Readonly<Record<string, readonly ScriptedStage[]>>;
  #visitCounts = new Map<string, number>();
  #dispatched = new Map<
    string,
    { stageId: string; scripted: ScriptedStage; acknowledged: boolean }
  >();
  #now: Instant;

  constructor(options: FakeExecutorOptions = {}) {
    this.#capabilities = { ...FULL_CAPABILITIES, ...options.capabilities };
    this.#script = options.script ?? {};
    this.#now = options.now ?? "2026-01-01T00:00:00.000Z";
  }

  capabilities(): Promise<ExecutorCapabilities> {
    return Promise.resolve(this.#capabilities);
  }

  #scriptFor(stageId: string): ScriptedStage {
    const entries = this.#script[stageId] ?? [];
    const index = this.#visitCounts.get(stageId) ?? 0;
    this.#visitCounts.set(stageId, index + 1);
    return entries[Math.min(index, entries.length - 1)] ?? {};
  }

  startStage(request: StageRequest): Promise<StageHandle> {
    const stageId = request.stage.contract.id as string;
    const scripted = this.#scriptFor(stageId);
    this.log.push({
      kind: "start",
      operationId: request.operationId,
      stageId,
      input: request.input,
    });
    this.#dispatched.set(request.operationId as string, { stageId, scripted, acknowledged: false });

    if (scripted.dispatch === "lost-ack") {
      // The executor received it. The caller never finds out.
      return Promise.reject(new Error("connection dropped before acknowledgment"));
    }

    this.#dispatched.get(request.operationId as string)!.acknowledged = true;
    return Promise.resolve({
      operationId: request.operationId,
      handle: `handle-${request.operationId}`,
    });
  }

  continueStage(handle: StageHandle, correction: string): Promise<ContinueOutcome> {
    const record = this.#dispatched.get(handle.operationId as string);
    const stageId = record?.stageId ?? "unknown";
    this.log.push({
      kind: "continue",
      operationId: handle.operationId,
      stageId,
      input: correction,
    });

    const scripted = this.#scriptFor(stageId);
    this.#dispatched.set(handle.operationId as string, { stageId, scripted, acknowledged: true });

    switch (
      scripted.continuation ??
      (this.#capabilities.sameContextContinuation ? "continued" : "unsupported")
    ) {
      case "continued":
        return Promise.resolve({ kind: "continued", handle });
      case "unsupported":
        return Promise.resolve({
          kind: "unsupported",
          reason: "This executor cannot continue an existing context.",
        });
      case "lost-context":
        return Promise.resolve({
          kind: "lost-context",
          reason: "The provider session ended between the turn and the correction.",
        });
    }
  }

  inspect(operationId: OperationId): Promise<InspectOutcome> {
    const record = this.#dispatched.get(operationId as string);
    if (record === undefined) return Promise.resolve({ kind: "never-dispatched" });
    if (!this.#capabilities.recovery) {
      return Promise.resolve({
        kind: "unknown",
        reason: "This executor cannot reconcile operations.",
      });
    }
    return Promise.resolve({
      kind: "settled",
      settlement: this.#settlementFor(operationId, record.scripted),
    });
  }

  interrupt(handle: StageHandle): Promise<void> {
    const record = this.#dispatched.get(handle.operationId as string);
    this.log.push({
      kind: "interrupt",
      operationId: handle.operationId,
      stageId: record?.stageId ?? "unknown",
      input: "",
    });
    return Promise.resolve();
  }

  awaitSettlement(handle: StageHandle): Promise<StageSettlement> {
    const record = this.#dispatched.get(handle.operationId as string);
    return Promise.resolve(this.#settlementFor(handle.operationId, record?.scripted ?? {}));
  }

  pendingRequests(): Promise<readonly ProviderRequest[]> {
    return Promise.resolve([]);
  }

  answerRequest(): Promise<AnswerOutcome> {
    return Promise.resolve({
      kind: "not-pending",
      reason: "This executor has no provider to ask.",
    });
  }

  #settlementFor(operationId: OperationId, scripted: ScriptedStage): StageSettlement {
    return {
      operationId,
      outcome: scripted.outcome ?? "completed",
      settled: scripted.settled ?? this.#capabilities.settledCompletion,
      detail: scripted.detail ?? null,
      at: this.#now,
    };
  }

  /** Every start/continue this executor was asked to perform, in order. */
  dispatchedStages(): string[] {
    return this.log.filter((entry) => entry.kind !== "interrupt").map((entry) => entry.stageId);
  }
}
