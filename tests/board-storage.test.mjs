// Real bundled CLI subprocesses in disposable homes; only the requested filesystem calls
// are fault-injected. These are not live agent sessions or actual disk/permission failures.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

const NOW = Date.UTC(2026, 9, 17, 12)
const month = `${new Date(NOW).getFullYear()}-${String(new Date(NOW).getMonth() + 1).padStart(2, '0')}`
const FILE = '## Synthetic\n### Keep the evidence\n- [ ] Verify the result\n'
const HISTORY = '# Existing history\nKEEP_OLD_HISTORY_7C4\n'

const fixture = run => {
  const dir = mkdtempSync(join(tmpdir(), 'board-storage-'))
  try {
    const paths = {
      board: join(dir, 'progress.md'),
      archive: join(dir, `progress-archive-${month}.md`),
      journal: join(dir, `progress-journal-${month}.md`),
    }
    for (const [kind, path] of Object.entries(paths)) writeFileSync(path, kind === 'board' ? FILE : HISTORY)
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: paths.board, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const play = (key, fault = '', lang = 'en', isWatch = false, args = []) => {
      const preload = join(dir, 'fault.cjs')
      writeFileSync(preload, `const fs = require('node:fs')\nconst { syncBuiltinESMExports } = require('node:module')\nDate.now = () => ${NOW}\n${fault}\nsyncBuiltinESMExports()\n`)
      return spawnSync(process.execPath, ['-r', preload, script, '--lang', lang, ...(args.length ? args : isWatch ? ['--watch'] : ['--keys', key])], {
        cwd: dir, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: join(dir, '.codex'), CLAUDE_PROGRESS_FILE: paths.board, NO_COLOR: '1' },
      })
    }
    run({ dir, paths, play })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const failed = (result, path, code) => {
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.ok((result.stdout + result.stderr).includes(path), result.stdout + result.stderr)
  assert.ok((result.stdout + result.stderr).includes(code), result.stdout + result.stderr)
  assert.ok(!(result.stdout + result.stderr).includes('Done:'))
  assert.ok(!(result.stdout + result.stderr).includes('Archived “'))
  assert.ok(!(result.stdout + result.stderr).includes('nothing changed'))
}

test('--tidy reports failed persistence and retries an archive-first sweep without duplicate entries', () => fixture(({ paths, play }) => {
  const file = `## Synthetic\n<!-- auto session=a1b2c312 agent=codex state=done updated=${new Date(NOW - 13 * 3600000).toISOString()} -->\n### Old done\n- [x] Finished\n<!-- /auto session=a1b2c312 -->\n`
  writeFileSync(paths.board, file)
  const fault = `const original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(paths.board)}) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return original(from, to) }`
  failed(play('', fault, 'en', false, ['--tidy']), paths.board, 'EIO')
  assert.equal(readFileSync(paths.board, 'utf8'), file)
  assert.ok(readFileSync(paths.archive, 'utf8').includes('### Old done'))
  assert.equal(readFileSync(paths.journal, 'utf8'), HISTORY)
  const retried = play('', '', 'en', false, ['--tidy'])
  assert.equal(retried.status, 0, retried.stdout + retried.stderr)
  assert.ok(!readFileSync(paths.board, 'utf8').includes('### Old done'))
  assert.equal(readFileSync(paths.archive, 'utf8').split('### Old done').length - 1, 1)
}))

test('Confirm done leaves every step open when its journal cannot be replaced and retries without duplicate ticks', () => fixture(({ paths, play }) => {
  const file = FILE + '- [~] Second new step\n- [-] Canceled\n- [x] Already done\n'
  writeFileSync(paths.board, file)
  const fault = `const original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(paths.journal)}) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return original(from, to) }`
  failed(play('d', fault), paths.journal, 'EIO')
  assert.equal(readFileSync(paths.board, 'utf8'), file)
  assert.equal(readFileSync(paths.journal, 'utf8'), HISTORY)
  assert.equal(play('d').status, 0)
  const history = readFileSync(paths.journal, 'utf8')
  assert.equal(history.split('Verify the result').length - 1, 1)
  assert.equal(history.split('Second new step').length - 1, 1)
  assert.ok(!history.includes('Canceled') && !history.includes('Already done'))
  assert.equal(readFileSync(paths.board, 'utf8'), file.replace('[ ]', '[x]').replace('[~]', '[x]'))
}))

for (const kind of ['board', 'archive', 'journal']) {
  for (const code of ['EACCES', 'EIO']) {
    test(`an ${code} reading the ${kind} aborts the action and preserves every existing file`, () => fixture(({ dir, paths, play }) => {
      const before = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, readFileSync(path, 'utf8')]))
      const fault = `const original = fs.readFileSync\nfs.readFileSync = (path, ...args) => { if (String(path) === ${JSON.stringify(paths[kind])}) throw Object.assign(new Error('injected read failure'), { code: '${code}' }); return original(path, ...args) }`
      failed(play(kind === 'archive' ? 'a' : 'x', fault), paths[kind], code)
      for (const [name, path] of Object.entries(paths)) assert.equal(readFileSync(path, 'utf8'), before[name])
      assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
    }))
  }
}

