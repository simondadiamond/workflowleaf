// @effect-diagnostics preferSchemaOverJson:off
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { otlpHeaders, otlpProtocol } from "./otlpConfig.ts";

const read = (env: Record<string, string>) =>
  Config.all({ otlpHeaders, otlpProtocol }).parse(ConfigProvider.fromEnv({ env }));

it.effect("keeps unauthenticated JSON export as the default", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* read({}), { otlpHeaders: undefined, otlpProtocol: "http/json" });
  }),
);

it.effect("decodes exporter headers and keeps their values redacted", () =>
  Effect.gen(function* () {
    const config = yield* read({
      T3CODE_OTLP_PROTOCOL: "http/protobuf",
      T3CODE_OTLP_HEADERS: "Authorization=Bearer%20secret%3Dvalue%2Cpart,x-project=demo",
    });
    assert.equal(config.otlpProtocol, "http/protobuf");
    assert.deepStrictEqual(Redacted.value(config.otlpHeaders!), {
      Authorization: "Bearer secret=value,part",
      "x-project": "demo",
    });
    assert.notInclude(JSON.stringify(config), "secret");
  }),
);

for (const headers of [
  "Authorization=secret%ZZ",
  "Authorization=secret%0D%0Ainjected",
  "bad header=secret",
]) {
  it.effect(
    "rejects invalid headers without exposing their contents: " + headers.split("=")[0],
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(read({ T3CODE_OTLP_HEADERS: headers }));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.include(Cause.pretty(exit.cause), "Invalid T3CODE_OTLP_HEADERS");
          assert.notInclude(Cause.pretty(exit.cause), "secret");
        }
      }),
  );
}

it.effect("rejects unsupported protocols", () =>
  Effect.gen(function* () {
    assert.isTrue(Exit.isFailure(yield* Effect.exit(read({ T3CODE_OTLP_PROTOCOL: "grpc" }))));
  }),
);
