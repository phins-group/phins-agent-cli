import path from "path"
import fs from "fs/promises"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "../shared/flock"
import { Flag } from "./flags"
import { ServiceGraph } from "./effect/service-graph"

const app = "phins"
const home = process.env.PHINS_TEST_HOME ?? os.homedir()
const root = path.join(home, `.${app}`)
const data = path.join(root, "share")
const cache = path.join(root, "cache")
const config = path.join(root, "config")
const state = path.join(root, "state")
const tmp = path.join(os.tmpdir(), app)

export const directories = {
  get home() {
    return home
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(root, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(directories.data, { recursive: true }),
  fs.mkdir(directories.config, { recursive: true }),
  fs.mkdir(directories.state, { recursive: true }),
  fs.mkdir(directories.tmp, { recursive: true }),
  fs.mkdir(directories.log, { recursive: true }),
  fs.mkdir(directories.bin, { recursive: true }),
  fs.mkdir(directories.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@phins/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function resolvePaths(input: Partial<Interface> = {}): Interface {
  return {
    home: directories.home,
    data: directories.data,
    cache: directories.cache,
    config: Flag.PHINS_CONFIG_DIR ?? directories.config,
    state: directories.state,
    tmp: directories.tmp,
    bin: directories.bin,
    log: directories.log,
    repos: directories.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(resolvePaths())),
)

export const defaultLayer = layer
export const node = ServiceGraph.node(layer, [])

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(resolvePaths(input))),
  )

export * as AppPaths from "./paths"
