import type { Strings } from './i18n'

// Native command-file syntax is separate from the shell command it contains.
export const boardRun = (path: string, args: string[] = []): string => {
  if (!path || path.includes('\0')) throw new Error('INVALID_BOARD_PATH')
  if (args.length === 0 && /^[A-Za-z0-9 ._:/\\-]+$/.test(path)) return `node "${path}"`
  // Only numeric code points enter the shell. This also keeps native !{...},
  // Markdown backticks and Windows %VAR% expansion away from literal path data.
  const points = Array.from(path, char => char.codePointAt(0)).join(',')
  const extra = args.length === 0 ? '' : `process.argv.push(${args.map(value => `String.fromCodePoint(${Array.from(value, char => char.codePointAt(0)).join(',')})`).join(',')});`
  const source = `const p=String.fromCodePoint(${points});process.argv.splice(1,0,p);${extra}import(require('node:url').pathToFileURL(p).href)`
  return `node --input-type=commonjs -e "${source}" --`
}

export const geminiBoardCommand = (description: string, prompt: string, run: string): string =>
  `# Written by the Agent Board plugin (/progress connect).\ndescription = ${JSON.stringify(description)}\nprompt = ${JSON.stringify(`${prompt}\n\n\`${run}\`\n\n!{${run}}\n`)}\n`

export const opencodeBoardCommand = (description: string, prompt: string, run: string): string =>
  `---\ndescription: ${JSON.stringify(description)}\n---\n\n${prompt}\n\n\`${run}\`\n\n!\`${run}\`\n`

// Hash the same template on every host, including paths escaped by TOML's JSON
// string syntax or encoded for the shell. The placeholder is internal hash data.
export const normalizeCommandPath = (text: string, path: string, placeholder: string): string => {
  const encoded = `String.fromCodePoint(${Array.from(path, char => char.codePointAt(0)).join(',')})`
  return text.split(encoded).join(placeholder).split(JSON.stringify(path).slice(1, -1)).join(placeholder).split(path).join(placeholder)
}

// Share the exact command names with generated prompt hooks and inbox readers. `/board` is
// only recognised: since #868 no command file or text offers it, but an install that kept an
// edited old /board file still has it, and its typed prompt is still a board request.
export const BOARD_REQUEST = /^\s*(?:\/board|[$/]agent-board)\s*$/

// The fields a prompt receipt keeps: who sent it and from which folder, never its words.
export const RECEIPT_SESSION_KEYS = ['session_id', 'sessionId', 'sessionID', 'thread-id', 'thread_id', 'conversation_id', 'conversationId'] as const
export const RECEIPT_FOLDER_KEYS = ['cwd', 'workspaceRoot', 'workspace', 'project_dir', 'directory'] as const
export const RECEIPT_KEYS = [...RECEIPT_SESSION_KEYS, ...RECEIPT_FOLDER_KEYS, 'hook_event_name', 'hookEventName'] as const
// Timeout receipts conservatively keep board requests from answering a question.
export const BOARD_REQUEST_HINTS = ['board', '--chat', '--serve']

// Keep the exact 0.24.2 prompts while installed commands and skills can still expand them.
export const LEGACY_BOARD_PROMPTS = [
  {
    boardCommandPrompt: 'Show me the Agent Board below exactly as it is, in a code block, with the link to the board you can click from its last line. Then tell me in one sentence what needs me first. Do not change any file.',
    boardSkillPrompt: (command: string): string => `If you are replying in a chat app, run \`${command} --chat\` and send what it prints exactly as it is, with no code block and no link. Otherwise run \`${command} --serve\` and show me the Agent Board it prints exactly as it is, in a code block, with the link to the board you can click from its last line. Then tell me in one sentence what needs me first. Do not change any file.`,
    boardChatSkillPrompt: (command: string): string => `Run \`${command} --chat\` and send me what it prints exactly as it is, as plain text and nothing else. Do not add a link, do not open a page, and do not change any file.`,
  },
  {
    boardCommandPrompt: '把下面的 Agent Board 原樣放在程式碼區塊裡給我看，附上最後一行可以點的看板網址，再用一句話說現在最需要我處理的是什麼。不要改任何檔案。',
    boardSkillPrompt: (command: string): string => `如果你是在聊天軟體裡回覆，執行 \`${command} --chat\`，把它印出的內容原樣傳給我，不要用程式碼區塊，也不要附連結。否則執行 \`${command} --serve\`，把它印出的 Agent Board 原樣放在程式碼區塊裡給我看，附上最後一行可以點的看板網址，再用一句話說現在最需要我處理的是什麼。不要改任何檔案。`,
    boardChatSkillPrompt: (command: string): string => `執行 \`${command} --chat\`，把它印出的內容原樣、只用純文字傳給我，不要加別的。不要加網址連結、不要開網頁、不要改任何檔案。`,
  },
  {
    boardCommandPrompt: '把下面的 Agent Board 原样放在代码块里给我看，附上最后一行可以点的看板网址，再用一句话说现在最需要我处理的是什么。不要改任何文件。',
    boardSkillPrompt: (command: string): string => `如果你是在聊天软件里回复，运行 \`${command} --chat\`，把它打印的内容原样发给我，不要用代码块，也不要附链接。否则运行 \`${command} --serve\`，把它打印的 Agent Board 原样放在代码块里给我看，附上最后一行可以点的看板网址，再用一句话说现在最需要我处理的是什么。不要改任何文件。`,
    boardChatSkillPrompt: (command: string): string => `运行 \`${command} --chat\`，把它打印的内容原样、只用纯文本发给我，不要加别的。不要加网址链接、不要开网页、不要改任何文件。`,
  },
]

export const boardRequestWords = (strings: readonly Strings[]): string[] => [...strings, ...LEGACY_BOARD_PROMPTS].flatMap(s =>
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
