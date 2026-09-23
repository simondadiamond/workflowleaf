/**
 * Execution profiles.
 *
 * A playbook says what must happen. A profile says where and with what: which
 * executor, which repository, which skill roots, which budgets, which external
 * effects are permitted. Profiles are local and untracked, because they point
 * at private checkouts and name the environment variables holding credentials.
 *
 * Secrets are referenced, never stored. A profile names an environment
 * variable; it never contains a token, and neither the run plan nor any prompt
 * ever sees one.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { DEFAULT_REVIEWER, type ReviewerConfig } from "./reviewer.ts";

export class ProfileError extends Schema.TaggedError<ProfileError>()("WlProfileError", {
  message: Schema.String,
}) {}

const T3ExecutorConfig = Schema.Struct({
  kind: Schema.Literal("t3"),
  /** Origin of the T3 server this profile drives, e.g. `http://127.0.0.1:5173`. */
  origin: Schema.String.check(Schema.isNonEmpty()),
  /** Name of the environment variable holding the bearer token. Never the token. */
  tokenEnv: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /**
   * Absolute path of a file holding the bearer token, used when `tokenEnv` is
   * absent or unset. Keeps a run startable without exporting anything first.
   * The path is in the profile; the token never is.
   */
  tokenFile: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  projectId: Schema.String.check(Schema.isNonEmpty()),
  provider: Schema.String.check(Schema.isNonEmpty()),
  model: Schema.NullOr(Schema.String),
  /**
   * T3's runtime mode for every stage thread. `approval-required` makes the
   * provider ask before acting; answer with `wl requests` and `wl answer`, or
   * in T3 itself. `read-only` was accepted here once and was never a T3 mode.
   */
  runtimeMode: Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
});
export type T3ExecutorConfig = typeof T3ExecutorConfig.Type;

const FakeExecutorConfig = Schema.Struct({ kind: Schema.Literal("fake") });

const ExecutorConfig = Schema.Union([T3ExecutorConfig, FakeExecutorConfig]);
export type ExecutorConfig = typeof ExecutorConfig.Type;

/**
 * Where the run's pull request is opened. Named rather than inferred: reading
 * the repository's default branch would quietly retarget every run the day
 * someone changes it.
 */
