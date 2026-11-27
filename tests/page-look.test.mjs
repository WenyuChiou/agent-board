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
    import('../hooks/retention.ts'),
    import('../hooks/view.ts'),
    import('../hooks/parse.ts'),
    import('../hooks/questions.ts'),
    import('../hooks/board-status.ts'),
    import('../hooks/board-json.ts'),
    import('./e2e/lib/surfaces.mjs'),
  ])
} finally { loader.deregister() }

const [{ pageTokens, BOARD_PATH: boardPath }, { serveModel, servePage, pagePolicy, handledOnly }, { STRINGS }, { AGENT_ICONS }, { FONT_LICENSE }, { RETENTION, sizeWarnings, storageDetails }, { buildView }, { parseProgress }, { observeQuestions }, { boardCounts }, { boardDocument }, { pageDom }] = source
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
    text: { 'text-xs': 'max(13px,.8125rem)', 'text-sm': 'max(14px,.875rem)', 'text-md': 'max(16px,1rem)', 'text-lg': 'max(18px,1.125rem)' },
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
  assert.equal(light.waiting.toLowerCase(), '#8a5d00', 'the light waiting flag uses the page mark colour')
  assert.equal(dark.waiting.toLowerCase(), '#f8b500', 'the dark waiting flag keeps its page mark colour')
  assert.equal(light['waiting-text'].toLowerCase(), '#8a5200', 'light waiting text has its separate readable colour')
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
    for (const name of [...text, ...marks, 'ground', 'surface', 'inset', 'on-accent', 'waiting-fill', 'waiting-on', 'surf-cli-bg', 'surf-cli-line', 'surf-cli-ink', 'surf-app-bg', 'surf-app-line', 'surf-app-ink']) assert.equal(automatic[name], dark[name], `system dark and explicit dark agree for ${name}`)
    for (const [kind, tokens, threshold] of [['text', text, 4.5], ['mark', marks, 3]]) {
      for (const surface of ['ground', 'surface', 'inset']) {
        for (const token of tokens) pairs.push({ mode, rule: `${kind}/${surface}`, token, surface, threshold, ratio: contrast(palette[token], palette[surface]) })
      }
    }
    // The count on an agent's badge and on the Needs you flag (waiting-on on the Yamabuki amber fill), the "!" badge (on-accent on
    // the alert colour), the surface pills (CLI and App), the primary button, and the glyph on an offline agent's muted tile.
    // 'surface' on 'ink' is a primary button: its text (--on-act) on its fill (--act), both of which are the ink pair.
    for (const [token, surface, threshold] of [['on-accent', 'accent', 4.5], ['waiting-on', 'waiting-fill', 4.5], ['on-accent', 'alert', 4.5], ['surf-cli-ink', 'surf-cli-bg', 4.5], ['surf-app-ink', 'surf-app-bg', 4.5], ['on-accent', 'muted', 3], ['ground', 'ink', 4.5], ['surface', 'ink', 4.5]]) pairs.push({ mode, rule: `${token}/${surface}`, token, surface, threshold, ratio: contrast(palette[token], palette[surface]) })
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
    assert.equal(declared(rules, '.badge', 'color'), 'var(--waiting-on)', `${name}: the badge numerals use waiting-on`)
    assert.equal(declared(rules, '.badge.bad', 'background'), 'var(--alert)', `${name}: the "!" badge is the alert colour`)
    assert.equal(declared(rules, '.badge.bad', 'color'), 'var(--on-accent)', `${name}: the "!" badge numerals use on-accent`)
    assert.equal(declared(rules, '.badge', 'border'), '2px solid var(--ground)', `${name}: the badge has the 2px ground ring`)
    assert.ok(!rules.some(rule => /data-presence[^,]*\.ag(?!::)/.test(rule.selector)), `${name}: no state repaints an agent's icon`)
    assert.equal(declared(rules, '.chip[data-presence="open"]::after,.chip[data-presence="connected"]::after', 'border-color'), 'var(--alive)', `${name}: an open agent's mark is a green ring`)
    assert.equal(declared(rules, '.chip[data-presence="offline"]::after', 'background'), 'var(--muted)', `${name}: a closed agent's mark is a grey square`)
    assert.ok(declared(rules, '.chip[data-presence="notseen"]::after', 'background')?.includes('8px 2px'), `${name}: a quiet agent's mark is a grey dash`)
    assert.equal(declared(rules, '.chip.working::after', 'background'), 'var(--alive)', `${name}: a working agent's mark is a green dot`)
    assert.ok(!rules.some(rule => rule.selector.includes('.chip') && rule.declarations.some(item => item.property === 'opacity')), `${name}: no icon is dimmed with opacity`)
    assert.equal(declared(rules, '.flag', 'background'), 'var(--waiting-fill)', `${name}: the flag sits on the amber fill`)
    assert.equal(declared(rules, '.flag', 'color'), 'var(--waiting-on)', `${name}: the flag text uses waiting-on`)
    assert.equal(declared(rules, '.s-n.hot,.side .badge', 'color'), 'var(--waiting-on)', `${name}: sidebar waiting badge uses waiting-on`)
    assert.equal(declared(rules, '.side .badge.bad', 'color'), 'var(--on-accent)', `${name}: sidebar alert badge uses on-accent`)
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

test('a board over every size limit shows no storage notice on the first screen', async () => {
  const sizes = { progress: RETENTION.progressSoftBytes + 128 * 1024, store: RETENTION.storeWarnBytes + 512 * 1024 }
  const projects = parseProgress('## Synthetic project\n### Synthetic task\n- [ ] Check size notice placement\n')
  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const s = STRINGS[lang]
    const base = buildView(projects, ['Synthetic project'], null, now, 0, {}, s)
    const details = storageDetails(sizes, 0, s)
    const largeView = { ...base, warning: sizeWarnings(sizes, s).join(' · '), isLarge: true, details }
    const group = { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' }
    const html = servePage(s, 'synthetic')
    const dom = await pageDom(html, serveModel(largeView, [], s, new Set(), false, undefined, false, group))
    const boardText = `${dom.node('board').readText}\n${dom.node('board').textContent}`
    assert.ok(!boardText.includes(s.boardLarge), `${lang}: boardLarge must not appear on the first screen`)
    assert.ok(!boardText.includes(s.progressLarge(Math.round(sizes.progress / 1024), RETENTION.progressSoftBytes / 1024)), `${lang}: progressLarge must not appear on the first screen`)
    assert.ok(!boardText.includes(s.storeLarge((sizes.store / (1024 * 1024)).toFixed(1), (RETENTION.storeCapBytes / (1024 * 1024)).toFixed(1))), `${lang}: storeLarge must not appear on the first screen`)

    const storageHtml = /<section id="settings-storage"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? ''
    assert.equal((storageHtml.match(/<p\b/g) ?? []).length, 1, `${lang}: Settings has one storage line`)
    const storageSection = dom.node('settings-storage')
    const storageLine = dom.node('settings-storage-line')
    assert.equal(storageSection.hidden, false, `${lang}: Settings shows the storage section when over a limit`)
    assert.equal(storageLine.textContent, details, `${lang}: Settings line carries the full storage details`)

    const smallDom = await pageDom(html, serveModel(base, [], s, new Set(), false, undefined, false, group))
    assert.equal(smallDom.node('settings-storage').hidden, true, `${lang}: Settings hides the storage section under the limits`)
    assert.equal(smallDom.node('settings-storage-line').textContent, '', `${lang}: Settings storage line is empty under the limits`)

    const writeFailView = { ...largeView, warning: [s.journalFailed, s.boardLarge].join(' · ') }
    const writeFailDom = await pageDom(html, serveModel(writeFailView, [], s, new Set(), false, undefined, false, group))
    const writeFailBoardText = `${writeFailDom.node('board').readText}\n${writeFailDom.node('board').textContent}`
    assert.ok(writeFailBoardText.includes(s.journalFailed), `${lang}: write failure still speaks on the first screen`)
    assert.ok(!writeFailBoardText.includes(s.boardLarge), `${lang}: boardLarge stays hidden alongside a write failure`)
  }
})

