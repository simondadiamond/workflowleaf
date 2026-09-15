// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as ServerConfig from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import { ObservabilityLive } from "./Observability.ts";

const collector = (status = 200) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: Array<{
        url: string;
        authorization: string | undefined;
        contentType: string | undefined;
        body: Buffer;
      }> = [];
      const server = NodeHttp.createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
          url: request.url!,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks),
        });
        response.writeHead(status).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing collector port");
      return { server, requests, url: `http://127.0.0.1:${address.port}` };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );

const observability = (config: ServerConfig.ServerConfig["Service"]) =>
  ObservabilityLive.pipe(
    Layer.provide(ResourceAttribution.layer),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(FetchHttpClient.layer),
  );
const dependencies = ServerConfig.layerTest(process.cwd(), { prefix: "t3-otlp-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

for (const protocol of ["http/json", "http/protobuf"] as const) {
  it.live(`exports a server operation and metrics using authenticated ${protocol}`, () =>
    Effect.gen(function* () {
      const { requests, url } = yield* collector();
      const base = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        yield* Metric.update(Metric.counter("test.server.operations"), 1);
        yield* Effect.void.pipe(
          Effect.withSpan("test.server.operation", {
            attributes: { "orchestration.thread_id": "test-thread" },
          }),
        );
      }).pipe(
        Effect.provide(
          observability({
            ...base,
            otlpProtocol: protocol,
            otlpHeaders: Redacted.make({ Authorization: "test-token" }),
            otlpTracesUrl: `${url}/v1/traces`,
            otlpMetricsUrl: `${url}/v1/metrics`,
            otlpExportIntervalMs: 60000,
          }),
        ),
      );
      const trace = requests.find((request) => request.url === "/v1/traces");
      const metric = requests.find((request) => request.url === "/v1/metrics");
      for (const request of [trace, metric]) {
        expect(request?.authorization).toBe("test-token");
        expect(request?.contentType).toContain(
          protocol === "http/json" ? "application/json" : "application/x-protobuf",
        );
        expect(request?.body.length).toBeGreaterThan(0);
        expect(request?.body.toString()).not.toContain("test-token");
      }
      expect(trace?.body.toString()).toContain("test.server.operation");
      expect(metric?.body.toString()).toContain("test.server.operations");
    }).pipe(Effect.provide(dependencies)),
  );
}

for (const status of [401, 503]) {
  for (const interrupted of [false, true]) {
    it.live(
      `keeps local tracing and ${interrupted ? "cancellation" : "successful operations"} working when the exporter responds with ${status}`,
      () =>
        Effect.gen(function* () {
          const { url, requests } = yield* collector(status);
          const base = yield* ServerConfig.ServerConfig;
          const result = yield* Effect.exit(
            (interrupted ? Effect.interrupt : Effect.succeed("completed")).pipe(
              Effect.withSpan("test.exporter.unavailable"),
              Effect.provide(
                observability({
                  ...base,
                  otlpProtocol: "http/protobuf",
                  otlpHeaders: Redacted.make({ Authorization: "rejected-test-token" }),
                  otlpTracesUrl: `${url}/v1/traces`,
                }),
              ),
            ),
          );
          if (interrupted)
            expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
          else expect(result).toEqual(Exit.succeed("completed"));
          const fs = yield* FileSystem.FileSystem;
          const localTrace = yield* fs.readFileString(base.serverTracePath);
          expect(requests.length).toBeGreaterThan(0);
          expect(localTrace).toContain("test.exporter.unavailable");
          expect(localTrace).not.toContain("rejected-test-token");
        }).pipe(Effect.provide(dependencies)),
    );
  }
}
