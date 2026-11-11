import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { spawnIsolated } from './lib/spawn.mjs'
import { makeWorld } from './lib/world.mjs'

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
// Each README's sections in the order a newcomer reads them, the same ten in every language.
const SECTIONS = {
  en: ['Quick start', 'What you get', 'Supported agents', 'Answer from the board', 'Open it anywhere', 'How it works', 'Update and remove', 'Troubleshooting', 'Documentation', 'License'],
  'zh-TW': ['快速開始', '你會得到什麼', '支援的 agent', '在看板上回答', '在哪裡都能開', '怎麼運作', '更新與移除', '疑難排解', '文件', '授權'],
  'zh-CN': ['快速开始', '你会得到什么', '支持的 agent', '在看板上回复', '在哪里都能开', '怎么运作', '更新和卸载', '问题排查', '文档', '许可证'],
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
// The seven agents with a 0.24.3 record, in the support table's order, and each one's board command (none for Cursor).
const LISTED = ['Claude Code', 'Codex', 'Antigravity', 'Cursor', 'OpenCode', 'Grok Build', 'Hermes Agent']
const BOARD_COMMANDS = { 'Claude Code': '/agent-board', Codex: '$agent-board', Antigravity: '/agent-board', OpenCode: '/agent-board', 'Grok Build': '/agent-board', 'Hermes Agent': '/agent-board' }
// What each README says per language: the reply cells of the support table, how each answer button is
// described, and the words of the phone row. The cells follow docs/MESSAGING.md "Agent and surface support"
// (Proposed or None is "Not yet", Implemented and not tested is "Not tested", no such surface is a dash).
const WORDS = {
  en: { now: 'At once (confirmed)', next: 'At its next turn', paste: 'You paste it', send: /- \*\*Send\*\* hands it to a connected session; a confirmation from that session means it was received/, queue: /- \*\*Queue for the agent's next turn\*\* holds it until that session's next turn, does not wake an idle one, and can be rejected if the session ends first or its 12-hour mailbox expires/, copy: /- \*\*Copy answer\*\* puts it on your clipboard/, hide: '**Already answered, hide**', viewOnly: /cannot send an answer/, askNote: 'Ask it for the `agent-board` skill' },
  'zh-TW': { now: '立即送到（會確認）', next: '下一輪才收到', paste: '你自己貼上', send: /- \*\*傳送\*\*把它交給已連線的對話；對話回確認才代表收到/, queue: /- \*\*排入 agent 的下一回合\*\*會留到那個對話的下一回合才送，不會叫醒閒置中的對話；對話先結束，或它的信箱滿 12 小時過期，都可能被拒收/, copy: /- \*\*複製回答\*\*把它放進剪貼簿/, hide: '**已回覆，先隱藏**', viewOnly: /不能傳送回答/, askNote: '請它執行 `agent-board` skill' },
  'zh-CN': { now: '立即送达（会确认）', next: '下一轮才收到', paste: '你自己粘贴', send: /- \*\*发送\*\*把它交给已连接的对话；对话回确认才代表收到/, queue: /- \*\*排入 agent 的下一回合\*\*会留到那个对话的下一回合才送，不会唤醒空闲中的对话；对话先结束，或它的邮箱满 12 小时过期，都可能被拒收/, copy: /- \*\*复制回答\*\*把它放进剪贴板/, hide: '**已回复，先隐藏**', viewOnly: /不能发送回复/, askNote: '让它执行 `agent-board` skill' },
}
// Each agent's command-line reply in the terminal table, a key of WORDS.
const REPLY = { 'Claude Code': 'now', Codex: 'next', Antigravity: 'next', Cursor: 'paste', OpenCode: 'paste', 'Grok Build': 'paste', 'Hermes Agent': 'paste' }
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
  test('L0 README: each README opens with its title, tagline, badges and cover, and its Quick start holds the install commands and three bullets', () => {
    const taglines = { en: 'A board that shows which AI agent is waiting on you.', 'zh-TW': '一塊本機看板，告訴你哪個 AI agent 在等你回答', 'zh-CN': '一块本机看板，告诉你哪个 AI agent 在等你回复' }
    for (const [name, lang] of READMES) {
      const text = read(name)
      const cover = text.indexOf(`docs/images/cover-${lang}-dark.svg`)
      assert.ok(cover >= 0, `${name}: the cover exists`)
      // The top is the project's name, one line on what it does, its badges, then the picture.
      const top = text.slice(0, cover).split('\n').filter(Boolean)
      assert.equal(top[0], '<h1 align="center"><img alt="Agent Board" src="docs/images/brand/agent-board-logo.svg" width="360"></h1>', `${name}: the logo, which follows the reader's theme, is the title and comes first`)
      assert.equal(top[1], `<p align="center"><b>${taglines[lang]}</b></p>`, `${name}: the owner's tagline follows the title`)
      // Our own version comes first; the npm badge is the registry's, further along (owner, 11-11).
      assert.match(top[2], /^<p align="center"><a href="CHANGELOG\.md"><img alt="Version" src="https:\/\/img\.shields\.io\/github\/package-json\/v\/WenyuChiou\/agent-board\?label=version"><\/a> <a href="LICENSE"><img [^>]*src="https:\/\/img\.shields\.io\//, `${name}: the version badge opens the badge row, after the tagline`)
      assert.ok(top[2].indexOf('label=version') < top[2].indexOf('npm/v/'), `${name}: the version badge comes before the npm badge`)
      assert.ok(!text.slice(0, cover).includes('npx @wenyuchiou/agent-board'), `${name}: no install command comes before the cover`)
      assert.doesNotMatch(text, /coding agent|coding-agent/i, `${name}: it says AI agent, not coding agent`)
      const first = section(text, SECTIONS[lang][0])
      assert.ok(first, `${name}: Quick start exists`)
      const node = first.indexOf('Node.js 22')
      const install = /```(?:sh|bash)\r?\n(npx @wenyuchiou\/agent-board@next setup\r?\nnpx @wenyuchiou\/agent-board@next)\r?\n```/.exec(first)
      assert.ok(node >= 0 && install && install.index > node, `${name}: Quick start gives Node 22, then setup and the board command in order`)
      // The language flag, --no-open, the clone route and the agent-install prompt moved to docs/SETUP.md (checked below).
      assert.ok(!first.includes('--no-open') && !first.includes('--lang'), `${name}: Quick start leaves the options to the setup guide`)
      assert.ok(first.includes('/agent-board') && first.includes('$agent-board') && first.includes('Cursor'), `${name}: Quick start names the board command inside an agent and says Cursor has none`)
      assert.ok(first.includes('docs/SETUP.md#after-setup-per-agent'), `${name}: Quick start points to the per-agent steps after setup`)
      // The README stays short: one screen of reading for a newcomer, not the guide.
      assert.ok(text.split('\n').length <= 140, `${name}: the README has at most 140 lines`)
      // Bullets, not paragraphs: three after the code block.
      assert.equal(first.split('\n').filter(line => line.startsWith('- ')).length, 3, `${name}: Quick start has three bullets`)
    }
  })

  test('the quick start runs as written without a global install', () => {
    for (const [name, lang] of READMES) {
      const quick = section(read(name), SECTIONS[lang][0])
      assert.ok(quick, `${name}: Quick start exists`)
      const commands = /```(?:sh|bash)\n([\s\S]*?)\n```/.exec(quick)?.[1]
      assert.ok(commands, `${name}: Quick start has a command block`)
      assert.ok(!commands.split('\n').some(line => /^\s*agent-board(?:\s|$)/.test(line)), `${name}: Quick start cannot require the global command`)
      assert.ok(commands.split('\n').includes('npx @wenyuchiou/agent-board@next'), `${name}: Quick start opens the board with npx, on the pre-release tag`)
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

  test('Update and remove links to the uninstall steps in the guide in every language', () => {
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
      const update = section(read(name), SECTIONS[lang][6])
      assert.ok(update, `${name}: Update and remove exists`)
      const line = update.split('\n').find(l => words[lang].test(l) && l.includes(links[lang]))
      assert.ok(line, `${name}: Update and remove has a line on how to remove it linking to ${links[lang]}`)
      assert.ok(update.includes('npx @wenyuchiou/agent-board@next remove --apply'), `${name}: Update and remove gives the remove command`)
    }
  })

  test('L0 README: each README describes Send, Queue and Copy as docs/MESSAGING.md does, says the phone page is view only and makes no claim 0.24.3 does not back', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      const words = WORDS[lang]
      const answer = section(text, SECTIONS[lang][3]) ?? ''
      assert.match(answer, words.send, `${name}: Send hands the answer to a connected session, which confirms it`)
      assert.ok(answer.includes(words.hide), `${name}: the hide button is named as the board labels it`)
      assert.doesNotMatch(answer, /^- \*\*Queue\*\*/m, `${name}: no bare Queue button name`)
      assert.match(answer, words.queue, `${name}: Queue waits for the next turn and wakes no idle session`)
      assert.match(answer, words.copy, `${name}: Copy puts the answer on the clipboard`)
      assert.ok(answer.includes('](docs/MESSAGING.md#local-storage)'), `${name}: Send links to the local message hub`)
      assert.ok(answer.includes(`docs/images/answer-${lang}.svg`), `${name}: the answer picture is shown`)
      const anywhere = section(text, SECTIONS[lang][4]) ?? ''
      const lan = anywhere.split('\n').filter(line => line.includes('--lan'))
      assert.equal(lan.length, 1, `${name}: one phone route`)
      assert.match(lan[0], words.viewOnly, `${name}: the LAN page is view only`)
      assert.match(lan[0], lang === 'en' ? /phone.*same Wi-?Fi/i : lang === 'zh-TW' ? /同一.*Wi-?Fi.*手機/ : /同一.*Wi-?Fi.*手机/, `${name}: the phone is on the same Wi-Fi`)
      assert.match(lan[0], lang === 'zh-CN' ? /二维码/ : /QR/, `${name}: LAN mentions a QR code`)
      assert.match(lan[0], lang === 'en' ? /\btrust\b/i : lang === 'zh-TW' ? /信得過/ : /信得过/, `${name}: the LAN trust limit is stated`)
      assert.match(lan[0], lang === 'en' ? /not encrypted.*anyone who has it can open/i : lang === 'zh-TW' ? /沒有加密.*拿到的人都能打開/ : /没有加密.*拿到的人都能打开/, `${name}: the link is unencrypted and anyone with it can open the page`)
      // Claims 0.24.3 does not back: every agent receiving at once, no Copy, self-upgrade, an automatic percentage.
      assert.doesNotMatch(text, /every agent (?:receives|gets)|no Copy|upgrades itself|\d+ ?% automatic|90%|不用複製|不用复制/i, `${name}: no claim 0.24.3 does not back`)
      const image = [...text.matchAll(/<img\b[^>]*>/g)].find(([tag]) => tag.includes(`docs/images/cover-${lang}-dark.svg`))?.[0] ?? ''
      const alt = /\balt="([^"]*)"/.exec(image)?.[1] ?? ''
      assert.ok(alt, `${name}: cover has alt text`)
      assert.doesNotMatch(alt, /\b\d+\.\d+\.\d+\b|preview|預覽|预览/i, `${name}: the alt does not describe a coming version`)
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
        const body = svg.match(new RegExp(`@keyframes ${literal(name)} \\{((?:[^{}]|\\{[^{}]*\\})*)\\}`))?.[1] ?? ''
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
      // Every opacity a span can reach: the lines between points are straight, so its lowest and
      // highest values sit at the span's two ends or at a point inside it.
      const valuesOver = (points, from, to) => [opacityAt(points, from), opacityAt(points, to), ...points.filter(([x]) => x >= from && x <= to).map(([, value]) => value)]
      // Amber means someone waits: the logo's light and its halo are off once the answer is sent,
      // through the start scene and the calm close (the last 30% of the loop), between stops too.
      const lights = [...svg.matchAll(/<circle class="a s (c\d+)" fill="#F8B500"/gi)].map(match => match[1])
      assert.equal(lights.length, 2, `${file}: the logo's light and its halo move`)
      for (const name of lights) {
        const points = pointsOf(name)
        assert.ok(points.length > 0 && valuesOver(points, 70, 100).every(value => value <= 0.1), `${file}: the logo's light (${name}) stays off after the answer is sent`)
      }
      // At the loop's end a row fades as a whole: the layers drawn over it (each step done, the
      // receipt; class `cover`) stay fully on while it fades, so the text under them never shows through.
      // The rows fade from half a second before the loop's end until a quarter second before it.
      const end = 100 * (1 - 0.5 / Number(loop))
      const gone = 100 * (1 - 0.25 / Number(loop))
      const layers = [...svg.matchAll(/<g class="a (c\d+) cover\b[^"]*">/g)].map(match => match[1])
      assert.ok(layers.length >= 5, `${file}: the rows' done steps are layers drawn over them`)
      for (const name of layers) {
        const points = pointsOf(name)
        assert.ok(valuesOver(points, end, gone).every(value => value >= 0.99), `${file}: a layer drawn over a row (${name}) stays on until the row is gone`)
      }
      // The setup command stays on screen, the end frame included.
      const commands = [...svg.matchAll(new RegExp(`${literal(COMMAND)}</text>`, 'g'))]
      assert.ok(commands.some(command => isKept(groupsAround(svg, command.index))), `${file}: the end frame shows "${COMMAND}"`)
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

  test('L0 README: each README shows the cover before its first section, then the same ten sections in the same order', () => {
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

  test('L0 README: Supported agents has one table for the terminal and one for desktop apps and IDEs, each row with its icon at 28 px, board command and reply, and leaves Muse Code out', () => {
    const headings = {
      en: ['In a terminal (command line)', 'In a desktop app or IDE'],
      'zh-TW': ['在終端機（命令列）', '在桌面 app 或 IDE'],
      'zh-CN': ['在终端（命令行）', '在桌面 app 或 IDE'],
    }
    const headers = {
      en: ['Agent', 'Open the board', 'Your reply reaches it'],
      'zh-TW': ['Agent', '開看板', '你的回答怎麼送到'],
      'zh-CN': ['Agent', '打开看板', '你的回复怎么送到'],
    }
    // Words of the page and pane cells; "Not tested yet" is MESSAGING.md's Implemented with no live run.
    const DESKTOP = {
      en: { pane: 'The pane beside its chat', page: 'Board page (second command)', notYet: 'Not yet', untested: 'Not tested yet', second: 'The second Quick start command' },
      'zh-TW': { pane: '聊天旁的面板', page: '看板網頁（第二個指令）', notYet: '尚未支援', untested: '尚未測試', second: '快速開始的第二個指令' },
      'zh-CN': { pane: '聊天旁的面板', page: '看板网页（第二个命令）', notYet: '暂不支持', untested: '尚未测试', second: '快速开始的第二个命令' },
    }
    // Agents with a desktop app or IDE in docs/MESSAGING.md "Agent and surface support", and what that table says of each.
    const DESK = { 'Claude Code': ['pane', 'notYet'], Codex: ['page', 'notYet'], Antigravity: ['page', 'untested'], Cursor: ['page', 'untested'], OpenCode: ['page', 'notYet'] }
    const messaging = read('docs/MESSAGING.md')
    for (const [host, surface, status, live] of [['Claude Code', 'Desktop Code', 'Proposed', 'Not tested'], ['Codex', 'Desktop App', 'Proposed', 'Not tested'], ['Antigravity', '2.0 Desktop App', 'Implemented', 'Not tested'], ['Antigravity', 'IDE', 'Implemented', 'Not tested'], ['Cursor', 'IDE (Composer)', 'Implemented', 'Not tested'], ['OpenCode', 'Desktop App', 'Proposed', 'Not tested']]) {
      assert.ok(messaging.split('\n').some(line => line.startsWith(`| ${host} | ${surface} | `) && line.includes(`| ${status} | ${live} |`)), `docs/MESSAGING.md: ${host} ${surface} is ${status}, ${live}`)
    }
    for (const [name, lang] of READMES) {
      const text = read(name)
      const words = WORDS[lang]
      const desk = DESKTOP[lang]
      const support = section(text, SECTIONS[lang][2]) ?? ''
      const [terminalPart, desktopPart] = headings[lang].map(heading => section(support, heading, 3))
      assert.ok(terminalPart && desktopPart, `${name}: the terminal and the desktop app subsections exist`)
      assert.ok(support.indexOf(headings[lang][0]) < support.indexOf(headings[lang][1]), `${name}: the terminal comes first`)
      // Nothing between a subsection heading and its table.
      for (const part of [terminalPart, desktopPart]) assert.ok(part.trim().startsWith('| | Agent'), `${name}: a table follows its heading at once`)
      const terminal = firstTable(terminalPart)
      const desktop = firstTable(desktopPart)
      for (const table of [terminal, desktop]) assert.deepEqual(rows(table, '| |')[0].slice(1), headers[lang], `${name}: the table's columns`)
      const agents = rows(terminal, '| <img')
      assert.deepEqual(agents.map(cells => /alt="([^"]+)"/.exec(cells[0])?.[1]), LISTED, `${name}: one terminal row per agent, in order`)
      for (const [icon, agent, command, reply] of agents) {
        const file = /src="([^"]+)"/.exec(icon)[1]
        assert.ok(exists(file), `${name}: ${file} exists`)
        assert.match(icon, /\swidth="28"/, `${name}: ${agent}'s mark is drawn at 28 px, where the brand mark reads`)
        assert.equal(agent, /alt="([^"]+)"/.exec(icon)[1], `${name}: the row names ${agent}`)
        assert.deepEqual(codeSpans(command), agent === 'Hermes Agent' ? ['agent-board'] : BOARD_COMMANDS[agent] ? [BOARD_COMMANDS[agent]] : [], `${name}: ${agent}'s board command`)
        assert.equal(command === desk.second, agent === 'Cursor', `${name}: only Cursor opens the board with the second Quick start command`)
        assert.equal(command.includes(words.askNote), agent === 'Hermes Agent', `${name}: only Hermes's command carries the note that a prompt asked for the skill`)
        assert.equal(reply, words[REPLY[agent]], `${name}: ${agent}'s command-line reply`)
      }
      const apps = rows(desktop, '| <img')
      assert.deepEqual(apps.map(cells => /alt="([^"]+)"/.exec(cells[0])?.[1]), Object.keys(DESK), `${name}: the desktop table lists the agents with an app or IDE, and no others`)
      for (const [icon, agent, open, reply] of apps) {
        assert.match(icon, /\swidth="28"/, `${name}: ${agent}'s mark is drawn at 28 px`)
        assert.equal(open, desk[DESK[agent][0]], `${name}: how ${agent}'s app opens the board`)
        assert.equal(reply, desk[DESK[agent][1]], `${name}: ${agent}'s app reply`)
      }
      assert.doesNotMatch(text, /Muse/i, `${name}: Muse Code is not in the README`)
      // The notes about which version was tested live in the validation records, not in the README.
      assert.doesNotMatch(support, /0\.24\.3|not run live|未實機執行|未实机运行/, `${name}: the support section carries no test-record notes`)
      assert.doesNotMatch(support, /\bQueue\b/, `${name}: the support tables never say Queue`)
      assert.ok(support.includes('docs/REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste'), `${name}: web chats link to the hand-report steps`)
    }
  })

  test('L0 README: the header has no Node badge and only small project badges, and the install steps keep Node 22+ for npm', () => {
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
        const isVersion = href === 'CHANGELOG.md' && src === 'https://img.shields.io/github/package-json/v/WenyuChiou/agent-board?label=version'
        assert.ok(isLicense || isNpm || isVersion || (href === workflow && src === `${workflow}/badge.svg`), `${name}: ${src} is the version badge, the license badge, the test workflow's status or the npm version`)
      }
      assert.equal(badges.length, [...header.matchAll(/img\.shields\.io|\/badge\.svg/g)].length, `${name}: every badge is one of those`)
      const quick = section(text, SECTIONS[lang][0])
      assert.ok(quick, `${name}: Quick start exists`)
      // npm needs Node 22, said before its commands.
      const npm = quick.search(/Node\.js 22\b/)
      assert.ok(npm >= 0 && npm < quick.indexOf('npx @wenyuchiou/agent-board@next setup'), `${name}: Node.js 22 comes before the npm commands`)
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
      for (const file of [`cover-${lang}-dark.svg`, `answer-${lang}.svg`, `places-${lang}.svg`, `flow-${lang}.svg`, `page-${lang}-dark.png`]) assert.ok(pictures.includes(`docs/images/${file}`), `${name}: shows docs/images/${file}`)
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

  test('L0 README: Open it anywhere has a row for an agent, a terminal, a phone and an agent reading the board, each with its command', () => {
    const wanted = [['/agent-board', '$agent-board'], ['npx @wenyuchiou/agent-board', 'HERMES_HOME', 'OPENCODE_CONFIG_DIR', '--watch'], ['npx @wenyuchiou/agent-board --lan'], ['npx @wenyuchiou/agent-board --json']]
    for (const [name, lang] of READMES) {
      const anywhere = section(read(name), SECTIONS[lang][4])
      assert.ok(anywhere, `${name}: Open it anywhere exists`)
      const surfaces = rows(anywhere, '|').slice(2)
      assert.equal(surfaces.length, wanted.length, `${name}: an agent, a terminal, a phone and an agent reading the board`)
      surfaces.forEach(([, how], i) => assert.deepEqual(codeSpans(how), wanted[i], `${name}: surface row ${i + 1} runs ${wanted[i].join(' or ')}`))
      assert.ok(anywhere.includes(`docs/images/places-${lang}.svg`), `${name}: the places picture is shown`)
    }
  })

  // #1326's bot-route review (codex_089): the commands a README gives do what it says on every computer.
  const SCOPE = {
    en: { terminal: ['in an interactive terminal over SSH or on Linux with no display', 'plain text in CI', 'the page everywhere else', 'in any interactive terminal'] },
    'zh-TW': { terminal: ['在互動式終端機裡，透過 SSH 連線或在沒有顯示器的 Linux 上', 'CI 裡印出純文字', '其他情況都開網頁', '在互動式終端機加 `--watch`'] },
    'zh-CN': { terminal: ['在交互式终端里，通过 SSH 连接或在没有显示器的 Linux 上', 'CI 里打印纯文本', '其他情况都开网页', '在交互式终端加 `--watch`'] },
  }
  // The doctor belongs in SETUP.md, and the clone route opens the chosen or plugin board.
  // Run the journey in an isolated world, never against this machine's own folders.
  test('L0 README: the READMEs leave the doctor to SETUP.md, and the clone route opens the board setup wrote in a chosen folder or the plugin board by its progress file', async () => {
    const world = makeWorld()
    try {
      const launcher = fileURLToPath(new URL('bin/agent-board.mjs', root))
      const setup = fileURLToPath(new URL('scripts/setup-agent.mjs', root))
      const run = (file, args) => new Promise((done, fail) => {
        const child = spawnIsolated(process.execPath, [file, ...args], { cwd: world.root, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.on('error', fail)
        child.on('close', status => done({ status, stdout, stderr }))
      })
      const save = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
      const stub = name => `globalThis.AGENT_BOARD = {"lang":"en"}\nprocess.stdout.write(${JSON.stringify(`${name}:`)} + process.argv.slice(2).join(' '))\n`
      // The paragraph under the troubleshooting table keeps the Claude Code check, the guide links and the bug form.
      const help = {
        en: ['](docs/GUIDE.md#faq)', '](docs/GUIDE.md#troubleshooting)', '](docs/GUIDE.md#reporting-a-problem-safely)', 'no session ids, home-folder paths or tokens'],
        'zh-TW': ['](docs/GUIDE.zh-TW.md#常見問題)', '](docs/GUIDE.zh-TW.md#疑難排解)', '](docs/GUIDE.zh-TW.md#安全地回報問題)', '不要放 session id、家目錄路徑或 token'],
        'zh-CN': ['](docs/GUIDE.zh-CN.md#常见问题)', '](docs/GUIDE.zh-CN.md#问题排查)', '](docs/GUIDE.zh-CN.md#安全地报告问题)', '不要带 session id、主目录路径或 token'],
      }
      for (const [name, lang] of READMES) {
        const text = read(name)
        assert.doesNotMatch(text, /--codex-doctor/, `${name}: the doctor is left to SETUP.md`)
        const line = text.split('\n').find(one => one.includes('issues/new?template=bug_report.yml')) ?? ''
        for (const want of ['`claude plugin list`', '`/progress connect status`', ...help[lang]]) {
          assert.ok(line.includes(want), `${name}: the help paragraph keeps ${want}`)
        }
      }
      assert.ok(read('docs/SETUP.md').includes('--codex-doctor --agent <name>'), 'SETUP.md: the doctor command is documented')
      // The clone route with a chosen folder, for Cursor: setup writes the board there, and --data-dir opens it.
      const chosen = join(world.root, 'boards', 'cursor board')
      // Setup honors the world's progress override, so give this board a separate file from the default board.
      const chosenProgress = join(chosen, 'progress.md')
      world.env.CLAUDE_PROGRESS_FILE = chosenProgress
      const applied = await run(setup, ['--agent', 'cursor', '--data-dir', chosen, '--apply'])
      world.env.CLAUDE_PROGRESS_FILE = world.path
      assert.equal(applied.status, 0, applied.stderr || applied.stdout)
      save(world.path, '## Default board\n\n### Default board task\n- [ ] Work\n')
      const title = 'Chosen folder board task'
      save(chosenProgress, `## Chosen board\n\n### ${title}\n- [ ] Work\n`)
      const opened = await run(launcher, ['--data-dir', chosen, '--print'])
      assert.equal(opened.status, 0, opened.stderr || opened.stdout)
      assert.ok(opened.stdout.includes(title), opened.stderr || opened.stdout)
      // A board the Claude Code plugin manages opens by its progress file.
      const progress = join(world.root, 'plugin', 'progress.md')
      save(join(dirname(progress), 'agent-board.mjs'), stub('plugin'))
      const plugin = await run(launcher, ['--progress-file', progress, '--print'])
      assert.ok(plugin.stdout.startsWith('plugin:'), plugin.stderr || plugin.stdout)
      const clone = section(read('docs/SETUP.md'), 'Install from a clone')
      assert.ok(clone.includes('when setup wrote the board there') && clone.includes('`--progress-file <'), 'SETUP.md: the clone route says when --data-dir applies, and opens a plugin board by its progress file')
      assert.doesNotMatch(clone, /also finds a board the Claude Code\s+plugin manages/, 'SETUP.md: the clone route does not promise the bare command finds the plugin board')
    } finally { await world.close() }
  })

  test('L0 README: the setup guide holds the no-window page command, the language flag and the clone route, and the global install uses @next, in all three languages', () => {
    const clone = section(read('docs/SETUP.md'), 'Install from a clone')
    assert.ok(clone, 'SETUP.md: Install from a clone exists')
    for (const step of ['git clone https://github.com/WenyuChiou/agent-board.git', 'cd agent-board', 'node scripts/setup-agent.mjs\n', 'node scripts/setup-agent.mjs --apply']) {
      assert.ok(`${clone}\n`.includes(step), `SETUP.md: the clone route runs ${step.trim()}`)
    }
    // codex_090: in a terminal the first command asks once and a yes writes; the board command is setup's own,
    // which names a custom data folder; the per-agent steps differ (Codex `$agent-board`, Cursor none).
    assert.ok(clone.includes('`Set these up? [Y/n]`') && clone.includes('a no writes nothing'), 'SETUP.md: the clone route says the first command asks once in a terminal')
    assert.doesNotMatch(clone, /first `setup-agent\.mjs` only previews/, 'SETUP.md: the clone route does not say the first command only previews')
    assert.ok(clone.includes('(#after-setup-per-agent)'), 'SETUP.md: the clone route sends the reader to the per-agent steps')
    // codex_093 + Greptile r4536141917: after a yes, setup prints no board command (only "type /agent-board",
    // which Cursor lacks), so the clone route gives the launcher itself, which reads --data-dir.
    assert.ok(clone.includes('`node bin/agent-board.mjs`') && clone.includes('`--data-dir <folder>`'), 'SETUP.md: the clone route opens the board with node bin/agent-board.mjs and --data-dir <folder>')
    assert.doesNotMatch(clone, /board command in setup's Next steps/, "SETUP.md: the clone route does not promise a board command setup's yes path never prints")
    assert.ok(read('bin/agent-board.mjs').includes("join(resolve(dataDir), 'agent-board.mjs')"), 'bin/agent-board.mjs: --data-dir opens the board installed in that folder')
    // codex_093: setup asks only when there is something to set up, and in the system's language.
    assert.ok(clone.includes('when there is something to set up') && clone.includes('`要設定這些嗎？[Y/n]`'), 'SETUP.md: the clone route says when setup asks and that the question is localized')
    assert.doesNotMatch(clone, /`\/agent-board` inside an agent/, 'SETUP.md: the clone route does not give /agent-board for every agent')
    for (const [name, lang] of READMES) {
      const text = read(name)
      const first = section(text, SECTIONS[lang][0])
      // The options moved out of the README: the setup guide holds each of them (and the README says no more).
      const setup = read('docs/SETUP.md')
      assert.ok(setup.includes('`--html --no-open`') && setup.includes('`--no-open` alone does not'), 'SETUP.md: starting the page with no window is --html --no-open, and --no-open alone is not')
      assert.ok(setup.includes('`--lang en`, `--lang zh-TW` or `--lang zh-CN`') && setup.includes('follows the system language'), 'SETUP.md: the language flag and the system-language default')
      assert.ok(setup.includes('`要設定這些嗎？[Y/n]`') && setup.includes('`要设置这些吗？[Y/n]`'), 'SETUP.md: the question is localized')
      assert.ok(setup.includes('Open the board in the new session with `/agent-board`, or `$agent-board` in Codex. Cursor has no such command'), 'SETUP.md: how to open the board per agent, and that Cursor has no command')
      assert.ok(setup.includes('## Install from a clone') && setup.includes('## Let an agent install it'), 'SETUP.md: the clone route and the agent-install prompt')
      assert.doesNotMatch(first, /`--no-open`/, `${name}: Quick start does not give --no-open alone`)
      // The stable tag is still 0.24.2, whose launcher has no `remove`.
      assert.ok(text.includes('`npm install -g @wenyuchiou/agent-board@next`'), `${name}: the global install uses @next`)
      assert.doesNotMatch(text, /npm install -g @wenyuchiou\/agent-board`/, `${name}: no global install of the stable tag`)
      // Which surface the bare command picks (hooks/surface.ts): the terminal board only in an interactive terminal over SSH
      // or on Linux with no display, text in CI, the page otherwise; --watch in any interactive terminal.
      const terminalRow = text.split('\n').find(line => line.startsWith('|') && line.includes('`npx @wenyuchiou/agent-board`'))
      for (const words of SCOPE[lang].terminal) assert.ok(terminalRow?.includes(words), `${name}: the terminal row says ${words}`)
    }
  })
})