for (const kind of ['board', 'archive', 'journal']) {
  for (const operation of ['write', 'rename']) {
    test(`a failed ${kind} temp ${operation} preserves old bytes and reports incomplete persistence`, () => fixture(({ dir, paths, play }) => {
      const target = paths[kind]
      const before = readFileSync(target, 'utf8')
      const code = operation === 'write' ? 'ENOSPC' : 'EIO'
      // Simulate a short temp write followed by ENOSPC, rather than only a failure
      // before a temp exists. The destination is still the real fixture file.
      const fault = operation === 'write'
        ? `const original = fs.writeFileSync\nfs.writeFileSync = (path, data, ...args) => { if (String(path).startsWith(${JSON.stringify(target + '.')}) && String(path).endsWith('.board-tmp')) { original(path, 'partial', ...args); throw Object.assign(new Error('injected full disk'), { code: '${code}' }) } return original(path, data, ...args) }`
        : `const original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(target)}) throw Object.assign(new Error('injected rename failure'), { code: '${code}' }); return original(from, to) }`
      failed(play(kind === 'archive' ? 'a' : 'x', fault), target, code)
      assert.equal(readFileSync(target, 'utf8'), before)
      assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
      if (kind !== 'board') assert.equal(readFileSync(paths.board, 'utf8'), FILE)
      assert.ok(readFileSync(paths.archive, 'utf8').includes('KEEP_OLD_HISTORY_7C4'))
      assert.ok(readFileSync(paths.journal, 'utf8').includes('KEEP_OLD_HISTORY_7C4'))
      const recovered = play(kind === 'archive' ? 'a' : 'x')
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr)
      const history = readFileSync(kind === 'archive' ? paths.archive : paths.journal, 'utf8')
      const marker = kind === 'archive' ? '### Keep the evidence' : 'Verify the result'
      assert.equal(history.split(marker).length - 1, 1, history)
    }))
  }
}

test('an archive saved before a failed board replacement survives retry without a duplicate entry', () => fixture(({ paths, play }) => {
  const fault = `const original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(paths.board)}) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return original(from, to) }`
  failed(play('a', fault), paths.board, 'EIO')
  assert.equal(readFileSync(paths.board, 'utf8'), FILE)
  assert.ok(readFileSync(paths.archive, 'utf8').includes('### Keep the evidence'))
  const retry = play('a')
  assert.equal(retry.status, 0, retry.stdout + retry.stderr)
  assert.equal(readFileSync(paths.archive, 'utf8').split('### Keep the evidence').length - 1, 1)
  assert.ok(!readFileSync(paths.board, 'utf8').includes('### Keep the evidence'))
}))

