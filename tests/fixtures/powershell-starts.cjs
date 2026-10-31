// Preload for the Windows page-start tests (--require, or NODE_OPTIONS so the page's server child
// loads it too). It counts every Windows PowerShell start, one line per start in the file named by
// AGENT_BOARD_TEST_PS_LOG, and can make the first start in each process slow, the way a cold first
// start is on a busy computer: AGENT_BOARD_TEST_PS_FIRST_MS is a .NET sleep ahead of the script, so
// no module is touched. Synthetic data only.
const cp = require('node:child_process')
const fs = require('node:fs')
const log = process.env.AGENT_BOARD_TEST_PS_LOG
const slowMs = Number(process.env.AGENT_BOARD_TEST_PS_FIRST_MS || 0)
const role = process.argv.includes('--serve-child') ? 'child' : 'parent'
const isPowerShell = file => /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(String(file))
const isIcacls = file => /(?:^|[\\/])icacls(?:\.exe)?$/i.test(String(file))
let isFirst = true
const note = () => { if (log) try { fs.appendFileSync(log, `${role}\n`) } catch {} }
// What each PowerShell start read and returned, and each icacls call, in a file beside the count,
// so a failing count says which step started the extra PowerShell.
const detail = line => { if (log) try { fs.appendFileSync(`${log}.detail`, `${role} ${line}\n`) } catch {} }

const original = cp.execFileSync
cp.execFileSync = function (file, args, options) {
  if (isIcacls(file) && Array.isArray(args)) detail(`icacls ${args.join(' ')}`)
  if (!isPowerShell(file)) return original.apply(this, arguments)
  note()
  detail(`powershell reads ${options?.env?.AGENT_BOARD_RUNTIME_ACL_PATH ?? '?'}`)
  let output
  if (isFirst && slowMs > 0 && Array.isArray(args)) {
    isFirst = false
    const at = args.indexOf('-Command')
    const slowed = args.map((arg, index) => (index === at + 1 && at >= 0 ? `[System.Threading.Thread]::Sleep(${slowMs}); ${arg}` : arg))
    output = original.call(this, file, slowed, options)
  } else {
    isFirst = false
    output = original.apply(this, arguments)
  }
  detail(`powershell returned ${String(output).trim().split(/\r?\n/).join(' | ')}`)
  return output
}
// Any other way of starting PowerShell is counted too, so a start cannot hide behind another call.
for (const name of ['spawnSync', 'spawn', 'execFile']) {
  const wrapped = cp[name]
  cp[name] = function (file) {
    if (isPowerShell(file)) note()
    return wrapped.apply(this, arguments)
  }
}
require('node:module').syncBuiltinESMExports()
