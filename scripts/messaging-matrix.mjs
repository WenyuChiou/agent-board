import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const start = '<!-- messaging-matrix:start -->'
const end = '<!-- messaging-matrix:end -->'
export const matrixFiles = ['docs/MESSAGING.md', 'README.md', 'README.zh-CN.md', 'README.zh-TW.md']

// These are coverage targets, not receiver claims. A matching receiver record replaces
// the fallback automatically; adding a receiver never changes another receiver's file.
const targets = [
  ['Claude Code', ['CLI', 'Desktop Code']],
  ['Claude Desktop', ['Chat']],
  ['Codex', ['CLI', 'Daemon', 'Desktop App']],
  ['Antigravity', ['2.0 Desktop App', 'IDE', 'agy TUI']],
  ['OpenCode', ['CLI TUI', 'Desktop App', 'Web UI']],
  ['Cursor', ['IDE (Composer)', 'cursor-agent CLI']],
  ['Grok Build', ['CLI']],
  ['Muse Code', ['CLI']],
  ['Hermes Agent', ['CLI', 'Chat Gateway']],
  ['OpenClaw', ['Gateway', 'WebChat', 'Desktop Control UI']],
  ['DeepSeek Harness', ['Cordis CLI', 'TUI', 'Desktop', 'Web']],
  ['Gemini CLI', ['CLI']],
  ['Gemini', ['Web']],
  ['dot / Web Chats', ['dot', 'Claude.ai', 'ChatGPT', 'DeepSeek Web', 'Grok Web']],
]

const words = {
  en: {
    headers: ['Host', 'Surface', 'Tier', 'Primitive', 'Status', 'Live run', 'Receiver'],
    intro: 'Generated from receiver records by `node scripts/messaging-matrix.mjs --write`. Progress reporting is separate. Verified requires a dated live-run file for that exact surface; synthetic tests only establish Implemented. Unconnected targets use Tier 4 / [P5] Copy fallback, not a native receiver. Unknown means the roadmap names no primitive for this surface.',
    notTested: 'Not tested',
    unknown: 'Unknown',
    none: 'None',
    statuses: { Verified: 'Verified', Implemented: 'Implemented', Proposed: 'Proposed' },
  },
  'zh-CN': {
    headers: ['宿主', '运行界面', '层级', '原语', '状态', '现场运行', '接收器'],
    intro: '由接收器记录生成：`node scripts/messaging-matrix.mjs --write`。进度报告与消息接收分别验证。Verified 需要该运行界面的带日期现场记录；合成测试只能证明 Implemented。未连接的目标使用 Tier 4 / [P5] 复制回退，不代表已有原生接收器。“未知”表示路线图没有为该运行界面指定原语。',
    notTested: '未测试',
    unknown: '未知',
    none: '无',
    statuses: { Verified: 'Verified（已验证）', Implemented: 'Implemented（已实现）', Proposed: 'Proposed（规划中）' },
  },
  'zh-TW': {
    headers: ['宿主', '執行介面', '層級', '原語', '狀態', '現場執行', '接收器'],
    intro: '由接收器紀錄產生：`node scripts/messaging-matrix.mjs --write`。進度回報與訊息接收分別驗證。Verified 需要該執行介面的附日期現場紀錄；合成測試只能證明 Implemented。未連線的目標使用 Tier 4 / [P5] 複製備援，不代表已有原生接收器。「未知」表示路線圖沒有為該執行介面指定原語。',
    notTested: '未測試',
    unknown: '未知',
    none: '無',
    statuses: { Verified: 'Verified（已驗證）', Implemented: 'Implemented（已實作）', Proposed: 'Proposed（規劃中）' },
  },
}

const sourceFiles = directory => {
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && /\.(?:mjs|ts)$/.test(entry.name) ? [path] : []
  })
}

const isText = value => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value)

