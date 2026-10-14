export * as PluginHost from "./host"

import type { PluginContext as Interface } from "./api"
import { Effect, Schema } from "effect"
import { AgentRegistry } from "../agents/registry"

import { Catalog } from "../inference/catalog/registry"
import { CommandRegistry } from "../agents/commands"
import { Credential } from "../security/credentials"
import { Integration } from "./integrations/service"
import { CatalogModel } from "../inference/catalog/model"
import { ExtensionService } from "./service"
import { CatalogProvider } from "../inference/catalog/provider"
import { Reference } from "../agents/references/registry"
import { SkillRegistry } from "../agents/skills/registry"
import { PluginTools } from "./tools"

export const make = Effect.fn("PluginHost.make")(function* (
  plugin: ExtensionService.Interface,
) {
  const agents = yield* AgentRegistry.Service
  const catalog = yield* Catalog.Service
  const commands = yield* CommandRegistry.Service
  const integration = yield* Integration.Service
  const reference = yield* Reference.Service
  const skill = yield* SkillRegistry.Service
  const tool = yield* PluginTools.make()

  return {
    options: {},
    tool,
    agent: {
      reload: agents.reload,
      transform: (callback) =>
        agents.transform((draft) =>
          callback({
            list: draft.list,
            get: (id) => draft.get(AgentRegistry.ID.make(id)),
            default: (id) =>
              draft.default(id === undefined ? undefined : AgentRegistry.ID.make(id)),
            update: (id, update) => draft.update(AgentRegistry.ID.make(id), update),
            remove: (id) => draft.remove(AgentRegistry.ID.make(id)),
          }),
        ),
    },
    
    catalog: {
      reload: catalog.reload,
      transform: (callback) =>
        catalog.transform((draft) =>
          callback({
            provider: {
              list: draft.provider.list,
              get: (id) => draft.provider.get(CatalogProvider.ID.make(id)),
              update: (id, update) =>
                draft.provider.update(CatalogProvider.ID.make(id), update),
              remove: (id) => draft.provider.remove(CatalogProvider.ID.make(id)),
            },
            model: {
              get: (providerID, modelID) =>
                draft.model.get(
                  CatalogProvider.ID.make(providerID),
                  CatalogModel.ID.make(modelID),
                ),
              update: (providerID, modelID, update) =>
                draft.model.update(
                  CatalogProvider.ID.make(providerID),
                  CatalogModel.ID.make(modelID),
                  update,
                ),
              remove: (providerID, modelID) =>
                draft.model.remove(
                  CatalogProvider.ID.make(providerID),
                  CatalogModel.ID.make(modelID),
                ),
              default: {
                get: draft.model.default.get,
                set: (providerID, modelID) =>
                  draft.model.default.set(
                    CatalogProvider.ID.make(providerID),
                    CatalogModel.ID.make(modelID),
                  ),
              },
            },
          }),
        ),
    },
    command: {
      reload: commands.reload,
      transform: commands.transform,
    },
    integration: {
      reload: integration.reload,
      connection: {
        active: (id) => integration.connection.active(Integration.ID.make(id)),
        resolve: (connection) =>
          integration.connection.resolve(
            connection.type === "credential"
              ? { ...connection, id: Credential.ID.make(connection.id) }
              : connection,
          ),
      },
      transform: (callback) =>
        integration.transform((draft) =>
          callback({
            list: draft.list,
            get: (id) => draft.get(Integration.ID.make(id)),
            update: (id, update) =>
              draft.update(Integration.ID.make(id), update),
            remove: (id) => draft.remove(Integration.ID.make(id)),
            method: {
              list: (id) => draft.method.list(Integration.ID.make(id)),
              update: (input) => {
                if ("authorize" in input) {
                  const methodID = Integration.MethodID.make(input.method.id)
                  const refresh = input.refresh
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { ...input.method, id: methodID },
                    authorize: (inputs) =>
                      input.authorize(inputs).pipe(
                        Effect.map((authorization) => {
                          if (authorization.mode === "auto") {
                            return {
                              ...authorization,
                              callback: authorization.callback.pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(
                                      credential.methodID,
                                    ),
                                  }),
                                ),
                              ),
                            }
                          }
                          return {
                            ...authorization,
                            callback: (code: string) =>
                              authorization.callback(code).pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(
                                      credential.methodID,
                                    ),
                                  }),
                                ),
                              ),
                          }
                        }),
                      ),
                    ...(refresh
                      ? {
                          refresh: (value: Credential.OAuth) =>
                            refresh(value).pipe(
                              Effect.map((next) =>
                                Credential.OAuth.make({
                                  ...next,
                                  methodID: Integration.MethodID.make(
                                    next.methodID,
                                  ),
                                }),
                              ),
                            ),
                        }
                      : {}),
                    ...(input.label ? { label: input.label } : {}),
                  })
                  return
                }
                if (input.method.type === "env") {
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { type: "env", names: input.method.names },
                  })
                  return
                }
                draft.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: { type: "key", label: input.method.label },
                })
              },
              remove: (id, method) =>
                draft.method.remove(
                  Integration.ID.make(id),
                  Schema.decodeUnknownSync(Integration.Method)(method),
                ),
            },
          }),
        ),
    },
    plugin: {
      add: (input) => plugin.add(ExtensionService.ID.make(input.id), input.effect),
      remove: (id) => plugin.remove(ExtensionService.ID.make(id)),
    },
    reference: {
      reload: reference.reload,
      transform: (callback) =>
        reference.transform((draft) =>
          callback({
            add: (name, source) =>
              draft.add(
                name,
                Schema.decodeUnknownSync(Reference.Source)(source),
              ),
            remove: draft.remove,
            list: draft.list,
          }),
        ),
    },
    skill: {
      reload: skill.reload,
      transform: (callback) =>
        skill.transform((draft) =>
          callback({
            source: (source) =>
              draft.source(Schema.decodeUnknownSync(SkillRegistry.Source)(source)),
            list: draft.list,
          }),
        ),
    },
  } satisfies Interface
})
