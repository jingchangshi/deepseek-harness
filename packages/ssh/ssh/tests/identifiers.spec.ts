import { expect, expectTypeOf, it } from 'vitest'
import { preparedSchema, processIdSchema, textStreamIdSchema, readRootIdSchema, rootSegmentsSchema } from '../src/schemas.ts'
import type { SshProcessId, SshTextStreamId, SshReadRootId } from '../src/schemas.ts'

it('keeps root identities distinct and rejects non-component root requests', () => {
  const root = readRootIdSchema.parse('a25daf3e-c6dd-4bb7-9f39-14f09eb2d155')
  expectTypeOf(root).toEqualTypeOf<SshReadRootId>()
  expectTypeOf(root).not.toExtend<SshProcessId>()
  expectTypeOf(root).not.toExtend<SshTextStreamId>()
  expect(readRootIdSchema.safeParse('invalid').success).toBe(false)
  expect(rootSegmentsSchema.parse([])).toEqual([])
  expect(rootSegmentsSchema.parse(['src', 'file.ts'])).toEqual(['src', 'file.ts'])
  for (const name of ['', '.', '..', 'a/b', 'a\\b', '\0']) {
    expect(rootSegmentsSchema.safeParse([name]).success).toBe(false)
  }
})

it('keeps process and text-stream identities distinct while retaining their UUID wire values', () => {
  const wire = 'a25daf3e-c6dd-4bb7-9f39-14f09eb2d155'
  const process = processIdSchema.parse(wire)
  const stream = textStreamIdSchema.parse(wire)
  expectTypeOf(process).toEqualTypeOf<SshProcessId>()
  expectTypeOf(stream).toEqualTypeOf<SshTextStreamId>()
  expectTypeOf(stream).not.toExtend<SshProcessId>()
  expectTypeOf(process).not.toExtend<SshTextStreamId>()
  expectTypeOf<string>().not.toExtend<SshProcessId>()
  expectTypeOf<string>().not.toExtend<SshTextStreamId>()
  expect(JSON.stringify({ process, stream })).toBe(JSON.stringify({ process: wire, stream: wire }))
  expect(preparedSchema.parse({ id: wire, streams: {} }).id).toBe(process)
  expect(processIdSchema.safeParse('invalid').success).toBe(false)
  expect(textStreamIdSchema.safeParse('invalid').success).toBe(false)
})
