/** Independent parser, emitted-target and arithmetic-reference checks for Pebble. */

import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { compile, fold, parse } from '../compiler/pebble.mjs'

function reference(source) {
  const values = new Map()
  for (const line of source.trim().split('\n')) {
    const tokens = line.split(' ')
    if (tokens[0] === 'ret') return values.get(tokens[1])
    const [name, , operation, first, second] = tokens
    if (operation === 'const') values.set(name, Number(first))
    else if (operation === 'add') values.set(name, values.get(first) + values.get(second))
    else if (operation === 'mul') values.set(name, values.get(first) * values.get(second))
    else throw new Error('unsupported reference instruction')
  }
  throw new Error('missing reference return')
}

assert.equal(process.env.PEBBLE_FIXTURE, '1')
const [mode, target] = process.argv.slice(2)
const source = await readFile('programs/arithmetic.ir', 'utf8')
if (mode === 'parse') {
  assert.equal(parse(source).at(-1).operation, 'ret')
  for (const invalid of [
    'seed = const 1\nseed = const 2\nret seed\n',
    'seed = add missing missing\nret seed\n',
    'seed = const 1\n',
    'seed = const 1\nret seed\nfactor = const 2\n',
    'seed = divide 2 3\nret seed\n',
  ]) assert.throws(() => parse(invalid))
} else if (mode === 'emit') {
  const output = compile(source, target)
  const value = reference(source)
  const expected = target === 'stack' ? `push.i32 ${value}\nreturn.i32\n` : `r0 = imm.i32 ${value}\nreturn.i32 r0\n`
  assert.equal(output, expected)
  assert.equal(output.includes('mul'), false)
  assert.equal(output.includes('add'), false)
  await mkdir('task.runtime', { recursive: true })
  await writeFile(`task.runtime/${target}.ir`, output)
  assert.equal(await readFile(`task.runtime/${target}.ir`, 'utf8'), expected)
} else if (mode === 'reference') {
  for (const [left, right] of [[6, 7], [-3, 5], [0, 9], [11, 1]]) {
    const regression = `left = const ${left}\nright = const ${right}\nproduct = mul left right\nsum = add product left\nret sum\n`
    assert.equal(fold(parse(regression)), reference(regression))
  }
  assert.equal(fold(parse(source)), reference(source))
  assert.throws(() => compile(source, 'missing'), /unsupported target/)
} else throw new Error('unsupported check')
const execution = { mode, target: target ?? null, value: reference(source) }
await appendFile('.agent/executions.jsonl', `${JSON.stringify(execution)}\n`)
console.log(JSON.stringify(execution))