const PullRequestConfig = Schema.Struct({
  /** Remote the run's branch is pushed to. */
  remote: Schema.String.check(Schema.isNonEmpty()),
  /** Branch the pull request is opened against. */
  baseBranch: Schema.String.check(Schema.isNonEmpty()),
  /**
   * How long `converged-on-head` waits for a review on a ready pull request
   * before converging without one. Absent means it waits for a review, which is
   * right for a repository with review bots and wrong for one without.
   */
  reviewWaitMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type PullRequestConfig = typeof PullRequestConfig.Type;

/**
 * Who judges review gates. Any command that reads a prompt on stdin and prints
 * a verdict works; `${schema}` and `${schemaFile}` in `args` are replaced with
 * the verdict schema. Absent means a fresh `claude -p` with read-only tools.
 */
const ReviewerConfigDocument = Schema.Struct({
  executable: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Array(Schema.String),
  timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

const ProfileDocument = Schema.Struct({
  executor: ExecutorConfig,
  /** Absolute path to the repository runs operate on. */
  repoRoot: Schema.String.check(Schema.isNonEmpty()),
  /** Where run worktrees are created. */
  worktreeRoot: Schema.optional(Schema.String),
  /**
   * A run's branch is `<branchPrefix>/<run>`. Absent means `workflowleaf`. The
   * branch name is what the repository and its pull requests show, and what
   * the repository's own hooks can match on.
   */
  branchPrefix: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /**
   * The playbook this machine runs by default, as an absolute directory.
   *
   * A playbook is portable: it is copied between repositories and shared, so it
   * cannot know where it lives. The profile is the local half of that pair and
   * is where the path belongs. `wl run <playbook>` still overrides it, because
   * one repository has more than one playbook.
   */
  defaultPlaybook: Schema.optional(Schema.String),
  /** Directories searched for skills, in order. Later roots shadow earlier ones. */
  skillRoots: Schema.Array(Schema.String),
  reviewer: Schema.optional(ReviewerConfigDocument),
  /**
   * The `gh` config directory for the profile's repository, when it is not the
   * active account's. WorkflowLeaf's own `gh` calls and command gates use it,
   * and each stage is told to. The global active account is never switched.
   */
  ghConfigDir: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  budgets: Schema.Struct({
    maxRepairCycles: Schema.Int,
    runDeadlineMs: Schema.NullOr(Schema.Int),
  }),
  /** Required when `permissions.createPullRequest` is on, ignored when it is off. */
  pullRequest: Schema.optional(PullRequestConfig),
  /**
   * What WorkflowLeaf itself may do outside the run's worktree. Nothing infers
   * these from a playbook, and each one defaults to false.
   *
   * Only effects WorkflowLeaf performs are listed. What an agent may do inside
   * its worktree is the executor's runtime mode and the provider's own
   * approvals, which `wl answer` passes through; a second permission layer
   * over the same actions would only disagree with the first. That is why the
   * Firestore flag and `deploy` are gone. Each stage is still told what these
   * permit, since an agent with `gh` can comment or merge on its own; that
   * asks and does not enforce.
   */
  permissions: Schema.Struct({
    /** Open the run's draft pull request at run start. Every later stage delivers into it. */
    createPullRequest: Schema.Boolean,
    /** Post and reply on that pull request, including resolving review threads it answered. */
    commentOnPullRequest: Schema.Boolean,
    /**
     * Mark it ready for review once the stage that produces `pull-request` has
     * passed its gates. Review bots commonly skip drafts, so a run that leaves
     * its pull request a draft is never reviewed. Absent means off.
     */
    markPullRequestReady: Schema.optional(Schema.Boolean),
    /** Merge it. Off everywhere today: merging stays a person's call. */
    merge: Schema.Boolean,
    /** Run a canary against live systems, bound to a deployed revision (#12). */
    liveCanary: Schema.Boolean,
  }),
});
export type ProfileDocument = typeof ProfileDocument.Type;

export interface Profile extends Omit<ProfileDocument, "reviewer"> {
  readonly name: string;
  readonly worktreeRoot: string;
  readonly branchPrefix: string;
  readonly reviewer: ReviewerConfig;
}

const decodeProfile = Schema.decodeUnknownResult(ProfileDocument, {
  onExcessProperty: "error",
  errors: "all",
});

const decodeJsonValue = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/**
 * Profiles written before a permission was retired still load. The key is
 * dropped rather than rejected because it never granted anything, and a
 * profile in use by a running run should not stop loading over it.
 */
const RETIRED_PERMISSIONS = ["deploy"];

function withoutRetiredKeys(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const permissions = (raw as { permissions?: unknown }).permissions;
  if (typeof permissions !== "object" || permissions === null) return raw;
  const kept = Object.fromEntries(
    Object.entries(permissions).filter(([key]) => !RETIRED_PERMISSIONS.includes(key)),
  );
  return { ...raw, permissions: kept };
}

/** `$WORKFLOWLEAF_HOME`, else `~/.workflowleaf`. Never the live T3 data directory. */
export const workflowleafHome = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.String("WORKFLOWLEAF_HOME").pipe(
    Config.option,
    Config.map(Option.getOrElse(() => "")),
  );
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

  return configured.length > 0 ? configured : path.join(home, ".workflowleaf");
});

export const profilePath = Effect.fnUntraced(function* (name: string) {
  const path = yield* Path.Path;
  return path.join(yield* workflowleafHome(), "profiles", `${name}.json`);
});

export const loadProfile = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* profilePath(name);

  if (!(yield* fs.exists(file))) {
    return yield* new ProfileError({
      message: `No profile named ${name}. Create ${file}, or run \`wl profile init ${name}\` for a template.`,
    });
  }

  const parsed = decodeJsonValue(yield* fs.readFileString(file));
  if (parsed._tag === "Failure") {
    return yield* new ProfileError({
      message: `${file} is not valid JSON: ${parsed.failure.message}`,
    });
  }
  const raw = parsed.success;

  if (typeof raw === "object" && raw !== null && "executor" in raw) {
    const executor = (raw as { executor: unknown }).executor;
    if (typeof executor === "object" && executor !== null && "token" in executor) {
      return yield* new ProfileError({
        message: `${file}: executor.token is not allowed. Name the environment variable in executor.tokenEnv and keep the secret out of the file.`,
      });
    }
  }

  const decoded = decodeProfile(withoutRetiredKeys(raw));
  if (decoded._tag === "Failure") {
    return yield* new ProfileError({ message: `${file}: ${decoded.failure.message}` });
  }

  const document = decoded.success;
  if (document.permissions.createPullRequest && document.pullRequest === undefined) {
    return yield* new ProfileError({
      message: `${file}: permissions.createPullRequest is on, so pullRequest.remote and pullRequest.baseBranch have to say where the run's pull request goes.`,
    });
  }

  return {
    ...document,
    name,
    reviewer: document.reviewer ?? DEFAULT_REVIEWER,
    branchPrefix: document.branchPrefix ?? "workflowleaf",
    worktreeRoot:
      document.worktreeRoot !== undefined && document.worktreeRoot.length > 0
        ? document.worktreeRoot
        : path.join(yield* workflowleafHome(), "worktrees"),
  } satisfies Profile;
});

/**
 * Resolves the bearer token: the environment variable the profile names, if it
 * is set, else the file the profile names.
 */
export const executorToken = Effect.fnUntraced(function* (executor: T3ExecutorConfig) {
  if (executor.tokenEnv !== undefined) {
    const token = yield* Config.Redacted(executor.tokenEnv).pipe(Config.option);
    if (Option.isSome(token) && Redacted.value(token.value).length > 0) return token.value;
  }

  if (executor.tokenFile !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(executor.tokenFile)
      .pipe(Effect.catchCause(() => Effect.succeed("")));
    if (text.trim().length > 0) return Redacted.make(text.trim());
  }

  const sources = [
    ...(executor.tokenEnv === undefined ? [] : [`$${executor.tokenEnv}`]),
    ...(executor.tokenFile === undefined ? [] : [executor.tokenFile]),
  ];
  return yield* new ProfileError({
    message:
      sources.length === 0
        ? "The profile names no source for the T3 bearer token. Set executor.tokenEnv or executor.tokenFile."
        : `No T3 bearer token in ${sources.join(" or ")}.`,
  });
});

export const PROFILE_TEMPLATE = {
  executor: {
    kind: "t3",
    origin: "http://127.0.0.1:5173",
    tokenFile: "<absolute path to a file holding the bearer token, mode 0600>",
    projectId: "<project id>",
    provider: "claude",
    model: null,
    runtimeMode: "full-access",
  },
  repoRoot: "<absolute path to the repository runs operate on>",
  defaultPlaybook: "<absolute path to a playbook directory, or omit to pass one per run>",
  skillRoots: ["<absolute path to a directory of skills>"],
  budgets: { maxRepairCycles: 2, runDeadlineMs: null },
  pullRequest: { remote: "origin", baseBranch: "main" },
  permissions: {
    createPullRequest: false,
    commentOnPullRequest: false,
    markPullRequestReady: false,
    merge: false,
    liveCanary: false,
  },
};