for (const kind of ['longer last step', 'additional step']) {
  test(`an archive entry with a ${kind} does not suppress a distinct shorter task`, () => fixture(({ paths, play }) => {
    const longer = kind === 'longer last step' ? FILE : `${FILE}- [ ] Preserve the extra evidence\n`
    const shorter = kind === 'longer last step' ? FILE.replace('Verify the result', 'Verify') : FILE
    writeFileSync(paths.board, longer)
    assert.equal(play('a').status, 0)
    const before = readFileSync(paths.archive, 'utf8')
    writeFileSync(paths.board, shorter)
    const result = play('a')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const after = readFileSync(paths.archive, 'utf8')
    assert.ok(after.startsWith(before.trimEnd()), after)
    assert.equal(after.split('### Keep the evidence').length - 1, 2, after)
    assert.ok(!readFileSync(paths.board, 'utf8').includes('### Keep the evidence'))
  }))
}

test('a read-back error reports uncertainty without replacing saved history with empty text', () => fixture(({ paths, play }) => {
  const fault = `let replaced = false\nconst rename = fs.renameSync\nconst read = fs.readFileSync\nfs.renameSync = (from, to) => { rename(from, to); if (String(to) === ${JSON.stringify(paths.archive)}) replaced = true }\nfs.readFileSync = (path, ...args) => { if (replaced && String(path) === ${JSON.stringify(paths.archive)}) throw Object.assign(new Error('injected verification failure'), { code: 'EIO' }); return read(path, ...args) }`
  failed(play('a', fault), paths.archive, 'EIO')
  assert.equal(readFileSync(paths.board, 'utf8'), FILE)
  assert.ok(readFileSync(paths.archive, 'utf8').includes('KEEP_OLD_HISTORY_7C4'))
  assert.ok(readFileSync(paths.archive, 'utf8').includes('### Keep the evidence'))
  assert.equal(play('a').status, 0)
  assert.equal(readFileSync(paths.archive, 'utf8').split('### Keep the evidence').length - 1, 1)
}))

test('only ENOENT permits a new journal or archive to be created', () => fixture(({ paths, play }) => {
  rmSync(paths.journal)
  assert.equal(play('x').status, 0)
  assert.ok(readFileSync(paths.journal, 'utf8').includes('Verify the result'))
  writeFileSync(paths.board, FILE)
  rmSync(paths.archive)
  assert.equal(play('a').status, 0)
  assert.ok(readFileSync(paths.archive, 'utf8').includes('### Keep the evidence'))
}))

test('replacing board and history retains their POSIX permission bits despite a restrictive umask', { skip: process.platform === 'win32' }, () => fixture(({ paths, play }) => {
  for (const path of Object.values(paths)) chmodSync(path, 0o640)
  assert.equal(play('x', 'process.umask(0o077)').status, 0)
  writeFileSync(paths.board, FILE)
  assert.equal(play('a', 'process.umask(0o077)').status, 0)
  for (const path of Object.values(paths)) assert.equal(statSync(path).mode & 0o777, 0o640)
}))

test('the error and recovery notice keeps the affected path and error code in every language', () => fixture(({ paths, play }) => {
  const fault = `const original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(paths.archive)}) throw Object.assign(new Error('injected failure'), { code: 'EACCES' }); return original(from, to) }`
  for (const lang of ['en', 'zh-TW', 'zh-CN']) failed(play('a', fault, lang), paths.archive, 'EACCES')
}))

for (const operation of ['statSync', 'chmodSync']) {
  test(`a failed ${operation} preserves original permission metadata and file bytes`, () => fixture(({ dir, paths, play }) => {
    const before = readFileSync(paths.archive, 'utf8')
    const mode = statSync(paths.archive).mode
    const fault = `const original = fs.${operation}\nfs.${operation} = (path, ...args) => { if (String(path).startsWith(${JSON.stringify(paths.archive)})) throw Object.assign(new Error('injected metadata failure'), { code: 'EACCES' }); return original(path, ...args) }`
    failed(play('a', fault), paths.archive, 'EACCES')
    assert.equal(readFileSync(paths.archive, 'utf8'), before)
    assert.equal(statSync(paths.archive).mode, mode)
    assert.equal(readFileSync(paths.board, 'utf8'), FILE)
    assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
  }))
}

