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
  ['Antigravity', ['Antigravity app', '`agy` in a terminal']],
  ['OpenCode', ['Terminal', 'Desktop App', 'Web UI']],
  ['Cursor', ['IDE (Composer)', 'cursor-agent CLI']],
  ['Grok Build', ['CLI']],
  ['Muse Code', ['CLI']],
  ['Hermes Agent', ['CLI', 'Chat Gateway']],
  ['OpenClaw', ['Gateway', 'WebChat', 'Desktop Control UI']],
  ['DeepSeek Harness', ['Cordis CLI', 'Terminal', 'Desktop', 'Web']],
  ['Gemini CLI', ['CLI']],
  ['Gemini', ['Web']],
  ['dot / Web Chats', ['dot', 'Claude.ai', 'ChatGPT', 'DeepSeek Web', 'Grok Web']],
]

const words = {
  en: {
    headers: ['Host', 'Surface', 'Tier', 'Delivery', 'Status', 'Live run', 'Receiver'],
    intro: 'Generated from receiver records by `node scripts/messaging-matrix.mjs --write`. Progress reporting is separate. Verified requires a `<date>-<host>-live.md` file for that surface; synthetic tests only establish Implemented. Unconnected targets use Tier 4 / Copy fallback, not a native receiver. Unknown means the roadmap names no delivery way for this surface.',
    notTested: 'Not tested',
    earlier: 'Earlier run, not counted:',
    unknown: 'Unknown',
    none: 'None',
    statuses: { Verified: 'Verified', Implemented: 'Implemented', Proposed: 'Proposed' },
    // Plain words for the roadmap's primitive codes; the records keep the codes.
    delivery: { '[P1]': 'Live push', '[P2]': 'Background wakeup', '[P3]': 'Wait for a message', '[P4]': 'Step-end pickup', '[P5]': 'Copy', unknown: 'Unknown' },
    tierLine: 'Tier is how directly the board can reach the session: 1 wakes it at once, 2 catches it at the end of a step, 3 queues a message for its next turn, 4 copies the message for the person to paste.',
    notes: { boardStarted: 'The board can also reach `agy` it started itself in headless mode, which owns its input stream; that is a delivery way, not a surface of its own. See {adapter}.' },
  },
  'zh-CN': {
    headers: ['宿主', '运行界面', '层级', '投递方式', '状态', '现场运行', '接收器'],
    intro: '由接收器记录生成：`node scripts/messaging-matrix.mjs --write`。进度报告与消息接收分别验证。Verified 需要该运行界面的 `<date>-<host>-live.md` 文件；合成测试只能证明 Implemented。未连接的目标使用 Tier 4 / 复制回退，不代表已有原生接收器。“未知”表示路线图没有为该运行界面指定投递方式。',
    notTested: '未测试',
    earlier: '早期运行（不计入）：',
    unknown: '未知',
    none: '无',
    statuses: { Verified: 'Verified（已验证）', Implemented: 'Implemented（已实现）', Proposed: 'Proposed（规划中）' },
    delivery: { '[P1]': 'Live push（实时推送）', '[P2]': 'Background wakeup（后台唤醒）', '[P3]': 'Wait for a message（等待消息）', '[P4]': 'Step-end pickup（步骤结束时接收）', '[P5]': 'Copy（复制）', unknown: '未知' },
    tierLine: '层级是联系会话的直接程度：1 立即唤醒，2 在步骤结束时接收，3 为下一轮排队消息，4 复制消息由用户粘贴。',
    notes: { boardStarted: 'board 也可以联系它自己以 headless 模式启动的 `agy`，由其拥有输入流；那是一种投递方式，不是独立的运行界面。见 {adapter}。' },
  },
  'zh-TW': {
    headers: ['宿主', '執行介面', '層級', '投遞方式', '狀態', '現場執行', '接收器'],
    intro: '由接收器紀錄產生：`node scripts/messaging-matrix.mjs --write`。進度回報與訊息接收分別驗證。Verified 需要該執行介面的 `<date>-<host>-live.md` 檔案；合成測試只能證明 Implemented。未連線的目標使用 Tier 4 / 複製備援，不代表已有原生接收器。「未知」表示路線圖沒有為該執行介面指定投遞方式。',
    notTested: '未測試',
    earlier: '早期執行（不計入）：',
    unknown: '未知',
    none: '無',
    statuses: { Verified: 'Verified（已驗證）', Implemented: 'Implemented（已實作）', Proposed: 'Proposed（規劃中）' },
    delivery: { '[P1]': 'Live push（即時推送）', '[P2]': 'Background wakeup（背景喚醒）', '[P3]': 'Wait for a message（等待訊息）', '[P4]': 'Step-end pickup（步驟結束時接收）', '[P5]': 'Copy（複製）', unknown: '未知' },
    tierLine: '層級是聯繫工作階段的直接程度：1 立即喚醒，2 在步驟結束時接收，3 為下一輪排隊訊息，4 複製訊息由使用者貼上。',
    notes: { boardStarted: 'board 也可以聯繫它自己以 headless 模式啟動的 `agy`，由其擁有輸入串流；那是一種投遞方式，不是獨立的執行介面。見 {adapter}。' },
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

const isText = value => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value)

export const readReceiverRecords = async (directory = root) => {
  const records = []
  for (const path of [...sourceFiles(join(directory, 'scripts')), ...sourceFiles(join(directory, 'hooks'))]) {
    if (!hasReceiverRecord(readFileSync(path, 'utf8'))) continue
    // Record modules must be safe to import: no host startup or model calls at load time.
    const { messagingReceiver: record } = await import(pathToFileURL(path).href)
    if (!record || !isText(record.host) || ![1, 2, 3, 4].includes(record.tier) || !/^(?:\[P[1-5]\]|unknown)$/.test(record.primitive) || typeof record.isImplemented !== 'boolean' || !Array.isArray(record.surfaces) || !record.surfaces.length || record.surfaces.some(surface => !isText(surface?.name) || surface.evidence !== null && !isText(surface.evidence) || surface.earlier !== undefined && !isText(surface.earlier) || surface.note !== undefined && !isText(surface.note) || surface.isDelivery !== undefined && typeof surface.isDelivery !== 'boolean' || surface.isDelivery === true && !isText(surface.note))) {
      throw new Error('Invalid messaging receiver record: ' + relative(directory, path))
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

export const receiverRows = (records, directory = root) => records.flatMap(record => record.surfaces.filter(surface => surface.isDelivery !== true).map(surface => {
  // Copy needs no receiver, so a tier 4 surface can be run with nothing implemented.
  const isVerified = (record.isImplemented || record.tier === 4) && hasLiveRun(directory, surface.evidence, record.host)
  return {
    host: record.host, surface: surface.name, tier: record.tier, primitive: record.primitive,
    status: isVerified ? 'Verified' : record.isImplemented ? 'Implemented' : 'Proposed',
    evidence: isVerified ? surface.evidence : null, earlier: !isVerified && hasEarlierRun(directory, surface.earlier) ? surface.earlier : null, source: record.source, note: surface.note ?? null,
  }
}))

// A way of delivering the person does not open is a note on its surface's row, not a row.
export const deliveryNotes = records => records.flatMap(record => record.surfaces.filter(surface => surface.isDelivery === true).map(surface => ({ host: record.host, surface: surface.name, note: surface.note, source: record.source })))

const cell = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('[', '&#91;').replaceAll(']', '&#93;')
const link = (path, file) => `[${cell(path)}](${file.startsWith('docs/') ? '../' : ''}${path.split('/').map(encodeURIComponent).join('/')})`

export const renderMatrix = (records, file, directory = root) => {
  const s = words[file.includes('.zh-CN.') ? 'zh-CN' : file.includes('.zh-TW.') ? 'zh-TW' : 'en']
  const rows = receiverRows(records, directory)
  for (const [host, surfaces] of targets) for (const surface of surfaces) {
    if (!rows.some(row => row.host === host && row.surface === surface)) rows.push({ host, surface, tier: 4, primitive: '[P5]', status: 'Proposed', evidence: null, source: null, note: null })
  }
  rows.sort((a, b) => a.host.localeCompare(b.host, 'en') || a.surface.localeCompare(b.surface, 'en') || String(a.source).localeCompare(String(b.source), 'en'))
  const notes = deliveryNotes(records)
  // A row carries a marker when its own surface names a note, or a delivery way names it.
  const noted = new Set([...rows.filter(row => row.note).map(row => row.host + '\n' + row.surface), ...notes.map(note => note.host + '\n' + note.surface)])
  // The delivery way's own module is the note's link; a row's note falls back to its own source.
  const adapterByNote = new Map(notes.map(note => [note.note, note.source]))
  const seenNotes = new Set()
  const noteLines = []
  const addNote = (key, source) => {
    if (!key || seenNotes.has(key)) return
    const template = s.notes[key]
    if (!template) throw new Error('Unknown messaging matrix note: ' + key)
    seenNotes.add(key)
    noteLines.push('* ' + template.replace('{adapter}', link(source, file)))
  }
  for (const row of rows) if (row.note) addNote(row.note, adapterByNote.get(row.note) ?? row.source)
  for (const note of notes) addNote(note.note, note.source)
  return [
    start, '', s.intro, '',
    '| ' + s.headers.join(' | ') + ' |',
    '| ' + s.headers.map(() => '---').join(' | ') + ' |',
    ...rows.map(row => '| ' + [
      cell(row.host), cell(row.surface) + (noted.has(row.host + '\n' + row.surface) ? ' *' : ''), row.tier, cell(s.delivery[row.primitive] ?? row.primitive), s.statuses[row.status],
      row.evidence ? link(row.evidence, file) : row.earlier ? s.earlier + ' ' + link(row.earlier, file) : s.notTested,
      row.source ? link(row.source, file) : s.none,
    ].join(' | ') + ' |'),
    '', ...noteLines, s.tierLine,
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
