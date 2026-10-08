---
kind: upgrade-guide
description: Raw tool calls with arguments that do not match their JSON Schema now fail before the tool body runs.
---

# Tool Body Argument Validation

English | [中文](guide.zh.md)

## Change

The registry now validates arguments before `execute` runs. `defineTool` uses its captured parameter validator; raw definitions without `validateArguments` use Ajv Draft 7 to validate against `parameters`. Previously, a raw definition without its own validator could receive arguments that did not satisfy its schema. A schema mismatch now produces the normal `INVALID_ARGS` tool result without invoking the body. Strict schema checks reject unsupported keywords, formats and dialects; unresolved references fail without remote retrieval.

## Migration

1. Review each raw `ToolDefinition` registered with `ctx.tools.register()` and make its `parameters` schema use the supported Ajv Draft 7 dialect and describe the inputs its `execute` body accepts. Update the schema or the argument producer when they disagree; remote `$ref` values are not fetched.
2. If a definition supplies `validateArguments`, make it throw `ToolArgsError` for invalid arguments that should return `INVALID_ARGS`. `defineTool` captures and applies its parameter validator automatically.
3. Confirm that a valid call reaches `execute`, while a call with an invalid argument returns `INVALID_ARGS` and does not enter the body.