export const readReceiverRecords = async (directory = root) => {
  const records = []
  for (const path of [...sourceFiles(join(directory, 'scripts')), ...sourceFiles(join(directory, 'hooks'))]) {
    if (!/^export const messagingReceiver\s*=/m.test(readFileSync(path, 'utf8'))) continue
    // Record modules must be safe to import: no host startup or model calls at load time.
    const { messagingReceiver: record } = await import(pathToFileURL(path).href)
    if (!record || !isText(record.host) || ![1, 2, 3, 4].includes(record.tier) || !/^(?:\[P[1-5]\]|unknown)$/.test(record.primitive) || typeof record.isImplemented !== 'boolean' || !Array.isArray(record.surfaces) || !record.surfaces.length || record.surfaces.some(surface => !isText(surface?.name) || surface.evidence !== null && !isText(surface.evidence))) {
      throw new Error('Invalid messaging receiver record: ' + relative(directory, path))
    }
    records.push({ ...record, source: relative(directory, path).split('\\').join('/') })
  }
  return records
}

const hasLiveRun = (directory, evidence) => {
  if (typeof evidence !== 'string' || !/^docs\/validation\/\d{4}-\d{2}-\d{2}-[^/\\]+\.md$/.test(evidence)) return false
  try { return lstatSync(join(directory, evidence)).isFile() } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

export const receiverRows = (records, directory = root) => records.flatMap(record => record.surfaces.map(surface => {
  const isVerified = record.isImplemented && hasLiveRun(directory, surface.evidence)
  return {
    host: record.host, surface: surface.name, tier: record.tier, primitive: record.primitive,
    status: isVerified ? 'Verified' : record.isImplemented ? 'Implemented' : 'Proposed',
    evidence: isVerified ? surface.evidence : null, source: record.source,
  }
}))

const cell = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('[', '&#91;').replaceAll(']', '&#93;')
const link = (path, file) => `[${cell(path)}](${file.startsWith('docs/') ? '../' : ''}${path.split('/').map(encodeURIComponent).join('/')})`

export const renderMatrix = (records, file, directory = root) => {
  const s = words[file.includes('.zh-CN.') ? 'zh-CN' : file.includes('.zh-TW.') ? 'zh-TW' : 'en']
  const rows = receiverRows(records, directory)
  for (const [host, surfaces] of targets) for (const surface of surfaces) {
    if (!rows.some(row => row.host === host && row.surface === surface)) rows.push({ host, surface, tier: 4, primitive: '[P5]', status: 'Proposed', evidence: null, source: null })
  }
  rows.sort((a, b) => a.host.localeCompare(b.host, 'en') || a.surface.localeCompare(b.surface, 'en') || String(a.source).localeCompare(String(b.source), 'en'))
  return [
    start, '', s.intro, '',
    '| ' + s.headers.join(' | ') + ' |',
    '| ' + s.headers.map(() => '---').join(' | ') + ' |',
    ...rows.map(row => '| ' + [
      cell(row.host), cell(row.surface), row.tier, row.primitive === 'unknown' ? s.unknown : cell(row.primitive), s.statuses[row.status],
      row.evidence ? link(row.evidence, file) : s.notTested,
      row.source ? link(row.source, file) : s.none,
    ].join(' | ') + ' |'),
    '', end,
  ].join('\n')
}

export const updateMatrix = (text, table, file) => {
  const first = text.indexOf(start), last = text.indexOf(end)
  if (first < 0 || last < first || text.indexOf(start, first + start.length) !== -1 || text.indexOf(end, last + end.length) !== -1) throw new Error('Missing or duplicate messaging matrix markers: ' + file)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return text.slice(0, first) + table.replaceAll('\n', newline) + text.slice(last + end.length)
}

export const main = async (argv = process.argv.slice(2)) => {
  if (argv.length !== 1 || !['--write', '--check'].includes(argv[0])) throw new Error('Use --write or --check')
  const records = await readReceiverRecords()
  // Validate every destination before writing any of them.
  const changes = matrixFiles.map(file => {
    const path = join(root, file), before = readFileSync(path, 'utf8')
    return { file, path, before, after: updateMatrix(before, renderMatrix(records, file), file) }
  }).filter(change => change.before !== change.after)
  if (argv[0] === '--check') {
    if (changes.length) {
      console.error('Messaging matrix is stale: ' + changes.map(change => change.file).join(', ') + '. Run node scripts/messaging-matrix.mjs --write')
      return 1
    }
    console.log('Messaging matrix is up to date.')
    return 0
  }
  for (const change of changes) writeFileSync(change.path, change.after, 'utf8')
  console.log('Updated ' + changes.length + ' messaging matrix file(s).')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code }).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
