/** Opt-in SandboxEngine creation probe. The payload stays suspended and is never executed. */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import koffi from 'koffi'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This probe requires native Windows x64')
const dependencyRoot = process.argv[2]
if (!dependencyRoot) throw new Error('Pass an isolated directory containing flatbuffers@25.9.23')
const requireDependency = createRequire(join(resolve(dependencyRoot), 'package.json'))
const { Builder } = requireDependency('flatbuffers')
const builder = new Builder(1024)
const version = builder.createString('0.1.0')
const roots = [process.env.WINDIR, dirname(process.execPath), resolve(dependencyRoot)]
const rootStrings = roots.map(root => builder.createString(root))
builder.startVector(4, rootStrings.length, 4)
for (const offset of rootStrings.toReversed()) builder.addOffset(offset)
const readRoots = builder.endVector()
builder.startObject(12)
builder.addFieldOffset(0, version, 0)
builder.addFieldInt8(1, 1, 0)
builder.addFieldOffset(8, readRoots, 0)
builder.finish(builder.endObject(), 'SBOX')
const specification = Buffer.from(builder.asUint8Array())
const kernel = koffi.load(join(process.env.WINDIR, 'System32', 'kernel32.dll'))
const engine = koffi.load(join(process.env.WINDIR, 'System32', 'processmodel.dll'))
const userenv = koffi.load(join(process.env.WINDIR, 'System32', 'userenv.dll'))
const bind = (library, name, result, args) => library.func('__stdcall', name, result, args)
const lastError = bind(kernel, 'GetLastError', 'uint32', [])
const close = bind(kernel, 'CloseHandle', 'int', ['void *'])
const create = bind(engine, 'Experimental_CreateProcessInSandbox', 'int', [
  'str16', 'void *', 'void *', 'void *', 'int', 'uint32', 'void *', 'str16',
  'void *', 'str16', 'void *', 'uint32', 'void *',
])
const wait = bind(kernel, 'WaitForSingleObject', 'uint32', ['void *', 'uint32'])
const terminate = bind(kernel, 'TerminateProcess', 'int', ['void *', 'uint32'])
const removeProfile = bind(userenv, 'DeleteAppContainerProfile', 'int32', ['str16'])
const identity = `DSH.Readonly.Probe.${randomUUID()}`
const startup = Buffer.alloc(104)
startup.writeUInt32LE(104, 0)
startup.writeUInt32LE(1, 60)
const info = Buffer.alloc(24)
const command = Buffer.from(`"${process.execPath}" --version\0`, 'utf16le')
const result = { identity, api: 'Experimental_CreateProcessInSandbox', created: false, payloadExecuted: false, cleanupFailures: [] }
let processHandle = 0n
let threadHandle = 0n
let quiescent = true
try {
  result.created = create(process.execPath, command, null, null, 0, 4, null,
    resolve(dependencyRoot), startup, identity, specification, specification.length, info) !== 0
  result.win32Error = result.created ? 0 : lastError()
  if (result.created) {
    processHandle = info.readBigUInt64LE(0)
    threadHandle = info.readBigUInt64LE(8)
    quiescent = false
  }
} catch (error) {
  result.failure = error.message
} finally {
  if (processHandle !== 0n) {
    if (!terminate(processHandle, 125)) result.cleanupFailures.push(`TerminateProcess:${lastError()}`)
    result.wait = wait(processHandle, 10000)
    quiescent = result.wait === 0
    if (!quiescent) result.cleanupFailures.push(`WaitForSingleObject:${result.wait}`)
  }
  for (const handle of [threadHandle, processHandle]) {
    if (handle !== 0n && !close(handle)) result.cleanupFailures.push(`CloseHandle:${lastError()}`)
  }
  if (quiescent) {
    result.profileCleanupHresult = removeProfile(identity)
    if (result.profileCleanupHresult !== 0) result.cleanupFailures.push(`DeleteAppContainerProfile:${result.profileCleanupHresult}`)
  } else {
    result.cleanupFailures.push('Profile retained because process quiescence was not established')
  }
  console.log(JSON.stringify(result, null, 2))
}
process.exitCode = result.created && !result.failure && result.cleanupFailures.length === 0 ? 0 : 1
