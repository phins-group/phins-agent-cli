import type { PluginContext } from "../../src/extensions/api"
import { AgentRegistry } from "../../src/agents/registry"
import { Catalog } from "../../src/inference/catalog/registry"
import { Credential } from "../../src/security/credentials"
import { Integration } from "../../src/extensions/integrations/service"
import { CatalogModel } from "../../src/inference/catalog/model"
import { CatalogProvider } from "../../src/inference/catalog/provider"
import type {
  IntegrationEnvMethod,
  IntegrationKeyMethod,
  IntegrationOAuthMethod,
} from "../../src/transport/client/generated/types.gen"
import { Effect } from "effect"

type Overrides = Partial<Omit<PluginContext, "options">>

export function host(overrides: Overrides = {}): PluginContext {
  return {
    options: {},
    tool: overrides.tool ?? {
      register: () => Effect.die("unused tool.register"),
    },
    agent: overrides.agent ?? {
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    catalog: overrides.catalog ?? {
      transform: () => Effect.die("unused catalog.transform"),
      reload: () => Effect.die("unused catalog.reload"),
    },
    command: overrides.command ?? {
      transform: () => Effect.die("unused command.transform"),
      reload: () => Effect.die("unused command.reload"),
    },
    integration: overrides.integration ?? {
      transform: () => Effect.die("unused integration.transform"),
      reload: () => Effect.die("unused integration.reload"),
      connection: {
        active: () => Effect.die("unused integration.connection.active"),
        resolve: () => Effect.die("unused integration.connection.resolve"),
      },
    },
    plugin: overrides.plugin ?? {
      add: () => Effect.die("unused plugin.add"),
      remove: () => Effect.die("unused plugin.remove"),
    },
    reference: overrides.reference ?? {
      transform: () => Effect.die("unused reference.transform"),
      reload: () => Effect.die("unused reference.reload"),
    },
    skill: overrides.skill ?? {
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
  }
}

export function agentHost(agent: AgentRegistry.Interface): PluginContext["agent"] {
  return {
    reload: agent.reload,
    transform: (callback) =>
      agent.transform((draft) =>
        callback({
          list: () => draft.list().map(agentInfo),
          get: (id) => {
            const value = draft.get(AgentRegistry.ID.make(id))
            return value && agentInfo(value)
          },
          default: (id) =>
            draft.default(id === undefined ? undefined : AgentRegistry.ID.make(id)),
          update: (id, update) =>
            draft.update(AgentRegistry.ID.make(id), (value) => {
              const current = agentInfo(value)
              update(current)
              Object.assign(value, current, { id: AgentRegistry.ID.make(current.id) })
            }),
          remove: (id) => draft.remove(AgentRegistry.ID.make(id)),
        }),
      ),
  }
}

export function catalogHost(
  catalog: Catalog.Interface,
): PluginContext["catalog"] {
  return {
    reload: catalog.reload,
    transform: (callback) =>
      catalog.transform((draft) =>
        callback({
          provider: {
            list: () =>
              draft.provider.list().map((value) => ({
                provider: providerInfo(value.provider),
                models: new Map(
                  Array.from(value.models, ([id, model]) => [
                    id,
                    modelInfo(model),
                  ]),
                ),
              })),
            get: (id) => {
              const value = draft.provider.get(CatalogProvider.ID.make(id))
              return (
                value && {
                  provider: providerInfo(value.provider),
                  models: new Map(
                    Array.from(value.models, ([id, model]) => [
                      id,
                      modelInfo(model),
                    ]),
                  ),
                }
              )
            },
            update: (id, update) =>
              draft.provider.update(CatalogProvider.ID.make(id), (value) => {
                const current = providerInfo(value)
                update(current)
                Object.assign(value, current, {
                  id: CatalogProvider.ID.make(current.id),
                })
              }),
            remove: (id) => draft.provider.remove(CatalogProvider.ID.make(id)),
          },
          model: {
            get: (providerID, modelID) => {
              const value = draft.model.get(
                CatalogProvider.ID.make(providerID),
                CatalogModel.ID.make(modelID),
              )
              return value && modelInfo(value)
            },
            update: (providerID, modelID, update) =>
              draft.model.update(
                CatalogProvider.ID.make(providerID),
                CatalogModel.ID.make(modelID),
                (value) => {
                  const current = modelInfo(value)
                  update(current)
                  Object.assign(value, current, {
                    id: CatalogModel.ID.make(current.id),
                    providerID: CatalogProvider.ID.make(current.providerID),
                    family:
                      current.family === undefined
                        ? undefined
                        : CatalogModel.Family.make(current.family),
                    variants: current.variants.map((variant) => ({
                      ...variant,
                      id: CatalogModel.VariantID.make(variant.id),
                    })),
                  })
                },
              ),
            remove: (providerID, modelID) =>
              draft.model.remove(
                CatalogProvider.ID.make(providerID),
                CatalogModel.ID.make(modelID),
              ),
            default: {
              get: () => {
                const value = draft.model.default.get()
                return (
                  value && {
                    providerID: value.providerID,
                    modelID: value.modelID,
                  }
                )
              },
              set: (providerID, modelID) =>
                draft.model.default.set(
                  CatalogProvider.ID.make(providerID),
                  CatalogModel.ID.make(modelID),
                ),
            },
          },
        }),
      ),
  }
}

export function integrationHost(
  integration: Integration.Interface,
): PluginContext["integration"] {
  return {
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
          list: () =>
            draft.list().map((value) => ({ id: value.id, name: value.name })),
          get: (id) => {
            const value = draft.get(Integration.ID.make(id))
            return value && { id: value.id, name: value.name }
          },
          update: (id, update) => draft.update(Integration.ID.make(id), update),
          remove: (id) => draft.remove(Integration.ID.make(id)),
          method: {
            list: (id) =>
              draft.method.list(Integration.ID.make(id)).map(method),
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
                  method: { ...input.method, names: [...input.method.names] },
                })
                return
              }
              draft.method.update({
                integrationID: Integration.ID.make(input.integrationID),
                method: input.method,
              })
            },
            remove: (id, item) =>
              draft.method.remove(
                Integration.ID.make(id),
                internalMethod(item),
              ),
          },
        }),
      ),
  }
}

