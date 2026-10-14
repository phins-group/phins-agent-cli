import type { TuiPluginApi, TuiPluginStatus, TuiSlotPlugin } from "./contracts"
import { builtinPlugins } from "./builtins"
import type { TuiPluginHost } from "./provider"

/** Built-in contributions for the local CLI/TUI. */
export function createBuiltinTuiPluginHost(): TuiPluginHost {
  const controller = new AbortController()
  const disposers = new Set<() => void | Promise<void>>()
  function track(dispose: () => void) {
    disposers.add(dispose)
    return () => { disposers.delete(dispose); dispose() }
  }
  return {
    async start({ api, config, runtime }) {
      const slots = runtime.setupSlots(api)
      disposers.add(slots.dispose)
      let nextSlot = 0
      // Keymap methods use private instance state and must stay bound to it.
      const keymap = new Proxy(api.keymap, { get(target, key) {
        if (key === "registerLayer") return (layer: Parameters<typeof target.registerLayer>[0]) => track(target.registerLayer(layer))
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      } })
      const scoped: TuiPluginApi = {
        ...api,
        lifecycle: { signal: controller.signal, onDispose(dispose) {
          disposers.add(dispose)
          return () => { disposers.delete(dispose) }
        } },
        keymap,
        slots: { register(plugin: TuiSlotPlugin) {
          const id = `builtin:${nextSlot++}`
          track(slots.register({ ...plugin, id }))
          return id
        } },
        route: { ...api.route, register: (routes) => track(api.route.register(routes)) },
        event: { ...api.event, on: (type, listener) => track(api.event.on(type, listener)) },
      }
      const status: TuiPluginStatus[] = []
      for (const plugin of builtinPlugins) {
        const enabled = config.plugin_enabled?.[plugin.id] ?? plugin.enabled ?? true
        if (enabled) {
          const now = Date.now()
          await plugin.tui(scoped, undefined, {
            id: plugin.id, source: "internal", spec: plugin.id, target: plugin.id,
            state: "same", first_time: now, last_time: now, time_changed: now,
            load_count: 1, fingerprint: plugin.id,
          })
        }
        status.push({ id: plugin.id, source: "internal", spec: plugin.id,
          target: plugin.id, enabled, active: enabled })
      }
      runtime.update({ status })
    },
    async dispose() {
      controller.abort()
      for (const dispose of [...disposers].reverse()) await dispose()
      disposers.clear()
    },
  }
}
