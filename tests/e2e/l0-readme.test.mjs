import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// L0: what a newcomer meets first, before installing anything. Links and image files across the
// three READMEs are #207's sync test; this journey keeps to the picture at the top.
const root = new URL('../../', import.meta.url)
// A Windows checkout may hold CRLF line ends, and the README checks read lines.
const read = name => readFileSync(fileURLToPath(new URL(name, root)), 'utf8').replace(/\r\n/g, '\n')
const exists = name => existsSync(fileURLToPath(new URL(name, root)))
// The README in each language, its language tag, and the words its alt text uses to say a picture is synthetic.
const READMES = [
  ['README.md', 'en', 'Synthetic data.'],
  ['README.zh-TW.md', 'zh-TW', '合成資料。'],
  ['README.zh-CN.md', 'zh-CN', '合成数据。'],
]
// Each README's sections in the order a newcomer reads them, the same eight in every language.
const SECTIONS = {
  en: ['Quick start', 'Key commands', 'Supported agents', 'What you see', 'How it works', 'Troubleshooting', 'Documentation', 'License'],
  'zh-TW': ['快速開始', '常用指令', '支援的 agent', '你會看到什麼', '怎麼運作', '疑難排解', '文件', '授權'],
  'zh-CN': ['快速开始', '常用命令', '支持的 agent', '你会看到什么', '怎么运作', '问题排查', '文档', '许可证'],
}

