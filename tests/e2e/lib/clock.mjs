import { readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The world's clock starts at the real time, runs at real speed and moves forward on a jump. The
// clock file holds its base and the real time that base was set, so every faked child and the
// test agree. A frozen clock would let a product retry reuse a temp name it stamped a moment ago.
export const clockText = clock => `${clock.base} ${clock.at}`

export const clockPreload = world => {
  const file = join(world.root, 'clock-preload.mjs')
  writeFileSync(file, `import { readFileSync } from 'node:fs'
const RealDate = Date
let base = Number(process.env.E2E_NOW)
let at = Number(process.env.E2E_CLOCK_AT)
const refresh = () => {
  try {
    const [value, from] = readFileSync(process.env.E2E_CLOCK_FILE, 'utf8').trim().split(' ').map(Number)
    if (Number.isFinite(value) && value > 0 && Number.isFinite(from) && from > 0) {
      base = value
      at = from
    }
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(0)
    if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) return
    throw error
  }
}
refresh()
if (!Number.isFinite(base + at)) throw new Error('The e2e clock is unset')
const now = () => base + (RealDate.now() - at)
function FakeDate(...args) {
  if (!new.target) return new RealDate(now()).toString()
  return Reflect.construct(RealDate, args.length ? args : [now()], new.target)
}
Object.setPrototypeOf(FakeDate, RealDate)
FakeDate.prototype = RealDate.prototype
FakeDate.now = now
globalThis.Date = FakeDate
setInterval(refresh, 100).unref()
`)
  return file
}

const JUMP_UNITS = { m: 60000, h: 3600000, d: 86400000, mo: 30 * 86400000 }

export const jump = (world, spec) => {
  const match = /^(\d+)(m|h|d|mo)$/.exec(spec)
  if (!match) throw new Error(`Unsupported clock jump: ${spec}`)
  const ms = Number(match[1]) * JUMP_UNITS[match[2]]
  const real = Date.now()
  world.clock.base += real - world.clock.at + ms
  world.clock.at = real
  const temporary = world.env.E2E_CLOCK_FILE + '.tmp'
  writeFileSync(temporary, clockText(world.clock))
  // Windows refuses to replace a file a reader child or a virus scanner has open; retry briefly.
  for (let attempt = 1; ; attempt++) {
    try { renameSync(temporary, world.env.E2E_CLOCK_FILE); break } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  world.env.E2E_NOW = String(world.clock.base)
  world.env.E2E_CLOCK_AT = String(world.clock.at)
  for (const name of readdirSync(world.inbox)) {
    const file = join(world.inbox, name)
    const stat = statSync(file)
    // Seconds as a number keep the part below a millisecond, which a Date would drop.
    if (stat.isFile()) utimesSync(file, stat.atime, (stat.mtimeMs - ms) / 1000)
  }
  return world.clock.base
}
