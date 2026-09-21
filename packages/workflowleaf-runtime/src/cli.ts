/**
 * The `wl` command line.
 *
 * The first surface for driving and inspecting runs. Mutating commands take an
 * explicit run id and the revision they believe they are acting on, so a
 * terminal that has been sitting open cannot advance a run that moved on
 * without it.
 */
import { formatDiagnostics } from "@t3tools/workflowleaf-core";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { prettyJson } from "./canonical.ts";
import { loadPlaybook } from "./load.ts";
import { describeRun, nextRunId, resumeRun, startRun, summarizeRuns } from "./run.ts";
import {
  loadProfile,
  PROFILE_TEMPLATE,
  profilePath,
  workflowleafHome,
  type Profile,
} from "./profile.ts";
import { RunStore } from "./store/RunStore.ts";
import { loadSkillCatalog } from "./skillCatalog.ts";
import type { RunProgress } from "./worker.ts";

export class PlaybookInvalid extends Schema.TaggedError<PlaybookInvalid>()("WlPlaybookInvalid", {
  report: Schema.String,
}) {
  override get message(): string {
    return this.report;
  }
}

/** The run moved on between the caller reading it and acting on it. */
export class StaleRevision extends Schema.TaggedError<StaleRevision>()("WlStaleRevision", {
  runId: Schema.String,
  expected: Schema.Int,
  actual: Schema.Int,
}) {
  override get message(): string {
    return `Run ${this.runId} is on revision ${this.actual}, not ${this.expected}. Look again before acting.`;
  }
}

const profileFlag = Flag.String("profile").pipe(
  Flag.withDescription("Execution profile: skill roots, target repository, executor, permissions."),
);

const inputFlag = Flag.KeyValuePair("input").pipe(
  Flag.withDescription("A run input as key=value. Repeatable."),
  Flag.withDefault({}),
);

const playbookArgument = Argument.String("playbook").pipe(
  Argument.withDescription(
    "Directory containing PLAYBOOK.md. Defaults to the profile's defaultPlaybook.",
  ),
  Argument.optional,
);

/**
 * Which playbook this command means.
 *
 * A playbook is portable and knows nothing about where it was copied to, so
 * the path is either typed here or read from the profile, which is the local
 * half of the pair. Neither one present is an error rather than a guess.
 */
export const playbookDirFor = Effect.fnUntraced(function* (
  given: Option.Option<string>,
  profile: Profile,
) {
  const path = yield* Path.Path;
  const named = Option.getOrElse(given, () => profile.defaultPlaybook ?? "");
  if (named.trim().length === 0) {
    return yield* new PlaybookInvalid({
      report: `Profile ${profile.name} has no defaultPlaybook, so this command needs a playbook directory.`,
    });
  }
  return path.resolve(named);
});

const loadForCli = Effect.fnUntraced(function* (
  playbook: Option.Option<string>,
  profileName: string,
  inputs: Readonly<Record<string, string>>,
) {
  const profile = yield* loadProfile(profileName);
  const now = yield* DateTime.now;

  const loaded = yield* loadPlaybook({
    playbookDir: yield* playbookDirFor(playbook, profile),
    repoRoot: profile.repoRoot,
    skillRoots: profile.skillRoots,
    inputs,
    compiledAt: DateTime.formatIso(now),
  });

  if (!loaded.ok) {
    // The diagnostics are the useful part, so they go to stderr in full rather
    // than being folded into a one-line failure message.
    const report = formatDiagnostics(loaded.diagnostics);
    yield* Console.error(report);
    return yield* new PlaybookInvalid({ report });
  }

  return { profile, loaded: loaded.value };
});

