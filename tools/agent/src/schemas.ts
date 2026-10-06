/** JSON Schema loading and validation for repository task artifacts. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { assertRequiredVerification } from './verification.ts'
import type { VerificationDocument } from './types.ts'

/** Schema names committed below `.agent/schemas`. */
export type ArtifactSchemaName =
  | 'task'
  | 'state'
  | 'baseline'
  | 'investigation'
  | 'plan'
  | 'evidence'
  | 'verification'
  | 'review'
  | 'decision'

/** Error containing Ajv's stable instance paths for an invalid artifact. */
export class ArtifactValidationError extends Error {
  /** Create a validation diagnostic for one schema. */
  constructor(public readonly schema: ArtifactSchemaName, details: string) {
    super(`${schema} artifact is invalid: ${details}`)
    this.name = 'ArtifactValidationError'
  }
}

/** Compile and cache the committed artifact schemas. */
export class ArtifactSchemas {
  private readonly ajv = addFormats(new Ajv({ allErrors: true, strict: true }))
  private readonly validators = new Map<string, ReturnType<Ajv['compile']>>()

  /**
   * Create a registry reading schemas from one target repository.
   * @param schemaRoot - directory containing `<name>.schema.json` files.
   */
  constructor(private readonly schemaRoot: string) {}

  /**
   * Validate one parsed artifact and return it unchanged.
   * @param name - schema selected by the artifact's repository filename.
   * @param value - parsed JSON or YAML value.
   * @returns the same value after schema validation.
   */
  async validate<T>(name: ArtifactSchemaName, value: T): Promise<T> {
    if (name === 'verification' && !isJsonValue(value)) throw new ArtifactValidationError(name, 'verification must be lossless JSON data')
    const version = typeof value === 'object' && value !== null ? Reflect.get(value, 'schemaVersion') : undefined
    const schemaName = name === 'verification' && version === 3 ? 'verification-v3'
      : name === 'verification' && version === 2 ? 'verification-v2'
        : (name === 'plan' || name === 'review' || name === 'decision') && version === 2 ? `${name}-v2` : name
    let validator = this.validators.get(schemaName)
    if (validator === undefined) {
      const source = await readFile(join(this.schemaRoot, `${schemaName}.schema.json`), 'utf8')
      validator = this.ajv.compile(JSON.parse(source))
      this.validators.set(schemaName, validator)
    }
    if (validator(value)) {
      if (name === 'verification' && (version === 2 || version === 3)) assertRequiredVerification([], value as VerificationDocument)
      return value
    }
    const details = (validator.errors ?? [])
      .map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ')
    throw new ArtifactValidationError(name, details)
  }
}
