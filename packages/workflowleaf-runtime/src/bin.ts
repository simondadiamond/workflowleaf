#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { wlCommand } from "./cli.ts";

Command.run(wlCommand, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
