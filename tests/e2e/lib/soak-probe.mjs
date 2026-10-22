import fs from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'

// Preloaded into the soak world's board processes only. It counts what the board does (file
// operations by kind and requests served) and appends one JSON line every 10 s and at exit. It
// changes nothing the board does: every wrapper returns and throws what the original does. Its own
// writes are left out of the counts by file name, since Node's appendFileSync writes through the
// wrapped exports. It counts no process launches, so it never touches the process module the L0
// safety scan guards.
const dir = process.env.E2E_SOAK_PROBE_DIR
const role = process.argv.includes('--serve-child') ? 'serve' : process.argv.includes('--watch') ? 'watch' : 'other'

if (dir && role !== 'other') {
  const append = fs.appendFileSync
  const file = join(dir, `${role}-${process.pid}.jsonl`)
  // The clock preload reads this file every 100 ms in every process; it is not the board's work.
  const clockFile = process.env.E2E_CLOCK_FILE
  const ops = {}
  let requests = 0

  const kinds = ['open', 'read', 'readFile', 'write', 'writeFile', 'appendFile', 'stat', 'lstat', 'fstat', 'readdir', 'opendir', 'exists', 'access', 'rename', 'unlink', 'rm', 'rmdir', 'mkdir', 'copyFile', 'realpath', 'link', 'chmod', 'utimes']
  const count = kind => { ops[kind] = (ops[kind] ?? 0) + 1 }

  // The wrapper keeps the original's own properties (the promisify hooks of exists, read and
  // write, realpath.native, the name and the length). Only the outermost call counts: Node's own
  // fs calls go through the wrapped exports too (exists calls access, readFileSync calls open and read).
  let depth = 0
  const wrap = (original, onCall) => {
    const wrapper = function (...args) {
      if (depth === 0) onCall(args)
      depth += 1
      try { return original.apply(this, args) } finally { depth -= 1 }
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(original))) {
      if (key !== 'prototype') Object.defineProperty(wrapper, key, descriptor)
    }
    for (const symbol of Object.getOwnPropertySymbols(original)) Object.defineProperty(wrapper, symbol, Object.getOwnPropertyDescriptor(original, symbol))
    if (typeof original.native === 'function') wrapper.native = wrap(original.native, onCall)
    return wrapper
  }
  // appendFileSync writes through the wrapped writeFileSync, so the probe's own file is left out by name.
  const counter = kind => args => {
    if (args[0] === file || (clockFile && args[0] === clockFile)) return
    count(kind)
  }
  const patch = (target, name, kind) => {
    if (typeof target[name] === 'function') target[name] = wrap(target[name], counter(kind))
  }
  for (const kind of kinds) {
    patch(fs, kind, kind)
    patch(fs, `${kind}Sync`, kind)
    patch(fs.promises, kind, kind)
  }

  const emit = http.Server.prototype.emit
  http.Server.prototype.emit = function (event, ...rest) {
    if (event === 'request') requests += 1
    return emit.call(this, event, ...rest)
  }
  syncBuiltinESMExports()

  const sample = () => {
    try {
      const memory = process.memoryUsage()
      const line = JSON.stringify({ at: Math.round(performance.timeOrigin + performance.now()), pid: process.pid, role, rss: memory.rss, heapUsed: memory.heapUsed, ops: { ...ops }, requests })
      append(file, `${line}\n`)
    } catch {
      // A probe that cannot write stays silent; the board must not notice it.
    }
  }
  sample()
  setInterval(sample, 10000).unref()
  process.on('exit', sample)
}