function method(value: Integration.Method) {
  if (value.type === "env") return { type: value.type, names: [...value.names] }
  if (value.type === "key") return { type: value.type, label: value.label }
  return {
    type: value.type,
    id: value.id,
    label: value.label,
    prompts: value.prompts?.map((prompt) => {
      if (prompt.type === "text") return { ...prompt }
      return {
        ...prompt,
        options: prompt.options.map((option) => ({ ...option })),
      }
    }),
  }
}

function internalMethod(
  value: IntegrationOAuthMethod | IntegrationKeyMethod | IntegrationEnvMethod,
): Integration.Method {
  if (value.type === "env") return value
  if (value.type === "key") return value
  return {
    ...value,
    id: Integration.MethodID.make(value.id),
  }
}

function agentInfo(value: AgentRegistry.Info) {
  return {
    ...value,
    model: value.model && { ...value.model },
    request: {
      headers: { ...value.request.headers },
      body: { ...value.request.body },
    },
    permissions: value.permissions.map((permission) => ({ ...permission })),
  }
}

function providerInfo(value: CatalogProvider.MutableInfo) {
  return {
    ...value,
    api: {
      ...value.api,
      settings: value.api.settings && { ...value.api.settings },
    },
    request: {
      headers: { ...value.request.headers },
      body: { ...value.request.body },
    },
  }
}

function modelInfo(value: CatalogModel.Info | CatalogModel.MutableInfo) {
  return {
    ...value,
    api: {
      ...value.api,
      settings: value.api.settings && { ...value.api.settings },
    },
    capabilities: {
      ...value.capabilities,
      input: [...value.capabilities.input],
      output: [...value.capabilities.output],
    },
    request: {
      ...value.request,
      headers: { ...value.request.headers },
      body: { ...value.request.body },
    },
    variants: value.variants.map((variant) => ({
      ...variant,
      headers: { ...variant.headers },
      body: { ...variant.body },
    })),
    time: { ...value.time },
    cost: value.cost.map((cost) => ({
      ...cost,
      tier: cost.tier && { ...cost.tier },
      cache: { ...cost.cache },
    })),
    limit: { ...value.limit },
  }
}
