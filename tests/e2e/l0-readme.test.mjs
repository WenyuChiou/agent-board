import { existsSync, readFileSync } from 'node:fs'
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
})
