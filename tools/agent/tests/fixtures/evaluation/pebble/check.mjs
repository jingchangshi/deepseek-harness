import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? process.cwd())
const compiler = await import(pathToFileURL(resolve(root, 'compiler/pebble.mjs')))
for (const [left, right] of [[6, 7], [-3, 5], [0, 9], [11, 1]]) {
  const source = `left = const ${left}\nright = const ${right}\nproduct = mul left right\nsum = add product left\nret sum\n`
  const expected = left * right + left
  assert.equal(compiler.compile(source, 'stack'), `push.i32 ${expected}\nreturn.i32\n`)
  assert.equal(compiler.compile(source, 'register'), `r0 = imm.i32 ${expected}\nreturn.i32 r0\n`)
}
for (const invalid of ['seed = const 1\nseed = const 2\nret seed\n', 'seed = add missing missing\nret seed\n', 'seed = const 1\n']) assert.throws(() => compiler.parse(invalid))
assert.equal((await readFile(resolve(root, 'programs/arithmetic.ir'), 'utf8')).includes('mul'), true)
console.log(JSON.stringify({ oracle: 'independent-integer-evaluation', accepted: true, cases: 4 }))
