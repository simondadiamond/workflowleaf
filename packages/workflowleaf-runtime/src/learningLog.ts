/**
 * The learning log: every place the deterministic path did not carry the work.
 *
 * It is derived, not written. Every failing gate already left an evidence
 * record, every stop for a human already left a `raise-decision` effect in the
 * transition log, every answer a `decision-answered` input, and every executor
 * gap a limitation. Reading those back is the log, so there is no second writer
 * to forget to call and no entry that can disagree with what the run recorded.
 *
 * Grouping is by cause: the gate and how it failed, the kind of decision, the
 * missing capability. A cause that recurs is a candidate for a script, a skill
 * or a playbook change; one that happened once is maintenance.
 */
import type { EvidenceRecord, RunRecord } from "@t3tools/workflowleaf-core";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RunStore, type TransitionRow } from "./store/RunStore.ts";

export interface LearningEntry {
  readonly at: string;
  readonly runId: string;
  readonly stageId: string | null;
  /** What kind of thing went wrong. `intervention` means a person had to act. */
  readonly kind: "gate" | "decision" | "intervention" | "limitation";
  /** The grouping key, e.g. `gate mapped-tests-pass failed`. */
  readonly cause: string;
  readonly detail: string;
  /** Where the full evidence is, when there is more than the detail. */
  readonly evidence: string | null;
  readonly human: boolean;
}

export interface LearningGroup {
  readonly cause: string;
  readonly kind: LearningEntry["kind"];
  readonly count: number;
  readonly runs: readonly string[];
  readonly firstAt: string;
  readonly lastAt: string;
  readonly latest: LearningEntry;
  /** How many of the entries needed a person. */
  readonly human: number;
}

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

function parse(text: string): unknown {
  const decoded = decodeJson(text);
  return decoded._tag === "Success" ? decoded.success : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function evidenceDetail(evidence: EvidenceRecord): string {
  const detail = evidence.detail;
  switch (detail.kind) {
    case "command":
      return detail.timedOut ? "timed out" : `exit ${String(detail.exitCode)}`;
    case "file":
      return detail.exists
        ? `missing ${detail.missingContent.join(", ") || "size"}`
        : "missing file";
    case "diff":
      return `outside the plan: ${detail.outsideScope.join(", ")}`;
    case "review":
      return detail.findings
        .map((finding) => `[${finding.severity}] ${finding.summary}`)
        .join("; ");
    case "external":
      return `${detail.state}${detail.detail === null ? "" : `: ${detail.detail}`}`;
  }
}

/** Entries from evidence, decisions, answers and limitations. Pure, so testable. */
export function learningEntries(input: {
  readonly evidence: readonly EvidenceRecord[];
  readonly transitions: readonly TransitionRow[];
  readonly limitations: readonly {
    readonly runId: string;
    readonly stageId: string;
    readonly capability: string;
    readonly detail: string;
    readonly at: string;
  }[];
  readonly runs: ReadonlyMap<string, RunRecord>;
}): LearningEntry[] {
  const stageOfVisit = (runId: string, visitId: string) =>
    (input.runs.get(runId)?.visits.find((visit) => visit.visitId === visitId)?.stageId as
      | string
      | undefined) ?? null;

  const entries: LearningEntry[] = [];

  for (const record of input.evidence) {
    entries.push({
      at: record.endedAt,
      runId: record.runId as string,
      stageId: stageOfVisit(record.runId as string, record.visitId as string),
      kind: "gate",
      cause: `gate ${record.gateId as string} ${record.outcome}`,
      detail: evidenceDetail(record),
      evidence: record.logRef,
      human: false,
    });
  }

  for (const row of input.transitions) {
    const transitionInput = asRecord(parse(row.input));
    const effects = parse(row.effects);

    if (Array.isArray(effects)) {
      for (const effect of effects) {
        const raised = asRecord(effect);
        if (raised?.type !== "raise-decision") continue;
        const decision = asRecord(raised.decision);
        const run = input.runs.get(row.runId);
        entries.push({
          at: row.at,
          runId: row.runId,
          stageId: (run?.currentStageId as string | null | undefined) ?? null,
          kind: "decision",
          cause: `decision ${String(decision?.kind ?? "unknown")}`,
          detail: String(decision?.detail ?? ""),
          evidence: null,
          human: false,
        });
      }
    }

    if (transitionInput?.type === "decision-answered") {
      entries.push({
        at: row.at,
        runId: row.runId,
        stageId: null,
        kind: "intervention",
        cause: `answered ${String(transitionInput.answer)}`,
        detail: `A person answered decision ${String(transitionInput.decisionId)} with ${String(transitionInput.answer)}.`,
        evidence: null,
        human: true,
      });
    }
    if (transitionInput?.type === "cancel") {
      entries.push({
        at: row.at,
        runId: row.runId,
        stageId: null,
        kind: "intervention",
        cause: "cancelled",
        detail: String(transitionInput.reason ?? ""),
        evidence: null,
        human: true,
      });
    }
  }

  for (const limitation of input.limitations) {
    entries.push({
      at: limitation.at,
      runId: limitation.runId,
      stageId: limitation.stageId,
      kind: "limitation",
      cause: `limitation ${limitation.capability}`,
      detail: limitation.detail,
      evidence: null,
      human: false,
    });
  }

  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

/** Groups entries by cause, most frequent first. */
export function groupByCause(entries: readonly LearningEntry[]): LearningGroup[] {
  const groups = new Map<string, LearningEntry[]>();
  for (const entry of entries) {
    const existing = groups.get(entry.cause);
    if (existing === undefined) groups.set(entry.cause, [entry]);
    else existing.push(entry);
  }

  return [...groups.entries()]
    .map(([cause, members]) => ({
      cause,
      kind: members[0]!.kind,
      count: members.length,
      runs: [...new Set(members.map((member) => member.runId))],
      firstAt: members[0]!.at,
      lastAt: members.at(-1)!.at,
      latest: members.at(-1)!,
      human: members.filter((member) => member.human).length,
    }))
    .sort((left, right) => right.count - left.count || right.lastAt.localeCompare(left.lastAt));
}

/**
 * `30d`, `12h` or `90m` back from now, or an ISO instant as given. Anything
 * else is rejected rather than read as "everything".
 */
export const sinceInstant = Effect.fnUntraced(function* (since: string) {
  const relative = /^(\d+)([dhm])$/.exec(since.trim());
  if (relative === null) {
    const parsed = DateTime.make(since.trim());
    if (parsed._tag === "None") return null;
    return DateTime.formatIso(parsed.value);
  }
  const amount = Number(relative[1]);
  const unit = relative[2];
  const duration =
    unit === "d"
      ? Duration.days(amount)
      : unit === "h"
        ? Duration.hours(amount)
        : Duration.minutes(amount);
  const now = yield* DateTime.now;
  return DateTime.formatIso(DateTime.subtractDuration(now, duration));
});

export const readLearningLog = Effect.fnUntraced(function* (since: string) {
  const store = yield* RunStore;
  const [evidence, transitions, limitations, runs] = yield* Effect.all([
    store.failedEvidenceSince(since),
    store.transitionsSince(since),
    store.limitationsSince(since),
    store.listRuns(),
  ]);
  return learningEntries({
    evidence,
    transitions,
    limitations,
    runs: new Map(runs.map((run) => [run.record.runId as string, run.record])),
  });
});
