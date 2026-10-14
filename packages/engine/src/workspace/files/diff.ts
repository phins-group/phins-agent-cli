export * as File from "./diff"

import { Revert } from "../../contracts/session/revert"

export const Diff = Revert.FileDiff
export type Diff = typeof Diff.Type
