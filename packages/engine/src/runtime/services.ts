/**
 * Điểm ghép gốc cho toàn bộ service Core V2 của một location.
 *
 * Luồng F1/7: `LocationServiceRegistry` cache graph theo location/TTL, dựng base
 * services trước rồi ghép resource, permission, tool, runner và background work.
 * @module
 */
import { Effect, Layer, LayerMap } from "effect"
import { Location } from "../workspace/location"
import { Policy } from "../security/policy"
import { Config } from "../settings/config"
import { Catalog } from "../inference/catalog/registry"
import { Integration } from "../extensions/integrations/service"
import { CommandRegistry } from "../agents/commands"
import { AgentRegistry } from "../agents/registry"
import { ExtensionLoader } from "../extensions/internal"
import { ProjectRegistry } from "../workspace/projects/service"
import { ProjectCopy } from "../workspace/projects/copy"
import { ProjectDirectories } from "../workspace/projects/directories"
import { EventBus } from "./events/bus"
import { Credential } from "../security/credentials"

import { ModelMetadata } from "../inference/catalog/metadata"
import { FileAccess } from "../workspace/files/access"
import { Git } from "../workspace/repository/git"
import { AppPaths } from "./paths"
import { Database } from "../storage/database"
import { PermissionPolicy } from "../security/permissions/service"

import { PermissionSaved } from "../security/permissions/saved"
import { FileSystem } from "../workspace/files/service"
import { Ripgrep } from "../workspace/search/ripgrep"
import { Watcher } from "../workspace/files/watcher"
import { LocationMutation } from "../workspace/mutations"
import { FileMutation } from "../workspace/files/mutation"
import { Formatter } from "../workspace/files/formatter"
import { Reference } from "../agents/references/registry"
import { ReferenceGuidance } from "../agents/references/guidance"
import { RepositoryCache } from "../workspace/repository/cache"
import { Pty } from "../execution/terminal/service"
import { SkillRegistry } from "../agents/skills/registry"
import { SkillGuidance } from "../agents/skills/guidance"
import { BuiltInTools } from "../tools/builtins"
import { Image } from "../workspace/media/image"
import { ToolRegistry } from "../tools/registry"
import { ApplicationTools } from "../tools/application"
import { McpLocal } from "../extensions/mcp/local"
import { ToolOutputStore } from "../tools/output-store"
import { ProcessRunner } from "../execution/process/runner"
import { SessionStore } from "../sessions/store"
import { SessionTodo } from "../sessions/tasks"
import { UserQuestions } from "../agents/questions"
import { LLMClient } from "../inference/api"
import { RequestExecutor } from "../inference/request/api"
import * as SessionRunnerLLM from "../sessions/run/inference"
import { SessionRunnerModel } from "../sessions/run/model"
import { SessionOperations } from "../sessions/actions/operations"
import { SystemContextBuiltIns } from "../agents/context/builtins"
import { FetchHttpClient } from "effect/unstable/http"
import { Snapshot } from "../workspace/repository/snapshot"
import { VerificationSettlementPublisher } from "./events/verification-publisher"
import { VerifierAuthority } from "../verification/authority"
import { VerifierOciContainment } from "../verification/oci/containment"
import { VerifierOciRuntime } from "../verification/oci/runtime"
import { VerifierOciSupervisor } from "../verification/oci/supervisor"
import { ServiceGraph } from "./effect/service-graph"

const locationDependencies = [
  ProjectRegistry.defaultLayer,
  VerifierAuthority.defaultLayer,
  VerifierOciRuntime.defaultLayer,
  VerifierOciSupervisor.defaultLayer,
  Credential.defaultLayer,
  ModelMetadata.defaultLayer,
  FileAccess.defaultLayer,
  Git.defaultLayer,
  ProcessRunner.defaultLayer,
  AppPaths.defaultLayer,
  Ripgrep.defaultLayer,
  Database.defaultLayer,
  ProjectDirectories.defaultLayer,
  SessionStore.layer.pipe(Layer.provide(Database.defaultLayer)),
  PermissionSaved.defaultLayer,
  RepositoryCache.defaultLayer,
  LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" }),
    ),
  ),
  ToolOutputStore.defaultCleanupLayer,
  ApplicationTools.layer,
] as const

