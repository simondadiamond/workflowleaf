import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const Header = Schema.Tuple([
  Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)),
  Schema.StringFromUriComponent.pipe(Schema.check(Schema.isPattern(/^[\t\x20-\x7e\x80-\xff]*$/))),
]);

const decodeHeaders = Schema.decodeUnknownEffect(Schema.Array(Header));

export const otlpHeaders = Config.redacted("T3CODE_OTLP_HEADERS").pipe(
  Config.mapOrFail((value) =>
    decodeHeaders(
      Redacted.value(value).trim() === ""
        ? []
        : Redacted.value(value)
            .split(",")
            .map((entry) => {
              const separator = entry.indexOf("=");
              return separator < 0
                ? [entry.trim()]
                : [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
            }),
    ).pipe(
      Effect.map((entries) => Redacted.make(Object.fromEntries(entries))),
      Effect.mapError(
        () =>
          new Config.ConfigError(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue({
                message:
                  "Invalid T3CODE_OTLP_HEADERS. Use comma-separated name=URL-encoded-value pairs.",
              }),
            ),
          ),
      ),
    ),
  ),
  Config.option,
  Config.map(Option.getOrUndefined),
);

export const otlpProtocol = Config.literals(
  ["http/json", "http/protobuf"],
  "T3CODE_OTLP_PROTOCOL",
).pipe(Config.withDefault("http/json"));
