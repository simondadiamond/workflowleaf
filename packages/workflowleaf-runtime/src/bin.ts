#!/usr/bin/env node
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { wlCommand } from "./cli.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerDefault } from "./store/Sqlite.ts";

// HTTP and WebSocket are here for the T3 executor: it exchanges the profile's
// bearer token for a socket ticket, then speaks the same protocol the web
// client speaks.
const services = Layer.mergeAll(
  RunStore.layer.pipe(Layer.provide(layerDefault)),
  NodeHttpClient.layerUndici,
  NodeSocket.layerWebSocketConstructor,
).pipe(Layer.provideMerge(NodeServices.layer));

Command.run(wlCommand, { version: "0.1.0" }).pipe(
  Effect.provide(services),
  Effect.scoped,
  NodeRuntime.runMain,
);
