import { readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const clockPreload = world => {
  const file = join(world.root, 'clock-preload.mjs')
  writeFileSync(file, `import { readFileSync } from 'node:fs'
const RealDate = Date
let now = Number(process.env.E2E_NOW)
const refresh = () => {
  try {
    const value = Number(readFileSync(process.env.E2E_CLOCK_FILE, 'utf8'))
    if (Number.isFinite(value) && value > 0) now = value
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(0)
    if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) return
    throw error
  }
}
refresh()
function FakeDate(...args) {
  if (!new.target) return new RealDate(now).toString()
  return Reflect.construct(RealDate, args.length ? args : [now], new.target)
}
Object.setPrototypeOf(FakeDate, RealDate)
FakeDate.prototype = RealDate.prototype
FakeDate.now = () => now
globalThis.Date = FakeDate
setInterval(refresh, 100).unref()
`)
  return file
}

export const jump = (world, spec) => {
  const match = /^(\d+)(m|h|d|mo)$/.exec(spec)
  if (!match) throw new Error(`Unsupported clock jump: ${spec}`)
  const scale = { m: 60000, h: 3600000, d: 86400000, mo: 30 * 86400000 }
  const ms = Number(match[1]) * scale[match[2]]
  world.now += ms
  const temporary = world.env.E2E_CLOCK_FILE + '.tmp'
  writeFileSync(temporary, String(world.now))
  // Windows refuses to replace a file a reader child or a virus scanner has open; retry briefly.
  for (let attempt = 1; ; attempt++) {
    try { renameSync(temporary, world.env.E2E_CLOCK_FILE); break } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  world.env.E2E_NOW = String(world.now)
  for (const name of readdirSync(world.inbox)) {
    const file = join(world.inbox, name)
    const stat = statSync(file)
    if (stat.isFile()) utimesSync(file, stat.atime, new Date(stat.mtimeMs - ms))
  }
  return world.now
}
