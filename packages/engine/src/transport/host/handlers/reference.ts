/** Hiện thực reference.list từ registry Reference của location. @module */
import { Reference } from "../../../agents/references/registry"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ReferenceHandler = HttpApiBuilder.group(Api, "server.reference", (handlers) =>
  handlers.handle("reference.list", () => response(Reference.Service.use((reference) => reference.list()))),
)
