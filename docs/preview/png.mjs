// The PNGs the README needs besides the SVGs: progress.html on a desktop and on a phone, in each
// language, and GitHub's social preview (1280 × 640, from the English light banner).
//   node docs/preview/png.mjs        (after `bun docs/preview/render.ts`; needs Playwright)
// Set PLAYWRIGHT to the module's path when it is not installed where Node can find it.
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const { chromium } = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default
const here = dirname(fileURLToPath(import.meta.url))
const images = join(here, '..', 'images')
const browser = await chromium.launch()

for (const lang of ['en', 'zh-TW', 'zh-CN']) {
  const url = `file://${join(here, 'out', `dashboard-${lang}.html`)}`
  const desk = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })
  await desk.goto(url)
  await desk.screenshot({ path: join(images, `dashboard-${lang}.png`) })
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  await phone.goto(url)
  await phone.screenshot({ path: join(images, `dashboard-phone-${lang}.png`) })
  await Promise.all([desk.close(), phone.close()])
}

const social = await browser.newPage({ viewport: { width: 1280, height: 640 } })
await social.goto(`file://${join(images, 'hero-en-light.svg')}`)
await social.screenshot({ path: join(images, 'social-preview.png') })
await browser.close()
console.log(`wrote progress.html screenshots and social-preview.png to ${images}`)