test("a waiting question's folded item is two lines at 1280 px", async () => {
  const s = STRINGS.en
  const html = servePage(s, 'n')
  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  const md = [
    '## weather-model',
    `<!-- auto session=aa11bb22 agent=codex state=waiting updated=${new Date(now - 7 * 60000).toISOString()} -->`,
    '### Compare rainfall model error rates across stations',
    '> Context: Need the Q4 report pick before Friday review.',
    '- [x] Load station series',
    '- [?] Choose model for `bun run compare-models`?',
    '<!-- options=["ECMWF","Local model","Hybrid","Skip"] -->',
    '<!-- /auto session=aa11bb22 -->',
    '',
  ].join('\n')
  const view = buildView(parseProgress(md), ['weather-model'], null, now, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const model = serveModel(view, [], s, new Set(), false, undefined, false, { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' })
  const dom = await pageDom(html, model)
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)]
  const isInert = node => {
    for (let cur = node; cur; cur = cur.parentNode) if (cur.inert || cur.hidden) return true
    return false
  }
  const card = walk(dom.node('needs')).find(node => node.tag === 'article' && node.getAttribute('data-ref-key'))
  assert.ok(card, 'question card renders in Needs you')
  const descendants = walk(card)
  const mark = descendants.find(node => String(node.className ?? '').split(' ').includes('ag'))
  assert.equal(mark?.getAttribute('title'), 'Codex', 'AI mark tooltip carries the AI name')
  assert.equal(mark?.getAttribute('role'), 'img', 'AI mark exposes role="img" to screen readers')
  assert.equal(mark?.getAttribute('aria-label'), 'Codex', 'AI mark exposes AI name to screen readers')
  assert.equal(mark?.getAttribute('aria-hidden'), null, 'AI mark is not hidden from screen readers')
  assert.equal(descendants.some(node => String(node.className ?? '').split(' ').includes('who')), false, 'folded item carries no inline AI name word')
  const toggle = descendants.find(node => node.tag === 'button' && String(node.className ?? '').split(' ').includes('q-toggle'))
  assert.ok(toggle, 'line 1 question uses a collapsible toggle button')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'waiting question item starts folded')
  const qNode = descendants.find(node => String(node.className ?? '').split(' ').includes('q'))
  assert.ok(qNode?.textContent.includes('Choose model for'), qNode?.textContent)
  const line2 = descendants.find(node => String(node.className ?? '').split(' ').includes('c-line2'))
  assert.ok(line2, 'folded item has line 2 container (.c-line2)')
  assert.ok(line2.textContent.includes('weather-model') && line2.textContent.includes('7'), 'line 2 shows project and age')
  const visibleButtons = descendants.filter(node => node.tag === 'button' && node !== toggle && !isInert(node))
  assert.ok(visibleButtons.length <= 3, `folded item shows at most 3 controls, got ${visibleButtons.length}`)
  const foldedText = card.visibleText
  for (const hiddenSnippet of [
    'Compare rainfall model error rates across stations',
    'Need the Q4 report pick before Friday review.',
    'Load station series',
    'Hybrid',
    'Skip',
    '$ bun run compare-models',
    s.pgWriteOwn,
    s.answeredHide,
  ]) {
    assert.ok(!foldedText.includes(hiddenSnippet), `folded item hides "${hiddenSnippet}"`)
  }
  toggle.click()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'clicking item opens it')
  const openText = card.visibleText
  for (const detailSnippet of [
    'Compare rainfall model error rates across stations',
    'Need the Q4 report pick before Friday review.',
    'Load station series',
    'Hybrid',
    'Skip',
    '$ bun run compare-models',
    s.pgWriteOwn,
    s.answeredHide,
  ]) {
    assert.ok(openText.includes(detailSnippet), `opened item shows "${detailSnippet}"`)
  }
})

