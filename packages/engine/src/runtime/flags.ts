import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["PHINS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["PHINS_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("PHINS_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  PHINS_AUTO_HEAP_SNAPSHOT: truthy("PHINS_AUTO_HEAP_SNAPSHOT"),
  PHINS_GIT_BASH_PATH: process.env["PHINS_GIT_BASH_PATH"],
  PHINS_CONFIG: process.env["PHINS_CONFIG"],
  PHINS_CONFIG_CONTENT: process.env["PHINS_CONFIG_CONTENT"],
  PHINS_DISABLE_AUTOUPDATE: truthy("PHINS_DISABLE_AUTOUPDATE"),
  PHINS_ALWAYS_NOTIFY_UPDATE: truthy("PHINS_ALWAYS_NOTIFY_UPDATE"),
  PHINS_DISABLE_PRUNE: truthy("PHINS_DISABLE_PRUNE"),
  PHINS_DISABLE_TERMINAL_TITLE: truthy("PHINS_DISABLE_TERMINAL_TITLE"),
  PHINS_SHOW_TTFD: truthy("PHINS_SHOW_TTFD"),
  PHINS_DISABLE_AUTOCOMPACT: truthy("PHINS_DISABLE_AUTOCOMPACT"),
  PHINS_DISABLE_MODELS_FETCH: truthy("PHINS_DISABLE_MODELS_FETCH"),
  PHINS_DISABLE_MOUSE: truthy("PHINS_DISABLE_MOUSE"),
  PHINS_FAKE_VCS: process.env["PHINS_FAKE_VCS"],
  PHINS_SERVER_PASSWORD: process.env["PHINS_SERVER_PASSWORD"],
  PHINS_SERVER_USERNAME: process.env["PHINS_SERVER_USERNAME"],
  PHINS_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("PHINS_DISABLE_FFF"),

  // Experimental
  PHINS_EXPERIMENTAL_FILEWATCHER: Config.boolean("PHINS_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  PHINS_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("PHINS_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  PHINS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("PHINS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  PHINS_MODELS_URL: process.env["PHINS_MODELS_URL"],
  PHINS_MODELS_PATH: process.env["PHINS_MODELS_PATH"],
  PHINS_DB: process.env["PHINS_DB"],

  PHINS_WORKSPACE_ID: process.env["PHINS_WORKSPACE_ID"],
  PHINS_EXPERIMENTAL_WORKSPACES: enabledByExperimental("PHINS_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get PHINS_DISABLE_PROJECT_CONFIG() {
    return truthy("PHINS_DISABLE_PROJECT_CONFIG")
  },
  get PHINS_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("PHINS_EXPERIMENTAL_REFERENCES")
  },
  get PHINS_TUI_CONFIG() {
    return process.env["PHINS_TUI_CONFIG"]
  },
  get PHINS_CONFIG_DIR() {
    return process.env["PHINS_CONFIG_DIR"]
  },
  get PHINS_PURE() {
    return truthy("PHINS_PURE")
  },
  get PHINS_PERMISSION() {
    return process.env["PHINS_PERMISSION"]
  },
  get PHINS_PLUGIN_META_FILE() {
    return process.env["PHINS_PLUGIN_META_FILE"]
  },
  get PHINS_CLIENT() {
    return process.env["PHINS_CLIENT"] ?? "cli"
  },
}
