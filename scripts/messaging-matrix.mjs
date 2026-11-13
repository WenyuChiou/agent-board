import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SURFACE_IDS } from '../hooks/messaging.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const start = '<!-- messaging-matrix:start -->'
const end = '<!-- messaging-matrix:end -->'
export const matrixFiles = ['docs/MESSAGING.md']

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
  ['Gemini', ['Web']],
  ['dot / Web Chats', ['dot', 'Claude.ai', 'ChatGPT', 'DeepSeek Web', 'Grok Web']],
]

const words = {
  en: {
    headers: ['Host', 'Surface', 'Tier', 'Primitive', 'Status', 'Live run', 'Receiver', 'Idle', 'Working', 'Ended'],
    intro: 'Generated from receiver records by `node scripts/messaging-matrix.mjs --write`. Progress reporting is separate. Verified requires a `<date>-<host>-live.md` file for that surface; synthetic tests only establish Implemented. Unconnected targets use Tier 4 / [P5] Copy fallback, not a native receiver. Unknown means the roadmap names no primitive for this surface. Idle, Working and Ended give the route for a session in that state: `now`, `stepEnd` (when its step ends), `nextTurn`, `chatOpen` (when the chat opens again), `reopen` or `none`, with the live note that showed it; the board offers Send only on a route with a note.',
    notTested: 'Not tested',
    earlier: 'Earlier run, not counted:',
    unknown: 'Unknown',
    none: 'None',
    noRecord: 'no live note',
    statuses: { Verified: 'Verified', Implemented: 'Implemented', Proposed: 'Proposed' },
  },
  'zh-CN': {
    headers: ['宿主', '运行界面', '层级', '原语', '状态', '现场运行', '接收器', '空闲', '工作中', '已结束'],
    intro: '由接收器记录生成：`node scripts/messaging-matrix.mjs --write`。进度报告与消息接收分别验证。Verified 需要该运行界面的 `<date>-<host>-live.md` 文件；合成测试只能证明 Implemented。未连接的目标使用 Tier 4 / [P5] 复制回退，不代表已有原生接收器。“未知”表示路线图没有为该运行界面指定原语。空闲、工作中、已结束列出接收器在该状态下的路线：`now`、`stepEnd`（这一步结束时）、`nextTurn`、`chatOpen`（会话再次打开时）、`reopen` 或 `none`，并附上证明它的现场记录；看板只在有记录的路线上提供发送。',
    notTested: '未测试',
    earlier: '早期运行（不计入）：',
    unknown: '未知',
    none: '无',
    noRecord: '无现场记录',
    statuses: { Verified: 'Verified（已验证）', Implemented: 'Implemented（已实现）', Proposed: 'Proposed（规划中）' },
  },
  'zh-TW': {
    headers: ['宿主', '執行介面', '層級', '原語', '狀態', '現場執行', '接收器', '閒置', '工作中', '已結束'],
    intro: '由接收器紀錄產生：`node scripts/messaging-matrix.mjs --write`。進度回報與訊息接收分別驗證。Verified 需要該執行介面的 `<date>-<host>-live.md` 檔案；合成測試只能證明 Implemented。未連線的目標使用 Tier 4 / [P5] 複製備援，不代表已有原生接收器。「未知」表示路線圖沒有為該執行介面指定原語。閒置、工作中、已結束列出接收器在該狀態下的路線：`now`、`stepEnd`（這一步結束時）、`nextTurn`、`chatOpen`（對話再次開啟時）、`reopen` 或 `none`，並附上證明它的現場紀錄；看板只在有紀錄的路線上提供傳送。',
    notTested: '未測試',
    earlier: '早期執行（不計入）：',
    unknown: '未知',
    none: '無',
    noRecord: '無現場紀錄',
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
    return entry.isFile() && /\.(?:mjs|tsx?)$/.test(entry.name) ? [path] : []
  })
}

export const hasReceiverRecord = text => /^export\s+const\s+messagingReceiver\b|^export\s*\{[^}]*\bmessagingReceiver\b/m.test(text)

const lines = ['now', 'stepEnd', 'nextTurn', 'chatOpen', 'reopen', 'none']
const states = ['idle', 'working', 'ended']
const isRoute = route => route && lines.includes(route.line) && (route.record === null || isText(route.record)) && Array.isArray(route.surfaces) && (route.record === null || route.surfaces.length > 0) && route.surfaces.every(isText)
const isRoutes = record => record.routes === undefined || isText(record.agent) && ['live', 'mailbox', 'turn'].includes(record.kind) && record.routes !== null && typeof record.routes === 'object' && states.every(state => isRoute(record.routes[state]))
const isText = value => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value)
const surfaceIds = new Set(Object.values(SURFACE_IDS))

