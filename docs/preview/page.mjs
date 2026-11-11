// The README's "what you get" picture: three real screenshots of the board's page (dark), one per
// language, from a made-up progress file in page-sample.mjs. Writes docs/images/page-<lang>-dark.png.
//   node docs/preview/page.mjs        (needs Playwright and Node 22.18+; set PLAYWRIGHT to its path if Node cannot find it)
// The page runs from this checkout in a throwaway home, so it never touches the real ~/.claude,
// and only the page itself is shot: no address bar, so the `?t=` token never reaches a picture.
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { BOARD_SCRIPT } from '../../hooks/board-script.ts'
import { pageFile } from './page-sample.mjs'

const { chromium } = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default
const here = dirname(fileURLToPath(import.meta.url))
const images = join(here, '..', 'images')
const pause = ms => new Promise(done => setTimeout(done, ms))

// Starts the page for one language and returns its address and a way to stop it.
const serve = async lang => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-page-'))
  const home = join(root, 'home')
  const folders = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'run'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp') }
  for (const dir of Object.values(folders)) mkdirSync(dir, { recursive: true })
  const progress = join(home, '.claude', 'progress.md')
  writeFileSync(progress, pageFile(lang))
  const script = join(root, 'agent-board.mjs')
  writeFileSync(script, BOARD_SCRIPT)
  const env = { ...process.env, ...folders, CLAUDE_PROGRESS_FILE: progress, NO_COLOR: '1', AGENT_BOARD_TEST_PID: String(process.pid) }
  const child = spawn(process.execPath, [script, '--serve', '--no-open', '--lang', lang, '--progress-file', progress], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  let match
  for (let n = 0; n < 200 && !(match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)); n++) await pause(100)
  if (!match) throw new Error(`The page did not start:\n${output}`)
  const url = new URL(match[0])
  const stop = async () => {
    await fetch(new URL('/api/close', url), { method: 'POST', headers: { 'x-board-token': url.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
    for (let n = 0; n < 30 && child.exitCode === null; n++) await pause(100)
    if (child.exitCode === null) child.kill()
  }
  return { url: url.href, stop }
}

const browser = await chromium.launch()
try {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const page = await serve(lang)
    try {
      const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 780 }, deviceScaleFactor: 2, locale: lang })
      const tab = await context.newPage()
      await tab.goto(page.url)
      await tab.waitForSelector('body')
      await tab.evaluate(() => document.fonts.ready)
      await pause(1500)
      await tab.screenshot({ path: join(images, `page-${lang}-dark.png`) })
      await context.close()
    } finally {
      await page.stop()
    }
  }
} finally {
  await browser.close()
}
