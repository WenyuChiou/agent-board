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
    import('../hooks/strings.ts'),
    import('../hooks/agent-icons.ts'),
    import('../hooks/page-fonts.ts'),
  ])
} finally { loader.deregister() }

const [{ pageTokens, BOARD_PATH: boardPath }, { servePage, pagePolicy }, { STRINGS }, { AGENT_ICONS }, { FONT_LICENSE }] = source
const SANS = 'Inter,"PingFang TC","Noto Sans TC","Microsoft JhengHei UI","Microsoft JhengHei","Hiragino Sans","PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif'
const SANS_SC = 'Inter,"PingFang SC","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang TC","Noto Sans TC","Microsoft JhengHei UI","Microsoft JhengHei","Hiragino Sans",system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif'
const MONO = 'ui-monospace,"SF Mono","Cascadia Mono","Segoe UI Mono",Menlo,Consolas,"Liberation Mono",monospace'
const PRIVACY = /\b[\da-f]{8}\b|\b[\da-f]{40}\b|\b[\da-f]{64}\b|(?<![A-Za-z])[A-Za-z]:[\\/]|\/home\/|\/Users\//i
const renders = (lang = 'en') => {
  const s = STRINGS[lang]
  return [
    { name: 'page', lang, html: servePage(s, 'n') },
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
const isTokenRule = rule => /^:root(?:$|\[data-theme="dark"\]$|:not\(\[data-theme="light"\]\)$|:lang\(zh-Hans\)$)/.test(rule.selector)
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
const isMobile = rule => rule.ancestors.some(ancestor => /@media\s*\([^)]*max-width\s*:\s*(?:600|640|760)px\s*\)/.test(ancestor))
// The sheet that holds Needs you is the one raised surface. A field, an outlined button (filled with the surface so it reads on the
// ground and on the sheet alike) and a card of the Needs you view, which is its own sheet, may use it too. A select is a field.
const surfaceAllowed = selector => /(?:^|\s)(?:textarea|input|select)(?=$|[:[\s])/.test(selector) || /(?:^|\s)\.sheet$/.test(selector) ||
  /(?:^|\s)(?:\.btn|\.shelf-head|button[\w.:-]*|#close)(?=$|[:\s])/.test(selector) || /\.cards>li$/.test(selector)

test('the page uses only colour, size, radius, spacing and motion tokens from page-look', () => {
  const expected = {
    text: { 'text-xs': 'max(13px,.8125rem)', 'text-sm': 'max(14px,.875rem)', 'text-md': 'max(16px,1rem)', 'text-lg': 'max(20px,1.25rem)' },
    radius: { 'radius-s': '6px', 'radius-m': '10px', 'radius-round': '999px' },
    dur: { 'dur-fast': '120ms', 'dur-base': '200ms', 'dur-layout': '260ms', 'dur-glow': '1.6s', 'dur-dots': '1.2s', 'dur-theme': '.28s' },
    ease: { 'ease-out': 'cubic-bezier(.2,0,0,1)', 'ease-in': 'cubic-bezier(.4,0,1,1)' },
  }
  for (const [prefix, values] of Object.entries(expected)) {
    assert.deepEqual([...definedTokens].filter(name => name.startsWith(`${prefix}-`)).sort(), Object.keys(values).sort(), `${prefix} has no additional theme-only tokens`)
    assert.deepEqual(Object.fromEntries(Object.entries(light).filter(([name]) => name.startsWith(`${prefix}-`))), values, `${prefix} has exactly the specified tokens`)
    for (const [name, value] of Object.entries(values)) assert.equal(dark[name], value, `${name} is unchanged by dark mode`)
  }
  assert.deepEqual(Object.fromEntries(Object.entries(light).filter(([name]) => /^s\d$/.test(name))), { s1: '4px', s2: '8px', s3: '12px', s4: '16px', s5: '24px', s6: '32px', s7: '48px' }, 'spacing is the 4px scale')
  assert.equal(light.hit, '36px', 'a control is at least 36px tall')
  // Every text size is a floor that follows the reader's own font size, and nothing is below 13px.
  for (const value of Object.values(expected.text)) assert.match(value, /^max\((\d+)px,[\d.]+rem\)$/, 'text sizes are max(px floor, rem)')
  assert.ok(Object.values(expected.text).every(value => Number(/^max\((\d+)px/.exec(value)[1]) >= 13), 'no text size is below 13px')
  const phone = tokenRules.find(rule => rule.ancestors.some(ancestor => /max-width\s*:\s*640px/.test(ancestor)))
  assert.deepEqual(phone?.declarations, [{ property: '--text-lg', value: 'max(18px,1.125rem)' }], 'the question size is 18px on a phone')
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
    assert.equal(valuesOf(roots[0])['head-h'], '56px', `${name}: the header fallback height remains defined`)
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
        if (property === 'border-radius') assert.match(value, /^(?:0|var\(--radius-(?:s|m|round)\))(?:\s+(?:0|var\(--radius-(?:s|m|round)\))){0,3}$/, `${where}: use the three radii`)
        // The only shadow is the focus ring around a field; everything else is flat.
        if (property === 'box-shadow') assert.ok(value === 'none' || value === 'var(--ring)' && /:focus/.test(rule.selector), `${where}: the page is flat; only the sheet is raised, by its border and surface`)
        if (/^(?:transition|animation)(?:-(?:duration|timing-function|delay))?$/.test(property) && value !== 'none' && !/^\.ab-(?:logo|icon)(?=$|[\s.:])/.test(rule.selector)) {
          if (property !== 'animation-delay') assert.doesNotMatch(value, /(?:^|[\s,])[\d.]+m?s\b/, `${where}: no literal duration`)
          assert.doesNotMatch(value, /cubic-bezier|linear\(/, `${where}: easing comes from the ease tokens`)
        }
        if (/^(?:background|background-color)$/.test(property) && varsUsed(value).includes('surface')) {
          for (const selector of rule.selector.split(',')) assert.ok(surfaceAllowed(selector.trim()), `${where}: surface is reserved for Needs you, fields and buttons`)
        }
      }
    }
    assert.ok(rules.some(rule => rule.selector === '.sheet' && rule.declarations.some(item => /^(?:background|background-color)$/.test(item.property) && item.value === 'var(--surface)')), `${name}: .sheet retains its surface background`)
    const bodyFont = rules.filter(rule => rule.selector === 'body').flatMap(rule => rule.declarations.filter(item => item.property === 'font')).at(-1)
    assert.equal(bodyFont?.value, 'var(--text-sm)/1.5 var(--font-sans)', `${name}: body uses the 14px text size and line height`)
    assert.ok(rules.some(rule => rule.selector === ':focus-visible' && rule.declarations.some(item => item.property === 'outline')), `${name}: keyboard focus keeps its outline`)
    const reduced = rules.filter(rule => rule.ancestors.some(ancestor => ancestor.includes('prefers-reduced-motion:reduce')))
    assert.ok(reduced.some(rule => rule.declarations.some(item => item.property === 'transition' && item.value === 'none') && rule.declarations.some(item => item.property === 'animation' && item.value === 'none')), `${name}: reduced motion turns every transition and animation off`)
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
const mix = (a, b, share) => channels(a).map((channel, index) => Math.round(channel * share + channels(b)[index] * (1 - share)))
const contrast = (foreground, background) => {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

test('every text colour passes 4.5:1 and every mark colour 3:1 on its surface in light and dark', t => {
  const text = ['ink', 'muted', 'accent', 'done', 'running', 'soon', 'alert', 'project', 'waiting-text']
  const marks = ['waiting', 'brand', 'accent', 'done', 'running', 'soon', 'alert', 'ink', 'muted']
  const pairs = []
  assert.equal(light.waiting.toLowerCase(), '#9a7200', 'the light waiting flag uses the page mark colour')
  assert.equal(dark.waiting.toLowerCase(), '#f8b500', 'the dark waiting flag keeps its page mark colour')
  assert.equal(light['waiting-text'].toLowerCase(), '#715c1f', 'light waiting text has its separate readable colour')
  assert.equal(dark['waiting-text'].toLowerCase(), '#f8b500', 'dark waiting text has its readable colour')
  // The roles: ink acts (the primary button is ink on the surface colour), green is alive, amber is only what needs you.
  for (const palette of [light, dark]) {
    assert.equal(palette.act, 'var(--ink)', 'an action is ink')
    assert.equal(palette['on-act'], 'var(--surface)', 'the text on an action is the surface colour')
    assert.equal(palette.alive, 'var(--done)', 'alive is the green')
    assert.equal(palette['btn-line'], 'color-mix(in srgb,var(--ink) 55%,var(--surface))', 'a button outline is ink over the surface')
  }
  assert.equal(light.brand.toLowerCase(), '#b36a00', 'the light logo uses its deepened amber')
  assert.equal(dark.brand.toLowerCase(), '#f8b500', 'the dark logo is the waiting amber')
  for (const [mode, palette] of Object.entries({ light, dark })) {
    const automatic = valuesOf(tokenRules.find(rule => rule.selector.includes(':not(')))
    for (const name of [...text, ...marks, 'ground', 'surface', 'inset', 'on-accent', 'waiting-fill']) assert.equal(automatic[name], dark[name], `system dark and explicit dark agree for ${name}`)
    for (const [kind, tokens, threshold] of [['text', text, 4.5], ['mark', marks, 3]]) {
      for (const surface of ['ground', 'surface', 'inset']) {
        for (const token of tokens) pairs.push({ mode, rule: `${kind}/${surface}`, token, surface, threshold, ratio: contrast(palette[token], palette[surface]) })
      }
    }
    // The count on an agent's badge and on the Needs you flag (on-accent on the amber fill), the "!" badge (on-accent on
    // the alert colour), the primary button, and the glyph on an offline agent's muted tile. The 13px semibold numerals
    // are not "large text", so the badge pairs need the full 4.5:1.
    // 'surface' on 'ink' is a primary button: its text (--on-act) on its fill (--act), both of which are the ink pair.
    for (const [token, surface, threshold] of [['on-accent', 'accent', 4.5], ['on-accent', 'waiting-fill', 4.5], ['on-accent', 'alert', 4.5], ['on-accent', 'muted', 3], ['ground', 'ink', 4.5], ['surface', 'ink', 4.5]]) pairs.push({ mode, rule: `${token}/${surface}`, token, surface, threshold, ratio: contrast(palette[token], palette[surface]) })
    // An outlined button's border (ink 55% over the surface) is a 3:1 boundary on the ground and on the sheet.
    const outline = `rgb(${mix(palette.ink, palette.surface, .55).join(',')})`
    for (const background of ['ground', 'surface']) pairs.push({ mode, rule: `btn-line/${background}`, token: 'btn-line', surface: background, threshold: 3, ratio: contrast(outline, palette[background]) })
    // The working dot sits on the ground colour's ring, so the ring never has to carry meaning.
    for (const surface of ['ground', 'surface']) pairs.push({ mode, rule: `dot/${surface}`, token: 'running', surface, threshold: 3, ratio: contrast(palette.running, palette[surface]) })
  }
  const minima = [...new Set(pairs.map(pair => `${pair.mode}|${pair.rule}`))].map(key => pairs.filter(pair => `${pair.mode}|${pair.rule}` === key).reduce((lowest, pair) => pair.ratio < lowest.ratio ? pair : lowest))
  t.diagnostic('Contrast minima (WCAG 2.x):\nmode | rule | minimum | token | required\n' + minima.map(pair => `${pair.mode} | ${pair.rule} | ${pair.ratio.toFixed(3)}:1 | ${pair.token} | ${pair.threshold}:1`).join('\n'))
  for (const pair of pairs) assert.ok(pair.ratio >= pair.threshold, `${pair.mode}: --${pair.token} on --${pair.surface} is ${pair.ratio.toFixed(3)}:1, requires ${pair.threshold}:1`)
  // Frame, line and line-strong draw decorative rules and the empty part of a bar, not information.
  const markOnly = new Set(['waiting', 'waiting-fill', 'brand', 'frame', 'line', 'line-strong'])
  for (const { name, html } of renders()) {
    for (const rule of styleRules(html).filter(rule => !isTokenRule(rule))) {
      for (const { property, value } of rule.declarations.filter(item => item.property === 'color')) {
        for (const token of varsUsed(value)) assert.ok(!markOnly.has(token), `${name}: ${rule.selector} { ${property}:${value} } uses a mark-only token for text`)
      }
    }
  }
  // The badge and the flag draw on the amber fill, the "!" badge on the alert colour, the offline tile on the muted colour.
  const declared = (rules, selector, property) => rules.find(rule => rule.selector === selector)?.declarations.find(item => item.property === property)?.value
  for (const { name, html } of renders()) {
    const rules = styleRules(html)
    assert.ok(rules.some(rule => rule.selector === '.icon-btn'), `${name}: the theme switch is one icon button`)
    assert.ok(!rules.some(rule => /(?:^|\s)\.seg\b/.test(rule.selector)), `${name}: the Light/Dark pair is gone`)
    assert.ok(!rules.some(rule => rule.selector.includes('[aria-pressed="true"]') && rule.declarations.some(item => item.property === 'outline')), `${name}: the pressed state does not compete with the focus outline`)
    if (name === 'page') {
      assert.equal(declared(rules, 'button.primary', 'background'), 'var(--act)', `${name}: a primary button is the ink fill`)
      assert.equal(declared(rules, 'button.primary', 'color'), 'var(--on-act)', `${name}: its text is the surface colour`)
      assert.ok(declared(rules, '.btn,.answers button,.acts button,.state button,.composer button,.shelf-head,.pfoot .btn', 'border')?.includes('var(--btn-line)'), `${name}: an outlined button has its 3:1 border`)
      assert.equal(declared(rules, '.s-running', 'color'), 'var(--alive)', `${name}: a running step is the alive green`)
      assert.equal(declared(rules, '.s-blocked', 'color'), 'var(--alert)', `${name}: a blocked step is the alert red`)
    }
    assert.equal(declared(rules, '.badge', 'background'), 'var(--waiting-fill)', `${name}: the badge sits on the amber fill`)
    assert.equal(declared(rules, '.badge', 'color'), 'var(--on-accent)', `${name}: the badge numerals are on-accent`)
    assert.equal(declared(rules, '.badge.bad', 'background'), 'var(--alert)', `${name}: the "!" badge is the alert colour`)
    assert.equal(declared(rules, '.badge', 'border'), '2px solid var(--ground)', `${name}: the badge has the 2px ground ring`)
    assert.ok(!rules.some(rule => /data-presence[^,]*\.ag(?!::)/.test(rule.selector)), `${name}: no state repaints an agent's icon`)
    assert.equal(declared(rules, '.chip[data-presence="open"]::after,.chip[data-presence="connected"]::after', 'border-color'), 'var(--alive)', `${name}: an open agent's mark is a green ring`)
    assert.equal(declared(rules, '.chip[data-presence="offline"]::after', 'background'), 'var(--muted)', `${name}: a closed agent's mark is a grey square`)
    assert.ok(declared(rules, '.chip[data-presence="notseen"]::after', 'background')?.includes('8px 2px'), `${name}: a quiet agent's mark is a grey dash`)
    assert.equal(declared(rules, '.chip.working::after', 'background'), 'var(--alive)', `${name}: a working agent's mark is a green dot`)
    assert.ok(!rules.some(rule => rule.selector.includes('.chip') && rule.declarations.some(item => item.property === 'opacity')), `${name}: no icon is dimmed with opacity`)
    assert.equal(declared(rules, '.flag', 'background'), 'var(--waiting-fill)', `${name}: the flag sits on the amber fill`)
  }
})

test('the page embeds its fonts, makes no font request and allows only font-src data:', () => {
  assert.equal(light['font-sans'], SANS, 'the sans token starts with Inter, then the CJK UI fonts and the system stack')
  assert.equal(light['font-mono'], MONO, 'the mono token is the exact system stack')
  assert.match(FONT_LICENSE, /^Copyright \(c\) 2016 The Inter Project Authors/)
  assert.equal(FONT_LICENSE, readFileSync(new URL('../hooks/fonts/OFL.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), 'the bundled license matches the license shipped beside the source')
  const hashes = {
    400: 'dd05e326cf8eac3b55acecf29c842ed73e6e6dd06491cf47f7e8800680ab3e33',
    600: '62553d159189834af73c9a6264704be5b2bee9a08da66a14768d8e5c6ffd2cdb',
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
        assert.match(face, /\bfont-family\s*:\s*Inter\s*;/i, `${where}: font family`)
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
      // The footer's link to the project is the one remote address: something the person opens, never something the page loads.
      const projectLink = /<a class="ver-link" href="https:\/\/github\.com\/WenyuChiou\/agent-board" target="_blank" rel="noopener"[^>]*>/
      assert.equal(projectLink.test(markup), name === 'page', `${where}: only the live page links to the project`)
      assert.doesNotMatch(markup.replace(projectLink, ''), /(?:https?:)?\/\/[a-z\d]/i, `${where}: no remote or protocol-relative URL`)
      for (const link of html.match(/<link\b[^>]*>/gi) ?? []) assert.doesNotMatch(link, /\brel\s*=\s*["'](?:stylesheet|preload)["']/i, `${where}: no stylesheet or preload link`)
      for (const match of cleanCss.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) assert.match(match[1] ?? match[2] ?? match[3], /^(?:data:image\/svg\+xml,|data:font\/woff2;base64,)/, `${where}: CSS URLs are inline SVG images or WOFF2 fonts`)
      const sans = valuesOf(styleRules(html).find(rule => rule.selector === ':root'))['font-sans']
      assert.equal(sans, SANS, `${where}: the rendered page uses Inter with the CJK and system fallback stack`)
      for (const face of ['Noto Sans TC', 'Noto Sans SC', 'PingFang TC', 'PingFang SC', 'Microsoft JhengHei', 'Microsoft YaHei']) assert.ok(sans.includes(`"${face}"`), `${where}: ${face} is available for Chinese text`)
    }
  }
})

test('a zh-CN page lists the Simplified Chinese UI fonts before the Traditional ones', () => {
  const hans = tokenRules.find(rule => rule.selector === ':root:lang(zh-Hans)')
  assert.ok(hans, 'pageTokens declares a Simplified Chinese font rule')
  const sans = valuesOf(hans)['font-sans']
  assert.ok(sans, 'the Simplified Chinese rule sets --font-sans')
  assert.ok(sans.startsWith('Inter,'), 'the Simplified Chinese stack still starts with Inter')
  for (const [sc, tc] of [['"PingFang SC"', '"PingFang TC"'], ['"Noto Sans SC"', '"Noto Sans TC"'], ['"Microsoft YaHei"', '"Microsoft JhengHei"']]) {
    assert.ok(sans.includes(sc) && sans.includes(tc), `${sc} and ${tc} are both in the stack`)
    assert.ok(sans.indexOf(sc) < sans.indexOf(tc), `${sc} comes before ${tc}`)
  }
  assert.equal(sans, SANS_SC, 'the Simplified Chinese stack is Inter, the SC fonts, then the rest')
  assert.equal(light['font-sans'], SANS, 'the base stack is unchanged for en and zh-TW')
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const html = servePage(STRINGS[lang], 'n')
    const rule = styleRules(html).find(item => item.selector === ':root:lang(zh-Hans)')
    assert.ok(rule, `${lang}: the page ships the Simplified Chinese font rule`)
    assert.equal(valuesOf(rule)['font-sans'], SANS_SC, `${lang}: the shipped rule lists the SC fonts first`)
  }
})

const attribute = (tag, name) => new RegExp(`\\b${name}=("|')([\\s\\S]*?)\\1`, 'i').exec(tag)?.[2]
const BOARD_PATH = 'M31.04 8H20A12 12 0 0 0 8 20V44A12 12 0 0 0 20 56H44A12 12 0 0 0 56 44V32.96A1 1 0 0 0 54.35 32.2A16 16 0 0 1 31.8 9.65A1 1 0 0 0 31.04 8Z'
const withoutTemplates = html => html.replace(/<template\b[\s\S]*?<\/template>/g, '')
const logosOf = html => [...withoutTemplates(html).matchAll(/<svg\b(?=[^>]*\bclass="ab-(?:logo|icon)\b)[^>]*>[\s\S]*?<\/svg>/g)].map(match => match[0])
const isLogoRule = rule => /^\.ab-(?:logo|icon)(?=$|[\s.:])/.test(rule.selector)

test('the sidebar, the rail and the narrow header carry the Corner Light logo, scoped and in the page’s theme', () => {
  assert.equal(boardPath, BOARD_PATH, 'the board is the Corner Light outline')
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const { html } = renders(lang)[0]
    const s = STRINGS[lang]
    const logos = logosOf(html)
    assert.equal(logos.length, 3, lang + ': the name in the sidebar, the icon for the rail and the name in the narrow header')
    const [name, rail, narrow] = logos
    for (const [where, svg] of [['the sidebar', name], ['the narrow header', narrow]]) {
      assert.match(svg, /^<svg class="ab-logo is-idle" width="108" height="18" viewBox="-3 -103 830\.63 135\.66" role="img" aria-label="Agent Board">/, lang + ': ' + where + ' shows the designed name as one labelled picture, idle to begin with')
      assert.ok(svg.includes('<title>' + s.serveLiveHint + '</title>'), lang + ': the live hint is the name’s tooltip in ' + where)
    }
    assert.match(rail, /^<svg class="ab-icon is-idle" width="28" height="28" viewBox="0 0 64 64" role="img" aria-label="Agent Board">/, lang + ': the rail icon')
    assert.ok(html.includes('<h1>' + narrow + '</h1>'), lang + ': the narrow header’s heading is the designed name, not typed text')
    assert.doesNotMatch(html, /<h1>Agent Board<\/h1>/, lang + ': no typed name is left in the narrow header')
    for (const svg of logos) {
      assert.ok(Buffer.byteLength(svg) < 8192, lang + ': each inline picture stays under 8 KB')
      assert.doesNotMatch(svg, /<style|xmlns|<image|<text|font/i, lang + ': paths and circles only; the page’s stylesheet carries the motion')
    }
    for (const svg of [rail]) assert.ok(svg.includes('d="' + BOARD_PATH + '"') && svg.includes('<circle class="ab-dot" cx="44" cy="20" r="12"/>'), lang + ': the icon is the board with its light')
    assert.doesNotMatch(html, /class="live"|class="b-name"|lg-mark|class="mark"/, lang + ': the live pill, the typed name and the old mark are gone')
    const template = /<template id="fresh-mark">(<svg[^>]*>)/.exec(html)?.[1] ?? ''
    assert.match(template, /class="ab-icon is-idle is-arriving"[^>]*width="44"|width="44"[^>]*class="ab-icon is-idle is-arriving"|class="ab-icon is-idle is-arriving" width="44"/, lang + ': the first run’s 44 px mark waits in a template')
    const rules = styleRules(html)
    const logoRules = rules.filter(isLogoRule)
    assert.ok(logoRules.length > 20, lang + ': the logo’s rules are in the page’s stylesheet')
    const keyframes = [...html.matchAll(/@keyframes ([\w-]+)/g)].map(match => match[1]).filter(keyName => keyName.startsWith('ab-'))
    assert.ok(keyframes.length >= 10 && keyframes.every(keyName => /^ab-[li]-/.test(keyName)), lang + ': the keyframes are named ab-l-* and ab-i-*')
    for (const state of ['is-working', 'is-waiting', 'is-offline']) {
      assert.ok(logoRules.some(rule => rule.selector.includes('.ab-logo.' + state)), lang + ': the name has a ' + state + ' look')
      assert.ok(logoRules.some(rule => rule.selector.includes('.ab-icon.' + state)), lang + ': the icon has a ' + state + ' look')
    }
    for (const owner of ['.ab-logo', '.ab-icon']) {
      assert.ok(rules.some(rule => rule.selector === owner + ' *' && rule.ancestors.some(ancestor => ancestor.includes('prefers-reduced-motion:reduce')) && rule.declarations.some(item => item.property === 'animation' && item.value.startsWith('none'))), lang + ': reduced motion stops ' + owner)
    }
    assert.doesNotMatch(html, PRIVACY, lang + ': the full output satisfies the privacy contract')
  }
})

test('the tab icon is the Corner Light in ink, and in its needs-you form the light is amber, in light and dark', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const { html } = renders(lang)[0]
    const links = (html.match(/<link\b[^>]*>/gi) ?? []).filter(link => attribute(link, 'rel') === 'icon')
    assert.equal(links.length, 1, lang + ': there is one favicon')
    assert.equal(attribute(links[0], 'type'), 'image/svg+xml', lang + ': the favicon is SVG')
    const icons = { calm: attribute(links[0], 'href'), needs: attribute(links[0], 'data-needs') }
    for (const [kind, href] of Object.entries(icons)) {
      const where = lang + ' ' + kind + ' icon'
      assert.match(href, /^data:image\/svg\+xml,/, where + ': an inline picture')
      const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length))
      assert.match(svg, /\bviewBox="0 0 64 64"/, where + ': the 64 grid')
      assert.ok(svg.includes('<path class="b" d="' + BOARD_PATH + '"/>') && svg.includes('<circle class="d" cx="44" cy="20" r="12"/>'), where + ': the board and its light')
      assert.doesNotMatch(svg, /#/, where + ': the data URL cannot encode hex colours into private-looking ids')
      const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1]
      assert.ok(style, where + ': carries its theme colours')
      assert.match(style, /@media\s*\(prefers-color-scheme:dark\)/, where + ': follows dark mode')
      const styleRules = cssRules(style)
      for (const [mode, palette, tab] of [['light', light, '#dee1e6'], ['dark', dark, '#202124']]) {
        const fillOf = selector => styleRules.find(rule => rule.selector === selector && (mode === 'dark') === rule.ancestors.some(ancestor => ancestor.includes('prefers-color-scheme:dark')))?.declarations.find(item => item.property === 'fill')?.value
        const rgbOf = colour => 'rgb(' + channels(colour).join(',') + ')'
        assert.equal(fillOf('.b'), rgbOf(palette.ink), where + ': the ' + mode + ' board is ink')
        assert.equal(fillOf('.d'), rgbOf(kind === 'needs' ? palette.brand : palette.ink), where + ': the ' + mode + ' light is ' + (kind === 'needs' ? 'amber' : 'ink'))
        for (const selector of ['.b', '.d']) for (const [surface, colour] of [['page ground', palette.ground], ['browser tab', tab]]) assert.ok(contrast(fillOf(selector), colour) >= 3, where + ': ' + mode + ' ' + selector + ' on the ' + surface + ' needs 3:1')
      }
    }
    assert.notEqual(icons.calm, icons.needs, lang + ': the two icons differ')
  }
})

// docs/images/brand/ is drawn by docs/preview/render.ts; these are the files it wrote.
test('the brand lockups and the mark are paths and circles only, on a transparent background, in light and dark', () => {
  const brand = name => readFileSync(new URL('../docs/images/brand/' + name, import.meta.url), 'utf8')
  const grounds = { light: '#ffffff', dark: '#0d1117' }
  for (const [mode, palette] of Object.entries({ light, dark })) {
    const svg = brand('agent-board-lockup-' + mode + '.svg')
    const where = 'the ' + mode + ' lockup'
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*\brole="img"[^>]*\baria-label="Agent Board"/, where + ': one labelled picture')
    const elements = [...svg.matchAll(/<([a-z]+)\b/gi)].map(match => match[1])
    assert.deepEqual([...new Set(elements)].sort(), ['circle', 'path', 'svg', 'title'], where + ': paths and the light only, no text, font, image or background')
    assert.equal(elements.filter(name => name === 'circle').length, 1, where + ': one light, between the two words')
    const fills = new Set([...svg.matchAll(/\bfill="([^"]+)"/g)].map(match => match[1].toLowerCase()))
    assert.deepEqual([...fills].sort(), [palette.brand, palette.ink].map(colour => colour.toLowerCase()).sort(), where + ': the words in ink, the light in brand')
    assert.doesNotMatch(svg, /stroke|font|<rect|<image|background/i, where + ': no stroke, font or background')
    for (const colour of fills) assert.ok(contrast(colour, grounds[mode]) >= 3, where + ': ' + colour + ' on GitHub’s ' + mode + ' ground needs 3:1')
    assert.doesNotMatch(svg, PRIVACY, where + ': satisfies the privacy contract')
  }
  const mark = brand('agent-board-mark.svg')
  assert.match(mark, /\bviewBox="0 0 64 64"/, 'the mark file uses the 64 grid')
  assert.deepEqual([...mark.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match => match[1]), [BOARD_PATH], 'the mark file is the board')
  assert.match(mark, /<circle class="brand" cx="44" cy="20" r="12"\/>/, 'the mark file has the light in its corner')
  assert.doesNotMatch(mark, /<(?:text|rect|image)\b|font|stroke/i, 'the mark file has no text, background or stroke')
  assert.equal(/<style>([\s\S]*?)<\/style>/.exec(mark)?.[1], '.ink{fill:' + light.ink + '}.brand{fill:' + light.brand + '}@media (prefers-color-scheme:dark){.ink{fill:' + dark.ink + '}.brand{fill:' + dark.brand + '}}', 'the mark file follows the reader’s theme')
  // The README's title: the same lockup, coloured by its own style so it follows the reader's theme.
  const logo = brand('agent-board-logo.svg')
  assert.deepEqual([...new Set([...logo.matchAll(/<([a-z]+)\b/gi)].map(match => match[1]))].sort(), ['circle', 'path', 'style', 'svg', 'title'], 'the theme-following lockup is paths, its light and its style only')
  assert.deepEqual([...logo.matchAll(/<(?:path|circle)\b[^>]*>/g)].map(match => /\bclass="([^"]+)"/.exec(match[0])?.[1]), ['ink', 'brand'], 'the theme-following lockup: the words in ink, the light in brand')
  assert.doesNotMatch(logo, /\bfill="|stroke|font|<rect|<image|background/i, 'the theme-following lockup takes its colours from its style alone')
  assert.equal(/<style>([\s\S]*?)<\/style>/.exec(logo)?.[1], '.ink{fill:' + light.ink + '}.brand{fill:' + light.brand + '}@media (prefers-color-scheme:dark){.ink{fill:' + dark.ink + '}.brand{fill:' + dark.brand + '}}', 'the theme-following lockup uses the lockups’ colours')
  assert.doesNotMatch(logo, PRIVACY, 'the theme-following lockup satisfies the privacy contract')
})

test('receipt state groups have distinct tokens with >= 4.5:1 contrast and disabled primary buttons keep contrast (#1400)', () => {
  const automatic = valuesOf(tokenRules.find(rule => rule.selector.includes(':not(')))
  const groups = ['wait', 'done', 'fail']
  for (const [mode, palette] of Object.entries({ light, dark })) {
    const fgs = new Set(), bgs = new Set()
    for (const group of groups) {
      const fg = palette[`receipt-${group}`], bg = palette[`receipt-${group}-bg`], line = palette[`receipt-${group}-line`]
      assert.ok(fg && bg && line, `${mode}: receipt-${group} tokens exist`)
      if (mode === 'dark') {
        assert.equal(automatic[`receipt-${group}`], fg, `system dark and explicit dark agree for receipt-${group}`)
        assert.equal(automatic[`receipt-${group}-bg`], bg, `system dark and explicit dark agree for receipt-${group}-bg`)
        assert.equal(automatic[`receipt-${group}-line`], line, `system dark and explicit dark agree for receipt-${group}-line`)
      }
      assert.ok(contrast(fg, bg) >= 4.5, `${mode}: receipt-${group} on receipt-${group}-bg is ${contrast(fg, bg).toFixed(2)}:1, requires 4.5:1`)
      fgs.add(fg.toLowerCase())
      bgs.add(bg.toLowerCase())
    }
    assert.equal(fgs.size, 3, `${mode}: all three receipt state text colours differ`)
    assert.equal(bgs.size, 3, `${mode}: all three receipt state background colours differ`)
  }
  const pageRules = styleRules(renders().find(one => one.name === 'page').html)
  const disabledPrimary = pageRules.find(rule => rule.selector === 'button.primary:disabled')
  assert.equal(disabledPrimary?.declarations.find(item => item.property === 'background')?.value, 'var(--act)')
  assert.equal(disabledPrimary?.declarations.find(item => item.property === 'color')?.value, 'var(--on-act)')
  assert.equal(disabledPrimary?.declarations.find(item => item.property === 'opacity')?.value, '1')
  const disabledSendingArrow = pageRules.find(rule => rule.selector === '.answers button.answer-send[data-sending="1"]:disabled')
  assert.equal(disabledSendingArrow?.declarations.find(item => item.property === 'opacity')?.value, '1')
})
