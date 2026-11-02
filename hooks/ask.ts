// What a step that waits on the person actually asks of them, which decides what the pane
// offers: a yes or no, a pick among options, a line of input, something to go and do, something
// to look at, or nothing for now because someone else has to answer first.
//
//   ask      offers                                   e.g.
//   confirm  好 · 不要                                 可以推到 main 嗎？
//   choose   one button per option                    用 win rate 還是 Elo？
//   input    a reply box                              API key 放在哪個檔？
//   do       copy the command · 做好了                 在本機跑 setup.ps1
//   review   open the link · 沒問題 · 要改              看一下預覽頁
//   wait     完成 (when it has arrived)                等王教授回推薦信
//   reply    a reply box, when nothing says otherwise

export type AskKind = 'confirm' | 'choose' | 'input' | 'do' | 'review' | 'wait' | 'reply'

export const ASK_KINDS: readonly AskKind[] = ['confirm', 'choose', 'input', 'do', 'review', 'wait', 'reply']

export type Ask = { kind: AskKind; options: string[]; command: string | null; link: string | null }

// The words are matched in Chinese (繁 and 简) and English alike, whichever the pane speaks.
const CHOICE = /(.+?)\s*(?:還是|还是|或是|\bor\b)\s*(.+?)[？?]/i
const CONFIRM =
  /(嗎|吗|可以嗎|可以吗|好嗎|好吗|要不要|可不可以|是否|\bok\?|\bokay\?)\s*[？?]?\s*$|^(可以|要不要|能不能)|^(shall i|should i|can i|may i|is it ok|ok to)\b/i
const DO =
  /^(請|请|please)?\s*(在|到|去|幫我|帮我)?.{0,8}(跑|執行|执行|按|點|点|建立|建|登入|登录|安裝|安装|設定|设置|下載|下载|上傳|上传|貼|贴|開啟|开启|打開|打开|授權|授权|簽|签|寄|送出|push|run|install|click|log ?in|sign in|create|open|paste|set up)/i
const REVIEW = /(看一下|看看|檢查|检查|確認一下|确认一下|過目|过目|review|預覽|预览|校對|校对|讀一下|读一下|take a look|look at|check)/i
const WAIT = /^(等|在等|waiting for|waiting on|wait for|等待)/i
// An English yes/no question: it opens with an auxiliary or an action and ends with `?`.
const YES_NO =
  /^(is|are|can|could|should|shall|may|do|does|did|will|would|ok|okay|push|merge|deploy|ship|delete|remove|proceed|continue|go ahead|approve|publish|release)\b[^?]*\?\s*$/i
