/**
 * Boot registry cho toàn bộ internal Core V2 plugins.
 *
 * Mỗi plugin được gắn đúng location services; registration chạy tuần tự trước
 * khi graph sẵn sàng để consumer không đọc catalog/agent/skill chưa khởi tạo.
 * @module
 */
export * as ExtensionLoader from "./internal"

import type { PluginContext } from "./api"
import type { Plugin } from "./definition"
export { define, type Plugin } from "./definition"
import { Effect, Layer } from "effect"
import { AgentRegistry } from "../agents/registry"
import { Catalog } from "../inference/catalog/registry"
import { CommandRegistry } from "../agents/commands"
import { Config } from "../settings/config"
import { ConfigAgentPlugin } from "../settings/plugins/agent"
import { ConfigCommandPlugin } from "../settings/plugins/command"
import { ConfigProviderPlugin } from "../settings/plugins/provider"
import { ConfigReferencePlugin } from "../settings/plugins/reference"
import { ConfigSkillPlugin } from "../settings/plugins/skill"
import { EventBus } from "../runtime/events/bus"
import { FileSystem } from "../workspace/files/service"
import { FileAccess } from "../workspace/files/access"
import { AppPaths } from "../runtime/paths"
import { Integration } from "./integrations/service"
import { Location } from "../workspace/location"
import { ModelMetadata } from "../inference/catalog/metadata"

import { ExtensionService } from "./service"
import { Reference } from "../agents/references/registry"
import { SkillRegistry } from "../agents/skills/registry"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AgentPlugin } from "./agents"
import { ModelsDevPlugin } from "./models-dev"

import { SkillPlugin } from "./skills"

export type Requirements =
  | AgentRegistry.Service
  | Catalog.Service
  | CommandRegistry.Service
  | Config.Service
  | EventBus.Service
  | FileSystem.Service
  | FileAccess.Service
  | AppPaths.Service
  | HttpClient.HttpClient
  | Integration.Service
  | Location.Service
  | ModelMetadata.Service
  | Reference.Service
  | SkillRegistry.Service

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const commands = yield* CommandRegistry.Service
    const plugin = yield* ExtensionService.Service
    const integration = yield* Integration.Service
    const agents = yield* AgentRegistry.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelMetadata.Service
    const events = yield* EventBus.Service
    const fs = yield* FileAccess.Service
    const filesystem = yield* FileSystem.Service
    const global = yield* AppPaths.Service
    const http = yield* HttpClient.HttpClient
    const skill = yield* SkillRegistry.Service
    const reference = yield* Reference.Service
    /** Đóng service graph hiện tại vào effect contribution trước khi đăng ký. */
    const add = <R>(input: Plugin<R>) => {
      const loaded = {
        id: input.id,
        effect: (context: PluginContext) =>
          input
            .effect(context)
            .pipe(
              Effect.provideService(Catalog.Service, catalog),
              Effect.provideService(CommandRegistry.Service, commands),
              Effect.provideService(Integration.Service, integration),
              Effect.provideService(AgentRegistry.Service, agents),
              Effect.provideService(Config.Service, config),
              Effect.provideService(Location.Service, location),
              Effect.provideService(ModelMetadata.Service, modelsDev),
              Effect.provideService(EventBus.Service, events),
              Effect.provideService(FileAccess.Service, fs),
              Effect.provideService(FileSystem.Service, filesystem),
              Effect.provideService(AppPaths.Service, global),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(SkillRegistry.Service, skill),
              Effect.provideService(Reference.Service, reference),
            ),
      }
      return plugin.add(ExtensionService.ID.make(loaded.id), loaded.effect)
    }

    // Thứ tự boot plugin là một phần của hợp đồng ưu tiên; không chạy song song.
    yield* Effect.gen(function* () {
      yield* add(ConfigReferencePlugin.Plugin)
      yield* add(AgentPlugin.Plugin)
      yield* add(SkillPlugin.Plugin)
      yield* add(ModelsDevPlugin)
      yield* add(ConfigAgentPlugin.Plugin)
      yield* add(ConfigCommandPlugin.Plugin)
      yield* add(ConfigSkillPlugin.Plugin)
      yield* add(ConfigProviderPlugin.Plugin)
    }).pipe(Effect.withSpan("PluginInternal.boot"))
  }),
).pipe(
  Layer.provideMerge(ExtensionService.locationLayer),
  Layer.provideMerge(Config.locationLayer),
  Layer.provideMerge(FileSystem.locationLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)
