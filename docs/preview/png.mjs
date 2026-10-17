// GitHub's social preview (1280 × 640), from the English light banner.
//   node docs/preview/png.mjs        (after `bun docs/preview/render.ts`; needs Playwright)
// Set PLAYWRIGHT to the module's path when it is not installed where Node can find it.
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const { chromium } = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default
const here = dirname(fileURLToPath(import.meta.url))
const images = join(here, '..', 'images')
const browser = await chromium.launch()

const social = await browser.newPage({ viewport: { width: 1280, height: 640 } })
await social.goto(`file://${join(images, 'hero-en-light.svg')}`)
await social.screenshot({ path: join(images, 'social-preview.png') })
await browser.close()
console.log(`wrote social-preview.png to ${images}`)
