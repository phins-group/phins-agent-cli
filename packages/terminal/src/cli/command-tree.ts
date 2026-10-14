/** Builder typed cho cây command, params và subcommand lookup của CLI. @module */
import * as Command from "effect/unstable/cli/Command"

type Options<Config extends Command.Command.Config, Commands extends ReadonlyArray<Any>> = {
  readonly description?: string
  readonly hidden?: boolean
  readonly params?: Config
  readonly commands?: Commands
}

export interface Node<
  Name extends string,
  Spec extends Command.Command<Name, any, any, any, any>,
  Commands extends Children,
> {
  readonly name: Name
  readonly spec: Spec
  readonly commands: Commands
}

export type Any = Node<string, Command.Command<any, any, any, any, any>, Children>
export type Children = Readonly<Record<string, Any>>

export function defineCommand<
  const Name extends string,
  const Config extends Command.Command.Config = {},
  const Commands extends ReadonlyArray<Any> = [],
>(name: Name, options: Options<Config, Commands> = {}) {
  const command = Command.make(name, options.params ?? ({} as Config))
  const described = options.description ? command.pipe(Command.withDescription(options.description)) : command
  const spec = options.hidden ? described.pipe(Command.withHidden) : described
  return {
    name,
    spec,
    commands: Object.fromEntries(
      (options.commands ?? []).map((command) => [command.name, command]),
    ) as ChildrenOf<Commands>,
  }
}

type ChildrenOf<Commands extends ReadonlyArray<Any>> = {
  readonly [Node in Commands[number] as Node["name"]]: Node
}

export * as CommandTree from "./command-tree"
