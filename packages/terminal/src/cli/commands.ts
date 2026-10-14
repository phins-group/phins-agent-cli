/**
 * Cây command/schema của CLI.
 * File này chỉ mô tả name/argument/flag; entry.ts đăng ký các action.
 * @module
 */
import { Argument, Flag } from "effect/unstable/cli"
import { CommandTree } from "./command-tree"

declare const PHINS_CLI_NAME: string | undefined

/** Root spec và các lệnh native; implementation được lazy-load. */
export const Commands = CommandTree.defineCommand(
  typeof PHINS_CLI_NAME === "string" ? PHINS_CLI_NAME : "phins",
  {
    description: "PHINs Agent — FROM IDEAS to IMPACT",
    params: {
      project: Argument.string("project").pipe(Argument.optional),
      session: Flag.string("session").pipe(Flag.optional),
      model: Flag.string("model").pipe(Flag.optional),
      agent: Flag.string("agent").pipe(Flag.optional),
      prompt: Flag.string("prompt").pipe(Flag.optional),
      recordOnly: Flag.boolean("record-only").pipe(Flag.withDefault(false)),
    },
    commands: [
      CommandTree.defineCommand("setup", {
        description: "Set an API key and choose a model locally; no inference",
        params: { project: Flag.string("project").pipe(Flag.optional) },
      }),
      CommandTree.defineCommand("agent-host", {
        description: "Private project execution host of this Agent CLI",
        hidden: true,
        params: {
          directory: Flag.string("directory"),
          nonce: Flag.string("nonce"),
          mode: Flag.choice("mode", ["personal"]).pipe(Flag.withDefault("personal")),
        },
      }),
      CommandTree.defineCommand("ask", {
        description:
          "Run the existing Agent CLI in this project and wait for its result",
        params: {
          message: Argument.string("message").pipe(
            Argument.variadic({ min: 1 }),
          ),
          project: Flag.string("project").pipe(Flag.optional),
          session: Flag.string("session").pipe(Flag.optional),
          model: Flag.string("model").pipe(Flag.optional),
          agent: Flag.string("agent").pipe(Flag.optional),
          id: Flag.string("id").pipe(Flag.optional),
          recordOnly: Flag.boolean("record-only").pipe(Flag.withDefault(false)),
          format: Flag.choice("format", ["text", "json"]).pipe(
            Flag.withDefault("text"),
          ),
        },
      }),
      CommandTree.defineCommand("resume", {
        description: "Open the full TUI for an existing Agent session",
        params: {
          session: Argument.string("session-id"),
          project: Flag.string("project").pipe(Flag.optional),
        },
      }),
    ],
  },
)
