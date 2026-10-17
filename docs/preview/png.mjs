// GitHub's social preview (1280 × 640) and the same card in Chinese, from promo-<lang>.svg.
//   node docs/preview/png.mjs        (after `bun docs/preview/render.ts`; needs Playwright)
// Set PLAYWRIGHT to the module's path when it is not installed where Node can find it.
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const { chromium } = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default
const here = dirname(fileURLToPath(import.meta.url))
const images = join(here, '..', 'images')
const browser = await chromium.launch()

// The promotional card in each language; the English one is the repository's social preview.
const social = await browser.newPage({ viewport: { width: 1280, height: 640 } })
for (const [lang, name] of [['en', 'social-preview.png'], ['zh-TW', 'social-preview-zh-TW.png'], ['zh-CN', 'social-preview-zh-CN.png']]) {
  await social.goto(`file://${join(images, `promo-${lang}.svg`)}`)
  await social.screenshot({ path: join(images, name), omitBackground: true })
}
await browser.close()
console.log(`wrote social-preview.png (and -zh-TW, -zh-CN) to ${images}`)
