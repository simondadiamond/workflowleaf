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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { prettyJson } from "./canonical.ts";
import { loadPlaybook } from "./load.ts";
import { loadProfile, PROFILE_TEMPLATE, profilePath, workflowleafHome } from "./profile.ts";
import { loadSkillCatalog } from "./skillCatalog.ts";

export class PlaybookInvalid extends Schema.TaggedError<PlaybookInvalid>()("WlPlaybookInvalid", {
  report: Schema.String,
}) {}

const profileFlag = Flag.String("profile").pipe(
  Flag.withDescription("Execution profile: skill roots, target repository, executor, permissions."),
);

const inputFlag = Flag.KeyValuePair("input").pipe(
  Flag.withDescription("A run input as key=value. Repeatable."),
  Flag.withDefault({}),
);

const playbookArgument = Argument.String("playbook").pipe(
  Argument.withDescription("Directory containing PLAYBOOK.md."),
);

const loadForCli = Effect.fnUntraced(function* (
  playbook: string,
  profileName: string,
  inputs: Readonly<Record<string, string>>,
) {
  const path = yield* Path.Path;
  const profile = yield* loadProfile(profileName);
  const now = yield* DateTime.now;

  const loaded = yield* loadPlaybook({
    playbookDir: path.resolve(playbook),
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

export const wlCommand = Command.make("wl").pipe(
  Command.withDescription("WorkflowLeaf: run playbooks as staged, gated, evidence-backed work."),
  Command.withSubcommands([validateCommand, compileCommand, skillsCommand, profileCommand]),
);