const INPUT = /(提供|給我|给我|告訴我|告诉我|哪個|哪个|哪裡|哪里|多少|什麼|什么|幾|几|名稱|名称|路徑|路径|帳號|账号|金鑰|密钥|\bkey\b|token|網址|网址|which|where|what|how many|name of|path)/i
const URL = /https?:\/\/\S+/
const CODE = /`([^`]+)`/

// Whole-question wrappers do not change any inferred reading, including confirmation.
// A wrapper closed inside an option, or a word's own apostrophe, belongs to the text.
const questionWords = (text: string): string => {
  let question = text.trim()
  const pairs: Record<string, string> = { '"': '"', "'": "'", '“': '”', '「': '」', '『': '』', '(': ')' }
  while (question.length >= 2 && pairs[question[0]!] === question[question.length - 1]) {
    const open = question[0]!
    const close = pairs[open]!
    let depth = 1
    let end = -1
    for (let i = 1; i < question.length; i += 1) {
      const char = question[i]
      if (char === '\\') { i += 1; continue }
      // A possessive apostrophe inside a word is not the end of a quoted question.
      if (open === "'" && char === "'" && /[\p{L}\p{N}]/u.test(question[i - 1] ?? '') && /[\p{L}\p{N}]/u.test(question[i + 1] ?? '')) continue
      if (open !== close && char === open) depth += 1
      else if (char === close && --depth === 0) { end = i; break }
    }
    // The first wrapper must enclose the whole question, not just its first option.
    if (end !== question.length - 1) break
    question = question.slice(1, -1).trim()
  }
  return question
}

// Splits `0.6.0 還是 1.0.0？` or a list Claude gave into options. The first option is the
// clause right before 還是 / or, so `先開旗標，還是全部開？` and `A first, or B?` read too.
const optionsOf = (text: string): string[] => {
  const match = CHOICE.exec(text)
  if (match === null) return []
  const clauses = (match[1] ?? '')
    .split(/[，,：:；;。]/)
    .map(one => one.trim())
    .filter(one => one !== '')
  const lead = clauses[clauses.length - 1] ?? ''
  const rest = (match[2] ?? '').trim()
  return [lead.replace(/^(要|用|選|是)/, '').trim(), rest].filter(one => one !== '' && [...one].length <= 24)
}

// A note that opens by asking for a look or an action. These are stricter than REVIEW and DO, which
// find their word anywhere (`按照`, `runs`, `reviewers`) and would take a choice away from its question.
const NOTE_LOOK = /^(請|请|please\s+)?\s*(看一下|看看|檢查|检查|確認一下|确认一下|過目|过目|review(?![\w-])|take a look|look at|check(?![\w-]))/i
const NOTE_ACT = /^(請|请|please\s+)?\s*(在|到|去|幫我|帮我)?\s*(跑|執行|执行|按(?!照)|點|点|run(?![\w-])|install(?![\w-])|click(?![\w-])|open(?![\w-])|paste(?![\w-])|set up(?![\w-])|log ?in(?![\w-])|sign in(?![\w-]))/i
// A note with its own reading decides the kind unless it holds a choice.
const noteDecides = (note: string): boolean =>
  note !== '' && optionsOf(note).length < 2 &&
  (CONFIRM.test(note) || YES_NO.test(note) || URL.test(note) || CODE.test(note) || NOTE_LOOK.test(note) || NOTE_ACT.test(note))

// The question is read before the note, and the first of them with two options is used; a lone
// option reads as before, from the note when there is one, else from the question.
// A note that asks, points to or tells something of its own decides the kind, so the question's
// options are not used then.
const optionsRead = (subject: string, note: string): string[] => {
  const fromQuestion = optionsOf(subject)
  if (fromQuestion.length >= 2 && !noteDecides(note)) return fromQuestion
  const fromNote = optionsOf(note)

  return fromNote.length >= 2 || note !== '' ? fromNote : fromQuestion
}

const kindOf = (value: unknown): AskKind | null => ASK_KINDS.find(one => one === value) ?? null

// What Claude said (`metadata.ask`, `options`, `command`, `link`), else what the words imply.
export const askOf = (
  subject: string,
  note: string,
  given: { ask?: unknown; options?: unknown; command?: unknown; link?: unknown } = {},
): Ask => {
  const subjectWords = questionWords(subject)
  const noteWords = questionWords(note)
  const text = `${noteWords} ${subjectWords}`.trim()
  // What the agent gave wins whole.
  const options = Array.isArray(given.options)
    ? given.options.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map(one => one.trim())
    : optionsRead(subjectWords, noteWords)
  const command = typeof given.command === 'string' && given.command.trim() !== '' ? given.command.trim() : (CODE.exec(text)?.[1] ?? null)
  const link = typeof given.link === 'string' && given.link.trim() !== '' ? given.link.trim() : (URL.exec(text)?.[0] ?? null)
  const said = kindOf(given.ask)
  if (said !== null) return { kind: said, options, command, link }

  const words = noteWords || subjectWords
  let kind: AskKind = 'reply'
  if (WAIT.test(noteWords) || (noteWords === '' && WAIT.test(subjectWords))) kind = 'wait'
  else if (options.length >= 2) kind = 'choose'
  else if (CONFIRM.test(words) || YES_NO.test(words)) kind = 'confirm'
  else if (link !== null || REVIEW.test(words)) kind = 'review'
  else if (command !== null || DO.test(words)) kind = 'do'
  else if (INPUT.test(words)) kind = 'input'

  return { kind, options: kind === 'choose' ? options : [], command, link }
}

// How urgent: something the person can settle now comes before something that waits on
// someone else.
export const askRank = (kind: AskKind): number => (kind === 'wait' ? 2 : kind === 'reply' || kind === 'input' ? 1 : 0)
