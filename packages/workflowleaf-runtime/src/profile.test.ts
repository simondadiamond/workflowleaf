import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";

import { executorToken, type T3ExecutorConfig } from "./profile.ts";

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
