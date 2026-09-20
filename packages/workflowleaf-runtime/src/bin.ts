#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { wlCommand } from "./cli.ts";
import { RunStore } from "./store/RunStore.ts";
import { layerDefault } from "./store/Sqlite.ts";

const services = RunStore.layer.pipe(
  Layer.provide(layerDefault),
  Layer.provideMerge(NodeServices.layer),
);

Command.run(wlCommand, { version: "0.1.0" }).pipe(Effect.provide(services), NodeRuntime.runMain);
