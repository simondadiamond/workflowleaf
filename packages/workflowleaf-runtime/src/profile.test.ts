import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";

import * as Path from "effect/Path";

import { canonicalJson } from "./canonical.ts";
import { executorToken, loadProfile, type T3ExecutorConfig } from "./profile.ts";

const executor = (overrides: Partial<T3ExecutorConfig>): T3ExecutorConfig => ({
  kind: "t3",
  origin: "http://127.0.0.1:1",
  projectId: "p",
  provider: "claudeAgent",
  model: null,
  runtimeMode: "full-access",
  ...overrides,
});

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)));

it.layer(NodeServices.layer)("the executor's bearer token", (it) => {
  it.effect("comes from the named environment variable when it is set", () =>
    Effect.gen(function* () {
      const token = yield* executorToken(executor({ tokenEnv: "WL_TOKEN", tokenFile: "/nope" }));
      assert.strictEqual(Redacted.value(token), "from-env");
    }).pipe(withEnv({ WL_TOKEN: "from-env" })),
  );

  it.effect("falls back to the named file, trimmed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.makeTempFileScoped();
      yield* fs.writeFileString(file, "from-file\n");
      const token = yield* executorToken(executor({ tokenEnv: "WL_TOKEN", tokenFile: file }));
      assert.strictEqual(Redacted.value(token), "from-file");
    }).pipe(Effect.scoped, withEnv({})),
  );

  it.effect("fails and names every source it tried when there is no token", () =>
    Effect.gen(function* () {
      const failure = yield* executorToken(
        executor({ tokenEnv: "WL_TOKEN", tokenFile: "/does/not/exist" }),
      ).pipe(Effect.flip);
      assert.include(failure.message, "$WL_TOKEN");
      assert.include(failure.message, "/does/not/exist");
    }).pipe(withEnv({})),
  );
});

/** Writes a profile under a fresh WorkflowLeaf home and loads it by name. */
const loadWritten = (document: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(home, "profiles"));
    yield* fs.writeFileString(
      path.join(home, "profiles", "p.json"),
      canonicalJson({
        executor: { kind: "fake" },
        repoRoot: "/repo",
        skillRoots: [],
        budgets: { maxRepairCycles: 2, runDeadlineMs: null },
        ...document,
      }),
    );
    return yield* loadProfile("p").pipe(withEnv({ WORKFLOWLEAF_HOME: home }), Effect.result);
  }).pipe(Effect.scoped);

const four = {
  createPullRequest: false,
  commentOnPullRequest: false,
  merge: false,
  liveCanary: false,
};

it.layer(NodeServices.layer)("a profile's permissions", (it) => {
  it.effect("are exactly four flags", () =>
    Effect.gen(function* () {
      const loaded = yield* loadWritten({ permissions: four });
      assert.strictEqual(loaded._tag, "Success");
      if (loaded._tag === "Success") {
        assert.deepStrictEqual(Object.keys(loaded.success.permissions).sort(), [
          "commentOnPullRequest",
          "createPullRequest",
          "liveCanary",
          "merge",
        ]);
      }
    }),
  );

  it.effect("still load from a profile written with the retired deploy flag", () =>
    Effect.gen(function* () {
      const loaded = yield* loadWritten({ permissions: { ...four, deploy: false } });
      assert.strictEqual(loaded._tag, "Success");
      if (loaded._tag === "Success") assert.notProperty(loaded.success.permissions, "deploy");
    }),
  );

  it.effect("reject a flag that is not one of the four", () =>
    Effect.gen(function* () {
      const loaded = yield* loadWritten({ permissions: { ...four, firestore: true } });
      assert.strictEqual(loaded._tag, "Failure");
    }),
  );

  it.effect("sit beside a runtime mode T3 actually has", () =>
    Effect.gen(function* () {
      const t3 = (runtimeMode: string) => ({
        permissions: four,
        executor: { ...executor({}), tokenFile: "/token", runtimeMode },
      });
      assert.strictEqual((yield* loadWritten(t3("approval-required")))._tag, "Success");
      assert.strictEqual((yield* loadWritten(t3("read-only")))._tag, "Failure");
    }),
  );
});
