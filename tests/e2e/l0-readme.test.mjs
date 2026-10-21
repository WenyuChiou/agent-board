import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// L0: what a newcomer meets first, before installing anything. Links and image files across the
// three READMEs are #207's sync test; this journey keeps to the picture at the top.
const root = new URL('../../', import.meta.url)
const read = name => readFileSync(fileURLToPath(new URL(name, root)), 'utf8')
const exists = name => existsSync(fileURLToPath(new URL(name, root)))
// The README in each language, its language tag, and the words its alt text uses to say a picture is synthetic.
const READMES = [
  ['README.md', 'en', 'Synthetic data.'],
  ['README.zh-TW.md', 'zh-TW', '合成資料。'],
  ['README.zh-CN.md', 'zh-CN', '合成数据。'],
]

// Each cover's six scenes: the two lines of every caption as COVER_WORDS in docs/preview/render.ts
// has them (none holds a character the SVG escapes, so they are written as they appear), the chip
// that marks scene 5 as a preview (soon.send there), and the words scene 5 shows in the board's own
// language: the page's Send button, its sending line and the reply receipt (serveSend,
// serveSending and messagesAcknowledged in the strings tables).
const SCENES = {
  en: [[['Every agent,', 'one board.'], ['Watch steps', 'tick off live.'], ['Questions jump', 'to the top.'], ['Answer with', 'one key.'], ['Message agents', 'from the board.'], ['One command,', 'every agent.']], 'Coming in 0.24.3', ['Send to Codex', 'Sending to Codex; waiting for its reply…', '✓ Replied']],
  'zh-TW': [[['每個 agent', '同一塊看板'], ['每一步', '即時打勾'], ['等你回答的', '排在最上面'], ['按一個鍵', '就能回答'], ['從看板直接', '傳訊息給 agent'], ['一行指令', '接上每個 agent']], '0.24.3 起提供', ['傳給 Codex', '正在傳給 Codex，等它回完…', '✓ 已回覆']],
  'zh-CN': [[['每个 agent', '同一块看板'], ['每一步', '实时打勾'], ['等你回答的', '排在最上面'], ['按一个键', '就能回答'], ['从看板直接', '发消息给 agent'], ['一行命令', '接上每个 agent']], '0.24.3 起提供', ['发给 Codex', '正在发给 Codex，等它回完…', '✓ 已回复']],
}
// The command the last scene shows, which reduced motion keeps on screen: the program on one line
// and its arguments on the next, as a terminal this narrow would wrap it.
const COMMAND = ['npx @wenyuchiou/agent-board', 'setup --apply']
// A piece of text as a pattern that matches it and nothing else.
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  test("L0 README: the README's first image has a light and a dark SVG source and a synthetic label", () => {
    for (const [name, lang, synthetic] of READMES) {
      const text = read(name)
      // The first picture a reader meets: the first <img> that is not a badge.
      const first = [...text.matchAll(/<img\b[^>]*>/g)].find(match => !/img\.shields\.io/.test(match[0]))
      assert.ok(first, `${name} has an image`)
      const picture = text.slice(0, first.index).lastIndexOf('<picture>')
      assert.ok(picture >= 0 && text.slice(picture, first.index).indexOf('</picture>') < 0, `${name}: the first image sits in a <picture>`)
      const dark = /<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)">/.exec(text.slice(picture, first.index))
      const light = /\bsrc="([^"]+)"/.exec(first[0])
      const alt = /\balt="([^"]*)"/.exec(first[0])
      assert.ok(dark && light && alt, `${name}: the first image has a dark source, a light src and alt text`)
      // Each README shows its own language's drawing, and each theme its own file.
      for (const [file, mode] of [[dark[1], 'dark'], [light[1], 'light']]) {
        assert.ok(file.endsWith(`-${lang}-${mode}.svg`), `${name}: ${file} is the ${lang} ${mode} SVG`)
        assert.ok(exists(file), `${name}: ${file} exists`)
      }
      assert.ok(alt[1].endsWith(synthetic), `${name}: the first image's alt text ends with "${synthetic}"`)
    }
  })

  test('L0 README: the cover loops through six captioned scenes in 20 to 30 seconds, moves with CSS alone and stands still on the setup scene for reduced motion', () => {
    for (const [name, lang] of READMES) {
      const text = read(name)
      const first = [...text.matchAll(/<img\b[^>]*>/g)].find(match => !/img\.shields\.io/.test(match[0]))
      assert.ok(first, `${name}: the first non-badge image exists`)
      const picture = text.slice(0, first.index).lastIndexOf('<picture>')
      assert.ok(picture >= 0 && !text.slice(picture, first.index).includes('</picture>'), `${name}: the first image sits in a <picture>`)
      const dark = /<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)">/.exec(text.slice(picture, first.index))
      const light = /\bsrc="([^"]+)"/.exec(first[0])
      assert.equal(light?.[1], `docs/images/cover-${lang}-light.svg`, `${name}: the light source is its animated cover`)
      assert.equal(dark?.[1], `docs/images/cover-${lang}-dark.svg`, `${name}: the dark source is its animated cover`)
      assert.match(first[0], /\swidth="860"/, `${name}: the cover has width="860"`)

      for (const file of [light[1], dark[1]]) {
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
        // The loop lasts 20 to 30 seconds: six scenes of a few seconds each, long enough to read a caption.
        const loop = rules.map(rule => /\banimation-duration\s*:\s*(\d+(?:\.\d+)?)s\s*(?:;|$)/i.exec(rule[1])?.[1]).find(seconds => seconds !== undefined)
        assert.ok(loop !== undefined && Number(loop) >= 20 && Number(loop) <= 30, `${file}: the loop lasts 20 to 30 seconds (it lasts ${loop}s)`)
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

        // The six captions, in order. Each is one <text> of two <tspan> lines inside an animated group;
        // reduced motion keeps only the last scene's group.
        const [scenes, soon, words] = SCENES[lang]
        let at = -1
        scenes.forEach(([first, second], k) => {
          // String match: the journey safety check reads a call on a built RegExp as a process call.
          const found = svg.match(new RegExp(`<g class="([^"]*)"><text\\b[^>]*>\\s*<tspan\\b[^>]*>${literal(first)}</tspan>\\s*<tspan\\b[^>]*>${literal(second)}</tspan>\\s*</text>`))
          assert.ok(found, `${file}: scene ${k + 1} has its caption "${first} ${second}"`)
          assert.ok(found[1].split(/\s+/).includes('a'), `${file}: scene ${k + 1}'s caption sits in an animated group`)
          assert.ok(found.index > at, `${file}: scene ${k + 1}'s caption comes after scene ${k}'s`)
          at = found.index
          assert.equal(found[1].split(/\s+/).includes('last'), k === scenes.length - 1, `${file}: only scene ${scenes.length}'s caption stays for reduced motion`)
        })
        // Scene 5 carries its preview mark, and the mark leaves with the scene: a group that
        // reduced motion keeps must not hold it.
        const chips = [...svg.matchAll(new RegExp(`>${literal(soon)}</text>`, 'g'))]
        assert.ok(chips.length > 0, `${file}: scene 5 says "${soon}"`)
        for (const chip of chips) assert.ok(!groupsAround(svg, chip.index).some(classes => classes.includes('last')), `${file}: "${soon}" is not in the group that reduced motion keeps`)
        // A receipt is text without textLength: the terminal board's own rows carry it, so a row
        // that reads the same as a receipt cannot stand in for it.
        const receipt = word => `<text(?![^>]*textLength)[^>]*>${literal(word)}</text>`
        for (const word of words) assert.match(svg, new RegExp(receipt(word)), `${file}: scene 5 shows "${word}"`)
        // The end frame shows the setup command: reduced motion keeps every animated group round it.
        const [program, args] = COMMAND
        const commands = [...svg.matchAll(new RegExp(`${literal(program)}</tspan>\\s*<tspan\\b[^>]*>${literal(args)}</tspan>\\s*</text>`, 'g'))]
        const isKept = groups => groups.some(classes => classes.includes('last')) && groups.every(classes => !classes.includes('a') || classes.includes('last'))
        assert.ok(commands.some(command => isKept(groupsAround(svg, command.index))), `${file}: the end frame shows "${COMMAND.join(' ')}"`)
      }
    }
  })
})