const validateCommand = Command.make(
  "validate",
  { playbook: playbookArgument, profile: profileFlag, input: inputFlag },
  Effect.fnUntraced(function* ({ playbook, profile, input }) {
    const { loaded } = yield* loadForCli(playbook, profile, input);
    const { document, plan } = loaded;

    yield* Console.log(
      `${document.id}@${document.version}: ${document.stages.length} stage(s), ${document.gates.length} gate(s)`,
    );
    yield* Console.log(`plan digest ${plan.planDigest}`);

    for (const stage of plan.stages) {
      const gates = stage.gates.map((gate) => `${gate.definition.id}:${gate.definition.type}`);
      yield* Console.log(
        `  ${stage.contract.id} (${stage.contract.kind}) up to ${stage.contract.budgets.attempts} attempt(s); gates ${gates.join(", ") || "none"}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Check a playbook contract. Reports the file and field for every problem.",
  ),
);

const compileCommand = Command.make(
  "compile",
  { playbook: playbookArgument, profile: profileFlag, input: inputFlag },
  Effect.fnUntraced(function* ({ playbook, profile, input }) {
    const { loaded } = yield* loadForCli(playbook, profile, input);
    yield* Console.log(prettyJson(loaded.plan));
  }),
).pipe(
  Command.withDescription("Resolve files, skills and gates and print the immutable run plan."),
);

const skillsCommand = Command.make(
  "skills",
  { profile: profileFlag },
  Effect.fnUntraced(function* ({ profile: profileName }) {
    const profile = yield* loadProfile(profileName);
    const catalog = yield* loadSkillCatalog(profile.skillRoots);

    if (catalog.byId.size === 0) {
      yield* Console.error(
        `No skills under ${profile.skillRoots.join(", ") || "<no roots configured>"}.`,
      );
      return;
    }

    const entries = [...catalog.byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const entry of entries) {
      yield* Console.log(
        `${entry.id.padEnd(28)} ${entry.digest.slice(7, 19)}  ${entry.description.slice(0, 72)}`,
      );
    }
  }),
).pipe(Command.withDescription("List the skills a profile's roots resolve, with their digests."));

const profileCommand = Command.make(
  "profile",
  {
    action: Argument.String("action").pipe(Argument.withDescription("init | show")),
    name: Argument.String("name"),
  },
  Effect.fnUntraced(function* ({ action, name }) {
    if (action === "init") {
      yield* Console.log(`Write this to ${yield* profilePath(name)} and fill in the placeholders:`);
      yield* Console.log(prettyJson(PROFILE_TEMPLATE));
      yield* Console.log(`WorkflowLeaf home: ${yield* workflowleafHome()}`);
      return;
    }
    if (action === "show") {
      yield* Console.log(prettyJson(yield* loadProfile(name)));
      return;
    }
    yield* Console.error("wl profile init <name> | wl profile show <name>");
  }),
).pipe(
  Command.withDescription("Create or inspect a local execution profile. Never holds secrets."),
);

const runIdArgument = Argument.String("run").pipe(
  Argument.withDescription("The run id. Mutating commands never guess which run you meant."),
);

const revisionFlag = Flag.Int("revision").pipe(
  Flag.withDescription(
    "The revision you believe the run is on. The command refuses if it has moved since you looked.",
  ),
  Flag.optional,
);

const ownerFlag = Flag.String("owner").pipe(
  Flag.withDescription("Who is driving this run. Recorded on the lease."),
  Flag.withDefault("cli"),
);

/** Fails when the run has moved on since the caller last looked at it. */
const assertRevision = Effect.fnUntraced(function* (
  runId: string,
  expected: Option.Option<number>,
) {
  if (Option.isNone(expected)) return;
  const store = yield* RunStore;
  const loaded = yield* store.loadRun(runId as never);
  if (Option.isNone(loaded)) return;
  if (loaded.value.record.revision !== expected.value) {
    return yield* new StaleRevision({
      runId,
      expected: expected.value,
      actual: loaded.value.record.revision,
    });
  }
});

/**
 * One line per visible moment, printed while the run is still going.
 *
 * A stage can take twenty minutes. Without this the only output is where the
 * run stopped, and the person who started it cannot tell a long build from a
 * hung one.
 */
export function formatProgress(event: RunProgress): string {
  switch (event.kind) {
    case "stage-started":
      return `  ${event.stageId}: ${event.correcting ? "correcting" : "started"} (attempt ${String(event.attempt)})`;
    case "gates": {
      const verdicts = event.verdicts
        .map((verdict) => `${verdict.gateId} ${verdict.outcome}`)
        .join(", ");
      // A failing gate's first line of detail is what makes the verdict
      // actionable; the rest of it is already in the evidence log.
      const detail = event.verdicts
        .filter((verdict) => verdict.outcome !== "passed" && verdict.outcome !== "waived")
        .map((verdict) => `\n    ${verdict.gateId}: ${verdict.summary.split("\n")[0] ?? ""}`)
        .join("");
      return `  ${event.stageId}: gates ${verdicts || "none"}${detail}`;
    }
    case "stage-settled":
      return `  ${event.stageId}: ${event.state}`;
  }
}

const printProgress = (event: RunProgress) => Console.log(formatProgress(event));

const reportResult = Effect.fnUntraced(function* (runId: string, stopped: string) {
  const detail = yield* describeRun(runId as never);
  if (Option.isNone(detail)) {
    yield* Console.log(`${runId}: ${stopped}`);
    return;
  }
  yield* Console.log(`${runId} ${detail.value.state} (${stopped})`);
  if (detail.value.pullRequest !== null) {
    yield* Console.log(
      `  pull request: #${String(detail.value.pullRequest.number)} ${detail.value.pullRequest.url}`,
    );
  }
  if (detail.value.stage !== null) yield* Console.log(`  stage: ${detail.value.stage}`);
  if (detail.value.attention !== null) yield* Console.log(`  needs you: ${detail.value.attention}`);
  for (const limitation of detail.value.limitations) {
    yield* Console.log(`  limitation at ${limitation.stageId}: ${limitation.detail}`);
  }
});

/** A story id safe to use as a branch name, a directory name and a run id. */
export function slugify(story: string): string {
  return story
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const runCommand = Command.make(
  "run",
  {
    playbook: playbookArgument,
    profile: profileFlag,
    input: inputFlag,
    owner: ownerFlag,
    base: Flag.String("base").pipe(
      Flag.withDescription("Revision the run's worktree branches from."),
      Flag.withDefault("HEAD"),
    ),
    story: Flag.String("story").pipe(
      Flag.withDescription(
        "The story this run delivers, e.g. issue-42. Defaults to the `issue` input. The run id is this plus its ordinal.",
      ),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ playbook, profile: profileName, input, owner, base, story }) {
    const profile = yield* loadProfile(profileName);
    const playbookDir = yield* playbookDirFor(playbook, profile);

    const inputs = input as Readonly<Record<string, string>>;
    const named = Option.getOrElse(story, () => inputs.issue ?? "");
    if (named.trim().length === 0) {
      yield* Console.error(
        "This run needs a story: pass --story, or an --input issue=<id> for the playbook to consume.",
      );
      return;
    }

    // A story that turns out to need a second pull request gets a second run,
    // so the id carries the ordinal and the two sort together.
    const runId = yield* nextRunId(slugify(named));

    const started = yield* startRun({
      runId,
      story: slugify(named),
      profile,
      playbookDir,
      inputs,
      baseRef: base,
      owner,
      progress: printProgress,
    });

    yield* reportResult(runId as string, started.result.stopped);
  }),
).pipe(Command.withDescription("Compile a playbook and drive a run until it needs you."));

const statusCommand = Command.make(
  "status",
  {
    run: Argument.String("run").pipe(Argument.optional),
    state: Flag.String("state").pipe(
      Flag.withDescription("Only runs in this state."),
      Flag.optional,
    ),
    pr: Flag.Int("pr").pipe(
      Flag.withDescription("Show the run that owns this pull request number."),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ run, state, pr }) {
    if (Option.isSome(pr)) {
      const store = yield* RunStore;
      const found = yield* store.findRunByPullRequest(pr.value);
      if (Option.isNone(found)) {
        yield* Console.error(`No run owns pull request #${String(pr.value)}.`);
        return;
      }
      const detail = yield* describeRun(found.value.record.runId);
      if (Option.isSome(detail)) yield* Console.log(prettyJson(detail.value));
      return;
    }

    if (Option.isSome(run)) {
      const detail = yield* describeRun(run.value as never);
      if (Option.isNone(detail)) {
        yield* Console.error(`No run ${run.value}.`);
        return;
      }
      yield* Console.log(prettyJson(detail.value));
      return;
    }

    const summaries = yield* summarizeRuns(Option.getOrUndefined(state));
    if (summaries.length === 0) {
      yield* Console.log("No runs.");
      return;
    }
    for (const summary of summaries) {
      const attention = summary.attention === null ? "" : `  ${summary.attention}`;
      // Every run shows its pull request, including the runs that have none:
      // "no pull request" is a fact about the run, not a blank.
      const pullRequest =
        summary.pullRequest === null ? "no PR" : `#${String(summary.pullRequest.number)}`;
      yield* Console.log(
        `${summary.state.padEnd(16)} ${summary.runId.padEnd(28)} ${pullRequest.padEnd(8)} ${summary.stage ?? "-"}${attention}`,
      );
    }
  }),
).pipe(Command.withDescription("List runs, or show one in full."));

