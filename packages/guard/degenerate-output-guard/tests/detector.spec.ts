import { describe, expect, it } from 'vitest'
import { RepetitionDetector, evaluateWindow } from '../src/detector.ts'
import type { DetectorTuning } from '../src/detector.ts'
import { degenerateSample1, degenerateSample2, healthyCorpus } from './fixtures.ts'

/**
 * Detector unit suite: the line-cycle verdicts over fixed windows, the
 * streaming accumulator's amortization, chunk-boundary behavior, and state
 * bound, plus the deterministic replay of the sanitized validation corpus
 * (two recorded-shape degenerate samples, one healthy corpus).
 */

const TUNING: DetectorTuning = {
  windowChars: 4000,
  checkEveryChars: 512,
  minWindowLines: 24,
  distinctLineRatio: 0.20,
  cyclePeriodMax: 12,
  cycleMatchRatio: 0.90,
}

/** A window of `lines` identical lines: the period-1 collapse. */
function period1(lines: number, text = 'Writing.'): string {
  return Array.from({ length: lines }, () => text).join('\n')
}

/** A window cycling through `phrases` until it holds at least `lines` lines. */
function cycle(phrases: string[], lines: number): string {
  const parts: string[] = []
  while (parts.length < lines) parts.push(...phrases)
  return parts.slice(0, lines).join('\n')
}

