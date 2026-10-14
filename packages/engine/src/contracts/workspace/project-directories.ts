export * as ProjectDirectories from "./project-directories"

import { define, inventory } from "../events/event"
import { Project } from "./project"

const Updated = define({
  type: "project.directories.updated",
  schema: { projectID: Project.ID },
})
export const Event = { Updated, Definitions: inventory(Updated) }
export const ProjectDirectoriesEvent = Event