const resumeCommand = Command.make(
  "resume",
  { run: runIdArgument, profile: profileFlag, owner: ownerFlag, revision: revisionFlag },
  Effect.fnUntraced(function* ({ run, profile: profileName, owner, revision }) {
    yield* assertRevision(run, revision);
    const profile = yield* loadProfile(profileName);
    const result = yield* resumeRun({
      runId: run as never,
      profile,
      owner,
      inputs: [{ type: "resume" }],
      progress: printProgress,
    });
    yield* reportResult(run, result.stopped);
  }),
).pipe(Command.withDescription("Pick a paused run back up."));

const pauseCommand = Command.make(
  "pause",
  { run: runIdArgument, profile: profileFlag, owner: ownerFlag, revision: revisionFlag },
  Effect.fnUntraced(function* ({ run, profile: profileName, owner, revision }) {
    yield* assertRevision(run, revision);
    const profile = yield* loadProfile(profileName);
    const result = yield* resumeRun({
      runId: run as never,
      profile,
      owner,
      inputs: [{ type: "pause" }],
    });
    yield* reportResult(run, result.stopped);
  }),
).pipe(Command.withDescription("Stop driving a run without losing its state."));

const cancelCommand = Command.make(
  "cancel",
  {
    run: runIdArgument,
    profile: profileFlag,
    owner: ownerFlag,
    revision: revisionFlag,
    reason: Flag.String("reason").pipe(Flag.withDefault("cancelled from the command line")),
  },
  Effect.fnUntraced(function* ({ run, profile: profileName, owner, revision, reason }) {
    yield* assertRevision(run, revision);
    const profile = yield* loadProfile(profileName);
    const result = yield* resumeRun({
      runId: run as never,
      profile,
      owner,
      inputs: [{ type: "cancel", reason }],
    });
    yield* reportResult(run, result.stopped);
  }),
).pipe(Command.withDescription("Cancel a run, interrupting whatever it is doing."));

