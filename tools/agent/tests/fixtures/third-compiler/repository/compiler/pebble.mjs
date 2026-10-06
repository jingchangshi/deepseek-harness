/** Parse and fold Pebble integer SSA into constant-only target IR. */

/**
 * Parse one program, rejecting duplicate definitions and undefined operands.
 * @param {string} source - Input IR with a final return instruction.
 * @returns {object[]} Validated instructions.
 */
export function parse(source) {
  const instructions = []
  const defined = new Set()
  const lines = source.trim().split('\n')
  for (const [index, line] of lines.entries()) {
    const returned = /^ret ([a-z]+)$/.exec(line)
    if (returned !== null) {
      if (index !== lines.length - 1 || !defined.has(returned[1])) throw new Error('invalid return')
      instructions.push({ operation: 'ret', operand: returned[1] })
      continue
    }
    const assigned = /^([a-z]+) = (const|add|mul) (-?\d+|[a-z]+)(?: ([a-z]+))?$/.exec(line)
    if (assigned === null) throw new Error('invalid instruction')
    const [, name, operation, first, second] = assigned
    if (defined.has(name)) throw new Error('duplicate definition')
    if (operation === 'const') {
      if (!/^-?\d+$/.test(first) || second !== undefined) throw new Error('invalid constant')
      instructions.push({ name, operation, value: Number(first) })
    } else {
      if (!defined.has(first) || !defined.has(second)) throw new Error('undefined operand')
      instructions.push({ name, operation, first, second })
    }
    defined.add(name)
  }
  if (instructions.at(-1)?.operation !== 'ret') throw new Error('missing return')
  return instructions
}

/**
 * Fold every integer operation and read the returned value.
 * @param {object[]} instructions - Parsed input instructions.
 * @returns {number} Constant return value.
 */
export function fold(instructions) {
  const values = new Map()
  for (const instruction of instructions) {
    const { name, operation } = instruction
    if (operation === 'ret') return values.get(instruction.operand)
    if (operation === 'const') values.set(name, instruction.value)
    else {
      const left = values.get(instruction.first)
      const right = values.get(instruction.second)
      values.set(name, operation === 'add' ? left + right : left + right)
    }
  }
  throw new Error('missing return')
}

/**
 * Emit a folded program for either supported target.
 * @param {string} source - Input IR.
 * @param {string} target - Stack or register target identifier.
 * @returns {string} Constant-only target IR ending in a newline.
 */
export function compile(source, target) {
  const value = fold(parse(source))
  if (target === 'stack') return `push.i32 ${value}\nreturn.i32\n`
  if (target === 'register') return `r0 = imm.i32 ${value}\nreturn.i32 r0\n`
  throw new Error('unsupported target')
}
