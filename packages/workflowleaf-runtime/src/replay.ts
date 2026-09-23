/**
 * Replaying a run's history through the controller.
 *
 * The transition log holds every input the controller was given, the effects
 * it answered with and the revision it left the run on. The controller is a
 * pure function, so feeding the same inputs to it again from the run's initial
 * state has to give the same answers. When it does not, the controller has
 * changed what it would have done on a run that already happened, and that is
 * reported at the first transition where the two disagree.
 *
 * Two things the controller takes are not rules: the clock and the ids it
 * mints. The clock is the instant each transition was recorded at. The ids are
 * handed back from what the run recorded, in the order it minted them, so an
 * id scheme can change without every past run failing to replay. A controller
 * that mints an id the run never recorded gets a placeholder, and the
 * placeholder shows up in the diff.
 */
import {
  decide as controllerDecide,
  initialRun,
  type ControllerEffect,
  type ControllerInput,
  type IdSource,
  type RunId,
  type RunPlan,
  type RunRecord,
} from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { canonicalJson, prettyJson } from "./canonical.ts";
import { RunStore, type TransitionRow } from "./store/RunStore.ts";

export class ReplayError extends Schema.TaggedError<ReplayError>()("WlReplayError", {
  message: Schema.String,
}) {}

export interface ReplayDivergence {
  /** The transition the replay first disagreed at, or null for the final state. */
  readonly seq: number | null;
  readonly what: "effects" | "revision" | "ignored" | "state";
  readonly recorded: string;
  readonly replayed: string;
}

export interface ReplayReport {
  readonly runId: string;
  readonly transitions: number;
  /** Null when every transition and the final state were reproduced exactly. */
  readonly divergence: ReplayDivergence | null;
}

export interface RecordedTransition {
  readonly seq: number;
  readonly at: string;
  readonly input: ControllerInput;
  readonly effects: readonly ControllerEffect[];
  readonly revision: number;
}

/**
 * Ids in the order the run minted them.
 *
 * Visits are never removed from a run, so the recorded visit list is every
 * visit id in minting order. Attempts, operations and decisions each appear in
 * the effects of the transition that minted them.
 */
function recordedIds(
  record: RunRecord,
  transition: () => RecordedTransition | undefined,
): IdSource {
  const visits = record.visits.map((visit) => visit.visitId as string);
  let unrecorded = 0;
  const placeholder = (kind: string) => `unrecorded-${kind}-${String(++unrecorded)}`;

  const fromEffects = (pick: (effect: ControllerEffect) => string | undefined) => {
    const used = new WeakMap<RecordedTransition, number>();
    return (kind: string) => {
      const current = transition();
      if (current === undefined) return placeholder(kind);
      const ids = current.effects.flatMap((effect) => {
        const id = pick(effect);
        return id === undefined ? [] : [id];
      });
      const index = used.get(current) ?? 0;
      used.set(current, index + 1);
      return ids[index] ?? placeholder(kind);
    };
  };

  const attempt = fromEffects((effect) =>
    effect.type === "dispatch-stage" ||
    effect.type === "continue-stage" ||
    effect.type === "run-gates"
      ? (effect.attemptId as string)
      : undefined,
  );
  const operation = fromEffects((effect) =>
    effect.type === "dispatch-stage" || effect.type === "continue-stage"
      ? (effect.operationId as string)
      : undefined,
  );
  const decision = fromEffects((effect) =>
    effect.type === "raise-decision" ? (effect.decision.decisionId as string) : undefined,
  );

  return {
    visitId: () => (visits.shift() ?? placeholder("visit")) as never,
    attemptId: () => attempt("attempt") as never,
    operationId: () => operation("op") as never,
    decisionId: () => decision("decision") as never,
  };
}

/**
 * Feeds recorded transitions back through the controller from the run's
 * initial state and reports the first place the result differs.
 *
 * `decide` is the controller under test. It defaults to the real one; a test
 * passes a changed one to prove a change is caught.
 */
