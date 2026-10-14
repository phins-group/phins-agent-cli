import { McpSchema } from "../../src/extensions/mcp/schema"
import type { Tool as McpDefinition } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, test } from "bun:test"

describe("MCP JSON Schema validation", () => {
  test("defaults to 2020-12 and enforces unevaluated properties and dependencies", () => {
    const schema = {
      type: "object",
      properties: { enabled: { type: "boolean" }, text: { type: "string" } },
      dependentRequired: { enabled: ["text"] },
      unevaluatedProperties: false,
    }
    for (const $schema of [
      undefined,
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      const validate = McpSchema.validator.getValidator({
        ...schema,
        ...($schema ? { $schema } : {}),
      })
      expect(validate({ unexpected: true }).valid).toBe(false)
      expect(validate({ enabled: true }).valid).toBe(false)
      expect(validate({ enabled: "true", text: "test" }).valid).toBe(false)
      const input = { enabled: true, text: "test" }
      expect(validate(input)).toMatchObject({ valid: true, data: input })
      expect(input).toEqual({ enabled: true, text: "test" })
    }
  })

  test("enforces 2020-12 prefixItems and separately declared draft-07 tuples", () => {
    const prefixItems = [{ type: "string" }, { type: "number" }]
    const validate = McpSchema.validator.getValidator({
      type: "array",
      prefixItems,
      items: false,
      minItems: 2,
    })
    expect(validate(["test", 1]).valid).toBe(true)
    expect(validate([1, "test"]).valid).toBe(false)
    expect(validate(["test", 1, "extra"]).valid).toBe(false)
    const legacySchema: McpDefinition["inputSchema"] = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        tuple: {
          type: "array",
          items: prefixItems,
          additionalItems: false,
          minItems: 2,
        },
      },
      required: ["tuple"],
    }
    const legacy = McpSchema.validator.getValidator(legacySchema)
    expect(legacy({ tuple: ["test", 1] }).valid).toBe(true)
    expect(legacy({ tuple: [1, "test"] }).valid).toBe(false)
    expect(legacy({ tuple: ["test", 1, "extra"] }).valid).toBe(false)
  })

  test("rejects unsupported keywords, formats, references and dialects at compilation", () => {
    for (const schema of [
      { type: "object", unknownConstraint: false },
      {
        type: "object",
        properties: { value: { type: "string", format: "unsupported-format" } },
      },
      { type: "object", $ref: "https://invalid.test/no-schema-download" },
      { type: "object", $schema: "https://invalid.test/unsupported-dialect" },
    ])
      expect(() => McpSchema.validator.getValidator(schema)).toThrow()
  })

  test("compiles conflicting schema ids independently without changing input", () => {
    const first = McpSchema.validator.getValidator({
      $id: "fixture/shared",
      type: "object",
      properties: { value: { const: "one" } },
      required: ["value"],
    })
    const second = McpSchema.validator.getValidator({
      $id: "fixture/shared",
      type: "object",
      properties: { value: { const: "two" } },
      required: ["value"],
    })
    expect(first({ value: "one" }).valid).toBe(true)
    expect(first({ value: "two" }).valid).toBe(false)
    expect(second({ value: "two" }).valid).toBe(true)
    expect(second({ value: "one" }).valid).toBe(false)
  })
})