test('a read error without an errno is not mistaken for a missing file', () => fixture(({ paths, play }) => {
  const fault = `const original = fs.readFileSync\nfs.readFileSync = (path, ...args) => { if (String(path) === ${JSON.stringify(paths.board)}) throw new Error('injected unknown failure'); return original(path, ...args) }`
  failed(play('x', fault), paths.board, 'UNKNOWN')
  assert.equal(readFileSync(paths.board, 'utf8'), FILE)
}))

test('a journal read that fails only when persisting a tick leaves that step unticked', () => fixture(({ paths, play }) => {
  // pin() and press() each read the journal for the view, before the action's read.
  const fault = `let reads = 0\nconst original = fs.readFileSync\nfs.readFileSync = (path, ...args) => { if (String(path) === ${JSON.stringify(paths.journal)} && ++reads > 2) throw Object.assign(new Error('injected journal read failure'), { code: 'EIO' }); return original(path, ...args) }`
  failed(play('x', fault), paths.journal, 'EIO')
  assert.equal(readFileSync(paths.board, 'utf8'), FILE)
  assert.equal(readFileSync(paths.journal, 'utf8'), HISTORY)
}))

test('a pre-existing temp is neither truncated nor deleted by a failed board action', () => fixture(({ dir, paths, play }) => {
  const fault = `const temp = ${JSON.stringify(paths.board)} + '.' + process.pid + '.' + Date.now().toString(36) + '.board-tmp'\nfs.writeFileSync(temp, 'FOREIGN_TEMP')`
  failed(play('x', fault), paths.board, 'EEXIST')
  assert.equal(readFileSync(paths.board, 'utf8'), FILE)
  const temp = readdirSync(dir).find(name => name.endsWith('.board-tmp'))
  assert.ok(temp)
  assert.equal(readFileSync(join(dir, temp), 'utf8'), 'FOREIGN_TEMP')
}))

test('watch recovers on its next redraw after a read error and restores raw mode on quit', () => fixture(({ paths, play }) => {
  // Mock the TTY boundary only; the real watch loop, timer and bundled filesystem code run.
  const fault = `let reads = 0\nconst original = fs.readFileSync\nfs.readFileSync = (path, ...args) => { if (String(path) === ${JSON.stringify(paths.board)} && ++reads === 1) throw Object.assign(new Error('injected transient read failure'), { code: 'EIO' }); return original(path, ...args) }\nObject.defineProperty(process.stdin, 'isTTY', { value: true })\nprocess.stdin.setRawMode = value => { if (!value) process.stderr.write('RAW_RESTORED\\n') }\nsetTimeout(() => process.stdin.emit('data', 'q'), 2300)`
  const result = play('', fault, 'en', true)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.ok(result.stderr.includes(paths.board) && result.stderr.includes('EIO'))
  assert.ok(result.stdout.includes('Keep the evidence'), result.stdout)
  assert.ok(result.stderr.includes('RAW_RESTORED'))
  assert.equal(readFileSync(paths.board, 'utf8'), FILE)
}))

test('watch can quit while its board remains unreadable', () => fixture(({ paths, play }) => {
  const fault = `const original = fs.readFileSync\nfs.readFileSync = (path, ...args) => { if (String(path) === ${JSON.stringify(paths.board)}) throw Object.assign(new Error('injected persistent read failure'), { code: 'EACCES' }); return original(path, ...args) }\nObject.defineProperty(process.stdin, 'isTTY', { value: true })\nprocess.stdin.setRawMode = value => { if (!value) process.stderr.write('RAW_RESTORED\\n') }\nsetTimeout(() => process.stdin.emit('data', 'q'), 50)`
  const result = play('', fault, 'en', true)
  failed(result, paths.board, 'EACCES')
  assert.ok(result.stderr.includes('RAW_RESTORED'))
}))
