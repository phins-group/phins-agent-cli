import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation"
import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

/** Compile each definition separately; never ignore unsupported constraints. */
export const validator: jsonSchemaValidator = {
  getValidator: (schema) => {
    const options = { strict: false, strictSchema: true, allErrors: true }
    const ajv =
      schema.$schema === "http://json-schema.org/draft-07/schema#" ||
      schema.$schema === "http://json-schema.org/draft-07/schema"
        ? new Ajv(options)
        : new Ajv2020(options)
    addFormats(ajv)
    return new AjvJsonSchemaValidator(ajv).getValidator(schema)
  },
}

export * as McpSchema from "./schema"
