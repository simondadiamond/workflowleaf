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

export class ProfileError extends Schema.TaggedError<ProfileError>()("WlProfileError", {
  message: Schema.String,
}) {}

const T3ExecutorConfig = Schema.Struct({
  kind: Schema.Literal("t3"),
  /** Origin of the T3 server this profile drives, e.g. `http://127.0.0.1:5173`. */
  origin: Schema.String.check(Schema.isNonEmpty()),
  /** Name of the environment variable holding the bearer token. Never the token. */
  tokenEnv: Schema.String.check(Schema.isNonEmpty()),
  projectId: Schema.String.check(Schema.isNonEmpty()),
  provider: Schema.String.check(Schema.isNonEmpty()),
  model: Schema.NullOr(Schema.String),
  runtimeMode: Schema.Literals(["full-access", "read-only"]),
});
export type T3ExecutorConfig = typeof T3ExecutorConfig.Type;

const FakeExecutorConfig = Schema.Struct({ kind: Schema.Literal("fake") });

const ExecutorConfig = Schema.Union([T3ExecutorConfig, FakeExecutorConfig]);
export type ExecutorConfig = typeof ExecutorConfig.Type;

const ProfileDocument = Schema.Struct({
  executor: ExecutorConfig,
  /** Absolute path to the repository runs operate on. */
  repoRoot: Schema.String.check(Schema.isNonEmpty()),
  /** Where run worktrees are created. */
  worktreeRoot: Schema.optional(Schema.String),
  /** Directories searched for skills, in order. Later roots shadow earlier ones. */
  skillRoots: Schema.Array(Schema.String),
  budgets: Schema.Struct({
    maxRepairCycles: Schema.Int,
    runDeadlineMs: Schema.NullOr(Schema.Int),
  }),
  /**
   * Whether this profile may perform external effects. Nothing infers these
   * from a playbook; an unlisted effect stays unavailable with a diagnostic.
   */
  permissions: Schema.Struct({
    createPullRequest: Schema.Boolean,
    commentOnPullRequest: Schema.Boolean,
    merge: Schema.Boolean,
    deploy: Schema.Boolean,
    liveCanary: Schema.Boolean,
  }),
});
export type ProfileDocument = typeof ProfileDocument.Type;

export interface Profile extends ProfileDocument {
  readonly name: string;
  readonly worktreeRoot: string;
}

const decodeProfile = Schema.decodeUnknownResult(ProfileDocument, {
  onExcessProperty: "error",
  errors: "all",
});

const decodeJsonValue = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

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

  const decoded = decodeProfile(raw);
  if (decoded._tag === "Failure") {
    return yield* new ProfileError({ message: `${file}: ${decoded.failure.message}` });
  }

  const document = decoded.success;
  return {
    ...document,
    name,
    worktreeRoot:
      document.worktreeRoot !== undefined && document.worktreeRoot.length > 0
        ? document.worktreeRoot
        : path.join(yield* workflowleafHome(), "worktrees"),
  } satisfies Profile;
});

/** Resolves the bearer token from the environment variable the profile names. */
export const executorToken = Effect.fnUntraced(function* (executor: T3ExecutorConfig) {
  const token = yield* Config.Redacted(executor.tokenEnv).pipe(Config.option);
  if (Option.isNone(token) || Redacted.value(token.value).length === 0) {
    return yield* new ProfileError({
      message: `${executor.tokenEnv} is not set. The profile names it as the source of the T3 bearer token.`,
    });
  }
  return token.value;
});

export const PROFILE_TEMPLATE = {
  executor: {
    kind: "t3",
    origin: "http://127.0.0.1:5173",
    tokenEnv: "WORKFLOWLEAF_T3_TOKEN",
    projectId: "<project id>",
    provider: "claude",
    model: null,
    runtimeMode: "full-access",
  },
  repoRoot: "<absolute path to the repository runs operate on>",
  skillRoots: ["<absolute path to a directory of skills>"],
  budgets: { maxRepairCycles: 2, runDeadlineMs: null },
  permissions: {
    createPullRequest: false,
    commentOnPullRequest: false,
    merge: false,
    deploy: false,
    liveCanary: false,
  },
};