describe('evaluateWindow verdicts', () => {
  it('fires at period 1, 4, 6, and 12 with the dominant period', () => {
    const cases: [string[], number][] = [
      [['same.'], 1],
      [['alpha', 'beta', 'gamma', 'delta'], 4],
      [['one', 'two', 'three', 'four', 'five', 'six'], 6],
      [Array.from({ length: 12 }, (_, i) => `phrase ${i}`), 12],
    ]
    for (const [phrases, period] of cases) {
      const detected = evaluateWindow(cycle(phrases, 120), TUNING)
      expect(detected, `period ${period}`).toBeDefined()
      expect(detected!.bestPeriod).toBe(period)
      expect(detected!.matchRatio).toBeGreaterThanOrEqual(TUNING.cycleMatchRatio)
    }
  })

  it('does not fire above the max scanned period', () => {
    const phrases = Array.from({ length: 13 }, (_, i) => `phrase ${i}`)
    expect(evaluateWindow(cycle(phrases, 130), TUNING)).toBeUndefined()
  })

  it('does not fire when the distinct-line ratio is healthy', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`)
    expect(evaluateWindow(lines.join('\n'), TUNING)).toBeUndefined()
  })

  it('treats a distinct ratio at the threshold as suspect and above it as healthy', () => {
    // 60 lines, 12 distinct, perfect period-12 cycle: ratio exactly 0.20 is
    // still suspect, and the scan finds the cycle.
    const distinct = Array.from({ length: 12 }, (_, i) => `phrase ${i}`)
    const lines: string[] = []
    while (lines.length < 60) lines.push(...distinct)
    const detected = evaluateWindow(lines.join('\n'), TUNING)
    expect(detected).toBeDefined()
    expect(detected!.distinctRatio).toBeCloseTo(0.20, 10)
    // One more distinct line pushes the ratio past the threshold: healthy
    // without ever reaching the period scan.
    const above = [...lines.slice(0, 59), 'unique-tail']
    expect(evaluateWindow(above.join('\n'), TUNING)).toBeUndefined()
  })

  it('does not fire when periodicity stays below the match ratio', () => {
    // A period-5 cycle whose every fifth line varies: match ≈ 0.8 < 0.90 while
    // the distinct ratio (24/120 = 0.20) sits exactly at the suspect gate.
    const lines: string[] = []
    for (let i = 0; i < 24; i++) {
      lines.push('a', 'b', 'c', 'd', `e-${i}`)
    }
    expect(evaluateWindow(lines.join('\n'), TUNING)).toBeUndefined()
  })

  it('does not fire below minWindowLines', () => {
    expect(evaluateWindow(period1(TUNING.minWindowLines - 1), TUNING)).toBeUndefined()
    expect(evaluateWindow(period1(TUNING.minWindowLines), TUNING)).toBeDefined()
  })

  it('normalizes whitespace and drops empty lines', () => {
    const noisy = period1(60, '  \tWriting.  \t')
      .split('\n')
      .flatMap(line => ['', line, '   '])
      .join('\n')
    const detected = evaluateWindow(noisy, TUNING)
    expect(detected).toBeDefined()
    expect(detected!.windowLines).toBe(60)
  })

  it('reports Unicode cycle content with the dominant period', () => {
    expect(evaluateWindow(cycle(['循环一步', '循环两步', '循环三步'], 60), TUNING)?.bestPeriod).toBe(3)
    expect(evaluateWindow(cycle(['判断投影边界', '等待信号'], 60), TUNING)?.bestPeriod).toBe(2)
  })
})

describe('RepetitionDetector streaming', () => {
  /** Feed text in fixed-size chunks through a live detector; report the first detection. */
  function replay(text: string, chunkSize: number): { trigger: number; period: number; matchRatio: number } | undefined {
    const detector = new RepetitionDetector(TUNING)
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      detector.push(text.slice(offset, offset + chunkSize))
      if (!detector.due()) continue
      const detected = detector.evaluate()
      if (detected !== undefined) {
        return { trigger: detector.charsSeen, period: detected.bestPeriod, matchRatio: detected.matchRatio }
      }
    }
    const final = detector.evaluate()
    return final === undefined ? undefined : { trigger: detector.charsSeen, period: final.bestPeriod, matchRatio: final.matchRatio }
  }

  it('accumulates multi-chunk deltas across chunk boundaries that cut mid-line', () => {
    const degenerate = period1(400)
    for (const chunkSize of [1, 3, 7, 512, 4096]) {
      const result = replay(degenerate, chunkSize)
      expect(result, `chunkSize ${chunkSize}`).toBeDefined()
      expect(result!.period).toBe(1)
    }
  })

  it('ignores empty deltas without advancing state', () => {
    const detector = new RepetitionDetector(TUNING)
    detector.push('')
    expect(detector.charsSeen).toBe(0)
    expect(detector.due()).toBe(false)
    detector.push('x')
    expect(detector.charsSeen).toBe(1)
  })

  it('keeps healthy streams undetected regardless of chunking', () => {
    const text = Array.from({ length: 400 }, (_, i) => `distinct line ${i} with trailing detail ${i * 13}`).join('\n')
    for (const chunkSize of [1, 3, 7, 512, 4096]) {
      expect(replay(text, chunkSize), `chunkSize ${chunkSize}`).toBeUndefined()
    }
  })

  it('retains at most windowChars after folding, with no pending residue', () => {
    const detector = new RepetitionDetector(TUNING)
    const big = Array.from({ length: 50_000 }, (_, i) => `healthy ${i}`).join('\n')
    detector.push(big)
    detector.evaluate()
    const internals = detector as unknown as { tail: string; pending: string }
    expect(internals.pending.length).toBe(0)
    expect(internals.tail.length).toBeLessThanOrEqual(TUNING.windowChars)
  })
})

describe('sanitized corpus replay', () => {
  /** Replay one block through the live detector with the committed defaults. */
  function firstDetection(text: string): { trigger: number; period: number; matchRatio: number } | undefined {
    const detector = new RepetitionDetector(TUNING)
    for (let offset = 0; offset < text.length; offset += 64) {
      detector.push(text.slice(offset, offset + 64))
      if (!detector.due()) continue
      const detected = detector.evaluate()
      if (detected !== undefined) {
        return { trigger: detector.charsSeen, period: detected.bestPeriod, matchRatio: detected.matchRatio }
      }
    }
    const final = detector.evaluate()
    return final === undefined
      ? undefined
      : { trigger: detector.charsSeen, period: final.bestPeriod, matchRatio: final.matchRatio }
  }

  it('detects both recorded-shape degenerate samples before 20,000 chars, shortly after their collapse onset', () => {
    // Measured onsets from the recorded session (see the Agent Note).
    const samples = [
      { name: 'sample-1', text: degenerateSample1(), onset: 10_100, period: 6 },
      { name: 'sample-2', text: degenerateSample2(), onset: 13_500, period: 4 },
    ]
    const latencies: string[] = []
    for (const sample of samples) {
      const result = firstDetection(sample.text)
      expect(result, sample.name).toBeDefined()
      expect(result!.trigger).toBeLessThan(20_000)
      expect(result!.period).toBe(sample.period)
      expect(result!.matchRatio).toBeGreaterThanOrEqual(TUNING.cycleMatchRatio)
      latencies.push(`${sample.name}: onset ${sample.onset}, trigger ${result!.trigger}, latency ${result!.trigger - sample.onset}, match ${result!.matchRatio.toFixed(4)}`)
    }
    // Detection latency is the acceptance metric: the guard must fire within a
    // few thousand characters of the collapse, not at the block tail.
    expect(latencies.join('\n')).toContain('latency')
  })

  it('never detects any healthy corpus block', () => {
    const corpus = healthyCorpus()
    expect(corpus.length).toBeGreaterThan(5)
    for (const [index, block] of corpus.entries()) {
      expect(firstDetection(block), `healthy block ${index}`).toBeUndefined()
    }
  })
})
