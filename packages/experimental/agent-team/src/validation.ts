/** Input normalization shared by Team roster and task commands. */

import { TeamError } from './error.ts'

/**
 * The only accepted write-scope form, stated once so every rejection names the
 * same requirement instead of a bare "invalid scope". A model that supplied an
 * absolute path sees what is storable and why, rather than having to infer it.
 */
const WRITE_SCOPE_FORM = 'write scopes are session-relative file or directory prefixes: no leading "/", no drive letter, and no "." or ".." segment'

/** One concrete accepted example, appended where an obvious retry exists. */
const WRITE_SCOPE_EXAMPLE = 'e.g. "targets/ascend/plan"'

/**
 * Normalize one required human-authored string.
 * @param value - raw input value.
 * @param field - diagnostic field name.
 * @param maxLength - maximum normalized character count.
 * @returns trimmed non-empty text.
 */
export function requiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text.length === 0) throw new TeamError(`${field} must be non-empty`, 'TEAM_INVALID_ARGUMENT')
  if (text.length > maxLength) {
    throw new TeamError(`${field} exceeds ${maxLength} characters`, 'TEAM_INVALID_ARGUMENT')
  }
  return text
}

/**
 * Normalize one session-relative path prefix without treating it as a lock.
 *
 * The stored form is the one a Session's own relative path uses, so two tasks'
 * scopes stay directly comparable. Every rejection names that form and the
 * reason this value cannot be stored: a refusal the model cannot act on is how
 * one bad scope destroys a whole batch of task creations.
 * @param value - user-authored path prefix.
 * @returns normalized slash-separated prefix.
 */
export function writeScope(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (normalized.length === 0) {
    throw new TeamError(
      `invalid write scope ${JSON.stringify(value)}: it names no path; ${WRITE_SCOPE_FORM}, ${WRITE_SCOPE_EXAMPLE}`,
      'TEAM_INVALID_WRITE_SCOPE',
    )
  }
  if (normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)) {
    throw new TeamError(
      `invalid write scope ${JSON.stringify(value)}: an absolute path is not storable; ${WRITE_SCOPE_FORM}; `
      + 'the Team tools convert an absolute path that lies inside the session workspace and refuse one that lies outside it',
      'TEAM_INVALID_WRITE_SCOPE',
    )
  }
  const segments = normalized.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TeamError(
      `invalid write scope ${JSON.stringify(value)}: it contains an empty, "." or ".." segment; ${WRITE_SCOPE_FORM}, ${WRITE_SCOPE_EXAMPLE}`,
      'TEAM_INVALID_WRITE_SCOPE',
    )
  }
  return normalized
}