test('no text inside an item is over 14 px', () => {
  const html = servePage(STRINGS.en, 'n')
  const rules = styleRules(html)
  const pxFloor = value => Number(/^max\((\d+)px/.exec(String(value ?? ''))?.[1] ?? NaN)
  const tokenPx = Object.fromEntries(
    ['text-xs', 'text-sm', 'text-md', 'text-lg'].map(name => [name, pxFloor(light[name])]),
  )
  const resolveFontPx = value => {
    const match = /var\(--(text-(?:xs|sm|md|lg))\)/.exec(String(value ?? ''))
    return match ? tokenPx[match[1]] : null
  }
  const isItemSelector = selector => selector.split(',').some(part => {
    const sel = part.trim()
    return /(?:^|[\s.>])(?:card|q|c-meta|c-line2|answers|answer-send|row|r-title|r-meta|r-right|row-open|hid|note|context)\b/.test(sel) ||
      /^(?:code|textarea)(?:$|:|\s)/.test(sel)
  })
  const checkedItemSizes = []
  for (const rule of rules.filter(one => !isTokenRule(one) && isItemSelector(one.selector))) {
    for (const decl of rule.declarations) {
      if (decl.property !== 'font-size' && decl.property !== 'font') continue
      const px = resolveFontPx(decl.value)
      if (px !== null) {
        checkedItemSizes.push({ selector: rule.selector, property: decl.property, value: decl.value, px })
        assert.ok(px <= 14, `${rule.selector} { ${decl.property}: ${decl.value} } resolves to ${px}px > 14px`)
      }
    }
  }
  assert.ok(checkedItemSizes.length > 0, 'item font sizes must be checked')
  const qRule = rules.find(rule => rule.selector === '.q')
  assert.equal(resolveFontPx(qRule?.declarations.find(d => d.property === 'font-size')?.value), 14, '.q question title is 14 px')
  assert.equal(qRule?.declarations.find(d => d.property === 'font-weight')?.value, '600', '.q question title weight is 600')
  assert.notEqual(qRule?.declarations.find(d => d.property === 'white-space')?.value, 'nowrap', '.q without .q-toggle (Older cards) wraps instead of truncating')
  const toggleQRule = rules.find(rule => rule.selector === '.q-toggle .q')
  assert.equal(toggleQRule?.declarations.find(d => d.property === 'white-space')?.value, 'nowrap', '.q-toggle .q folded question stays one line')
  const line2Rule = rules.find(rule => rule.selector === '.c-line2')
  assert.equal(resolveFontPx(line2Rule?.declarations.find(d => d.property === 'font-size')?.value), 13, '.c-line2 second line is 13 px')
  for (const viewSel of ['.sec-head h2', '.flag']) {
    const rule = rules.find(one => one.selector === viewSel)
    assert.equal(resolveFontPx(rule?.declarations.find(d => d.property === 'font-size')?.value), 18, `${viewSel} view title is 18 px`)
  }
})

test('waiting-on-others task folds under Needs you without duplicating in Other work', async () => {
  const now = Date.now()
  const updated = new Date(now - 5 * 60_000).toISOString()
  const md = [
    '## wait-only-repo',
    `<!-- auto session=ww112233 agent=codex state=waiting updated=${updated} -->`,
    '### Review downstream feedback',
    '- [?] Waiting for reviewer reply',
    '<!-- /auto session=ww112233 -->',
    '',
  ].join('\n')
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)]
  const othersSection = dom => dom.node('board').childNodes.find(node => node.getAttribute?.('data-sec') === 'others')

  const enView = buildView(parseProgress(md), ['wait-only-repo'], null, now, 0, {}, STRINGS.en, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const enModel = serveModel(enView, [], STRINGS.en, new Set(), false, undefined, false, { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' })
  const enDom = await pageDom(servePage(STRINGS.en, 'n'), enModel)
  const needsNodes = walk(enDom.node('needs'))
  const waitToggle = needsNodes.find(node => node.tag === 'button' && node.textContent === 'Waiting on others 1')
  assert.ok(waitToggle, 'EN toggle Waiting on others 1 renders under #needs')
  assert.equal(waitToggle.getAttribute('aria-expanded'), 'false')
  const waitWrap = waitToggle.parentNode.parentNode
  const waitFold = waitWrap.childNodes.find(node => String(node.className ?? '').split(' ').includes('fold'))
  assert.ok(waitFold, 'wait-only fold wrapper exists')
  assert.equal(waitFold.inert, true, 'wait-only fold starts inert')
  const others = othersSection(enDom)
  assert.ok(!others || !others.visibleText.includes('Review downstream feedback'), 'wait-only task does not render a duplicate row in Other work')
  assert.ok(enDom.node('side-projects').textContent.includes('wait-only-repo'), 'solo wait-only project stays in sidebar')

  waitToggle.click()
  assert.equal(waitToggle.getAttribute('aria-expanded'), 'true')
  assert.equal(waitFold.inert, false)
  const waitCard = walk(waitFold).find(node => node.tag === 'article' && String(node.className ?? '').split(' ').includes('card'))
  assert.ok(waitCard, 'waitingOthers card renders inside expanded fold')
  assert.ok(waitCard.textContent.includes('Waiting for reviewer reply'))
  const writeOwn = walk(waitCard).find(node => node.tag === 'button' && node.textContent === STRINGS.en.pgWriteOwn)
  assert.ok(writeOwn, 'Write your own control renders on waitingOthers card')
  writeOwn.click()
  assert.ok(walk(waitCard).some(node => node.tag === 'textarea'), 'clicking Write your own reveals composer textarea')

  const twView = buildView(parseProgress(md), ['wait-only-repo'], null, now, 0, {}, STRINGS['zh-TW'], [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const twModel = serveModel(twView, [], STRINGS['zh-TW'], new Set(), false, undefined, false, { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' })
  const twDom = await pageDom(servePage(STRINGS['zh-TW'], 'n'), twModel)
  const twToggle = walk(twDom.node('needs')).find(node => node.tag === 'button' && node.textContent === '等別人 1')
  assert.ok(twToggle, 'zh-TW toggle 等別人 1 renders under #needs')
})

test('row-backed wait task folds into Waiting on others without duplicating in Other work or Working, while staying in boardDocument.waiting', async () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  const updated = new Date(now - 5 * 60_000).toISOString()
  const md = [
    '## wait-row-repo',
    `<!-- auto session=wr112233 agent=codex state=working updated=${updated} -->`,
    '### Ship API endpoint',
    '- [~] Implementing API',
    '- [?] Waiting for reviewer reply',
    '<!-- /auto session=wr112233 -->',
    '',
    '## manual-wait-repo',
    '### Manual review wait',
    '- [ ] Draft release note',
    '- [?] Waiting for team sign-off',
    '',
  ].join('\n')
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)]
  const sectionBy = (dom, sec) => dom.node('board').childNodes.find(node => node.getAttribute?.('data-sec') === sec)
  const group = { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' }

  const view = buildView(parseProgress(md), ['wait-row-repo', 'manual-wait-repo'], null, now, 0, {}, STRINGS.en, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const model = serveModel(view, [], STRINGS.en, new Set(), false, undefined, false, group)

  assert.equal(model.view.needs.n, 0)
  assert.equal(model.view.needs.waitingOthers.length, 2)
  assert.deepEqual(model.view.working, [])
  assert.equal(model.view.all.open.length, 2)
  assert.ok(model.view.all.open.every(ref => ref.waitsOnOthers === true && ref.key.startsWith('row:')))
  assert.deepEqual(boardCounts(view, [], STRINGS.en, now), { needs: 0, queued: 0, working: 0 })

  const doc = boardDocument(view, [], [], STRINGS.en, '', false, now, group)
  assert.equal(doc.counts.needs, 0)
  assert.equal(doc.counts.working, 0)
  assert.equal(doc.counts.waiting, 2)
  assert.deepEqual(doc.waiting.map(one => one.title).sort(), ['Manual review wait', 'Ship API endpoint'])

  const dom = await pageDom(servePage(STRINGS.en, 'n'), model)
  const waitToggle = walk(dom.node('needs')).find(node => node.tag === 'button' && node.textContent === 'Waiting on others 2')
  assert.ok(waitToggle, 'toggle Waiting on others 2 renders under #needs')
  const waitFold = waitToggle.parentNode.parentNode.childNodes.find(node => String(node.className ?? '').split(' ').includes('fold'))
  assert.ok(waitFold, 'wait fold exists')
  assert.equal(waitFold.inert, true, 'wait fold starts inert')
  waitToggle.click()
  assert.equal(waitFold.inert, false, 'wait fold opens on click')
  assert.ok(waitFold.visibleText.includes('Waiting for reviewer reply'))
  assert.ok(waitFold.visibleText.includes('Waiting for team sign-off'))

  const working = sectionBy(dom, 'working')
  assert.ok(!working || !working.visibleText.includes('Ship API endpoint'), 'row-backed wait task must not duplicate in Working')
  const others = sectionBy(dom, 'others')
  assert.ok(!others || (!others.visibleText.includes('Ship API endpoint') && !others.visibleText.includes('Manual review wait')), 'row-backed wait tasks must not duplicate in Other work')
  assert.ok(dom.node('side-projects').textContent.includes('wait-row-repo'), 'row-backed wait project stays in sidebar')
  assert.ok(dom.node('side-projects').textContent.includes('manual-wait-repo'), 'manual row-backed wait project stays in sidebar')
})

test('parseProgress -> buildView -> serveModel orders cards by updated= age, puts AI before manual, and folds reminder/older into Earlier', async () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  const day = 24 * 60 * 60_000
  const min = 60_000
  const iso = ts => new Date(ts).toISOString()
  const s = STRINGS.en
  const group = { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' }

  const md = [
    '## alpha-repo',
    `<!-- auto session=aa100001 agent=codex state=waiting updated=${iso(now - 5 * min)} -->`,
    '### New AI task',
    '- [?] Newer AI question?',
    '<!-- /auto session=aa100001 -->',
    '',
    `<!-- auto session=aa100002 agent=codex state=waiting updated=${iso(now - 30 * day)} -->`,
    '### Long-waiting AI task',
    '- [?] Thirty-day-old AI question?',
    '<!-- /auto session=aa100002 -->',
    '',
    '### Hand-kept task',
    '- [?] Manual checklist question?',
    '',
    `<!-- auto session=aa100003 agent=codex state=waiting updated=${iso(now - 10 * min)} -->`,
    '### Reminder task',
    '- [?] Four-day-old reminder question?',
    '<!-- /auto session=aa100003 -->',
    '',
    `<!-- auto session=aa100004 agent=codex state=waiting updated=${iso(now - 10 * day)} -->`,
    '### Stopped old task',
    '- [?] Ten-day-old stopped question?',
    '<!-- /auto session=aa100004 -->',
    '',
  ].join('\n')

  const projects = parseProgress(md)
  let ledger = { version: 1, next: 1, records: [], legacy: {} }
  // Seed firstObserved timestamps via observeQuestions at historical observation times.
  const reminderOnly = parseProgress([
    '## alpha-repo',
    `<!-- auto session=aa100003 agent=codex state=waiting updated=${iso(now - 4 * day)} -->`,
    '### Reminder task',
    '- [?] Four-day-old reminder question?',
    '<!-- /auto session=aa100003 -->',
    '',
  ].join('\n'))
  ledger = observeQuestions(ledger, reminderOnly, null, [], now - 4 * day).ledger
  const olderOnly = parseProgress([
    '## alpha-repo',
    `<!-- auto session=aa100004 agent=codex state=waiting updated=${iso(now - 10 * day)} -->`,
    '### Stopped old task',
    '- [?] Ten-day-old stopped question?',
    '<!-- /auto session=aa100004 -->',
    '',
  ].join('\n'))
  ledger = observeQuestions(ledger, olderOnly, null, [], now - 10 * day).ledger
  ledger = observeQuestions(ledger, projects, null, [], now).ledger

  // With staleMs covering the 30-day block, observedTime flows updated= into ask.at so it ranks before the 5-min AI card and manual step.
  const view = buildView(projects, ['alpha-repo'], null, now, 0, {}, s, [], {}, ledger, undefined, [], new Set(), undefined, 60 * day)
  const model = serveModel(view, [], s, new Set(), false, undefined, false, group)
  const askText = ref => model.asks.find(one => one.key === ref.key)?.text

  assert.deepEqual(
    model.view.needs.cards.map(askText),
    ['Thirty-day-old AI question?', 'Newer AI question?', 'Manual checklist question?'],
    '30-day updated= AI card precedes 5-min AI card, and AI questions precede hand-kept manual steps',
  )
  assert.equal(model.view.needs.olderLabel, 'Earlier 2')
  assert.deepEqual(
    model.view.needs.older.map(ref => [...model.reminder, ...model.older].find(one => one.key === (ref.sourceKey ?? ref.key))?.text),
    ['Ten-day-old stopped question?', 'Four-day-old reminder question?'],
    'both >7d stopped/older and 3-7d reminder questions flow into model.view.needs.older',
  )

  const dom = await pageDom(servePage(s, 'n'), model)
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)]
  const activeCardsList = walk(dom.node('needs')).find(node => node.tag === 'ul' && String(node.className ?? '').split(' ').includes('cards'))
  const cardQuestions = walk(activeCardsList).filter(node => String(node.className ?? '').split(' ').includes('q')).map(node => node.textContent)
  assert.deepEqual(cardQuestions, ['Thirty-day-old AI question?', 'Newer AI question?', 'Manual checklist question?'])
  const olderToggle = walk(dom.node('needs')).find(node => node.tag === 'button' && node.textContent === s.pgSeeAll)
  assert.ok(olderToggle, 'See all toggle renders for older questions')
  const olderFold = olderToggle.parentNode.parentNode.childNodes.find(node => String(node.className ?? '').split(' ').includes('fold'))
  assert.equal(olderFold.inert, true)
  olderToggle.click()
  assert.equal(olderFold.inert, false)
  assert.ok(olderFold.visibleText.includes('Ten-day-old stopped question?'))
  assert.ok(olderFold.visibleText.includes('Four-day-old reminder question?'))
})

test('Redesign 2 pale washi & Yamabuki palette tokens keep terminal LIGHT/DARK untouched', async () => {
  const { LIGHT, DARK, PAGE_LIGHT, PAGE_DARK } = await import('../hooks/palette.ts')
  assert.equal(LIGHT.accent, '#165E83')
  assert.equal(LIGHT.ground, undefined)
  assert.equal(DARK.accent, '#00A3AF')
  assert.equal(PAGE_LIGHT.ground, '#F3F5F7')
  assert.equal(PAGE_LIGHT.surface, '#FCFDFE')
  assert.equal(PAGE_LIGHT.inset, '#EAEFF2')
  assert.equal(PAGE_LIGHT.ink, '#172026')
  assert.equal(PAGE_LIGHT.accent, '#185A7D')
  assert.equal(PAGE_LIGHT['waiting-fill'], '#F4B41A')
  assert.equal(PAGE_LIGHT['waiting-on'], '#231800')
  assert.equal(PAGE_LIGHT['surf-cli-bg'], '#ECEFF2')
  assert.equal(PAGE_LIGHT['surf-app-bg'], '#E7F2F8')
  assert.equal(PAGE_DARK['waiting-on'], '#141617')
  assert.equal(PAGE_DARK['surf-cli-bg'], '#25282B')
  assert.equal(PAGE_DARK['surf-app-bg'], '#182930')
})

test('Redesign 2 uses icon-only AI identity, distinct CLI/App .surf-pill badges, and keeps vendor names in [AI] filter checklist', async () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  const updated = new Date(now - 2 * 60_000).toISOString()
  const md = [
    '## cli-repo',
    `<!-- auto session=cc100001 agent=codex state=waiting updated=${updated} -->`,
    '### Codex CLI task',
    '- [?] Ship CLI build?',
    '<!-- /auto session=cc100001 -->',
    '',
    '## app-repo',
    `<!-- auto session=cc100002 agent=antigravity state=working updated=${updated} -->`,
    '### Antigravity App task',
    '- [~] Running IDE task',
    '<!-- /auto session=cc100002 -->',
    '',
  ].join('\n')
  const s = STRINGS.en
  const group = { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' }
  const view = buildView(parseProgress(md), ['cli-repo', 'app-repo'], null, now, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  view.hidden = [{ hideKey: 'hid-1', project: 'cli-repo', agent: 'codex', task: 'Hidden plan', text: 'Hidden question?' }]
  const model = serveModel(view, [], s, new Set(), false, {
    connections: [
      { id: 'c-cli', agent: 'codex', session: 'cc100001', surface: 'Codex CLI', scope: 'session', turn: 't1', contested: false, expires: now + 60_000 },
      { id: 'c-app', agent: 'antigravity', session: 'cc100002', surface: 'IDE', scope: 'session', turn: 't2', contested: false, expires: now + 60_000 },
    ],
    messages: [],
  }, false, group)
  const html = servePage(s, 'n')
  const rules = styleRules(html)
  const ruleFor = sel => rules.find(r => r.selector === sel)
  assert.ok(ruleFor('.s-agent .s-txt')?.declarations.some(d => d.property === 'clip-path' && d.value === 'inset(50%)'))
  assert.ok(ruleFor('.chip .c-name')?.declarations.some(d => d.property === 'clip-path' && d.value === 'inset(50%)'))
  assert.ok(!rules.some(r => r.selector === '.chip[aria-pressed="true"] .c-name'))
  assert.ok(ruleFor('.shell[data-rail="1"] .s-agent .surf-wrap')?.declarations.some(d => d.property === 'display' && d.value === 'none'))
  assert.ok(ruleFor('.side .badge')?.declarations.some(d => d.property === 'margin-left' && d.value === 'auto'))
  assert.ok(ruleFor('.r-meta>span+span'), 'uses direct-child combinator .r-meta>span+span')
  assert.ok(ruleFor('.surf-cli')?.declarations.some(d => d.property === 'background' && d.value === 'var(--surf-cli-bg)'))
  assert.ok(ruleFor('.surf-app')?.declarations.some(d => d.property === 'background' && d.value === 'var(--surf-app-bg)'))
  assert.ok(ruleFor('.surf-pill.surf-icon'), 'has compact icon-only pill rule for #chips')
  assert.match(html, /<template id="surf-cli-icon">/)
  assert.match(html, /<template id="surf-app-icon">/)

  const dom = await pageDom(html, model)
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)]
  const hasClass = (node, name) => String(node.className ?? '').split(' ').includes(name)

  // #side-agents renders full CLI/App .surf-pill badges while keeping vendor names and surface labels in aria-label/title.
  const sideCodex = dom.node('side-agents').childNodes.find(n => n.getAttribute?.('data-agent') === 'codex')
  const sideAntig = dom.node('side-agents').childNodes.find(n => n.getAttribute?.('data-agent') === 'antigravity')
  assert.ok(sideCodex.getAttribute('aria-label').includes('Codex · CLI'))
  assert.ok(sideAntig.getAttribute('aria-label').includes('Antigravity · App'))
  assert.ok(walk(sideCodex).some(n => hasClass(n, 'surf-cli') && !hasClass(n, 'surf-icon') && n.textContent.includes('CLI')))
  assert.ok(walk(sideAntig).some(n => hasClass(n, 'surf-app') && !hasClass(n, 'surf-icon') && n.textContent.includes('App')))

  // #chips renders compact icon-only .surf-icon pills and exposes surface labels in aria-label.
  const chipCodex = dom.node('chips').childNodes.find(n => n.getAttribute?.('data-agent') === 'codex')
  const chipAntig = dom.node('chips').childNodes.find(n => n.getAttribute?.('data-agent') === 'antigravity')
  assert.ok(chipCodex.getAttribute('aria-label').includes('Codex · CLI'))
  assert.ok(chipAntig.getAttribute('aria-label').includes('Antigravity · App'))
  assert.ok(walk(chipCodex).some(n => hasClass(n, 'surf-cli') && hasClass(n, 'surf-icon') && n.textContent.trim() === ''))
  assert.ok(walk(chipAntig).some(n => hasClass(n, 'surf-app') && hasClass(n, 'surf-icon') && n.textContent.trim() === ''))

  // Multi-surface agent (both CLI and App sessions at once) renders both badges and includes both surfaces in aria-label.
  const multiMd = [
    '## cli-repo',
    `<!-- auto session=cc200001 agent=codex state=waiting updated=${updated} -->`,
    '### Codex CLI task',
    '- [?] Ship CLI build?',
    '<!-- /auto session=cc200001 -->',
    '',
    '## app-repo',
    `<!-- auto session=cc200002 agent=codex state=working updated=${updated} -->`,
    '### Codex App task',
    '- [~] Running Desktop task',
    '<!-- /auto session=cc200002 -->',
    '',
  ].join('\n')
  for (const [locale, words] of [['en', STRINGS.en], ['zh-TW', STRINGS['zh-TW']], ['zh-CN', STRINGS['zh-CN']]]) {
    const multiView = buildView(parseProgress(multiMd), ['cli-repo', 'app-repo'], null, now, 0, {}, words, [], {}, { version: 1, next: 1, records: [], legacy: {} })
    const rawMessaging = {
      connections: [
        { id: 'c-cli', agent: 'codex', session: 'cc200001', surface: 'Codex CLI', scope: 'session', turn: 't1', contested: false, expires: now + 60_000 },
        { id: 'c-app', agent: 'codex', session: 'cc200002', surface: 'Codex desktop app', scope: 'session', turn: 't2', contested: false, expires: now + 60_000 },
      ],
      messages: [],
    }
    const redacted = handledOnly(rawMessaging)
    assert.deepEqual(redacted.connections, [])
    const redactedJson = JSON.stringify(redacted)
    for (const secret of ['c-cli', 'c-app', 't1', 't2']) assert.ok(!redactedJson.includes(secret), `${locale} leaked ${secret}`)

    for (const [isLan, messaging] of [[false, rawMessaging], [true, redacted]]) {
      const multiModel = serveModel(multiView, [], words, new Set(), isLan, messaging, false, group)
      const multiDom = await pageDom(servePage(words, 'n', isLan), multiModel)
      const multiSide = multiDom.node('side-agents').childNodes.find(n => n.getAttribute?.('data-agent') === 'codex')
      const multiChip = multiDom.node('chips').childNodes.find(n => n.getAttribute?.('data-agent') === 'codex')
      const expectSurf = `${words.pgInterfaceCli} · ${words.pgInterfaceApp}`
      assert.ok(multiSide.getAttribute('aria-label').includes(expectSurf), `${locale} lan=${isLan} side aria-label: ${multiSide.getAttribute('aria-label')}`)
      assert.ok(multiSide.getAttribute('title').includes(expectSurf), `${locale} lan=${isLan} side title: ${multiSide.getAttribute('title')}`)
      assert.ok(multiChip.getAttribute('aria-label').includes(expectSurf), `${locale} lan=${isLan} chip aria-label: ${multiChip.getAttribute('aria-label')}`)
      assert.ok(multiChip.getAttribute('title').includes(expectSurf), `${locale} lan=${isLan} chip title: ${multiChip.getAttribute('title')}`)
      assert.ok(walk(multiSide).some(n => hasClass(n, 'surf-cli') && !hasClass(n, 'surf-icon')))
      assert.ok(walk(multiSide).some(n => hasClass(n, 'surf-app') && !hasClass(n, 'surf-icon')))
      assert.ok(walk(multiChip).some(n => hasClass(n, 'surf-cli') && hasClass(n, 'surf-icon')))
      assert.ok(walk(multiChip).some(n => hasClass(n, 'surf-app') && hasClass(n, 'surf-icon')))
    }
  }

  // .c-meta and .r-meta render .surf-pill and zero visible vendor names.
  const cardMeta = walk(dom.node('needs')).find(n => hasClass(n, 'c-meta'))
  assert.ok(walk(cardMeta).some(n => hasClass(n, 'surf-cli') && n.textContent.includes('CLI')))
  assert.ok(!cardMeta.textContent.includes('Codex'))
  const rowMeta = walk(dom.node('working-now')).find(n => hasClass(n, 'r-meta'))
  assert.ok(walk(rowMeta).some(n => hasClass(n, 'surf-app') && n.textContent.includes('App')))
  assert.ok(!rowMeta.textContent.includes('Antigravity'))

  // .hid .c-meta renders agentMark icon instead of visible vendor name.
  const hidNode = walk(dom.node('board')).find(n => hasClass(n, 'hid'))
  assert.ok(walk(hidNode).some(n => hasClass(n, 'ag') && n.getAttribute('title') === 'Codex'))
  assert.ok(!walk(hidNode).find(n => hasClass(n, 'c-meta')).textContent.includes('Codex'))

  // [AI ▾] filter checklist retains vendor names.
  const aiGroup = walk(dom.node('filter-bar')).find(n => n.getAttribute?.('data-filter-kind') === 'agent')
  const aiLabels = walk(aiGroup).filter(n => hasClass(n, 'f-opt-lbl')).map(n => n.textContent)
  assert.ok(aiLabels.includes('Codex') && aiLabels.includes('Antigravity'))
})

test('narrow cockpit HUD promotes live working steps, toggles idle filters, and surfaces freshly finished AI work', async () => {
  const s = STRINGS.en
  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  const freshIso = new Date(now - 2 * 60_000).toISOString()
  const staleIso = new Date(now - 14 * 60_000).toISOString()
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)]
  const hasClass = (node, name) => String(node?.className ?? '').split(/\s+/).includes(name)
  const md = [
    '## retrieval-eval',
    `<!-- auto session=cc300001 agent=claude state=working updated=${freshIso} -->`,
    '### Evaluate 4 retrieval methods',
    '- [x] Index corpus',
    '- [~] Run hybrid rerank benchmark',
    '- [ ] Export table',
    '<!-- /auto session=cc300001 -->',
    '',
    '## stale-repo',
    `<!-- auto session=cc300002 agent=codex state=working updated=${staleIso} -->`,
    '### Background refactor',
    '- [~] Verify migrations',
    '<!-- /auto session=cc300002 -->',
    '',
    '## finished-repo',
    `<!-- auto session=cc300003 agent=codex state=done updated=${freshIso} -->`,
    '### Build release bundle',
    '- [x] Run checks',
    '<!-- /auto session=cc300003 -->',
    '',
  ].join('\n')
  const group = { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' }
  const view = buildView(parseProgress(md), ['retrieval-eval', 'stale-repo', 'finished-repo'], null, now, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const model = serveModel(view, [], s, new Set(), false, undefined, false, group)
  const html = servePage(s, 'n')

  // Test live step order, stale heartbeat class, HUD filter toggle, and live Done shelf auto-open.
  const dom = await pageDom(html, model)
  const workingChildren = dom.node('working-now').querySelectorAll('li.row')
  const evalRow = workingChildren.find(li => li.textContent.includes('Evaluate 4 retrieval methods'))
  assert.ok(evalRow, 'working row renders')
  const evalMeta = walk(evalRow).find(n => hasClass(n, 'r-meta'))
  const metaClasses = evalMeta.childNodes.map(n => String(n.className || ''))
  const progIdx = metaClasses.findIndex(cls => cls.split(' ').includes('prog'))
  const stepIdx = metaClasses.findIndex(cls => cls.split(' ').includes('r-step'))
  const projIdx = metaClasses.findIndex(cls => cls.split(' ').includes('r-proj'))
  assert.ok(progIdx >= 0 && stepIdx === progIdx + 1 && projIdx > stepIdx, `expected prog -> r-step -> r-proj, got ${metaClasses.join(',')}`)
  assert.equal(evalMeta.childNodes[stepIdx].textContent, 'Run hybrid rerank benchmark')

  const staleRow = workingChildren.find(li => li.textContent.includes('Background refactor'))
  assert.ok(staleRow, 'quiet working row renders')
  const staleRight = walk(staleRow).find(n => hasClass(n, 'r-right'))
  assert.ok(hasClass(staleRight, 't-stale'), `expected t-stale on quiet working row, got ${staleRight?.className}`)

  // Idle filter bar starts collapsed behind #hud-filter-btn and expands on click or active filter.
  const bar = dom.node('filter-bar')
  const btn = dom.node('hud-filter-btn')
  assert.equal(bar.getAttribute('data-hud-idle'), '1')
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  assert.equal(btn.getAttribute('data-active'), '0')
  btn.click()
  assert.equal(bar.getAttribute('data-hud-idle'), '0')
  assert.equal(btn.getAttribute('aria-expanded'), 'true')
  btn.click()
  assert.equal(bar.getAttribute('data-hud-idle'), '1')
  const aiChip = walk(bar).find(n => n.tag === 'button' && hasClass(n, 'f-chip'))
  aiChip.click()
  assert.equal(bar.getAttribute('data-hud-idle'), '0')

  // Done shelf starts closed on desktop initial draw, auto-opens when a working AI finishes live, and respects manual close.
  const doneShelf = () => walk(dom.node('board')).find(n => hasClass(n, 'shelf') && walk(n).some(c => c.textContent === s.pgDone))
  assert.ok(!hasClass(doneShelf(), 'open'), 'desktop viewport leaves Done shelf closed initially')
  const afterMd = md.replace('state=working updated=' + freshIso, 'state=done updated=' + new Date(now + 60_000).toISOString()).replace('- [~] Run hybrid rerank benchmark', '- [x] Run hybrid rerank benchmark').replace('- [ ] Export table', '- [x] Export table')
  const afterView = buildView(parseProgress(afterMd), ['retrieval-eval', 'stale-repo', 'finished-repo'], null, now + 60_000, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const afterModel = serveModel(afterView, [], s, new Set(), false, undefined, false, { ...group, now: now + 60_000 })
  await dom.redraw(afterModel)
  assert.ok(hasClass(doneShelf(), 'open'), 'live AI transition from working to done auto-opens Done shelf')
  const doneHead = walk(doneShelf()).find(n => n.tag === 'button' && hasClass(n, 'shelf-head'))
  doneHead.click()
  assert.ok(!hasClass(doneShelf(), 'open'), 'clicking Done shelf closes it')
  await dom.redraw(afterModel)
  assert.ok(!hasClass(doneShelf(), 'open'), 'redraw respects manual close of Done shelf')

  // Waiting -> done transition (not in previous Working now) also auto-opens Done shelf on desktop.
  const waitMd = [
    md,
    '## wait-to-done',
    `<!-- auto session=cc300004 agent=gemini state=waiting updated=${freshIso} -->`,
    '### Confirm production deploy',
    '- [?] Ship release?',
    '<!-- /auto session=cc300004 -->',
    '',
  ].join('\n')
  const waitView = buildView(parseProgress(waitMd), ['retrieval-eval', 'stale-repo', 'finished-repo', 'wait-to-done'], null, now, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const waitDom = await pageDom(html, serveModel(waitView, [], s, new Set(), false, undefined, false, group))
  const waitDoneShelf = () => walk(waitDom.node('board')).find(n => hasClass(n, 'shelf') && walk(n).some(c => c.textContent === s.pgDone))
  assert.ok(!hasClass(waitDoneShelf(), 'open'), 'desktop waiting state leaves Done shelf closed initially')
  // Importing a two-day-old completed record does not pop open Done on desktop.
  const twoDaysIso = new Date(now - 2 * 24 * 60 * 60_000).toISOString()
  const oldMd = [
    waitMd,
    '## historic-done',
    `<!-- auto session=cc300005 agent=codex state=done updated=${twoDaysIso} -->`,
    '### Two-day-old completed task',
    '- [x] Old step',
    '<!-- /auto session=cc300005 -->',
    '',
  ].join('\n')
  const oldView = buildView(parseProgress(oldMd), ['retrieval-eval', 'stale-repo', 'finished-repo', 'wait-to-done', 'historic-done'], null, now + 30_000, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  await waitDom.redraw(serveModel(oldView, [], s, new Set(), false, undefined, false, { ...group, now: now + 30_000 }))
  assert.ok(!hasClass(waitDoneShelf(), 'open'), 'importing a two-day-old done record keeps Done shelf closed')
  const waitAfterMd = waitMd.replace('state=waiting updated=' + freshIso, 'state=done updated=' + new Date(now + 60_000).toISOString()).replace('- [?] Ship release?', '- [x] Ship release')
  const waitAfterView = buildView(parseProgress(waitAfterMd), ['retrieval-eval', 'stale-repo', 'finished-repo', 'wait-to-done'], null, now + 60_000, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  await waitDom.redraw(serveModel(waitAfterView, [], s, new Set(), false, undefined, false, { ...group, now: now + 60_000 }))
  assert.ok(hasClass(waitDoneShelf(), 'open'), 'waiting-to-done AI transition auto-opens Done shelf')
})

test('row summaries clamp cleanly, phantom gaps collapse, and chrome controls render icons with full tooltips', async () => {
  const s = STRINGS.en
  const html = servePage(s, 'n')
  const rules = styleRules(html)
  const ruleFor = sel => rules.find(r => r.selector === sel)

  assert.equal(ruleFor('.row:not(.open) .r-title')?.declarations.find(d => d.property === 'white-space')?.value, 'nowrap')
  assert.equal(ruleFor('.row:not(.open) .r-title')?.declarations.find(d => d.property === 'text-overflow')?.value, 'ellipsis')
  assert.equal(ruleFor('.row.open .r-title')?.declarations.find(d => d.property === 'white-space')?.value, 'normal')
  assert.equal(ruleFor('.r-meta')?.declarations.find(d => d.property === 'display')?.value, 'flex')
  assert.equal(ruleFor('.r-meta .r-step')?.declarations.find(d => d.property === 'white-space')?.value, 'nowrap')
  assert.equal(ruleFor('.r-meta .r-proj')?.declarations.find(d => d.property === 'white-space')?.value, 'nowrap')
  assert.equal(ruleFor('#board')?.declarations.find(d => d.property === 'gap')?.value, '0')
  assert.ok(ruleFor('.shell[data-view="all"] #board>:not(.gone)~:not(.gone),.shell[data-view="needs"] #board>[data-sec="needs"]:not(.gone)~[data-sec="needs"]:not(.gone),.shell[data-view="others"] #board>[data-sec="others"]:not(.gone)~[data-sec="others"]:not(.gone)'), 'uses visible-sibling margin scoped to multi-section views')
  assert.equal(ruleFor('.sec>.fx.gone,.sheet>.fx.gone')?.declarations.find(d => d.property === 'display')?.value, 'none')
  assert.equal(ruleFor('.side .pfoot .set-row')?.declarations.find(d => d.property === 'margin-left')?.value, 'auto')
  assert.ok(!ruleFor('.side .pfoot .set-row')?.declarations.some(d => d.property === 'flex-basis'), 'sidebar footer keeps single-row layout')

  assert.match(html, /<button[^>]*class="icon-btn drawer-btn"[^>]*id="drawer-btn"/)
  assert.match(html, new RegExp(`<button[^>]*id="settings-toggle"[^>]*title="${s.settingsTitle}"`))
  for (const id of ['copy-icon', 'rail-peek-icon', 'archive-icon']) {
    assert.match(html, new RegExp(`<template id="${id}"><svg[^>]*>`))
  }

  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  const freshIso = new Date(now - 2 * 60_000).toISOString()
  const longTaskTitle = 'Synthetic overlong prompt heading repeated across telemetry slices to verify folded row clipping and expanded full preservation without blowing up narrow right quarter HUD rows'
  const longCardTask = 'Synthetic waiting card task title intentionally longer than ninety characters so expanded details use clip'
  const longWorklogStep = 'Step 1 initial ingestion completed in sandbox batch -> Step 2 schema verification passed across all shards -> Step 3 final benchmark synthesis running live across long validation shards after cleanup and verification — transferred -> main-recall-2'
  const md = [
    '## synthetic-long-repo',
    `<!-- auto session=dd100001 agent=claude state=waiting updated=${freshIso} -->`,
    `### ${longCardTask}`,
    '- [?] Ship iconified compact card chrome now?',
    '<!-- options=["Yes","No"] -->',
    '<!-- /auto session=dd100001 -->',
    '',
    `<!-- auto session=dd100002 agent=codex state=working updated=${freshIso} -->`,
    `### ${longTaskTitle}`,
    '- [x] Prepare fixtures',
    `- [~] ${longWorklogStep}`,
    '- [ ] Finish delivery',
    '<!-- /auto session=dd100002 -->',
    '',
    `<!-- auto session=dd100003 agent=gemini state=done updated=${freshIso} -->`,
    '### Compact done archive test',
    '- [x] Verified icon button',
    '<!-- /auto session=dd100003 -->',
    '',
  ].join('\n')

  const view = buildView(parseProgress(md), ['synthetic-long-repo'], null, now, 0, {}, s, [], {}, { version: 1, next: 1, records: [], legacy: {} })
  const dom = await pageDom(html, serveModel(view, [], s, new Set(), false, undefined, false, { now, versions: { board: '0.26.0', package: null }, unreadable: [], repoOf: () => '' }))
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)]
  const hasClass = (node, name) => String(node?.className ?? '').split(/\s+/).includes(name)

  // Worklog step summarizes to its latest tail segment in .r-meta while preserving the full text in .title and expanded .whole.
  const workRow = walk(dom.node('working-now')).find(n => n.tag === 'li' && hasClass(n, 'row'))
  const stepNode = walk(workRow).find(n => hasClass(n, 'r-step'))
  assert.ok(stepNode, '.r-step renders in Working now row')
  assert.ok(Array.from(stepNode.textContent).length <= 72, `compact step <= 72 code points, got ${Array.from(stepNode.textContent).length}: ${stepNode.textContent}`)
  assert.ok(stepNode.textContent.startsWith('… → '), `worklog chain shows latest tail with prefix: ${stepNode.textContent}`)
  assert.ok(stepNode.textContent.includes('Step 3 final benchmark synthesis'), stepNode.textContent)
  assert.ok(stepNode.textContent.endsWith('→ main-recall-2'), `preserves trailing handoff target: ${stepNode.textContent}`)
  assert.ok((stepNode.getAttribute('title') || '').includes('Step 1 initial ingestion'), 'full step remains on tooltip')
  const openWholes = walk(workRow).filter(n => hasClass(n, 'whole')).map(n => n.textContent)
  assert.ok(openWholes.includes(longWorklogStep), 'expanded row preserves verbatim full worklog step')

  // Long waiting-card task title uses <details class="clip"> inside expanded card body.
  const waitCard = walk(dom.node('needs')).find(n => n.tag === 'article' && n.getAttribute('data-ref-key'))
  const cTaskClip = walk(waitCard).find(n => hasClass(n, 'c-task') && hasClass(n, 'clip'))
  assert.ok(cTaskClip, 'overlong ask.task wraps in .c-task.clip')
  assert.equal(walk(cTaskClip).find(n => hasClass(n, 'whole'))?.textContent, longCardTask)

  // Surface pills on card and row carry tooltip title while label sits inside .surf-lbl.
  const cardPill = walk(waitCard).find(n => hasClass(n, 'surf-pill'))
  const rowPill = walk(workRow).find(n => hasClass(n, 'surf-pill'))
  assert.equal(cardPill?.getAttribute('title'), s.pgInterfaceCli)
  assert.equal(rowPill?.getAttribute('title'), s.pgInterfaceCli)

  // Copy confirm button keeps className="answer-send", data-copy="1", and exact textContent via .sr-lbl.
  const copyBtn = walk(waitCard).find(n => n.className === 'answer-send')
  assert.ok(copyBtn && copyBtn.getAttribute('data-copy') === '1')
  assert.ok(walk(copyBtn).some(n => hasClass(n, 'sr-lbl')), 'copy button wraps label in .sr-lbl')
  assert.equal(copyBtn.title, s.pgCopyChoice)
  assert.equal(copyBtn.textContent, s.pgCopyChoice)

  // Detail rail button wraps label in .sr-lbl and carries tooltip title.
  const detailBtn = walk(waitCard).find(n => hasClass(n, 'card-detail-btn'))
  assert.ok(walk(detailBtn).some(n => hasClass(n, 'sr-lbl')), 'detail button wraps label in .sr-lbl')
  assert.equal(detailBtn?.getAttribute('title'), s.pgDetailRail)
  assert.equal(detailBtn?.textContent, s.pgDetailRail)

  // Done shelf archive button uses icon-first .done-archive-btn + .sr-lbl inside [data-card-key="recent"].
  const doneSec = walk(dom.node('board')).find(n => n.getAttribute?.('data-sec') === 'done')
  const archiveBtn = walk(doneSec).find(n => hasClass(n, 'done-archive-btn'))
  assert.ok(archiveBtn, 'Done shelf renders compact icon-first .done-archive-btn')
  assert.ok(walk(archiveBtn).some(n => hasClass(n, 'sr-lbl')), 'archive button wraps label in .sr-lbl')
  assert.equal(archiveBtn.getAttribute('title'), s.archiveNow)
  assert.equal(archiveBtn.textContent, s.archiveNow)
  assert.equal(archiveBtn.parentNode?.getAttribute('data-card-key'), 'recent')
})

