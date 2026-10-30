import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

let source
try {
  source = await Promise.all([
    import('../hooks/page-look.ts'),
    import('../hooks/serve.ts'),
    import('../hooks/dashboard.ts'),
    import('../hooks/parse.ts'),
    import('../hooks/view.ts'),
    import('../hooks/strings.ts'),
    import('../hooks/agent-icons.ts'),
    import('../hooks/page-fonts.ts'),
  ])
} finally { loader.deregister() }

const [{ pageTokens, boardMark }, { servePage, pagePolicy }, { dashboardHtml }, { parseProgress }, { buildView }, { STRINGS }, { AGENT_ICONS }, { FONT_LICENSE }] = source
const SANS = '"Atkinson Hyperlegible Next",system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans TC","Noto Sans SC","Hiragino Sans","PingFang TC","PingFang SC","Microsoft JhengHei","Microsoft YaHei",sans-serif'
const MONO = 'ui-monospace,"SF Mono","Cascadia Mono","Segoe UI Mono",Menlo,Consolas,"Liberation Mono",monospace'
const SHAPES = '<rect class="lg-ink" x="8" y="8" width="36" height="8"/><path class="lg-flag" d="M8 24H56L48 32L56 40H8Z"/><rect class="lg-ink" x="8" y="48" width="28" height="8"/>'
const PRIVACY = /\b[\da-f]{8}\b|\b[\da-f]{40}\b|\b[\da-f]{64}\b|(?<![A-Za-z])[A-Za-z]:[\\/]|\/home\/|\/Users\//i
const NOW = 1_700_000_000_000
const FIXTURE = `## Synthetic
### Choose the release
- [?] Publish the preview, OK?
- [ ] Finish the review
### Choose a schedule
- [?] One day or one week?
### Running plan
> due 11-15
- [x] Read the notes
- [~] Check the examples
- [ ] Finish the draft
### Completed plan
- [x] Checked the sample
`

const renders = (lang = 'en') => {
  const s = STRINGS[lang]
  const view = buildView(parseProgress(FIXTURE), [], null, NOW, 0, {}, s)
  assert.ok(view.waiting.length >= 2, 'the fixture must render waiting question colours')
  assert.ok(view.groups.some(group => group.rows.length > 0), 'the fixture must render running plan colours')
  return [
    { name: 'classic', lang, html: servePage(s, 'n') },
    { name: 'grouped', lang, html: servePage(s, 'n', false, 0, true) },
    { name: 'dashboard', lang, html: dashboardHtml(view, s, '/synthetic/progress.md', 'updated 12:00') },
  ]
}

