/**
 * Asking for a run's decision on a T3 thread.
 *
 * T3 already has a place for work that is waiting on a person: a thread with a
 * pending question shows as awaiting input, sorts with the rest of the user's
 * work, and sends the same device notification any agent question does. A
 * client cannot open a question directly; only a provider can. So the run opens
 * one thread per decision, in its own worktree and in `approval-required` mode,
 * whose single turn asks the question with the provider's question tool.
 *
 * The answer is read from T3's record of the reply, the `user-input.resolved`
 * activity, never from what the model says afterwards. A model can phrase
 * anything; the selected option is what the person chose.
 */
import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import type { DecisionAnswer, DecisionPort, DecisionRequest } from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { T3ExecutorError } from "./executor.ts";

const ANSWERS: readonly DecisionAnswer[] = ["proceed", "waive", "abort"];

export function decisionThreadId(request: DecisionRequest): string {
  return `wl-${request.runId}-${request.decision.decisionId}`;
}

/** The turn's prompt: ask exactly this, with exactly these options, and nothing else. */
export function decisionPrompt(request: DecisionRequest): string {
  const { runId, decision } = request;
  const where =
    request.pullRequestUrl === null ? "" : ` Its pull request is ${request.pullRequestUrl}.`;
  return [
    `WL-DECISION: ${runId}/${decision.decisionId}`,
    "",
    `WorkflowLeaf run \`${runId}\` stopped and needs a person to decide how it continues.${where}`,
    "",
    "Your only job is to put the question below to the user with your tool for asking the user a question, then stop. Do not read files, run commands, or try to answer it yourself.",
    "",
    "Ask exactly one question:",
    `- header: WorkflowLeaf`,
    `- question: ${runId} needs a decision (${decision.kind}). ${decision.detail}`,
    "- options, single choice, with these exact labels:",
    "  - proceed: carry on from where the run stopped",
    "  - waive: accept the outstanding gates as an exception and move on",
    "  - abort: stop the run",
    "",
    `When the user has answered, reply with the label they chose and nothing else. They can also answer from a terminal with \`wl decide ${runId} <answer>\`.`,
  ].join("\n");
}

interface Activity {
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * The answer recorded on a decision thread, read from its activities.
 *
 * Null while the question is unanswered, and also when it was dismissed or the
 * turn ended without an answer: a missing answer is never read as a choice.
 */
export function answerFromActivities(activities: readonly Activity[]): DecisionAnswer | null {
  for (const activity of activities) {
    if (activity.kind !== "user-input.resolved") continue;
    const answers = (activity.payload as { answers?: unknown } | null)?.answers;
    if (typeof answers !== "object" || answers === null) continue;
    const chosen = Object.values(answers as Record<string, unknown>)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase());
    for (const value of chosen) {
      const answer = ANSWERS.find(
        (candidate) => value === candidate || value.startsWith(`${candidate} `),
      );
      if (answer !== undefined) return answer;
    }
  }
  return null;
}

/** Folds one subscription item into the activities seen so far. */
function activitiesOf(item: unknown): readonly Activity[] {
  const value = item as Record<string, unknown>;
  if (value.kind === "snapshot") {
    const thread = (value.snapshot as { thread?: { activities?: readonly Activity[] } }).thread;
    return thread?.activities ?? [];
  }
  if (value.kind === "event") {
    const event = value.event as { type?: string; payload?: { activity?: Activity } };
    if (event.type === "thread.activity-appended" && event.payload?.activity !== undefined) {
      return [event.payload.activity];
    }
  }
  return [];
}

export interface T3DecisionOptions {
  readonly client: WsRpcProtocolClient;
  readonly runEffect: <A>(effect: Effect.Effect<A, T3ExecutorError>) => Promise<A>;
  readonly projectId: string;
  readonly instanceId: string;
  readonly model: string;
  readonly now: () => string;
}

export class T3DecisionThread implements DecisionPort {
  #options: T3DecisionOptions;

  constructor(options: T3DecisionOptions) {
    this.#options = options;
  }

  #run<A, E>(operation: string, effect: Effect.Effect<A, E>): Promise<A> {
    return this.#options.runEffect(
      effect.pipe(
        Effect.mapError((cause) => new T3ExecutorError({ operation, detail: String(cause) })),
      ),
    );
  }

  ask(request: DecisionRequest): Promise<void> {
    const options = this.#options;
    const threadId = decisionThreadId(request);
    const id = request.decision.decisionId as string;
    return this.#run(
      "askDecision",
      Effect.gen(function* () {
        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.create",
          commandId: `${id}-create`,
          threadId,
          projectId: options.projectId,
          title: `WorkflowLeaf decision: ${request.runId}`,
          modelSelection: { instanceId: options.instanceId, model: options.model },
          // Nothing on this thread may change anything. It only asks.
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: request.branch,
          worktreePath: request.workspacePath,
          createdAt: options.now(),
        } as never);
        yield* options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.turn.start",
          commandId: `${id}-ask`,
          threadId,
          message: {
            messageId: `${id}-msg`,
            role: "user",
            text: decisionPrompt(request),
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: options.now(),
        } as never);
      }),
    );
  }

  answer(request: DecisionRequest, wait: boolean): Promise<DecisionAnswer | null> {
    const options = this.#options;
    return this.#run(
      "readDecision",
      Effect.gen(function* () {
        const stream = options.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
          threadId: decisionThreadId(request),
          requestCompletionMarker: true,
        } as never);

        // Collect activities until an answer shows up, or, when not waiting,
        // until the server says the snapshot and catch-up are complete.
        const final = yield* stream.pipe(
          Stream.scan(
            { activities: [] as readonly Activity[], synchronized: false },
            (state, item: unknown) => ({
              activities: [...state.activities, ...activitiesOf(item)],
              synchronized:
                state.synchronized || (item as { kind?: string }).kind === "synchronized",
            }),
          ),
          Stream.takeUntil(
            (state) =>
              answerFromActivities(state.activities) !== null || (!wait && state.synchronized),
          ),
          Stream.runLast,
        );
        return final._tag === "Some" ? answerFromActivities(final.value.activities) : null;
      }),
    );
  }

  withdraw(request: DecisionRequest): Promise<void> {
    const options = this.#options;
    const id = request.decision.decisionId as string;
    // Ending the turn dismisses its open question, so the thread stops asking.
    return this.#run(
      "withdrawDecision",
      options.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.turn.interrupt",
        commandId: `${id}-withdraw`,
        threadId: decisionThreadId(request),
        createdAt: options.now(),
      } as never).pipe(Effect.asVoid),
    );
  }
}