const decideCommand = Command.make(
  "decide",
  {
    run: runIdArgument,
    answer: Argument.String("answer").pipe(Argument.withDescription("proceed | waive | abort")),
    profile: profileFlag,
    owner: ownerFlag,
    revision: revisionFlag,
  },
  Effect.fnUntraced(function* ({ run, answer, profile: profileName, owner, revision }) {
    yield* assertRevision(run, revision);
    if (answer !== "proceed" && answer !== "waive" && answer !== "abort") {
      yield* Console.error("The answer must be proceed, waive or abort.");
      return;
    }

    const store = yield* RunStore;
    const loaded = yield* store.loadRun(run as never);
    if (Option.isNone(loaded) || loaded.value.record.decision === null) {
      yield* Console.error(`Run ${run} is not waiting on a decision.`);
      return;
    }

    const profile = yield* loadProfile(profileName);
    const result = yield* resumeRun({
      runId: run as never,
      profile,
      owner,
      progress: printProgress,
      inputs: [
        {
          type: "decision-answered",
          decisionId: loaded.value.record.decision.decisionId,
          answer,
          // The decision is answered against the plan it was raised on; a run
          // that has been replanned since will refuse it.
          planDigest: loaded.value.record.planDigest,
        },
      ],
    });
    yield* reportResult(run, result.stopped);
  }),
).pipe(Command.withDescription("Answer the decision a run is waiting on."));

export const wlCommand = Command.make("wl").pipe(
  Command.withDescription("WorkflowLeaf: run playbooks as staged, gated, evidence-backed work."),
  Command.withSubcommands([
    validateCommand,
    compileCommand,
    runCommand,
    statusCommand,
    resumeCommand,
    pauseCommand,
    cancelCommand,
    decideCommand,
    skillsCommand,
    profileCommand,
  ]),
);
