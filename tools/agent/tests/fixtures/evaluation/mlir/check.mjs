import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? process.cwd())
const { rewrite } = await import(pathToFileURL(resolve(root, 'pass.mjs')))
const source = await readFile(resolve(root, 'input.mlir'), 'utf8')
const expected = source.replace('    %sum = arith.addi %arg0, %zero : i32\n', '').replace('return %sum : i32', 'return %arg0 : i32')
assert.equal(rewrite(source), expected)
const nonzero = source.replace('constant 0', 'constant 1')
assert.equal(rewrite(nonzero), nonzero)
assert.equal(rewrite(expected), expected)
const verifier = process.env.DSH_EVALUATION_MLIR_OPT
if (verifier !== undefined) {
  const result = spawnSync(verifier, ['--verify-each'], { input: expected, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
console.log(JSON.stringify({ oracle: 'mlir-identity-and-nonzero-regression', accepted: true, pinnedVerifier: verifier !== undefined }))
