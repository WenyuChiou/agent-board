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

  test('L0 README: the cover moves with CSS alone and stands still on its last frame for reduced motion', () => {
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
        assert.ok(statSync(fileURLToPath(new URL(file, root))).size < 150_000, `${file}: the cover is under 150 000 bytes on disk`)
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
      }
    }
  })
})