export function replayTransitions(input: {
  readonly record: RunRecord;
  readonly plan: RunPlan;
  readonly transitions: readonly RecordedTransition[];
  readonly decide?: typeof controllerDecide;
}): ReplayReport {
  const decide = input.decide ?? controllerDecide;
  const { record } = input;
  let current: RecordedTransition | undefined;
  const ids = recordedIds(record, () => current);

  // Nothing the controller does changes these, so the final record carries the
  // values the run started with.
  let run = initialRun({
    runId: record.runId,
    planDigest: record.planDigest,
    workspaceId: record.workspaceId,
    pullRequest: record.pullRequest,
    capabilities: record.capabilities,
    maxRepairCycles: record.budget.maxRepairCycles,
    deadlineAt: record.budget.deadlineAt,
    now: record.createdAt,
  });

  const report = (divergence: ReplayDivergence | null): ReplayReport => ({
    runId: record.runId as string,
    transitions: input.transitions.length,
    divergence,
  });

  for (const transition of input.transitions) {
    current = transition;
    const decision = decide({ run, plan: input.plan, now: transition.at, ids }, transition.input);

    // The worker persists nothing for an input the controller ignores, so a
    // recorded transition that is now ignored is a changed outcome.
    if (decision.run.revision === run.revision && decision.effects.length === 0) {
      return report({
        seq: transition.seq,
        what: "ignored",
        recorded: prettyJson(transition.effects),
        replayed: "the controller ignored this input",
      });
    }

    const recordedEffects = canonicalJson(transition.effects);
    if (canonicalJson(decision.effects) !== recordedEffects) {
      return report({
        seq: transition.seq,
        what: "effects",
        recorded: prettyJson(transition.effects),
        replayed: prettyJson(decision.effects),
      });
    }

    if (decision.run.revision !== transition.revision) {
      return report({
        seq: transition.seq,
        what: "revision",
        recorded: String(transition.revision),
        replayed: String(decision.run.revision),
      });
    }

    run = decision.run;
  }

  if (canonicalJson(run) !== canonicalJson(record)) {
    const changed = Object.keys({ ...record, ...run }).filter(
      (key) =>
        canonicalJson((record as Record<string, unknown>)[key]) !==
        canonicalJson((run as Record<string, unknown>)[key]),
    );
    const pick = (value: RunRecord) =>
      Object.fromEntries(changed.map((key) => [key, (value as Record<string, unknown>)[key]]));
    return report({
      seq: null,
      what: "state",
      recorded: prettyJson(pick(record)),
      replayed: prettyJson(pick(run)),
    });
  }

  return report(null);
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const decodeTransition = (row: TransitionRow) =>
  Effect.gen(function* () {
    const input = yield* decodeJson(row.input);
    const effects = yield* decodeJson(row.effects);
    return {
      seq: row.seq,
      at: row.at,
      input: input as ControllerInput,
      effects: effects as readonly ControllerEffect[],
      revision: row.revision,
    } satisfies RecordedTransition;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ReplayError({
          message: `Transition ${String(row.seq)} of ${row.runId} is not readable: ${String(cause)}`,
        }),
    ),
  );

/** Replays one stored run against the controller this process was built with. */
export const replayRun = Effect.fnUntraced(function* (
  runId: RunId,
  decide?: typeof controllerDecide,
) {
  const store = yield* RunStore;
  const loaded = yield* store.loadRun(runId);
  if (Option.isNone(loaded)) {
    return yield* new ReplayError({ message: `No run ${runId}.` });
  }
  const rows = yield* store.transitionsFor(runId);
  const transitions = yield* Effect.forEach(rows, decodeTransition);
  return replayTransitions({
    record: loaded.value.record,
    plan: loaded.value.plan,
    transitions,
    ...(decide === undefined ? {} : { decide }),
  });
});
