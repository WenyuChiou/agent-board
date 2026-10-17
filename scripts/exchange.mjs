import { mkdir, readFile, writeFile, rename, unlink, rmdir, readdir, lstat, realpath } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindingOf, commandOf, receiptOf, progressBlock } from '../hooks/exchange.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'

const json = value => JSON.stringify(value, null, 2) + '\n'
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const safe = async path => {
  if ((await lstat(path)).isSymbolicLink()) throw new Error('SYMLINK_UNSUPPORTED')
  return path
}
const existing = async path => { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

// Exclusive directory creation works on Windows without hard-link privileges. A crash
// leaves the lock in place: the receiver must reconcile it before attempting delivery.
const create = async (path, value) => {
  const lock = path + '.lock'
  await mkdir(lock, { mode: 0o700 })
  const temp = path + '.' + randomBytes(12).toString('hex') + '.tmp'
  try {
    if (await existing(path)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    await writeFile(temp, json(value), { flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
    await rmdir(lock)
  }
}
const replace = async (path, text) => {
  const temp = path + '.' + randomBytes(12).toString('hex') + '.tmp'
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

export const exchange = async (action, directory, input = {}) => {
  const root = resolve(directory)
  if (action === 'init') {
    const binding = bindingOf({ ...input, version: 1, id: randomBytes(16).toString('hex') })
    await mkdir(root, { mode: 0o700 })
    await mkdir(join(root, 'commands'), { mode: 0o700 })
    await mkdir(join(root, 'receipts'), { mode: 0o700 })
    await create(join(root, 'binding.json'), binding)
    return { binding, native: 'unsupported', mode: 'cooperative-file' }
  }
  await safe(root)
  if (await realpath(root) !== root) throw new Error('SYMLINK_UNSUPPORTED')
  const binding = bindingOf(await read(await safe(join(root, 'binding.json'))))
  await safe(join(root, 'commands'))
  await safe(join(root, 'receipts'))
  const paths = command => ({ command: join(root, 'commands', command.id + '.json'), receipt: join(root, 'receipts', command.id + '.json') })
  const savedCommand = async id => {
    const requested = commandOf({ version: 1, id, binding: binding.id, agent: binding.agent, session: binding.session, text: 'lookup', turn: '' }, binding)
    const stored = commandOf(await read(await safe(paths(requested).command)), binding)
    if (stored.id !== requested.id) throw new Error('COMMAND_ID_MISMATCH')
    return stored
  }
  const getReceipt = async command => {
    const path = paths(command).receipt
    if (await existing(path + '.lock')) return { version: 1, id: command.id, binding: command.binding, status: 'uncertain' }
    return await existing(path) ? receiptOf(await read(await safe(path)), command) : null
  }
  if (action === 'report') {
    const { language = 'en', ...report } = input
    if (!['en', 'zh-TW', 'zh-CN'].includes(language)) throw new Error('UNSUPPORTED_LANGUAGE')
    const strings = { en: EN, 'zh-TW': ZH_TW, 'zh-CN': ZH_CN }[language]
    const path = join(root, 'progress.md')
    if (await existing(path)) await safe(path)
    await replace(path, progressBlock(report, binding, Date.now(), strings))
    return { status: 'reported', path }
  }
  if (action === 'enqueue') {
    const command = commandOf(input, binding)
    try { await create(paths(command).command, command) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const old = await savedCommand(command.id)
      if (JSON.stringify(old) !== JSON.stringify(command)) throw new Error('ID_CONFLICT')
    }
    const receipt = await getReceipt(command)
    return { command, receipt, status: receipt?.status ?? 'queued' }
  }
  if (action === 'take') {
    const command = await savedCommand(input.id)
    if (input.binding !== binding.id || input.session !== binding.session || input.agent !== binding.agent) throw new Error('TARGET_MISMATCH')
    // Reserve before any transport mutation. A crashed consumer leaves uncertainty,
    // which requires reconciliation rather than automatic replay.
    const receipt = { version: 1, id: command.id, binding: binding.id, status: 'uncertain' }
    try { await create(paths(command).receipt, receipt) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      return { status: 'already-claimed', receipt: await getReceipt(command) }
    }
    return { status: 'claimed', command, receipt }
  }
  if (action === 'ack') {
    const command = await savedCommand(input.id)
    if (await existing(paths(command).receipt + '.lock')) throw new Error('CLAIM_INCOMPLETE')
    const next = receiptOf(input, command)
    if (next.status === 'uncertain') throw new Error('TERMINAL_RECEIPT_REQUIRED')
    const old = await getReceipt(command)
    if (old === null) throw new Error('CLAIM_REQUIRED')
    if (old.status !== 'uncertain') {
      if (old.status !== next.status) throw new Error('RECEIPT_CONFLICT')
      return old
    }
    // A terminal decision is immutable even when two consumers race.
    const decision = paths(command).receipt + '.decision'
    try { await create(decision, next) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const decided = receiptOf(await read(await safe(decision)), command)
      if (decided.status !== next.status) throw new Error('RECEIPT_CONFLICT')
    }
    await replace(paths(command).receipt, json(next))
    return next
  }
  if (action === 'status') {
    const commands = []
    for (const name of (await readdir(join(root, 'commands'))).filter(name => name.endsWith('.json')).sort()) {
      const command = await savedCommand(name.slice(0, -5))
      commands.push({ id: command.id, status: (await getReceipt(command))?.status ?? 'queued' })
    }
    return { binding, mode: 'cooperative-file', native: 'unsupported', commands }
  }
  throw new Error('UNKNOWN_ACTION')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, directory] = process.argv.slice(2)
    if (!action || !directory) throw new Error('USAGE: node scripts/exchange.mjs ACTION DIRECTORY < input.json')
    let body = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      body += chunk
      if (body.length > 32768) throw new Error('INPUT_TOO_LARGE')
    }
    console.log(json(await exchange(action, directory, body.trim() === '' ? {} : JSON.parse(body))))
  } catch (error) {
    console.error(json({ status: 'failed', error: error.message }))
    process.exitCode = 1
  }
}
