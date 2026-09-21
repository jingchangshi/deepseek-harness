/**
 * Sanitized validation corpus for the repetition detector, modeled on the two
 * recorded degenerate blocks from the degenerate-output-guard Agent Note: a
 * sharp phase transition from healthy reasoning into a small phrase cycle.
 * All content is synthetic; no recorded session text is reproduced. Generation
 * is deterministic — the same seed always yields the same bytes.
 * @module fixtures
 */

/** Deterministic 32-bit PRNG so fixtures never drift between runs. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const SUBJECTS = [
  'the parser', 'this module', 'the retry path', 'the projection', 'the session log',
  'the adapter', 'the checkpoint', 'the inbox', 'the registry', 'the validator',
]

const VERBS = [
  'reads', 'normalizes', 'validates', 'folds', 'resolves', 'truncates', 'freezes', 'dispatches',
  'replays', 'closes', 'appends', 'derives',
]

const OBJECTS = [
  'every event payload', 'the trailing window', 'each pending message', 'the resolved config',
  'the durable stream', 'one step boundary', 'the canonical header', 'the open block',
  'the claimed batch', 'the settled attempt',
]

const CLAUSES = [
  'before the next request', 'without retaining the tail', 'at the commit point',
  'under the configured bound', 'after the signal settles', 'with the same identity',
  'in stream order', 'per the documented contract',
]

/** One healthy prose line of 40–90 characters. */
function proseLine(random: () => number): string {
  const subject = SUBJECTS[Math.floor(random() * SUBJECTS.length)]!
  const verb = VERBS[Math.floor(random() * VERBS.length)]!
  const object = OBJECTS[Math.floor(random() * OBJECTS.length)]!
  const clause = CLAUSES[Math.floor(random() * CLAUSES.length)]!
  const detail = Math.floor(random() * 900) + 100
  return `- ${subject} ${verb} ${object} ${clause} (case ${detail}).`
}

/**
 * Build a healthy reasoning prefix: prose lines whose only repetition is the
 * `- ` bullet, mirroring the ~50 chars/line density of the recorded healthy
 * prefixes.
 * @param chars - approximate prefix length in characters.
 * @param seed - PRNG seed; the same seed rebuilds the same prefix.
 * @returns the prefix text, newline-terminated.
 */
export function healthyPrefix(chars: number, seed: number): string {
  const random = lcg(seed)
  const lines: string[] = []
  let length = 0
  while (length < chars) {
    const line = proseLine(random)
    lines.push(line)
    length += line.length + 1
  }
  return `${lines.join('\n')}\n`
}

/**
 * Build one recorded-shape degenerate block: a healthy prefix that ends at the
 * collapse onset, then one small phrase cycle repeated far past the point
 * where any consumer would have finished reading.
 * @param options - onset position, cycle phrases, and total block length.
 * @returns the block text.
 */
export function degenerateBlock(options: {
  /** Characters of healthy reasoning before the collapse. */
  onsetChars: number
  /** The exact cycle phrases, whose count is the dominant line period. */
  phrases: string[]
  /** Total block length in characters. */
  totalChars: number
  /** PRNG seed for the healthy prefix. */
  seed: number
}): string {
  const prefix = healthyPrefix(options.onsetChars, options.seed)
  const cycle = `${options.phrases.join('\n')}\n`
  let cycleText = ''
  while (prefix.length + cycleText.length < options.totalChars) {
    cycleText += cycle
  }
  return prefix + cycleText
}

/** The first recorded failure shape: a six-phrase cycle after ~10k chars. */
export function degenerateSample1(): string {
  return degenerateBlock({
    onsetChars: 10_100,
    phrases: ['Let me write.', 'Writing.', 'Go.', 'OK.', 'Next.', 'Again.'],
    totalChars: 40_000,
    seed: 0x1a2b3c,
  })
}

/** The second recorded failure shape: a four-phrase cycle after ~13.5k chars. */
export function degenerateSample2(): string {
  return degenerateBlock({
    onsetChars: 13_500,
    phrases: ['Check the diff.', 'Running.', 'Wait.', 'Done.'],
    totalChars: 40_000,
    seed: 0x4d5e6f,
  })
}

/**
 * Healthy corpus: realistic streamed blocks that must never trip. Covers dense
 * analysis, fenced code, markdown tables, CSV, test vectors, generated
 * boilerplate, and a deliberately repetitive-but-legitimate footer block.
 * @returns block texts in stream order.
 */
export function healthyCorpus(): string[] {
  const random = lcg(0xabcdef)
  const blocks: string[] = []

  blocks.push(healthyPrefix(21_000, 0x0f0f0f))

  // Fenced code: mostly distinct lines with a few structural repeats.
  {
    const lines: string[] = ['Here is the implementation:', '', '```ts']
    for (let i = 0; i < 120; i++) {
      lines.push(`  const step${i} = await queue.claim(${i}, { signal: options.signal })`)
      lines.push(`  if (step${i} === undefined) return step${i}`)
    }
    lines.push('```', '')
    blocks.push(lines.join('\n'))
  }

  // Markdown table: alternating separator/row lines, period-2 match ~0.5.
  {
    const lines: string[] = ['| Field | Default | Meaning |', '|---|---|---|']
    for (let i = 0; i < 200; i++) {
      lines.push(`| field${i} | ${i} | description of field${i} |`)
    }
    blocks.push(lines.join('\n'))
  }

  // CSV export: every line distinct through its row index.
  {
    const lines: string[] = ['id,name,size_bytes']
    for (let i = 0; i < 250; i++) {
      lines.push(`${i},asset-${i * 7},${(i * 977) % 50_000}`)
    }
    blocks.push(lines.join('\n'))
  }

  // Test vectors: short lines, numbers distinct.
  {
    const lines: string[] = []
    for (let i = 0; i < 200; i++) {
      lines.push(`expect(round(${i}.5)).toBe(${Math.round(i + 0.5)})`)
    }
    blocks.push(lines.join('\n'))
  }

  // Generated boilerplate: an index with unique names.
  {
    const lines: string[] = []
    for (let i = 0; i < 150; i++) {
      lines.push(`export { handler${i} } from './modules/module${i}.ts'`)
    }
    blocks.push(lines.join('\n'))
  }

  // A repetitive-but-legitimate footer: 40 identical lines inside a 400-line
  // block — distinct ratio stays far above the threshold.
  {
    const lines: string[] = []
    for (let i = 0; i < 360; i++) lines.push(proseLine(random))
    for (let i = 0; i < 40; i++) lines.push('---')
    blocks.push(lines.join('\n'))
  }

  // Unicode content: CJK and accented prose with varied lines.
  {
    const lines: string[] = []
    for (let i = 0; i < 120; i++) {
      lines.push(`第 ${i + 1} 步：检查投影 cafédé 与会话日志的边界情形。`)
    }
    blocks.push(lines.join('\n'))
  }

  return blocks
}
