/**
 * Nối cây `CommandTree` với lazy handler modules và Effect CLI dispatcher.
 * Loader chỉ import handler của command thực sự được chọn để giữ startup nhẹ.
 * @module
 */
import * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import * as Command from "effect/unstable/cli/Command"
import { CommandTree } from "./command-tree"

export type CommandInput<Value> =
  Value extends CommandTree.Node<infer _Name, infer Command, infer _Commands>
    ? CommandInput<Command>
    : Value extends Command.Command<
          infer _Name,
          infer Input,
          infer _Context,
          infer _Error,
          infer _Requirements
        >
      ? Input
      : never

type HandlerModule<Value = unknown> = {
  readonly default: (input: Value) => Effect.Effect<void, unknown, Scope>
}
type Loader<Node extends CommandTree.Any> = () => Promise<HandlerModule<CommandInput<Node>>>
type ProvidedCommand = Command.Command<
  string,
  unknown,
  unknown,
  unknown,
  never
>

export type HandlerTree<Node extends CommandTree.Any> =
  keyof Node["commands"] extends never
    ? Loader<Node>
    : { readonly $?: Loader<Node> } & {
        readonly [Key in keyof Node["commands"]]: HandlerTree<
          Node["commands"][Key]
        >
      }

interface LazyHandler {
  readonly spec: Command.Command.Any
  readonly load: () => Promise<HandlerModule>
}

type RuntimeHandlers =
  | (() => Promise<HandlerModule>)
  | {
      readonly $?: () => Promise<HandlerModule>
      readonly [key: string]: RuntimeHandlers | undefined
    }

export function defineHandler<const Node extends CommandTree.Any, Error, Requirements>(
  _node: Node,
  run: (input: CommandInput<Node>) => Effect.Effect<void, Error, Requirements>,
) {
  return run
}

/** Flatten handler tree thành các cặp spec/loader có identity ổn định. */
export function bindHandlers<const Root extends CommandTree.Any>(
  root: Root,
  handlers: HandlerTree<Root>,
) {
  const result: LazyHandler[] = []

  function add(node: CommandTree.Any, value: RuntimeHandlers) {
    if (typeof value === "function") {
      result.push({ spec: node.spec, load: value })
      return
    }
    if (value.$) result.push({ spec: node.spec, load: value.$ })
    for (const [name, child] of Object.entries(node.commands))
      add(child, value[name] as RuntimeHandlers)
  }

  add(root, handlers as RuntimeHandlers)
  return result
}

/** Compile cây command đã gắn handler và chạy parser một lần. */
export function runCommands(
  commands: CommandTree.Any,
  handlers: ReadonlyArray<LazyHandler>,
  options: {
    readonly version: string
    readonly arguments?: ReadonlyArray<string>
  },
) {
  const command = attachHandlers(commands, handlers)
  return (
    options.arguments
      ? Command.runWith(command, { version: options.version })(
          options.arguments,
        )
      : Command.run(command, { version: options.version })
  ) as Effect.Effect<void, unknown, Command.Environment>
}

/** Gắn lazy handler đệ quy; parent node vẫn giữ toàn bộ subcommands. */
function attachHandlers(
  node: CommandTree.Any,
  handlers: ReadonlyArray<LazyHandler>,
): ProvidedCommand {
  const handler = handlers.find((handler) => handler.spec === node.spec)
  const spec = handler
    ? node.spec.pipe(
        Command.withHandler((input) =>
          Effect.gen(function* () {
            const module = yield* Effect.promise(handler.load)
            yield* module.default(input)
          }),
        ),
      )
    : node.spec
  if (!Object.keys(node.commands).length) return spec as ProvidedCommand
  return spec.pipe(
    Command.withSubcommands(
      Object.values(node.commands).map((child) => attachHandlers(child, handlers)),
    ),
  ) as ProvidedCommand
}

export * as CommandDispatcher from "./dispatcher"
