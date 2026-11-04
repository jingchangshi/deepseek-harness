/** Per-Team admission shared by allocation, retirement, inbox acceptance, and task ownership. */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Serializes admission without holding the durable journal during child drain. */
export class TeamAdmission {
  private readonly tails = new Map<SessionId, Promise<void>>()

  /**
   * Admit one operation after its Team's previous operation settles.
   * @param rootId - Lead Session identity.
   * @param operation - Complete admission check and effect.
   * @returns The admitted operation's result.
   */
  async run<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(rootId) ?? Promise.resolve()
    const result = prior.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(rootId, tail)
    try {
      return await result
    } finally {
      if (this.tails.get(rootId) === tail) this.tails.delete(rootId)
    }
  }
}
