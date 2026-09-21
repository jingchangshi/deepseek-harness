/**
 * Pure line-cycle repetition detector over a bounded trailing window. It holds
 * no reference to the agent runtime: callers feed text deltas and read one
 * verdict per amortized evaluation, so the class is directly unit-testable and
 * its memory is bounded by the configured window.
 * @module @deepseek-ai/dsh-degenerate-output-guard/detector
 */

/** Thresholds and window sizing for one detector instance. */
export interface DetectorTuning {
  /** Size in characters of the trailing window evaluated per check. */
  windowChars: number
  /** Minimum characters between evaluations, amortizing the scan. */
  checkEveryChars: number
  /** Minimum non-empty trimmed lines before a window is judged. */
  minWindowLines: number
  /** Windows whose distinct-line ratio exceeds this are healthy. */
  distinctLineRatio: number
  /** Largest line period scanned for a cycle. */
  cyclePeriodMax: number
  /** Period match fraction required to call the window degenerate. */
  cycleMatchRatio: number
}

/** Measured facts of one degenerate window; no raw text, only counts. */
export interface Degeneration {
  /** Line period of the best-matching cycle. */
  bestPeriod: number
  /** Match fraction of the best period: equal-neighbor lines over comparable pairs. */
  matchRatio: number
  /** Non-empty trimmed lines in the evaluated window. */
  windowLines: number
  /** Distinct-line ratio of the evaluated window. */
  distinctRatio: number
}

/**
 * Evaluate one fixed window for a short-period line cycle and return the
 * measured facts when it is degenerate.
 *
 * The window splits into non-empty trimmed lines. Below `minWindowLines` the
 * sample is too small to judge. A distinct-line ratio above
 * `distinctLineRatio` is healthy, so legitimately varied output exits before
 * the period scan. Otherwise the best match over periods `1..cyclePeriodMax`
 * — equal adjacent lines at distance `p`, over the `n - p` comparable pairs —
 * must reach `cycleMatchRatio`. Preferring the first (smallest) maximal match
 * reports the dominant period, not its multiples.
 *
 * Complexity per evaluation is O(window + lines × cyclePeriodMax) with a
 * transient line array; the caller amortizes it with `checkEveryChars`.
 *
 * @param window - trailing text to evaluate; may cut mid-line at its head.
 * @param tuning - thresholds and window sizing.
 * @returns the degeneration facts, or `undefined` when the window is healthy or too small.
 */
export function evaluateWindow(window: string, tuning: DetectorTuning): Degeneration | undefined {
  const lines: string[] = []
  const distinct = new Set<string>()
  for (const raw of window.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    lines.push(line)
    distinct.add(line)
  }
  const n = lines.length
  if (n < tuning.minWindowLines) return undefined
  const distinctRatio = distinct.size / n
  if (distinctRatio > tuning.distinctLineRatio) return undefined
  const maxPeriod = Math.min(tuning.cyclePeriodMax, n - 1)
  let bestPeriod = 0
  let bestMatch = 0
  for (let period = 1; period <= maxPeriod; period++) {
    let matches = 0
    for (let i = period; i < n; i++) {
      if (lines[i] === lines[i - period]) matches++
    }
    const ratio = matches / (n - period)
    if (ratio > bestMatch) {
      bestMatch = ratio
      bestPeriod = period
    }
  }
  if (bestMatch >= tuning.cycleMatchRatio) {
    return { bestPeriod, matchRatio: bestMatch, windowLines: n, distinctRatio }
  }
  return undefined
}

/**
 * Streaming accumulator for one open block: text deltas land in a pending
 * buffer and fold into the trailing window only at evaluation points, so the
 * retained state stays within `windowChars + checkEveryChars` characters
 * regardless of how long the block runs.
 */
export class RepetitionDetector {
  /** Total characters pushed for this block, including whitespace. */
  charsSeen = 0

  private readonly tuning: DetectorTuning
  private tail = ''
  private pending = ''
  private checkedAtChars = 0

  constructor(tuning: DetectorTuning) {
    this.tuning = tuning
  }

  /**
   * Buffer one streamed delta. Folding is deferred to {@link evaluate}, so the
   * per-call cost is one string append, never a window rescan.
   * @param delta - text fragment appended to the block.
   */
  push(delta: string): void {
    if (delta.length === 0) return
    this.pending += delta
    this.charsSeen += delta.length
  }

  /**
   * Whether at least `checkEveryChars` characters have accumulated since the
   * last evaluation — the amortization gate that keeps healthy output at
   * O(1) per delta.
   * @returns `true` when an evaluation is due.
   */
  due(): boolean {
    return this.charsSeen - this.checkedAtChars >= this.tuning.checkEveryChars
  }

  /**
   * Fold pending deltas into the trailing window and evaluate it.
   * @returns the degeneration facts, or `undefined` when healthy or too small.
   */
  evaluate(): Degeneration | undefined {
    this.checkedAtChars = this.charsSeen
    if (this.pending.length > 0) {
      this.tail = (this.tail + this.pending).slice(-this.tuning.windowChars)
      this.pending = ''
    }
    return evaluateWindow(this.tail, this.tuning)
  }
}