// The seven scenes' captions (the lines, the line under them and the words in amber), Claude Code's
// question, and the page's receipt once the answer reached Claude Code (claudeDelivered in the
// strings tables), in each locale. Scenes 3 and 7 say the same sentence.
const SET1 = {
  en: { caption: ['A board that shows', 'which AI agent is', 'waiting on you.'], sub: ['Claude Code, Codex, Cursor and more,', 'on your own computer.', 'Questions show up in seconds.'], amber: ['waiting on you'], subAmber: [] },
  'zh-TW': { caption: ['AI agent 進度看板'], sub: ['agent 一停下來等你回答，', '幾秒內就排到看板最上面，', '不用再一個個視窗找。'], amber: [], subAmber: ['等你回答'] },
  'zh-CN': { caption: ['AI agent 进度看板'], sub: ['agent 一停下来等你回复，', '几秒内就排到看板最上面，', '不用再挨个窗口找。'], amber: [], subAmber: ['等你回复'] },
}
const SCENES = {
  en: [[
    { caption: ['Which AI agent is', 'waiting on you?'], amber: ['waiting on you'] },
    { caption: ['One stopped to ask.', 'You were in', 'another window.'] },
    SET1.en,
    { caption: ['Its question goes', 'to the top.'], sub: ['On the board within seconds.'] },
    { caption: ['Answer it', 'on the board.'], sub: ['Claude Code gets it directly;', 'Codex and Antigravity on their', 'next turn; copy for the rest.'] },
    { caption: ['One command', 'to start.'], sub: ['On your computer.', 'One Markdown file. No account.'] },
    SET1.en,
  ], 'Blue or green?', "Delivered. Waiting for Claude's reply."],
  'zh-TW': [[
    { caption: ['現在哪個 AI agent', '在等你？'], amber: ['在等你'] },
    { caption: ['有一個停下來問你', '你人在別的視窗'] },
    SET1['zh-TW'],
    { caption: ['它的問題', '排到最上面'], sub: ['幾秒內就上看板。'] },
    { caption: ['在看板上回答'], sub: ['不用切視窗：Claude Code 直接收到，', 'Codex、Antigravity 下一輪收到，', '其他 agent 一鍵複製。'] },
    { caption: ['一行指令', '就能開始'], sub: ['在你的電腦上跑，', '一個 Markdown 檔，不用帳號。'] },
    SET1['zh-TW'],
  ], '藍色還是綠色？', '已送達，正在等 Claude 回覆。'],
  'zh-CN': [[
    { caption: ['现在哪个 AI agent', '在等你？'], amber: ['在等你'] },
    { caption: ['有一个停下来问你', '你在别的窗口'] },
    SET1['zh-CN'],
    { caption: ['它的提问', '排到最上面'], sub: ['几秒内就出现在看板上。'] },
    { caption: ['在看板上回复'], sub: ['不用切窗口：Claude Code 直接收到，', 'Codex、Antigravity 下一轮收到，', '其他 agent 一键复制。'] },
    { caption: ['一行命令', '就能开始'], sub: ['在你的电脑上运行，', '一个 Markdown 文件，不用账号。'] },
    SET1['zh-CN'],
  ], '蓝色还是绿色？', '已送达，正在等 Claude 回复。'],
}
// The first-run command stays on screen in every frame, reduced motion included.
const COMMAND = 'npx @wenyuchiou/agent-board'
// The ten integrations the header names, in the support matrix's order (#407).
const INTEGRATIONS = ['Claude Code', 'Codex', 'Antigravity', 'OpenCode', 'Cursor', 'Grok Build', 'Muse Code', 'Hermes Agent', 'OpenClaw', 'DeepSeek Harness']
// Each agent's board command, and the agents whose command is not run live yet.
const BOARD_COMMANDS = { 'Claude Code': '/progress', Codex: '$agent-board' }
const boardCommand = agent => BOARD_COMMANDS[agent] ?? '/agent-board'
// A live run is recorded in docs/parity-matrix.json with its date, host version and surface (#466).
// An agent leaves this list in the same change that records its run.
const NOT_RUN_LIVE = ['Antigravity', 'Cursor', 'Grok Build', 'Muse Code', 'DeepSeek Harness']
// The agents whose only check is the synthetic home: their row in the table of checks has no host version or record.
const SYNTHETIC_ONLY = ['Cursor', 'Muse Code']
// The setup and board commands still offered after #865 made the page the default.
const OLD_COMMANDS = ['claude plugin marketplace add WenyuChiou/agent-board', 'claude plugin install agent-board@agent-board', '/hooks', '/progress', '$agent-board', '/agent-board', 'node "$HOME/.agent-board/agent-board.mjs"', 'node "$HOME/.agent-board/agent-board.mjs" --lan', 'node "$HOME/.agent-board/agent-board.mjs" --json', 'node "$HOME/.agent-board/agent-board.mjs" --codex-doctor --agent codex']
// The code each surface row holds: terminal or desktop, browser, agent read, one agent's setup.
const SURFACE_COMMANDS = [['node "$HOME/.agent-board/agent-board.mjs"'], ['node "$HOME/.agent-board/agent-board.mjs" --lan'], ['node "$HOME/.agent-board/agent-board.mjs" --json'], ['node "$HOME/.agent-board/agent-board.mjs" --codex-doctor --agent codex']]
// Per language: the strip's label, the two command subsections, the caveat on a command
// not run live yet, the board's page heading, and how each surface row starts.
const WORDS = {
  en: { label: 'Integrations', inAgent: 'Open the board in your agent', anywhere: 'Open the board anywhere', checked: 'How each agent was checked', old: ['Untested'], notLive: '(checked in a synthetic home, not run live yet)', page: "The board's page", surfaces: ['A terminal or desktop', 'A phone on the same Wi-Fi', 'An agent reading the board', "Check one agent's setup"] },
  'zh-TW': { label: '整合', inAgent: '在你的 agent 裡打開看板', anywhere: '在任何地方打開看板', checked: '各個 agent 是怎麼驗證的', old: ['未驗證', '還沒驗證'], notLive: '（在測試環境檢查過，還沒實機執行）', page: '看板的網頁', surfaces: ['終端機或桌面', '同一個 Wi-Fi 的手機', 'Agent 讀取看板', '檢查某個 agent 的設定'] },
  'zh-CN': { label: '集成', inAgent: '在你的 agent 里打开看板', anywhere: '在任何地方打开看板', checked: '每个 agent 是怎么验证的', old: ['未验证', '还没验证'], notLive: '（在测试环境检查过，还没实机运行）', page: '看板的网页', surfaces: ['终端或桌面', '同一个 Wi-Fi 的手机', 'Agent 读取看板', '检查某个 agent 的设置'] },
}
// A piece of text as a pattern that matches it and nothing else.
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// What a heading holds: the lines after it, up to the next heading of its level or above.
const section = (text, heading, level = 2) => {
  const lines = text.split('\n')
  const start = lines.indexOf(`${'#'.repeat(level)} ${heading}`)
  if (start < 0) return undefined
  const next = new RegExp(`^#{1,${level}} `)
  const end = lines.findIndex((line, i) => i > start && next.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}
// The anchor GitHub gives a heading: lower case, punctuation dropped, each space a hyphen.
const anchorOf = heading => `#${heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')}`
// Everything before a README's first section: the title, the cover and the header rows under it.
const headerOf = text => text.slice(0, text.indexOf('\n## '))
// The cells of each Markdown table row that starts with `start`, trimmed.
const rows = (text, start) => text.split('\n').filter(line => line.startsWith(start)).map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
// The first table in a piece of text, so the prose and the tables after it stay out.
const firstTable = text => {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('|'))
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'))
  return start < 0 ? '' : lines.slice(start, end < 0 ? undefined : end).join('\n')
}
const codeSpans = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1])
// The class lists of every <g> that holds the character at `at`, outermost first. Counting the
// opening and closing tags keeps an inner group from hiding the one around it.
const groupsAround = (svg, at) => {
  const open = []
  for (const tag of svg.slice(0, at).matchAll(/<g\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<\/g\s*>/g)) {
    if (tag[0].startsWith('</')) open.pop()
    else if (!tag[1].endsWith('/')) open.push((tag[1].match(/\bclass\s*=\s*"([^"]*)"/)?.[1] ?? '').split(/\s+/))
  }
  return open
}

describe('L0 discover and install from the README', () => {
  test('L0 README: each README opens with its title, tagline, badges and cover, and its Quick start holds the install commands, --lan with its QR code and an I-use start for each main agent', () => {
    const agents = ['Claude Code', 'Codex', 'Antigravity', 'OpenCode']
    const taglines = { en: 'See what every AI coding agent is doing, and answer the one that needs you, from one board.', 'zh-TW': '每個 AI coding agent 在做什麼，一個看板看完；哪個在等你，就在那裡回它。', 'zh-CN': '每个 AI coding agent 在做什么，一个看板看完；哪个在等你，就在那里回它。' }
    const labels = { en: agent => `I use ${agent}:`, 'zh-TW': agent => `我用 ${agent}：`, 'zh-CN': agent => `我用 ${agent}：` }
    const phone = { en: /phone.*same Wi-?Fi/i, 'zh-TW': /同一.*Wi-?Fi.*手機/i, 'zh-CN': /同一.*Wi-?Fi.*手机/i }
    const qr = { en: /QR/i, 'zh-TW': /QR/i, 'zh-CN': /二维码/ }
    const trust = { en: /\btrust\b/i, 'zh-TW': /信得過/, 'zh-CN': /信得过/ }
    const exposure = { en: /not encrypted.*anyone who has it can open/i, 'zh-TW': /沒有加密.*拿到的人都能(?:打開|開啟)/, 'zh-CN': /没有加密.*拿到的人都能打开/ }
    for (const [name, lang] of READMES) {
      const text = read(name)
      const cover = text.indexOf(`docs/images/cover-${lang}-dark.svg`)
      assert.ok(cover >= 0, `${name}: the cover exists`)
      // The top is the project's name, one line on what it does, its badges, then the picture.
      const top = text.slice(0, cover).split('\n').filter(Boolean)
      assert.equal(top[0], '<h1 align="center"><img alt="Agent Board" src="docs/images/brand/agent-board-logo.svg" width="360"></h1>', `${name}: the logo, which follows the reader's theme, is the title and comes first`)
      assert.equal(top[1], `<p align="center"><b>${taglines[lang]}</b></p>`, `${name}: the original tagline follows the title`)
      assert.match(top[2], /^<p align="center"><a href="LICENSE"><img [^>]*src="https:\/\/img\.shields\.io\//, `${name}: the badges follow the tagline`)
      assert.ok(!text.slice(0, cover).includes('npx @wenyuchiou/agent-board'), `${name}: no install command comes before the cover`)
      const first = section(text, SECTIONS[lang][0])
      assert.ok(first, `${name}: Quick start exists`)
      const node = first.indexOf('Node.js 22')
      const install = /```(?:sh|bash)\r?\n(npx @wenyuchiou\/agent-board setup\r?\nnpx @wenyuchiou\/agent-board)\r?\n```/.exec(first)
      assert.ok(node >= 0 && install && install.index > node, `${name}: Quick start gives Node 22, then setup and the board command in order`)
      const lanLines = first.split('\n').filter(line => line.includes('npx @wenyuchiou/agent-board --lan'))
      assert.equal(lanLines.length, 1, `${name}: one phone route in Quick start`)
      const lan = lanLines[0]
      assert.ok(first.indexOf(lan) > install.index + install[0].length, `${name}: LAN follows the install commands`)
      assert.match(lan, qr[lang], `${name}: LAN mentions a QR code`)
      assert.match(lan, phone[lang], `${name}: the phone is on the same Wi-Fi`)
      assert.match(lan, trust[lang], `${name}: the LAN trust limit is stated`)
      assert.match(lan, exposure[lang], `${name}: the link is unencrypted and anyone with it can open the page`)
      const starts = first.split('\n').filter(line => /^- \*\*(?:I use |我用 )/.test(line))
      assert.equal(starts.length, agents.length, `${name}: one start for each of the four agents`)
      const allStarts = text.split('\n').filter(line => /^- \*\*(?:I use |我用 )/.test(line))
      assert.deepEqual(allStarts, starts, `${name}: no I-use starts are duplicated or added outside Quick start`)
      let at = first.indexOf(lan)
      for (const [i, agent] of agents.entries()) {
        const line = starts[i]
        assert.ok(line.startsWith(`- **${labels[lang](agent)}**`), `${name}: start ${i + 1} is ${agent}`)
        assert.ok(first.indexOf(line) > at, `${name}: ${agent}'s start is after the LAN line and preceding starts`)
        assert.ok(codeSpans(line).includes(agent === 'Claude Code' ? '/agent-board' : boardCommand(agent)), `${name}: ${agent}'s start names its board command`)
        at = first.indexOf(line)
      }
      assert.ok(starts[2].includes(WORDS[lang].notLive), `${name}: Antigravity is marked not run live`)
    }
  })

  test('the quick start runs as written without a global install', () => {
    for (const [name, lang] of READMES) {
      const quick = section(read(name), SECTIONS[lang][0])
      assert.ok(quick, `${name}: Quick start exists`)
      const commands = /```(?:sh|bash)\n([\s\S]*?)\n```/.exec(quick)?.[1]
      assert.ok(commands, `${name}: Quick start has a command block`)
      assert.ok(!commands.split('\n').some(line => /^\s*agent-board(?:\s|$)/.test(line)), `${name}: Quick start cannot require the global command`)
      assert.ok(commands.split('\n').includes('npx @wenyuchiou/agent-board'), `${name}: Quick start opens the board with npx`)
    }

    for (const name of [...READMES.map(([readme]) => readme), 'docs/GUIDE.md', 'docs/GUIDE.zh-TW.md', 'docs/GUIDE.zh-CN.md']) {
      const text = read(name)
      const installedAt = text.indexOf('npm install -g @wenyuchiou/agent-board')
      assert.ok(installedAt >= 0, `${name}: explains the global install`)
      for (const match of text.matchAll(/(?:^|\n)[ \t]*agent-board(?:[ \t]+[^\n]*)?|`(agent-board(?:[ \t]+[^`]*)?)`/g)) {
        if (match.index >= installedAt) continue
        // A sentence may name the shorter command while explaining how to install it.
        const restOfSentence = text.slice(match.index + match[0].length, installedAt)
        assert.ok(match[1] === 'agent-board' && /^[^.!?。！？\n]*$/.test(restOfSentence), `${name}: ${match[0]} precedes the global install`)
      }
    }
  })

  test('the Quick start links to the uninstall steps in the guide in every language', () => {
    const links = {
      en: 'docs/GUIDE.md#update-and-uninstall',
      'zh-TW': 'docs/GUIDE.zh-TW.md#更新與移除',
      'zh-CN': 'docs/GUIDE.zh-CN.md#更新和卸载',
    }
    const words = {
      en: /\b(?:remove|uninstall)\b/i,
      'zh-TW': /移除/,
      'zh-CN': /卸载/,
    }
    for (const [name, lang] of READMES) {
      const quick = section(read(name), SECTIONS[lang][0])
      assert.ok(quick, `${name}: Quick start exists`)
      const line = quick.split('\n').find(l => words[lang].test(l) && l.includes(links[lang]))
      assert.ok(line, `${name}: Quick start has a line on how to remove it linking to ${links[lang]}`)
    }
  })

  test('L0 README: each README describes Send as docs/MESSAGING.md does and its cover alt text agrees', () => {
    // Match the relationships in each local statement, rather than technical implementation
    // vocabulary or isolated words that could appear in an unrelated paragraph.
    const checks = {
      en: {
        starts: ['- **Answer the one that is waiting.**', '- **Tell an agent something without going there.**', '- **Answer** a question:'],
        connected: /messaging (?:is )?on.*session (?:is )?connected/i,
        actions: [/\*\*Send\*\*/i, /send it/i, /\*\*Send\*\*/i],
        noSend: /\b(?:do not|don't|never)\s+(?:\*\*)?send/i,
        fallback: /(?:otherwise (?:press \*\*Copy\*\*|\*\*Copy\*\*|copy|the board copies)|or \*\*Copy\*\*)/i,
        answerQueue: /\*\*Send\*\* queues your answer.*confirmation from that session means it was received/i,
        copyPress: /otherwise press \*\*Copy\*\*/i,
        altConnected: /messaging (?:is )?on.*Codex session connected.*Send.*queues/i,
        accepted: /accepted.*(?:does not|doesn't|not).*delivered/i,
        receipt: /confirmation.*session.*means (?:it was )?(?:received|receipt).*not.*(?:work|task).*done/i,
        lan: /LAN page (?:has )?no messaging/i,
      },
      'zh-TW': {
        starts: ['- **回覆在等你的那一個。**', '- **不用切過去也能交代事情。**', '- **回覆**問題：'],
        connected: /(?<![未沒])開(?:了|啟).*訊息功能.*對話(?:也)?連上/,
        actions: [/\*\*傳送\*\*/, /(?:送過去|傳送)/, /\*\*傳送\*\*/],
        noSend: /(?:不要|不能|不可|禁止)(?:\*\*)?(?:傳送|送過去)/,
        fallback: /(?:否則|或)(?:看板幫你|按)?(?:\*\*)?複製/,
        answerQueue: /\*\*傳送\*\*.*排進佇列.*對話.*確認.*才代表收到/,
        copyPress: /否則按\*\*複製\*\*/,
        altConnected: /(?<![未沒])開(?:了|啟).*訊息功能.*Codex.{0,12}對話(?:也)?連上.*(?:傳送|送出).*排.*佇列/,
        accepted: /已接受.*不代表.*送到/,
        receipt: /對話.*確認(?:才)?代表收到.*不代表.*做完/,
        lan: /LAN 網頁沒有訊息功能/,
      },
      'zh-CN': {
        starts: ['- **回复在等你的那一个。**', '- **不用切过去也能交代事情。**', '- **回复**问题：'],
        connected: /(?<![未没])开(?:了|启).*消息功能.*对话(?:也)?连上/,
        actions: [/\*\*发送\*\*/, /(?:送过去|发送)/, /\*\*发送\*\*/],
        noSend: /(?:不要|不能|不可|禁止)(?:\*\*)?(?:发送|送过去)/,
        fallback: /(?:否则|或)(?:看板帮你|按)?(?:\*\*)?复制/,
        answerQueue: /\*\*发送\*\*.*排进队列.*对话.*确认.*才代表收到/,
        copyPress: /否则按\*\*复制\*\*/,
        altConnected: /(?<![未没])开(?:了|启).*消息功能.*Codex.{0,12}对话(?:也)?连上.*(?:发送|送出).*排.*队列/,
        accepted: /已接受.*不代表.*送到/,
        receipt: /对话.*确认(?:才)?代表收到.*不代表.*做完/,
        lan: /LAN 网页没有消息功能/,
      },
    }
    for (const [name, lang] of READMES) {
      const text = read(name)
      const what = section(text, SECTIONS[lang][3]) ?? ''
      const pageSection = section(text, WORDS[lang].page, 3) ?? ''
      const [answer, tell] = checks[lang].starts.slice(0, 2).map(start => what.split('\n').find(line => line.startsWith(start)) ?? '')
      const page = pageSection.split('\n').find(line => line.startsWith(checks[lang].starts[2])) ?? ''
      for (const [index, [label, line]] of [['answer', answer], ['tell', tell], ['page', page]].entries()) {
        assert.ok(line, `${name}: ${label} explanation exists`)
        assert.match(line, checks[lang].connected, `${name}: ${label} requires messaging on and a connected session`)
        assert.match(line, checks[lang].actions[index], `${name}: ${label} offers Send`)
        assert.doesNotMatch(line, checks[lang].noSend, `${name}: ${label} does not forbid Send`)
        assert.match(line, checks[lang].fallback, `${name}: ${label} offers Copy otherwise`)
      }
      assert.match(answer, checks[lang].answerQueue, `${name}: Send queues the answer and session confirmation means receipt`)
      for (const line of [answer, tell]) assert.match(line, checks[lang].copyPress, `${name}: Copy requires a button press`)
      assert.ok(answer.includes('](docs/MESSAGING.md#local-storage)'), `${name}: Send links to the default local message hub`)
      assert.match(page, checks[lang].lan, `${name}: the LAN page has no messaging`)
      const image = [...text.matchAll(/<img\b[^>]*>/g)].find(([tag]) => tag.includes(`docs/images/cover-${lang}-dark.svg`))?.[0] ?? ''
      const alt = (/\balt="([^"]*)"/.exec(image)?.[1] ?? '').replaceAll('&quot;', '"')
      assert.ok(alt, `${name}: cover has alt text`)
      assert.match(alt, checks[lang].altConnected, `${name}: alt describes the enabled, connected queue`)
      assert.match(alt, checks[lang].accepted, `${name}: alt distinguishes accepted from delivered`)
      assert.match(alt, checks[lang].receipt, `${name}: alt distinguishes receipt from completed work`)
      assert.match(alt, checks[lang].lan, `${name}: alt says LAN has no messaging`)
      assert.doesNotMatch(alt, /\b\d+\.\d+\.\d+\b|preview|預覽|预览/i, `${name}: the alt does not describe Send as an upcoming preview`)
    }
  })

  test("L0 README: the README's first image is its dark cover SVG with a synthetic label", () => {
    for (const [name, lang, synthetic] of READMES) {
      const text = read(name)
      // The first picture a reader meets: the first <img> that is not a badge or the title's logo.
      const first = [...text.matchAll(/<img\b[^>]*>/g)].find(match => !/img\.shields\.io|\/badge\.svg"|docs\/images\/brand\//.test(match[0]))
      assert.ok(first, `${name} has an image`)
      const src = /\bsrc="([^"]+)"/.exec(first[0])
      const alt = /\balt="([^"]*)"/.exec(first[0])
      assert.ok(src && alt, `${name}: the first image has a src and alt text`)
      // Each README shows its own language's drawing, in the dark look every README picture shares (#407).
      assert.equal(src[1], `docs/images/cover-${lang}-dark.svg`, `${name}: the first image is the ${lang} dark cover`)
      assert.ok(exists(src[1]), `${name}: ${src[1]} exists`)
      assert.ok(alt[1].endsWith(synthetic), `${name}: the first image's alt text ends with "${synthetic}"`)
    }
  })

  test('L0 README: the cover loops through seven captioned scenes in 30 to 45 seconds, moves with CSS alone and, for reduced motion, rests on the closing sentence beside the board with the question on top', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      const first = [...text.matchAll(/<img\b[^>]*>/g)].find(match => !/img\.shields\.io|\/badge\.svg"|docs\/images\/brand\//.test(match[0]))
      assert.ok(first, `${name}: the first non-badge image exists`)
      const src = /\bsrc="([^"]+)"/.exec(first[0])
      assert.equal(src?.[1], `docs/images/cover-${lang}-dark.svg`, `${name}: the first image is its animated cover`)
      assert.match(first[0], /\swidth="860"/, `${name}: the cover has width="860"`)

      const file = src[1]
      assert.ok(exists(file), `${file}: the cover exists`)
      assert.ok(statSync(fileURLToPath(new URL(file, root))).size < 300_000, `${file}: the cover is under 300 000 bytes on disk`)
      const svg = read(file)
      assert.match(svg, /^<svg\b/, `${file}: the file starts with <svg`)
      const opening = /^<svg\b[^>]*>/.exec(svg)?.[0] ?? ''
      assert.match(opening, /\srole="img"/, `${file}: the SVG has role="img"`)
      assert.match(opening, /\saria-label="\s*[^"\s][^"]*"/, `${file}: the SVG has a non-empty aria-label`)
      assert.match(svg, /<title\b[^>]*>\s*[^<\s][^<]*<\/title>/i, `${file}: the SVG has a non-empty title`)
      assert.doesNotMatch(svg, /<script\b/i, `${file}: the cover has no script`)
      // Skip quoted values so a > inside an attribute cannot hide a later event attribute.
      for (const tag of svg.matchAll(/<[a-zA-Z][\w:-]*((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g)) {
        for (const attribute of tag[1].matchAll(/\s+([^\s=>\/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
          assert.doesNotMatch(attribute[1], /^on/i, `${file}: the cover has no event attributes`)
        }
      }
      assert.doesNotMatch(svg, /<foreignObject\b/i, `${file}: the cover has no foreignObject`)
      assert.doesNotMatch(svg, /<image\b/i, `${file}: the cover embeds no bitmap`)
      assert.doesNotMatch(svg, /\s(?:xlink:href|href|src)\s*=\s*['"](?!#|data:)/i, `${file}: attributes reference only local fragments or embedded data`)
      assert.doesNotMatch(svg, /@import\b/i, `${file}: the cover has no stylesheet imports`)
      assert.doesNotMatch(svg, /url\(\s*['"]?\s*(?:https?:|\/\/)/i, `${file}: CSS loads nothing from the network`)
      for (const font of svg.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
        // Keep semicolons inside data URLs when reading a font's source declaration.
        const sources = [...font[1].matchAll(/\bsrc\s*:\s*((?:url\([^)]*\)|[^;}])*)/gi)]
        assert.ok(sources.length > 0, `${file}: each font face has an embedded source`)
        for (const source of sources) {
          const urls = [...source[1].matchAll(/url\(\s*['"]?([^)'"\s]+)/gi)]
          assert.ok(urls.length > 0, `${file}: each font source has a data URL`)
          for (const url of urls) assert.match(url[1], /^data:/i, `${file}: every font source URL is data:`)
          assert.match(source[1].replace(/url\([^)]*\)|format\([^)]*\)/gi, ''), /^[\s,]*$/, `${file}: font sources contain only embedded URLs and formats`)
        }
      }
      assert.match(svg, /@keyframes\s+[\w-]+\s*\{/i, `${file}: CSS defines keyframes`)
      const rules = [...svg.matchAll(/\{([^{}]*)\}/g)]
      assert.ok(rules.some(rule => /\banimation-duration\s*:\s*[^;}\s][^;}]*(?:;|$)/i.test(rule[1]) && /\banimation-iteration-count\s*:\s*infinite\s*(?:;|$)/i.test(rule[1])), `${file}: one rule sets animation duration and infinite iteration`)
      // The loop lasts 30 to 45 seconds: seven scenes of a few seconds each, long enough to read a caption.
      const loop = rules.map(rule => /\banimation-duration\s*:\s*(\d+(?:\.\d+)?)s\s*(?:;|$)/i.exec(rule[1])?.[1]).find(seconds => seconds !== undefined)
      assert.ok(loop !== undefined && Number(loop) >= 30 && Number(loop) <= 45, `${file}: the loop lasts 30 to 45 seconds (it lasts ${loop}s)`)
      // Two stops at one point of a keyframe leave the later one in force: an element meant to stay
      // on screen to the loop's end faded out that way once. Stops out of order go wrong the same way.
      const bodies = [...svg.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
      assert.equal(bodies.length, [...svg.matchAll(/@keyframes\b/g)].length, `${file}: every keyframe body is read`)
      for (const frames of bodies) {
        const stops = [...frames[1].matchAll(/(\d+(?:\.\d+)?)%(?=[^{}]*\{)/g)].map(stop => Number(stop[1]))
        assert.ok(stops.every((stop, i) => i === 0 || stop > stops[i - 1]), `${file}: every keyframe's stops rise (${frames[0].slice(0, 80)})`)
      }
      const media = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/gi
      assert.equal([...svg.matchAll(media)].length, 1, `${file}: exactly one reduced-motion media block exists`)
      const reduced = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/i.exec(svg)
      assert.ok(reduced, `${file}: the reduced-motion media block has complete rules`)
      assert.match(reduced[1], /(?:^|\})\s*\.a\s*\{[^{}]*\banimation\s*:\s*none\s*(?:;|\})/i, `${file}: reduced motion disables animation on .a`)
      assert.match(reduced[1], /(?:^|\})\s*\.last\s*\{[^{}]*\bopacity\s*:\s*1\s*(?:;|\})/i, `${file}: reduced motion shows .last with opacity 1`)
      const lastAnimated = [...reduced[1].matchAll(/\.a\s*\{/gi)].at(-1)?.index ?? -1
      const lastVisible = [...reduced[1].matchAll(/\.last\s*\{/gi)].at(-1)?.index ?? -1
      assert.ok(lastVisible > lastAnimated, `${file}: reduced motion shows .last after hiding .a`)
      const classes = [...svg.matchAll(/<[a-z][^>]*\sclass\s*=\s*['"]([^'"]*)['"]/gi)].map(match => match[1].split(/\s+/))
      assert.ok(classes.some(words => words.includes('last')), `${file}: an element draws the last frame`)
      assert.ok(classes.some(words => words.includes('a')), `${file}: an element uses the animated class`)
      assert.doesNotMatch(svg, /\sstyle\s*=\s*(["'])(?:(?!\1)[\s\S])*\banimation\b/i, `${file}: animation names live in the stylesheet`)
      // Every keyframe moves something and everything that names one has it: a rule binds class cN
      // to @keyframes cN, an element carries that class, and no cN class lacks its keyframes.
      // Without the rules nothing moves and the caption column stays blank. The rules are read
      // outside the reduced-motion block, where they apply while the cover plays; there too a
      // viewer that plays no CSS animation is shown the last scene.
      const playing = svg.replace(reduced[0], '')
      assert.match(playing, /(?:^|\}|\*\/)\s*\.a\.last\s*\{[^{}]*\bopacity\s*:\s*1\s*(?:;|\})/, `${file}: outside reduced motion, .a.last has opacity 1`)
      const named = new Set([...svg.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)].map(match => match[1]))
      const bound = new Set(classes.flat().filter(word => /^c\d+$/.test(word)))
      for (const name of named) {
        assert.match(playing, new RegExp(`\\.${literal(name)}\\s*\\{\\s*animation-name\\s*:\\s*${literal(name)}\\s*;?\\s*\\}`), `${file}: .${name} plays @keyframes ${name}`)
        assert.ok(bound.has(name), `${file}: an element carries .${name}`)
      }
      for (const name of bound) assert.ok(named.has(name), `${file}: .${name} has its @keyframes`)

      // The seven captions, in order. Each is one <text> of one <tspan> per line inside an animated group
      // marked `cap`, with the words in amber in a <tspan> of their own; the line under it sits in a
      // group marked `sub`. Reduced motion keeps only the closing scene's groups.
      const [scenes, question, delivered] = SCENES[lang]
      const lines = body => [...body.replace(/<tspan fill="[^"]*">([^<]*)<\/tspan>/g, '$1').matchAll(/<tspan\b[^>]*>([^<]*)<\/tspan>/g)].map(match => match[1])
      const amber = body => [...body.matchAll(/<tspan fill="#F8B500">([^<]*)<\/tspan>/gi)].map(match => match[1])
      // String matches: the journey safety check reads a call on a built RegExp as a process call.
      const groupsOf = (svg, word) => svg.match(word === 'cap' ? /<g class="[^"]*\bcap\b[^"]*"><text\b[^>]*>[\s\S]*?<\/text><\/g>/g : /<g class="[^"]*\bsub\b[^"]*"><text\b[^>]*>[\s\S]*?<\/text><\/g>/g) ?? []
      const groupOf = word => groupsOf(svg, word).map(group => /^<g class="([^"]*)"><text\b[^>]*>([\s\S]*)<\/text><\/g>$/.exec(group))
      const captions = groupOf('cap')
      assert.equal(captions.length, scenes.length, `${file}: one caption for each of the ${scenes.length} scenes`)
      scenes.forEach((scene, k) => {
        assert.deepEqual(lines(captions[k][2]), scene.caption, `${file}: scene ${k + 1} has its caption`)
        assert.deepEqual(amber(captions[k][2]), scene.amber ?? [], `${file}: scene ${k + 1}'s caption has amber only on ${JSON.stringify(scene.amber ?? [])}`)
        assert.ok(captions[k][1].split(/\s+/).includes('a'), `${file}: scene ${k + 1}'s caption sits in an animated group`)
        assert.equal(captions[k][1].split(/\s+/).includes('last'), k === scenes.length - 1, `${file}: only scene ${scenes.length}'s caption stays for reduced motion`)
      })
      const subs = groupOf('sub')
      const withSub = scenes.filter(scene => scene.sub !== undefined)
      assert.equal(subs.length, withSub.length, `${file}: the scenes with a line under the caption have one`)
      withSub.forEach((scene, k) => {
        assert.deepEqual(lines(subs[k][2]), scene.sub, `${file}: sub line ${k + 1}`)
        assert.deepEqual(amber(subs[k][2]), scene.subAmber ?? [], `${file}: sub line ${k + 1} has amber only on ${JSON.stringify(scene.subAmber ?? [])}`)
        assert.equal(subs[k][1].split(/\s+/).includes('last'), k === withSub.length - 1, `${file}: only the closing scene's sub line stays for reduced motion`)
      })
      assert.doesNotMatch(svg, /Coming in 0\.24\.2|0\.24\.2 起提供|copied to the clipboard|已複製|已复制|progress\.html/i, `${file}: the cover does not teach the retired demo`)
      // A piece of text is in the end frame when every animated group round it stays for reduced
      // motion; text in no animated group is on screen in every frame.
      // The calm board of scene 7 is hidden for reduced motion, and the still board (class `still`) is shown in its place.
      const isKept = groups => groups.every(classes => !classes.includes('calm') && (!classes.includes('a') || classes.includes('last')))
      const shown = word => [...svg.matchAll(new RegExp(`>${literal(word)}</(?:text|tspan)>`, 'g'))]
      // The reduced-motion still keeps the closing sentence and shows the board of scene 4: Claude Code's
      // question on top (a still picture has to show who is waiting), not the calm board with its receipt.
      const asked = shown(question)
      assert.ok(asked.some(at => isKept(groupsAround(svg, at.index)) && groupsAround(svg, at.index).some(classes => classes.includes('still'))), `${file}: the still frame asks "${question}"`)
      assert.ok(asked.some(at => !isKept(groupsAround(svg, at.index))), `${file}: an earlier scene asks "${question}" too`)
      const receipts = shown(delivered)
      assert.ok(receipts.length > 0 && receipts.every(at => !isKept(groupsAround(svg, at.index))), `${file}: the still frame shows no receipt`)
      assert.ok(receipts.some(at => groupsAround(svg, at.index).some(classes => classes.includes('calm'))), `${file}: the calm closing board shows "${delivered}"`)
      assert.match(svg, /@media[^{]*reduce[^{]*\{[\s\S]*\.calm\s*\{\s*opacity\s*:\s*0/, `${file}: reduced motion hides the calm board`)
      assert.match(svg, /\.still\s*\{\s*display\s*:\s*none/, `${file}: the still board is hidden unless motion is reduced`)
      assert.match(reduced[1], /\.still\s*\{\s*display\s*:\s*inline/, `${file}: reduced motion shows the still board`)
      // Keyframe stops of class cN as [percent, opacity] points, one per percent of a stop, and the
      // opacity between two points, as the browser draws it (straight line; the easings used here
      // do not overshoot).
      const pointsOf = name => {
        const body = new RegExp(`@keyframes ${literal(name)} \\{((?:[^{}]|\\{[^{}]*\\})*)\\}`).exec(svg)?.[1] ?? ''
        return [...body.matchAll(/([\d.%,\s]+)\{[^{}]*?opacity:\s*([\d.]+)/g)].flatMap(stop => stop[1].match(/[\d.]+/g).map(at => [Number(at), Number(stop[2])]))
      }
      const opacityAt = (points, at) => {
        const after = points.findIndex(([x]) => x >= at)
        if (after === -1) return points.at(-1)?.[1] ?? 1
        if (after === 0) return points[0][1]
        const [x0, y0] = points[after - 1]
        const [x1, y1] = points[after]
        return x1 === x0 ? y1 : y0 + (y1 - y0) * (at - x0) / (x1 - x0)
      }
      const samples = (from, to) => Array.from({ length: Math.round((to - from) / 0.25) + 1 }, (_, i) => from + i * 0.25)
      // Amber means someone waits: the logo's light and its halo are off once the answer is sent,
      // through the start scene and the calm close (the last 30% of the loop), between stops too.
      const lights = [...svg.matchAll(/<circle class="a s (c\d+)" fill="#F8B500"/gi)].map(match => match[1])
      assert.equal(lights.length, 2, `${file}: the logo's light and its halo move`)
      for (const name of lights) {
        const points = pointsOf(name)
        assert.ok(points.length > 0 && samples(70, 100).every(at => opacityAt(points, at) <= 0.1), `${file}: the logo's light (${name}) stays off after the answer is sent`)
      }
      // At the loop's end a row fades as a whole: the layers drawn over it (each step done, the
      // receipt; class `cover`) stay fully on while it fades, so the text under them never shows through.
      const end = 100 * (1 - 0.5 / Number(loop))
      const layers = [...svg.matchAll(/<g class="a (c\d+) cover\b[^"]*">/g)].map(match => match[1])
      assert.ok(layers.length >= 5, `${file}: the rows' done steps are layers drawn over them`)
      for (const name of layers) {
        const points = pointsOf(name)
        assert.ok(samples(end, end + 25 / Number(loop) - 0.01).every(at => opacityAt(points, at) >= 0.99), `${file}: a layer drawn over a row (${name}) stays on until the row is gone`)
      }
      // ...and every frame before it: the box's group may dim while the terminal of scene 6 types the
      // same command, never vanish. (The terminal's own copy comes and goes with its scene.)
      for (const command of commands.filter(command => isKept(groupsAround(svg, command.index)))) {
        for (const classes of groupsAround(svg, command.index)) {
          for (const name of classes.filter(word => /^c\d+$/.test(word))) {
            assert.ok(pointsOf(name).every(([, value]) => value >= 0.25), `${file}: "${COMMAND}" stays on screen in every frame (${name})`)
          }
        }
      }
    }
  })

  test('L0 README: each README shows the cover before its first section, then the same eight sections in the same order', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      const cover = text.indexOf(`docs/images/cover-${lang}-dark.svg`)
      const firstSection = text.indexOf('\n## ')
      assert.ok(cover >= 0 && firstSection >= 0 && cover < firstSection, `${name}: the cover comes before the first section`)
      const sections = [...text.matchAll(/^## (.+)$/gm)].map(match => match[1].trim())
      assert.deepEqual(sections, SECTIONS[lang], `${name}: the sections are in the README's order`)
    }
    assert.equal(new Set(Object.values(SECTIONS).map(list => list.length)).size, 1, 'every language has the same number of sections')
  })

  test("L0 README: under the cover, each README lists the same ten integrations in the support matrix's order, each as one dark chip with the agent's tile and name, its name as alt text and a link to its own support matrix", () => {
    const chipsOf = {}
    for (const [name, lang] of READMES) {
      const text = read(name)
      const words = WORDS[lang]
      const header = headerOf(text)
      const strip = header.match(new RegExp(`<p align="center"><b>${literal(words.label)}</b><br>\\n([\\s\\S]*?)\\n</p>`))
      assert.ok(strip, `${name}: the header has an "${words.label}" strip`)
      const cover = header.indexOf(`docs/images/cover-${lang}-dark.svg`)
      assert.ok(strip.index > cover, `${name}: the strip comes after the cover`)
      // GitHub breaks a line between an image and the text beside it, so each entry is one picture
      // holding the tile and the name. Chips part only at a space, so the strip wraps on a narrow
      // screen; nothing else sits between them, so dot and the web chats stay out of it.
      const entry = /<a href="([^"]*)">(<img\b[^>]*>)<\/a>/g
      assert.match(strip[1].replace(entry, ''), /^\n*$/, `${name}: the strip holds only its chips, one to a line`)
      const attribute = (img, key) => img.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1]
      const chips = [...strip[1].matchAll(entry)].map(([, href, img]) => ({ href, ...Object.fromEntries(['src', 'height', 'alt'].map(key => [key, attribute(img, key)])) }))
      assert.deepEqual(chips.map(chip => chip.alt), INTEGRATIONS, `${name}: the strip names the ten integrations in order`)
      // The order is the support matrix's own: its rows with an icon, read in the same README.
      const matrix = section(text, SECTIONS[lang][2])
      assert.ok(matrix, `${name}: the support matrix section exists`)
      assert.deepEqual(rows(matrix, '| <img').map(cells => cells[1]), INTEGRATIONS, `${name}: the matrix lists the same agents in the same order`)
      assert.doesNotMatch(matrix.slice(0, matrix.indexOf('\n|')), /<img\b/, `${name}: no icons stand above the matrix`)
      const darkCover = read(`docs/images/cover-${lang}-dark.svg`)
      for (const { href, src, height, alt } of chips) {
        const file = alt.toLowerCase().replaceAll(' ', '-')
        assert.equal(src, `docs/images/agents/chip-${file}.svg`, `${name}: ${alt}'s chip`)
        assert.ok(exists(src), `${name}: ${src} exists`)
        assert.equal(href, anchorOf(SECTIONS[lang][2]), `${name}: ${alt} links to this README's support matrix`)
        const svg = read(src)
        assert.equal(/^<svg\b[^>]*\sheight="(\d+)"/.exec(svg)?.[1], height, `${name}: ${alt}'s chip is shown at its own height`)
        assert.ok(svg.includes(`aria-label="${alt}"`) && svg.includes(`<title>${alt}</title>`), `${src} names ${alt}`)
        assert.doesNotMatch(svg, /data:image\//, `${src} holds no embedded bitmap`)
        // Drawn from the same icon source as the agent's own tile: the chip has the tile's colour and
        // its whole mark (every path of a logo, or the letter of a tile without one), then the name.
        const icon = read(`docs/images/agents/${file}.svg`)
        const tile = /<rect width="48" height="48" rx="11" fill="(#[0-9A-Fa-f]{6})"/.exec(icon)?.[1]
        assert.ok(tile && svg.includes(`fill="${tile}"`), `${src} shows ${alt}'s tile`)
        const marks = [...icon.matchAll(/<path d="[^"]+"\/>|<text\b[^>]*>[^<]*<\/text>/g)].map(([mark]) => mark.startsWith('<path') ? mark : `>${/>([^<]*)</.exec(mark)[1]}</text>`)
        assert.ok(marks.length > 0 && marks.every(mark => svg.includes(mark)), `${src} draws ${alt}'s mark`)
        assert.match(svg, new RegExp(`<text\\b[^>]*>${literal(alt)}</text>`), `${src} shows the name ${alt}`)
        // The chip's card is the dark cover's card, so the strip shares the README's one dark look.
        const card = /<rect x="0\.5" y="0\.5" [^>]*fill="(#[0-9a-f]{6})"/.exec(svg)?.[1]
        assert.ok(card && darkCover.includes(card), `${src}: its card colour ${card} is the dark cover's`)
      }
      assert.equal(new Set(chips.map(chip => chip.height)).size, 1, `${name}: every chip has the same height`)
      chipsOf[lang] = chips.map(chip => chip.src)
      // The strip names integrations; how each was checked stays in the matrix.
      assert.doesNotMatch(header.slice(strip.index), /verif|驗證|验证/i, `${name}: the header claims no verification`)
      for (const mention of header.matchAll(/\bdot\b/g)) {
        const before = header.slice(0, mention.index)
        assert.ok(before.lastIndexOf('<sub>') > before.lastIndexOf('</sub>'), `${name}: dot is named only in the small note under the strip`)
      }
    }
    // One set of chips for every language: the names are product names.
    for (const lang of ['zh-TW', 'zh-CN']) assert.deepEqual(chipsOf[lang], chipsOf.en, `the ${lang} README shows the English README's chips in the same order`)
  })

  test('L0 README: the header has no Node badge and only small project badges, and the install steps keep Node 22+ for npm and 18+ for a checkout', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      const header = headerOf(text)
      // Node as ordinary prerequisite text or in an illustration is fine; a Node badge is not.
      // Read both HTML and Markdown images so changing image syntax cannot bypass the check.
      const htmlImages = [...header.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => ({
        alt: /\balt=["']([^"']*)["']/i.exec(tag)?.[1] ?? '',
        src: /\bsrc=["']([^"']*)["']/i.exec(tag)?.[1] ?? '',
      }))
      const markdownImages = [...header.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map(([, alt, src]) => ({ alt, src }))
      for (const { alt, src } of [...htmlImages, ...markdownImages]) {
        const isBadge = /shields\.io|\/badges?(?:\/|[._-])/i.test(src) || (/^Node(?:\.js)?(?:\s+\d+(?:\+|\.x)?)?$/i.test(alt) && /(?:^|\/)node(?:[.-]?js)?\.svg(?:\?|$)/i.test(src))
        assert.ok(!isBadge || !/node(?:\.js)?/i.test(`${alt} ${src}`), `${name}: the header has no Node image badge`)
      }
      // A badge links to what it reports: the license file, the test workflow's real status, or the
      // published npm package's version.
      const badges = [...header.matchAll(/<a href="([^"]+)"><img alt="([^"]*)" src="(https:\/\/(?:img\.shields\.io|github\.com)\/[^"]+)"><\/a>/g)]
      assert.ok(badges.some(([, href, alt, src]) => href === 'LICENSE' && alt && src === 'https://img.shields.io/badge/license-MIT-green'), `${name}: the MIT badge links to LICENSE`)
      for (const [, href, , src] of badges) {
        const workflow = 'https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml'
        const isLicense = href === 'LICENSE' && src === 'https://img.shields.io/badge/license-MIT-green'
        const isNpm = href === 'https://www.npmjs.com/package/@wenyuchiou/agent-board' && src === 'https://img.shields.io/npm/v/@wenyuchiou/agent-board'
        assert.ok(isLicense || isNpm || (href === workflow && src === `${workflow}/badge.svg`), `${name}: ${src} is the license badge, the test workflow's status or the npm version`)
      }
      assert.equal(badges.length, [...header.matchAll(/img\.shields\.io|\/badge\.svg/g)].length, `${name}: every badge is one of those`)
      const quick = section(text, SECTIONS[lang][0])
      assert.ok(quick, `${name}: Quick start exists`)
      // npm needs Node 22, said before its commands; a checkout needs 18, said in its folded steps.
      const details = quick.slice(quick.indexOf('<details>'), quick.indexOf('</details>'))
      const npm = quick.search(/Node\.js 22\b/)
      assert.ok(npm >= 0 && npm < quick.indexOf('npx @wenyuchiou/agent-board setup') && npm < quick.indexOf('<details>'), `${name}: Node.js 22 comes before the npm commands`)
      assert.ok(/Node\.js 18\b/.test(details) && details.includes('git clone'), `${name}: the checkout steps ask for Node.js 18`)
    }
  })

  // A picture drawn in both themes is shown in its dark one. The only bitmap is the screenshot of the board's page,
  // which render.ts cannot draw (CONTRIBUTING.md, Images).
  const pictureProblem = (file, has) => {
    if (!file.endsWith('.svg')) return /^docs\/images\/page-(en|zh-TW|zh-CN)-dark\.png$/.test(file) ? null : `${file} is a bitmap other than the page screenshot`
    if (!file.endsWith('-dark.svg') && has(file.replace(/\.svg$/, '-dark.svg'))) return `${file} has a dark version to show instead`
    return null
  }

  test('L0 README: every README picture shows its dark SVG and none keeps a light source', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      assert.doesNotMatch(text, /<source\b/, `${name}: no picture switches source with the theme`)
      assert.doesNotMatch(text, /-light\.svg/, `${name}: no light SVG is referenced`)
      const pictures = [...text.matchAll(/\b(?:src|srcset)="(docs\/images\/[^"]+)"/g)].map(match => match[1])
      for (const file of [`cover-${lang}`, `pane-${lang}`, `board/codex-${lang}`]) assert.ok(pictures.includes(`docs/images/${file}-dark.svg`), `${name}: shows docs/images/${file}-dark.svg`)
      for (const file of pictures) {
        assert.ok(exists(file), `${name}: ${file} exists`)
        const problem = pictureProblem(file, exists)
        assert.equal(problem, null, `${name}: ${problem}`)
      }
    }
  })

  test('L0 README: the page screenshot is the one bitmap a README may show, and an SVG drawn in both themes shows its dark one', () => {
    const all = () => true
    for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.equal(pictureProblem(`docs/images/page-${lang}-dark.png`, all), null)
    for (const file of ['docs/images/page-en-light.png', 'docs/images/page-fr-dark.png', 'docs/images/page-en-dark.jpg', 'docs/images/sub/page-en-dark.png', 'docs/images/interactive-board-en.jpg']) assert.notEqual(pictureProblem(file, all), null, file)
    assert.notEqual(pictureProblem('docs/images/flow-en.svg', all), null)
    assert.equal(pictureProblem('docs/images/flow-en.svg', () => false), null)
    assert.equal(pictureProblem('docs/images/cover-en-dark.svg', all), null)
  })

  test('the README marks every agent that was not run live with the same phrase', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      const words = WORDS[lang]
      const table = firstTable(section(text, words.inAgent, 3) ?? '')
      const agents = rows(table, '| <img')
      assert.deepEqual(agents.map(([icon]) => /alt="([^"]+)"/.exec(icon)?.[1]), INTEGRATIONS, `${name}: every agent has a command row`)
      for (const [icon, , command] of agents) {
        const agent = /alt="([^"]+)"/.exec(icon)[1]
        assert.equal(command.split(words.notLive).length - 1, NOT_RUN_LIVE.includes(agent) ? 1 : 0, `${name}: ${agent} carries the exact phrase once only if it was not run live`)
      }
      const starts = section(text, SECTIONS[lang][0]).split('\n').filter(line => line.includes('Antigravity') && line.startsWith('- **'))
      assert.equal(starts.length, 1, `${name}: Quick start has one Antigravity start`)
      assert.ok(starts[0].includes(words.notLive), `${name}: the Antigravity start carries the phrase`)
      assert.equal(text.split(words.notLive).length - 1, NOT_RUN_LIVE.length + 1, `${name}: Quick start and only the ${NOT_RUN_LIVE.join(', ')} command cells carry the phrase`)
      if (lang !== 'en') assert.ok(!text.includes(lang === 'zh-TW' ? '在合成環境檢查過，還沒實機執行' : '在合成环境检查过，还没实机运行'), `${name}: no old synthetic-home wording remains`)
      for (const old of ['not verified yet', '還沒驗證', '还没验证']) assert.ok(!text.includes(old), `${name}: ${NOT_RUN_LIVE.join(', ')} no longer use "${old}"`)
      // The table of what was checked says the same words, without the brackets, for an agent
      // whose only check is the synthetic home; the other rows keep the host version or record.
      const start = text.indexOf(`<summary><b>${words.checked}</b></summary>`)
      assert.ok(start >= 0, `${name}: has the "${words.checked}" table`)
      const checks = rows(firstTable(text.slice(start)), '| ').filter(([agent]) => INTEGRATIONS.includes(agent))
      assert.deepEqual(checks.map(([agent]) => agent), INTEGRATIONS, `${name}: the table has a row for every agent`)
      const phrase = words.notLive.slice(1, -1)
      for (const [agent, cell] of checks) {
        assert.equal(cell === phrase, SYNTHETIC_ONLY.includes(agent), `${name}: ${agent}'s checked cell is the phrase only if the synthetic home is its only check`)
        assert.ok(!words.old.includes(cell), `${name}: ${agent}'s checked cell no longer says "${cell}"`)
      }
    }
  })

  test('L0 README: the key commands have a table per agent and a table per surface with the current board commands', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      const words = WORDS[lang]
      const keys = section(text, SECTIONS[lang][1])
      assert.ok(keys, `${name}: the key commands section exists`)
      const inAgent = firstTable(section(keys, words.inAgent, 3) ?? '')
      const anywhere = firstTable(section(keys, words.anywhere, 3) ?? '')
      assert.ok(inAgent && anywhere, `${name}: the section has a table under "${words.inAgent}" and one under "${words.anywhere}"`)
      // One row per agent, in the matrix's order, each with its icon and one board command.
      const agents = rows(inAgent, '| <img')
      assert.deepEqual(agents.map(cells => /alt="([^"]+)"/.exec(cells[0])?.[1]), INTEGRATIONS, `${name}: one row per agent, in order`)
      for (const [icon, where, command] of agents) {
        const agent = /alt="([^"]+)"/.exec(icon)[1]
        assert.ok(where.startsWith(agent), `${name}: ${agent}'s row names it`)
        assert.deepEqual(codeSpans(command), [boardCommand(agent)], `${name}: ${agent}'s board command`)
        assert.equal(command.includes(words.notLive), NOT_RUN_LIVE.includes(agent), `${name}: ${agent}'s command is marked not run live only if it has no recorded live run`)
      }
      // One row per surface, in order, each beside its own board script command, so two swapped
      // commands fail.
      const surfaces = rows(anywhere, '|').slice(2)
      assert.equal(surfaces.length, SURFACE_COMMANDS.length, `${name}: terminal or desktop, phone, agent read and one agent's setup`)
      surfaces.forEach(([where, command], i) => {
        assert.ok(where.startsWith(words.surfaces[i]), `${name}: surface row ${i + 1} is "${words.surfaces[i]}"`)
        assert.deepEqual(codeSpans(command), SURFACE_COMMANDS[i], `${name}: "${words.surfaces[i]}" runs ${SURFACE_COMMANDS[i][0]}`)
      })
      // The steps after setup are a list under Quick start: Claude Code's plugin, Codex's hooks,
      // the plugin reloads and dot's merge.
      const quick = section(text, SECTIONS[lang][0])
      const steps = quick.slice(0, quick.indexOf('<details>')).split('\n').filter(line => line.startsWith('- ') && !/^- \*\*(?:I use |我用 )/.test(line)).join('\n')
      for (const agent of ['Claude Code', 'Codex', 'OpenCode', 'OpenClaw', 'dot']) assert.ok(steps.includes(agent), `${name}: the steps after setup name ${agent}`)
      for (const link of ['docs/CODEX.md', 'AGENTS.md#report-your-progress-to-the-progress-pane', 'docs/REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste']) assert.ok(steps.includes(`](${link})`), `${name}: the steps after setup link to ${link}`)
      // Each old command is still there: a board command once for each agent that uses it, any other once.
      const spans = codeSpans([steps, inAgent, anywhere].join('\n'))
      for (const command of OLD_COMMANDS) {
        const uses = INTEGRATIONS.filter(agent => boardCommand(agent) === command).length
        assert.equal(spans.filter(span => span === command).length, uses || 1, `${name}: \`${command}\` appears ${uses || 1} time(s) in the new layout`)
      }
    }
  })
})
