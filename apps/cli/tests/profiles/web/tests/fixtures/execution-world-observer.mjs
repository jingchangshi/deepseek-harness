export const inject = ['executionWorldIdentity']

export function apply(ctx) {
  const receive = message => {
    if (message === 'stop') {
      process.emit('SIGTERM')
      return
    }
    if (message?.command !== 'resolve') return
    void ctx.executionWorldIdentity.resolve(message.root).then(
      workspaceId => process.send({ workspaceId }),
      error => process.send({ error: String(error) }),
    )
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
  process.send({ kind: 'identity-ready' })
}
