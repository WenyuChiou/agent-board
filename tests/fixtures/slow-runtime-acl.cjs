const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')

// All ACL output belongs to this synthetic account; no system program is launched.
Object.defineProperty(process, 'platform', { value: 'win32' })
Object.defineProperty(process.stdin, 'isTTY', { value: true })
Object.defineProperty(process.stdout, 'isTTY', { value: true })
process.stdin.setRawMode = () => {}
const sid = 'S-1-5-21-100-200-300-1001'
const progress = path.join(path.dirname(process.argv[1]), 'progress.md')
const folder = path.join(process.env.XDG_RUNTIME_DIR, 'agent-board')
fs.mkdirSync(folder, { recursive: true })
const name = `agent-board-${createHash('sha256').update(path.resolve(progress)).digest('hex').slice(0, 16)}.json`
fs.writeFileSync(path.join(folder, name), JSON.stringify({ pid: process.pid, port: 1, url: 'http://127.0.0.1:1/?t=synthetic', path: progress }))
const original = { sync: cp.execFileSync, async: cp.execFile }
const report = { sync: 0, active: 0, maxActive: 0, acl: 0, draws: [], delay: 0 }
const isAcl = (file, args) => /powershell\.exe$/i.test(file) || args.includes('/save')
const isCommand = file => /(?:whoami|icacls|powershell)\.exe$/i.test(String(file))
const output = (file, args, options) => {
  if (/whoami\.exe$/i.test(file)) return `"SYNTHETIC\\user","${sid}"\n`
  if (/powershell\.exe$/i.test(file)) return options.env.AGENT_BOARD_RUNTIME_ACL_PATH.split('|').map(target =>
    `O:${sid}G:SYD:${target === folder ? 'P(A;OICI;' : 'AI(A;ID;'}FA;;;${sid})`).join('\n')
  if (args.includes('/save')) fs.writeFileSync(args[args.indexOf('/save') + 1], `address.json\r\nD:AI(A;ID;FA;;;${sid})\r\n`, 'utf16le')
  return ''
}
cp.execFileSync = (file, args, options) => {
  if (!isCommand(file)) return original.sync(file, args, options)
  report.sync += 1
  if (isAcl(file, args)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
  return output(file, args, options)
}
cp.execFile = (file, args, options, callback) => {
  if (!isCommand(file)) return original.async(file, args, options, callback)
  const slow = isAcl(file, args)
  report.active += 1
  report.maxActive = Math.max(report.maxActive, report.active)
  if (slow) report.acl += 1
  const finish = () => {
    report.active -= 1
    callback(null, output(file, args, options), '')
  }
  if (slow) setTimeout(finish, 3000)
  else queueMicrotask(finish)
  return {}
}
require('node:module').syncBuiltinESMExports()
let first, last
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (text, ...rest) => {
  const result = write(text, ...rest)
  if (first === undefined && String(text).startsWith('\x1b[H')) {
    first = last = performance.now()
    const source = fs.readFileSync(progress, 'utf8')
    const heartbeat = setInterval(() => {
      const now = performance.now()
      report.delay = Math.max(report.delay, now - last - 10)
      last = now
    }, 10)
    heartbeat.unref()
    for (const [ms, title] of [[100, 'First scheduled question'], [2100, 'Second scheduled question']]) {
      setTimeout(() => fs.writeFileSync(progress, source.replace(/### [^\n]+/, `### ${title}`)), ms)
    }
    setTimeout(() => {
      process.stderr.write(`ACL_SCHEDULE ${JSON.stringify(report)}\n`)
      process.exit(0)
    }, 6500)
  }
  for (const title of ['First scheduled question', 'Second scheduled question']) {
    if (String(text).includes(title)) report.draws.push({ title, ms: performance.now() - first, pending: report.active > 0 })
  }
  return result
}
