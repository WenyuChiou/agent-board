import type { Strings } from './i18n'

// Native command-file syntax is separate from the shell command it contains.
export const boardRun = (path: string): string => {
  if (!path || path.includes('\0')) throw new Error('INVALID_BOARD_PATH')
  if (/^[A-Za-z0-9 ._:/\\-]+$/.test(path)) return `node "${path}"`
  // Only numeric code points enter the shell. This also keeps native !{...},
  // Markdown backticks and Windows %VAR% expansion away from literal path data.
  const points = Array.from(path, char => char.codePointAt(0)).join(',')
  const source = `const p=String.fromCodePoint(${points});process.argv.splice(1,0,p);import(require('node:url').pathToFileURL(p).href)`
  return `node --input-type=commonjs -e "${source}" --`
}

export const geminiBoardCommand = (description: string, prompt: string, run: string): string =>
  `# Written by the Agent Board plugin (/progress connect).\ndescription = ${JSON.stringify(description)}\nprompt = ${JSON.stringify(`${prompt}\n\n!{${run} --serve}\n`)}\n`

export const opencodeBoardCommand = (description: string, prompt: string, run: string): string =>
  `---\ndescription: ${JSON.stringify(description)}\n---\n\n${prompt}\n\n!\`${run} --serve\`\n`

// Hash the same template on every host, including paths escaped by TOML's JSON
// string syntax or encoded for the shell. The placeholder is internal hash data.
export const normalizeCommandPath = (text: string, path: string, placeholder: string): string => {
  const encoded = `String.fromCodePoint(${Array.from(path, char => char.codePointAt(0)).join(',')})`
  return text.split(encoded).join(placeholder).split(JSON.stringify(path).slice(1, -1)).join(placeholder).split(path).join(placeholder)
}

// Share the exact command names with generated prompt hooks and inbox readers.
export const BOARD_REQUEST = /^\s*(?:\/board|[$/]agent-board)\s*$/

// Timeout receipts conservatively keep board requests from answering a question.
// The fields a prompt receipt keeps: who sent it and from which folder, never its words.
export const RECEIPT_SESSION_KEYS = ['session_id', 'sessionId', 'sessionID', 'thread-id', 'thread_id', 'conversation_id', 'conversationId'] as const
export const RECEIPT_FOLDER_KEYS = ['cwd', 'workspaceRoot', 'workspace', 'project_dir', 'directory'] as const
export const RECEIPT_KEYS = [...RECEIPT_SESSION_KEYS, ...RECEIPT_FOLDER_KEYS, 'hook_event_name', 'hookEventName'] as const
export const BOARD_REQUEST_HINTS = ['board', '--chat', '--serve']

// The skill names its command twice, for chat and the page. The words after
// each include the sentence earlier releases wrote, so their skills stay known.
export const boardRequestWords = (strings: readonly Strings[]): string[] => strings.flatMap(s =>
  [s.boardCommandPrompt, ...s.boardSkillPrompt('\u0000').split('\u0000').slice(1), ...s.boardChatSkillPrompt('\u0000').split('\u0000').slice(1)].filter(words => words.trim() !== ''),
)

export const boardPromptText = (value: unknown, depth = 0): string => {
  if (typeof value === 'string') return value
  if (depth >= 16 || value === null || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(one => boardPromptText(one, depth + 1)).join('\n')
  const record = value as Record<string, unknown>
  if (record.synthetic === true || record.ignored === true) return ''
  for (const key of ['prompt', 'user_prompt', 'user_message', 'input-messages', 'input_messages', 'last_user_message', 'text', 'content', 'parts', 'message', 'extra']) {
    const found = boardPromptText(record[key], depth + 1)
    if (found.trim() !== '') return found
  }
  return ''
}

export const isBoardRequest = (value: unknown, words: readonly string[]): boolean => {
  const prompt = boardPromptText(value)
  return BOARD_REQUEST.test(prompt) || /<name>agent-board<\/name>/.test(prompt) || words.some(one => prompt.includes(one))
}

// Kept as source so every generated runtime receives identical classifier bytes.
// ASCII single-quoted literals survive PowerShell 5.1's native argument handling.
export const boardPromptHelper = (words: readonly string[]): string => `const boardPromptText = (value, depth = 0) => {
  if (typeof value === 'string') return value
  if (depth >= 16 || value === null || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(one => boardPromptText(one, depth + 1)).join('\\n')
  if (value.synthetic === true || value.ignored === true) return ''
  for (const key of ['prompt', 'user_prompt', 'user_message', 'input-messages', 'input_messages', 'last_user_message', 'text', 'content', 'parts', 'message', 'extra']) {
    const found = boardPromptText(value[key], depth + 1)
    if (found.trim() !== '') return found
  }
  return ''
}
const BOARD_WORDS = [${[...new Set(words)].map(one => `'${JSON.stringify(one).slice(1, -1).replace(/'/g, "\\'").replace(/\\"/g, '\\u0022').replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`).join(',')}]
const isBoardRequest = value => {
  const prompt = boardPromptText(value)
  return /${BOARD_REQUEST.source}/.test(prompt) || prompt.includes('<name>agent-board</name>') || BOARD_WORDS.some(words => prompt.includes(words))
}
`

// Strip prose from valid JSON before it reaches a temporary inbox file. Native
// binding and workspace metadata remain usable by old readers.
export const promptReceiptScript = (words: readonly string[]): string => `${boardPromptHelper(words)}
try {
  const raw = JSON.parse((process.argv[1] ?? require('node:fs').readFileSync(0, 'utf8')).replace(/^\\uFEFF/, ''))
  const record = { ...(raw?.extra ?? {}), ...raw }
  const receipt = {}
  for (const key of [${RECEIPT_KEYS.map(key => `'${key}'`).join(', ')}]) {
    if (typeof record[key] === 'string') receipt[key] = record[key]
  }
  if (Array.isArray(record.workspace_roots)) receipt.workspace_roots = record.workspace_roots.filter(one => typeof one === 'string')
  if (record.board_request === true || isBoardRequest(record)) receipt.board_request = true
  process.stdout.write(JSON.stringify(receipt).replace(/[^\\x20-\\x7e]/g, char => String.fromCharCode(92) + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0')))
} catch {}
`
