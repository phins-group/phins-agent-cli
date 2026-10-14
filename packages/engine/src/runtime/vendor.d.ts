declare module "@parcel/watcher/wrapper" {
  import type * as ParcelWatcher from "@parcel/watcher"

  export function createWrapper(binding: unknown): typeof ParcelWatcher
}

declare module "@npmcli/config" {
  export default class Config {
    constructor(options: Record<string, unknown>)
    load(): Promise<void>
    flat: Record<string, unknown>
  }
}

declare module "@npmcli/config/lib/definitions/index.js" {
  export const definitions: unknown
  export const flatten: unknown
  export const nerfDarts: unknown
  export const shorthands: unknown
}

declare module "*.wasm" {
  const path: string
  export default path
}