const svgUrlsRemoved = css => css.replace(/url\(\s*(?:"data:[^"]*"|'data:[^']*'|data:[^)]*)\s*\)/gi, '')
const declarations = body => body.split(';').filter(part => part.trim() !== '').map(part => {
  const match = /^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(part)
  assert.ok(match, `unreadable CSS declaration: ${part}`)
  return { property: match[1].toLowerCase(), value: match[2].replace(/\s*!important\s*$/i, '').trim() }
})

// Keep media ancestors so only the phone navigation may have a surface background.
const cssRules = (rawCss, ancestors = []) => {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let start = 0
  let depth = 0
  let quote = ''
  let open = -1
  for (let index = 0; index < css.length; index++) {
    const character = css[index]
    if (quote) {
      if (character === '\\') index++
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '{') {
      if (depth++ === 0) open = index
    } else if (character === '}') {
      assert.ok(depth > 0, 'CSS has an unmatched closing brace')
      if (--depth !== 0) continue
      const selector = css.slice(start, open).trim()
      const body = css.slice(open + 1, index)
      if (selector === '@font-face') {
        // The font test checks these descriptors separately from page style tokens.
      } else if (selector.startsWith('@')) rules.push(...cssRules(body, [...ancestors, selector]))
      else rules.push({ selector, ancestors, declarations: declarations(body) })
      start = index + 1
    }
  }
  assert.equal(depth, 0, 'CSS has an unclosed rule')
  assert.equal(quote, '', 'CSS has an unclosed string')
  assert.equal(css.slice(start).trim(), '', 'CSS has unparsed trailing content')
  return rules
}

const styleRules = html => {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
  assert.ok(styles.length > 0, 'the output must include its styles')
  const rules = styles.flatMap(match => cssRules(svgUrlsRemoved(match[1])))
  for (const [index, match] of [...html.matchAll(/\bstyle=("|')([\s\S]*?)\1/gi)].entries()) {
    rules.push({ selector: `inline style ${index + 1}`, ancestors: [], declarations: declarations(svgUrlsRemoved(match[2])) })
  }
  return rules
}
const isTokenRule = rule => /^:root(?:$|\[data-theme="dark"\]$|:not\(\[data-theme="light"\]\)$)/.test(rule.selector)
const valuesOf = rule => Object.fromEntries(rule.declarations.filter(item => item.property.startsWith('--')).map(item => [item.property.slice(2), item.value]))
const tokenRules = cssRules(pageTokens())
const lightRule = tokenRules.find(rule => rule.selector === ':root')
const darkRule = tokenRules.find(rule => rule.selector === ':root[data-theme="dark"]')
assert.ok(lightRule && darkRule, 'pageTokens must declare both explicit themes')
const light = valuesOf(lightRule)
const dark = { ...light, ...valuesOf(darkRule) }
const definedTokens = new Set(tokenRules.flatMap(rule => rule.declarations.filter(item => item.property.startsWith('--')).map(item => item.property.slice(2))))
const varsUsed = value => [...value.matchAll(/var\(\s*--([\w-]+)/g)].map(match => match[1])

const NAMED_COLOURS = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(' '))
const bareValue = value => value.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, '')
const textSize = /^var\(--text-(?:xs|sm|md|lg)\)$/
const fontFamily = /^var\(--font-(?:sans|mono)\)$/
const fontShorthand = /^(?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d{3})\s+)*var\(--text-(?:xs|sm|md|lg)\)(?:\s*\/\s*(?:normal|[\d.]+|var\(--[\w-]+\)))?\s+var\(--font-(?:sans|mono)\)$/
const isMobile = rule => rule.ancestors.some(ancestor => /@media\s*\([^)]*max-width\s*:\s*(?:600|760)px\s*\)/.test(ancestor))
const surfaceAllowed = (name, selector, rule) => {
  if (/(?:^|\s)(?:#search|#search-results|textarea|input)(?=$|[:[\s])/.test(selector)) return true
  if (/(?:^|\s)\.seg$/.test(selector)) return true
  if (name === 'grouped') return /(?:^|\s)\.pg-sheet$/.test(selector) || (isMobile(rule) && /(?:#picks>button|button\.nav)(?=$|[:[])/.test(selector))
  return selector === "details.section[data-key='section:waiting']" || (isMobile(rule) && /(?:^|\s)\.dash-nav button(?=$|[:[])/.test(selector))
}

test('the page and the dashboard use only colour, size, radius, shadow and duration tokens from page-look', () => {
  const expected = {
    text: { 'text-xs': '12px', 'text-sm': '14px', 'text-md': '16px', 'text-lg': '20px' },
    radius: { 'radius-s': '6px', 'radius-m': '10px', 'radius-round': '999px' },
    dur: { 'dur-theme': '.28s' },
  }
  for (const [prefix, values] of Object.entries(expected)) {
    assert.deepEqual([...definedTokens].filter(name => name.startsWith(`${prefix}-`)).sort(), Object.keys(values).sort(), `${prefix} has no additional theme-only tokens`)
    assert.deepEqual(Object.fromEntries(Object.entries(light).filter(([name]) => name.startsWith(`${prefix}-`))), values, `${prefix} has exactly the specified tokens`)
    for (const [name, value] of Object.entries(values)) assert.equal(dark[name], value, `${name} is unchanged by dark mode`)
  }
  assert.ok(light.shadow && dark.shadow, 'the search panel has a shadow in each theme')
  assert.ok(light.scrim && dark.scrim, 'the drawer dim layer is a theme token')
  for (const icon of AGENT_ICONS) {
    assert.equal(light[`ag-${icon.file}`], icon.tile, `the ${icon.file} tile is a token`)
    assert.equal(tokenRules.flatMap(rule => rule.declarations).filter(item => item.property === `--ag-${icon.file}`).length, 1, `${icon.file} is declared once, outside theme overrides`)
  }
  for (const { name, html } of renders()) {
    const rules = styleRules(html)
    const roots = rules.filter(isTokenRule)
    assert.equal(roots.length, tokenRules.length, `${name}: token roots come only from pageTokens`)
    for (const [index, rule] of roots.entries()) {
      assert.equal(rule.selector, tokenRules[index].selector, `${name}: theme token selector`)
      assert.deepEqual(rule.ancestors, tokenRules[index].ancestors, `${name}: automatic dark tokens stay inside their media query`)
      assert.deepEqual(rule.declarations.filter(item => item.property !== '--head-h'), tokenRules[index].declarations.filter(item => item.property !== '--head-h'), `${name}: token definitions match pageTokens`)
    }
    assert.equal(valuesOf(roots[0])['head-h'], { classic: '54px', grouped: '56px', dashboard: '70px' }[name], `${name}: the header fallback height remains defined`)
    let shadowCount = 0
    for (const rule of rules.filter(rule => !isTokenRule(rule))) {
      for (const { property, value } of rule.declarations) {
        const where = `${name}: ${rule.selector} { ${property}:${value} }`
        const bare = bareValue(value)
        assert.doesNotMatch(bare, /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/i, `${where}: colour literals belong in pageTokens`)
        for (const word of bare.match(/[A-Za-z][\w-]*/g) ?? []) assert.ok(!NAMED_COLOURS.has(word.toLowerCase()), `${where}: named colour ${word} belongs in pageTokens`)
        for (const variable of varsUsed(value)) assert.ok(definedTokens.has(variable), `${where}: --${variable} is not defined by pageTokens`)
        assert.ok(!property.startsWith('--'), `${where}: custom properties belong in pageTokens`)
        if (property === 'font-size') assert.ok(value === 'inherit' || textSize.test(value), `${where}: use one of four text sizes`)
        if (property === 'font-family') assert.ok(value === 'inherit' || fontFamily.test(value), `${where}: use a system font token`)
        if (property === 'font') assert.ok(value === 'inherit' || fontShorthand.test(value), `${where}: use a text size and system font token`)
        if (property === 'border-radius') assert.match(value, /^(?:0|var\(--radius-(?:s|m|round)\))$/, `${where}: use one of three radii`)
        if (property === 'box-shadow') {
          assert.match(value, /^(?:none|var\(--shadow\))$/, `${where}: use the single shadow token`)
          if (value !== 'none') {
            shadowCount++
            assert.ok(rule.selector.split(',').every(selector => /(?:^|\s)#search-results$/.test(selector.trim())), `${where}: only the search results panel has a shadow`)
          }
        }
        if (varsUsed(value).includes('shadow')) assert.equal(property, 'box-shadow', `${where}: --shadow is only a box shadow`)
        if (/^(?:transition|animation)(?:-|$)/.test(property) && value !== 'none') {
          assert.ok(rule.selector.split(',').every(selector => /(?:^|\s)\.theming(?=$|[\s.*:#[])/.test(selector.trim())), `${where}: only a theme change may animate`)
          assert.ok(varsUsed(value).includes('dur-theme'), `${where}: use the single theme duration`)
          assert.doesNotMatch(value, /(?:^|[\s,])[\d.]+m?s\b/, `${where}: no literal duration`)
        }
        if (name !== 'classic' && /^(?:background|background-color)$/.test(property) && varsUsed(value).includes('surface')) {
          for (const selector of rule.selector.split(',')) assert.ok(surfaceAllowed(name, selector.trim(), rule), `${where}: surface is reserved for Needs you and allowed controls`)
        }
      }
    }
    if (name === 'grouped') assert.ok(shadowCount > 0, 'the search results panel retains its shadow')
    const sheet = { classic: '.card', grouped: '.grouped .pg-sheet', dashboard: "details.section[data-key='section:waiting']" }[name]
    assert.ok(rules.some(rule => rule.selector === sheet && rule.declarations.some(item => /^(?:background|background-color)$/.test(item.property) && item.value === 'var(--surface)')), `${name}: ${sheet} retains its surface background`)
    const bodyFont = rules.filter(rule => rule.selector === 'body').flatMap(rule => rule.declarations.filter(item => item.property === 'font')).at(-1)
    assert.equal(bodyFont?.value, 'var(--text-md)/1.55 var(--font-sans)', `${name}: body uses the shared readable text size and line height`)
    assert.equal(rules.filter(rule => rule.declarations.some(item => item.property === 'transition' && item.value !== 'none')).length, 1, `${name}: theme changes keep the sole transition rule`)
    assert.ok(rules.some(rule => rule.selector === ':focus-visible' && rule.declarations.some(item => item.property === 'outline')), `${name}: keyboard focus keeps its outline`)
    assert.ok(rules.some(rule => rule.ancestors.some(ancestor => ancestor.includes('prefers-reduced-motion:reduce'))), `${name}: reduced motion remains supported`)
    for (const icon of AGENT_ICONS) {
      const mark = rules.find(rule => rule.selector === `.ag-${icon.file}`)
      assert.ok(mark?.declarations.some(item => item.property === 'background' && item.value.startsWith(`var(--ag-${icon.file})`)), `${name}: ${icon.file} uses its tile token`)
    }
  }
})

const channels = colour => {
  const hex = /^#([\da-f]{6})$/i.exec(colour)
  if (hex) return hex[1].match(/../g).map(channel => parseInt(channel, 16))
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(colour)
  assert.ok(rgb, `expected an opaque six-digit hex or rgb colour, got ${colour}`)
  return rgb.slice(1).map(Number)
}
const luminance = colour => channels(colour).map(channel => {
  const srgb = channel / 255
  return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4
}).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
const contrast = (foreground, background) => {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

test('every text colour passes 4.5:1 and every mark colour 3:1 on its surface in light and dark', t => {
  const text = ['ink', 'muted', 'accent', 'done', 'running', 'soon', 'alert', 'project', 'waiting-text']
  const marks = ['waiting', 'accent', 'done', 'running', 'soon', 'alert', 'ink']
  const pairs = []
  assert.equal(light.waiting.toLowerCase(), '#9a7200', 'the light waiting flag uses the page mark colour')
  assert.equal(dark.waiting.toLowerCase(), '#f8b500', 'the dark waiting flag keeps its page mark colour')
  assert.equal(light['waiting-text'].toLowerCase(), '#715c1f', 'light waiting text has its separate readable colour')
  assert.equal(dark['waiting-text'].toLowerCase(), '#f8b500', 'dark waiting text has its readable colour')
  for (const [mode, palette] of Object.entries({ light, dark })) {
    const automatic = valuesOf(tokenRules.find(rule => rule.selector.includes(':not(')))
    for (const name of [...text, ...marks, 'ground', 'surface', 'inset', 'on-accent']) assert.equal(automatic[name], dark[name], `system dark and explicit dark agree for ${name}`)
    for (const [kind, tokens, threshold] of [['text', text, 4.5], ['mark', marks, 3]]) {
      for (const surface of ['ground', 'surface', 'inset']) {
        for (const token of tokens) pairs.push({ mode, rule: `${kind}/${surface}`, token, surface, threshold, ratio: contrast(palette[token], palette[surface]) })
      }
    }
    for (const [token, surface] of [['on-accent', 'accent'], ['ground', 'ink']]) pairs.push({ mode, rule: `${token}/${surface}`, token, surface, threshold: 4.5, ratio: contrast(palette[token], palette[surface]) })
  }
  const minima = [...new Set(pairs.map(pair => `${pair.mode}|${pair.rule}`))].map(key => pairs.filter(pair => `${pair.mode}|${pair.rule}` === key).reduce((lowest, pair) => pair.ratio < lowest.ratio ? pair : lowest))
  t.diagnostic('Contrast minima (WCAG 2.x):\nmode | rule | minimum | token | required\n' + minima.map(pair => `${pair.mode} | ${pair.rule} | ${pair.ratio.toFixed(3)}:1 | ${pair.token} | ${pair.threshold}:1`).join('\n'))
  for (const pair of pairs) assert.ok(pair.ratio >= pair.threshold, `${pair.mode}: --${pair.token} on --${pair.surface} is ${pair.ratio.toFixed(3)}:1, requires ${pair.threshold}:1`)
  // Frame, line and line-strong draw decorative rules and the empty part of a bar, not information.
  const markOnly = new Set(['waiting', 'frame', 'line', 'line-strong'])
  for (const { name, html } of renders()) {
    for (const rule of styleRules(html).filter(rule => !isTokenRule(rule))) {
      for (const { property, value } of rule.declarations.filter(item => item.property === 'color')) {
        for (const token of varsUsed(value)) assert.ok(!markOnly.has(token), `${name}: ${rule.selector} { ${property}:${value} } uses a mark-only token for text`)
      }
    }
  }
  // Selected states sit on other surfaces: the picked agent button is ink, so its flag text uses the ground colour
  // (ground on ink is checked above); the pressed theme button is marked by a muted border, which keeps its
  // contrast when the focus outline is also showing.
  const declared = (rules, selector, property) => rules.find(rule => rule.selector === selector)?.declarations.find(item => item.property === property)?.value
  for (const { name, html } of renders()) {
    const rules = styleRules(html)
    assert.equal(declared(rules, '.seg button[aria-pressed="true"]', 'border-color'), 'var(--muted)', `${name}: the pressed theme button keeps a 3:1 border`)
    assert.ok(!rules.some(rule => rule.selector.includes('[aria-pressed="true"]') && rule.declarations.some(item => item.property === 'outline')), `${name}: the pressed state does not compete with the focus outline`)
    if (name === 'grouped') assert.equal(declared(rules, '.grouped #picks>button[aria-current="true"] .pg-flag', 'color'), 'var(--ground)', 'the flag text on the picked agent button uses the ground colour')
  }
})

test('the page embeds its fonts, makes no font request and allows only font-src data:', () => {
  assert.equal(light['font-sans'], SANS, 'the sans token starts with Atkinson and keeps the system stack')
  assert.equal(light['font-mono'], MONO, 'the mono token is the exact system stack')
  assert.match(FONT_LICENSE, /^Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors/)
  assert.equal(FONT_LICENSE, readFileSync(new URL('../hooks/fonts/OFL.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), 'the bundled license matches the license shipped beside the source')
  const hashes = {
    400: '378aea0f5c1d179f4e0b5382c06bfc87571b98cfcc4fd1352bc979e2e2259c54',
    600: '4ab00275cc496a478fce7baafe89ed44af875acf57655dfd1183ff22bd23829a',
  }
  const policy = pagePolicy('n')
  assert.match(policy, /(?:^|;)\s*default-src 'none'(?:;|$)/)
  assert.deepEqual(policy.split(';').map(part => part.trim()).filter(part => /^font-src(?:\s|$)/i.test(part)), ['font-src data:'])
  assert.match(policy, /(?:^|;)\s*img-src data:(?:;|$)/)
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    for (const { name, html } of renders(lang)) {
      const where = `${name}/${lang}`
      assert.match(html, new RegExp(`<html lang="${{ en: 'en', 'zh-TW': 'zh-Hant', 'zh-CN': 'zh-Hans' }[lang]}"`), `${where}: the document has its language`)
      const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n')
      assert.ok(css.includes(FONT_LICENSE), `${where}: the license ships inside the page`)
      const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '')
      const faces = [...cleanCss.matchAll(/@font-face\s*\{([^{}]*)\}/gi)].map(match => match[1])
      assert.equal(faces.length, 2, `${where}: both font faces are embedded`)
      const weights = []
      for (const face of faces) {
        assert.match(face, /\bfont-family\s*:\s*(['"])Atkinson Hyperlegible Next\1\s*;/i, `${where}: font family`)
        assert.match(face, /\bfont-display\s*:\s*swap\s*(?:;|$)/i, `${where}: font display`)
        const weight = /\bfont-weight\s*:\s*(400|600)\s*(?:;|$)/i.exec(face)?.[1]
        assert.ok(weight, `${where}: regular or semibold weight`)
        weights.push(weight)
        const src = /\bsrc\s*:\s*url\(\s*(['"]?)(data:font\/woff2;base64,([A-Za-z0-9+/]+={0,2}))\1\s*\)\s*format\(\s*(['"])woff2\4\s*\)/i.exec(face)
        assert.ok(src, `${where}: ${weight} is an inline WOFF2 font`)
        const bytes = Buffer.from(src[3], 'base64')
        assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2', `${where}: ${weight} has a WOFF2 signature`)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[weight], `${where}: ${weight} matches the approved font`)
      }
      assert.deepEqual(weights.sort(), ['400', '600'], `${where}: one face for each weight`)
      assert.doesNotMatch(cleanCss, /@import\b/i, `${where}: no imported stylesheet`)
      for (const src of cleanCss.matchAll(/(?:^|[;{])\s*src\s*:\s*([^}]+)/gi)) assert.doesNotMatch(svgUrlsRemoved(src[1]), /https?:|\/\//i, `${where}: no remote CSS source`)
      const markup = svgUrlsRemoved(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/\/\*[\s\S]*?\*\//g, ''))
      assert.doesNotMatch(markup, /(?:https?:)?\/\/[a-z\d]/i, `${where}: no remote or protocol-relative URL`)
      for (const link of html.match(/<link\b[^>]*>/gi) ?? []) assert.doesNotMatch(link, /\brel\s*=\s*["'](?:stylesheet|preload)["']/i, `${where}: no stylesheet or preload link`)
      for (const match of cleanCss.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) assert.match(match[1] ?? match[2] ?? match[3], /^(?:data:image\/svg\+xml,|data:font\/woff2;base64,)/, `${where}: CSS URLs are inline SVG images or WOFF2 fonts`)
      const sans = valuesOf(styleRules(html).find(rule => rule.selector === ':root'))['font-sans']
      assert.equal(sans, SANS, `${where}: the rendered page uses Atkinson with the system fallback stack`)
      for (const face of ['Noto Sans TC', 'Noto Sans SC', 'PingFang TC', 'PingFang SC', 'Microsoft JhengHei', 'Microsoft YaHei']) assert.ok(sans.includes(`"${face}"`), `${where}: ${face} is available for Chinese text`)
    }
  }
})

const attribute = (tag, name) => new RegExp(`\\b${name}=("|')([\\s\\S]*?)\\1`, 'i').exec(tag)?.[2]
const logoSvg = html => /<svg\b(?=[^>]*\bclass="mark")[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0]
const assertShapes = (svg, where) => {
  assert.match(svg, /\bviewBox="0 0 64 64"/, `${where}: the Signal Row uses its 64 grid`)
  const shapes = (svg.match(/<(?:rect|path)\b[^>]*\/>/g) ?? []).join('')
  assert.equal(shapes, SHAPES, `${where}: the Signal Row has its two ink bars and flag`)
  assert.doesNotMatch(svg, /class="m[1-4]"/, `${where}: the old four-square mark is gone`)
}

test('the header and favicon show the Signal Row logo in light and dark', () => {
  assertShapes(boardMark, 'the shared board mark')
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    for (const { name, html } of renders(lang)) {
      const where = `${name}/${lang}`
      const header = /<header\b(?=[^>]*\bclass="head")[^>]*>[\s\S]*?<\/header>/.exec(html)?.[0]
      assert.ok(header, `${where}: the page has its header`)
      const logo = logoSvg(header)
      assert.ok(logo, `${where}: the header contains the board mark`)
      assertShapes(logo, `${where} header`)
      assert.match(logo, /\baria-hidden="true"/, `${where}: the decorative logo adds no wording`)
      const heading = name === 'grouped' ? 'Agent Board' : STRINGS[lang].paneTitle
      assert.ok(header.includes(`${logo}<h1>${heading}</h1>`), `${where}: the logo sits beside the existing board heading`)
      assert.match(html, /<title>[^<]*Agent Board<\/title>/, `${where}: the browser title names Agent Board`)
      assert.doesNotMatch(html, /class="m[1-4]"|\.m[1-4]\s*\{/, `${where}: no old mark shapes or rules`)
      const rules = styleRules(html)
      for (const [selector, value] of [['.lg-ink', 'var(--ink)'], ['.lg-flag', 'var(--waiting)']]) assert.ok(rules.some(rule => rule.selector === selector && rule.declarations.some(item => item.property === 'fill' && item.value === value)), `${where}: ${selector} follows the theme token`)
      if (name === 'grouped') {
        const fresh = /<div\b(?=[^>]*\bid="fresh-mark")[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]
        assert.ok(fresh, `${where}: the fresh page keeps its logo`)
        assertShapes(logoSvg(fresh), `${where} fresh mark`)
      }
      const links = (html.match(/<link\b[^>]*>/gi) ?? []).filter(link => attribute(link, 'rel') === 'icon')
      assert.equal(links.length, 1, `${where}: there is one favicon`)
      assert.equal(attribute(links[0], 'type'), 'image/svg+xml', `${where}: the favicon is SVG`)
      const href = attribute(links[0], 'href')
      assert.match(href, /^data:image\/svg\+xml,/, `${where}: the browser tab uses the inline logo`)
      const favicon = decodeURIComponent(href.slice('data:image/svg+xml,'.length))
      assertShapes(favicon, `${where} favicon`)
      assert.doesNotMatch(favicon, /#/, `${where}: the data URL cannot encode hex colours into private-looking ids`)
      const faviconStyle = /<style>([\s\S]*?)<\/style>/.exec(favicon)?.[1]
      assert.ok(faviconStyle, `${where}: the favicon includes its theme colours`)
      assert.match(faviconStyle, /@media\s*\(prefers-color-scheme:dark\)/, `${where}: the tab logo follows dark mode`)
      const faviconRules = cssRules(faviconStyle)
      for (const [mode, palette, tab, ink] of [['light', light, '#dee1e6', 'rgb(31,35,36)'], ['dark', dark, '#202124', 'rgb(230,228,220)']]) {
        for (const [selector, token, expected] of [['.lg-ink', 'ink', ink], ['.lg-flag', 'waiting', `rgb(${channels(palette.waiting).join(',')})`]]) {
          const rule = faviconRules.find(item => item.selector === selector && (mode === 'dark') === item.ancestors.some(ancestor => ancestor.includes('prefers-color-scheme:dark')))
          const fill = rule?.declarations.find(item => item.property === 'fill')?.value
          assert.equal(fill, expected, `${where}: ${mode} favicon ${token} matches its colour token`)
          for (const [surface, colour] of [['page ground', palette.ground], ['browser tab', tab]]) assert.ok(contrast(fill, colour) >= 3, `${where}: ${mode} favicon ${token} on ${surface} is ${contrast(fill, colour).toFixed(3)}:1, requires 3:1`)
        }
      }
      assert.doesNotMatch(html, PRIVACY, `${where}: the full output satisfies the privacy contract`)
    }
  }
})
