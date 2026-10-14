#!/usr/bin/env bun
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { runCli } from "./cli/entry"

NodeRuntime.runMain(runCli())