export class LocationServiceRegistry extends LayerMap.Service<LocationServiceRegistry>()(
  "@phins/example/LocationServiceMap",
  {
    lookup: (ref: Location.Ref) => {
      // F1.1: service graph luôn bắt đầu bằng identity layer của đúng location.
      const boot = Layer.effectDiscard(
        ref.scope === "chat-v1"
          ? Effect.die(new Error("Chat hosting is not included in the local edition"))
          : Effect.logInfo("booting location services", {
          directory: ref.directory,
          workspaceID: ref.workspaceID,
        }),
      )
      const location = Location.layer(ref)
      const systemContext = SystemContextBuiltIns.locationLayer
      const base = Layer.mergeAll(
        location,
        Policy.locationLayer,
        Config.locationLayer,
        Reference.locationLayer,
        Catalog.locationLayer,
        Integration.locationLayer,
        CommandRegistry.locationLayer,
        AgentRegistry.locationLayer,
        ProjectCopy.locationLayer,
        FileSystem.locationLayer,
        Watcher.locationLayer,
        Pty.locationLayer,
        SkillRegistry.locationLayer,
        systemContext,
        LocationMutation.locationLayer.pipe(Layer.orDie),
      ).pipe(Layer.provideMerge(location))
      // F1.2: output store có trước tool registry để settlement có chỗ offload.
      const resources = ToolOutputStore.layer.pipe(Layer.provide(base))
      const permissionsAndTools = ToolRegistry.layer.pipe(
        Layer.provideMerge(PermissionPolicy.locationLayer),
        Layer.provide(resources),
        Layer.provide(base),
      )
      // Plugin tool producers need the same Location registry and permission leaf.
      
      const beforePlugins = Layer.mergeAll(
        base,
        resources,
        permissionsAndTools,
      )
      const formatter = Formatter.layer.pipe(Layer.provide(beforePlugins))
      const image = Image.layer.pipe(Layer.provide(beforePlugins))
      const mutation = FileMutation.locationLayer.pipe(
        Layer.provide(beforePlugins),
      )
      const todos = SessionTodo.layer.pipe(Layer.provide(beforePlugins))
      const questions = UserQuestions.locationLayer.pipe(
        Layer.provide(beforePlugins),
      )
      const builtInTools = BuiltInTools.locationLayer.pipe(
        Layer.provide(formatter),
        Layer.provide(beforePlugins),
        Layer.provide(mutation),
        Layer.provide(resources),
        Layer.provide(todos),
        Layer.provide(questions),
        Layer.provide(image),
      )
      // Configured contributions come after built-ins and before any consumer.
      const plugins = ExtensionLoader.locationLayer.pipe(
        Layer.provide(beforePlugins),
        Layer.provide(builtInTools),
      )
      const services = Layer.mergeAll(beforePlugins, plugins)
      const skillGuidance = SkillGuidance.locationLayer.pipe(
        Layer.provide(services),
      )
      const referenceGuidance = ReferenceGuidance.locationLayer.pipe(
        Layer.provide(services),
      )
      const model = SessionRunnerModel.locationLayer.pipe(
        Layer.provide(services),
      )
      const mcp = McpLocal.layer.pipe(Layer.provide(services))
      const snapshot = Snapshot.locationLayer.pipe(Layer.provide(services))
      const verifierContainment = VerifierOciContainment.layer.pipe(
        Layer.provide(snapshot),
      )
      const operations = SessionOperations.layer.pipe(
        Layer.provide(services),
        Layer.provide(model),
      )
      // F1.3: runner nhận graph đã hoàn tất, không tự boot domain singleton khác.
      const runner = SessionRunnerLLM.defaultLayer.pipe(
        Layer.provide(services),
        Layer.provide(model),
        Layer.provide(skillGuidance),
        Layer.provide(referenceGuidance),
        Layer.provide(snapshot),
        Layer.provide(verifierContainment),
      )

      // Refresh project copy nền sau khi location services đã sẵn sàng.
      const projectCopyRefresh = Layer.effectDiscard(
        ProjectCopy.refreshAfterBoot,
      ).pipe(Layer.provide(services))

      return Layer.mergeAll(
        boot,
        services,
        formatter,
        image,
        mutation,
        resources,
        todos,
        questions,
        model,
        snapshot,
        runner,
        operations,
        builtInTools,
        mcp,
        referenceGuidance,
        projectCopyRefresh,
      ).pipe(Layer.fresh)
    },
    idleTimeToLive: "60 minutes",
    dependencies: [
      ...locationDependencies,
      EventBus.defaultLayer,
      VerificationSettlementPublisher.defaultLayer,
    ],
  },
) {}

/**
 * Graph variant that leaves EventBus open so every location runner publishes
 * through the same projector/bridge identity as the process root.
 */
export const sharedEventLayer = LocationServiceRegistry.layerNoDeps.pipe(
  Layer.provide([
    ...locationDependencies,
    VerificationSettlementPublisher.layer,
  ]),
)

/** Shared graph identity for consumers that must use one process-wide map. */
export const locationServicesNode = ServiceGraph.node(sharedEventLayer, [
  EventBus.node,
])