export const readReceiverRecords = async (directory = root) => {
  const records = []
  for (const path of [...sourceFiles(join(directory, 'scripts')), ...sourceFiles(join(directory, 'hooks'))]) {
    if (!hasReceiverRecord(readFileSync(path, 'utf8'))) continue
    // Record modules must be safe to import: no host startup or model calls at load time.
    const { messagingReceiver: record } = await import(pathToFileURL(path).href)
    if (!record || !isText(record.host) || ![1, 2, 3, 4].includes(record.tier) || !/^(?:\[P[1-5]\]|unknown)$/.test(record.primitive) || typeof record.isImplemented !== 'boolean' || !Array.isArray(record.surfaces) || !record.surfaces.length || record.surfaces.some(surface => !isText(surface?.name) || surface.evidence !== null && !isText(surface.evidence) || surface.earlier !== undefined && !isText(surface.earlier) || record.routes !== undefined && !surfaceIds.has(surface.id)) || !isRoutes(record)) {
      throw new Error('Invalid messaging receiver record: ' + relative(directory, path))
    }
    if (record.routes !== undefined && states.some(state => record.routes[state].surfaces.some(id => !record.surfaces.some(surface => surface.id === id)))) {
      throw new Error('A route names a surface its record does not list: ' + relative(directory, path))
    }
    records.push({ ...record, source: relative(directory, path).split('\\').join('/') })
  }
  return records
}

const isFile = (directory, path) => {
  try { return lstatSync(join(directory, path)).isFile() } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

const isRealDate = date => {
  const parsed = new Date(date + 'T00:00:00Z')
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

// Roadmap section 8: docs/validation/<date>-<host>-live.md. A surface may follow the host in the name.
const hasLiveRun = (directory, evidence, host) => {
  const match = typeof evidence === 'string' ? /^docs\/validation\/(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)-live\.md$/.exec(evidence) : null
  if (!match || !isRealDate(match[1])) return false
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return (match[2] + '-').startsWith(slug + '-') && isFile(directory, evidence)
}

const hasEarlierRun = (directory, earlier) => typeof earlier === 'string' && /^docs\/validation\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(earlier) && isFile(directory, earlier)

export const receiverRows = (records, directory = root) => records.flatMap(record => record.surfaces.map(surface => {
  // Copy needs no receiver, so a tier 4 surface can be run with nothing implemented.
  const isVerified = (record.isImplemented || record.tier === 4) && hasLiveRun(directory, surface.evidence, record.host)
  return {
    host: record.host, surface: surface.name, surfaceId: surface.id, tier: record.tier, primitive: record.primitive,
    status: isVerified ? 'Verified' : record.isImplemented ? 'Implemented' : 'Proposed',
    routes: record.routes ?? null,
    evidence: isVerified ? surface.evidence : null, earlier: !isVerified && hasEarlierRun(directory, surface.earlier) ? surface.earlier : null, source: record.source,
  }
}))

const cell = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('[', '&#91;').replaceAll(']', '&#93;')
const link = (path, file) => `[${cell(path)}](${file.startsWith('docs/') ? '../' : ''}${path.split('/').map(encodeURIComponent).join('/')})`

// A route's line, and the note that showed it live when the file is there.
// A route recorded for some surfaces only shows its note on those rows.
const routeCell = (route, file, directory, s, surface) => {
  if (!route) return s.none
  if (route.record === null || !route.surfaces.includes(surface)) return `${route.line} · ${s.noRecord}`
  return `${route.line} · ${hasEarlierRun(directory, route.record) ? link(route.record, file) : s.noRecord}`
}

export const renderMatrix = (records, file, directory = root) => {
  const s = words[file.includes('.zh-CN.') ? 'zh-CN' : file.includes('.zh-TW.') ? 'zh-TW' : 'en']
  const rows = receiverRows(records, directory)
  for (const [host, surfaces] of targets) for (const surface of surfaces) {
    if (!rows.some(row => row.host === host && row.surface === surface)) rows.push({ host, surface, tier: 4, primitive: '[P5]', status: 'Proposed', evidence: null, routes: null, source: null })
  }
  rows.sort((a, b) => a.host.localeCompare(b.host, 'en') || a.surface.localeCompare(b.surface, 'en') || String(a.source).localeCompare(String(b.source), 'en'))
  return [
    start, '', s.intro, '',
    '| ' + s.headers.join(' | ') + ' |',
    '| ' + s.headers.map(() => '---').join(' | ') + ' |',
    ...rows.map(row => '| ' + [
      cell(row.host), cell(row.surface), row.tier, row.primitive === 'unknown' ? s.unknown : cell(row.primitive), s.statuses[row.status],
      row.evidence ? link(row.evidence, file) : row.earlier ? s.earlier + ' ' + link(row.earlier, file) : s.notTested,
      row.source ? link(row.source, file) : s.none,
      ...states.map(state => routeCell(row.routes?.[state], file, directory, s, row.surfaceId)),
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
