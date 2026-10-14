export * as BuiltInTools from "./builtins"

import { Layer } from "effect"
import { BashTool } from "./process/shell"
import { ProcessSessionTool } from "./process/session"
import { ProcessSessions } from "../execution/process/sessions"
import { ApplyPatchTool } from "./files/patch"
import { EditTool } from "./files/edit"
import { GlobTool } from "./files/glob"
import { GrepTool } from "./files/grep"
import { QuestionTool } from "./question"
import { ReadTool } from "./files/read"
import { ReadToolFileSystem } from "./files/reader"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./planning"
import { WebFetchTool } from "./web/fetch"
import { WebSearchTool } from "./web/search"
import { WriteTool } from "./files/write"
import { FormatTool } from "./files/format"
import { TaskTool } from "./task"

/**
 * Composes only the shipped Location-scoped built-in tool layers.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and V2 plugin tools use separate scoped canonical registrations.
 * Provider/model filtering remains a deliberate follow-up, outside this static
 * list. The caller supplies shared Location services once to this set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * registrations separate from this static built-in list.
 */
export const locationLayer = Layer.mergeAll(
  ApplyPatchTool.layer,
  BashTool.layer,
  ProcessSessionTool.layer,
  EditTool.layer,
  GlobTool.layer,
  GrepTool.layer,
  QuestionTool.layer,
  ReadTool.layer.pipe(Layer.provide(ReadToolFileSystem.layer)),
  SkillTool.layer,
  TodoWriteTool.layer,
  WebFetchTool.layer,
  WebSearchTool.layer.pipe(Layer.provide(WebSearchTool.defaultConfigLayer)),
  WriteTool.layer,
  FormatTool.layer,
  TaskTool.layer,
).pipe(Layer.provideMerge(ProcessSessions.layer))
