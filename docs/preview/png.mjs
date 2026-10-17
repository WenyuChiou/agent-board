// GitHub's social preview and the same card in Chinese, from promo-<lang>.svg, at 2560 × 1280
// (the card's 1280 × 640, twice over, so text and logos stay sharp on a high-density screen).
//   node docs/preview/png.mjs        (after `bun docs/preview/render.ts`; needs Playwright, Node 22.2+)
// Set PLAYWRIGHT to the module's path when it is not installed where Node can find it.
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { crc32, deflateSync } from 'zlib'

const { chromium } = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default
const here = dirname(fileURLToPath(import.meta.url))
const images = join(here, '..', 'images')

// A PNG from RGBA pixels. Each row takes the filter that leaves the smallest differences (as
// libpng picks), and the data is deflated at level 9: Chrome's own encoder made files twice as big.
const encode = (pixels, w, h) => {
  const stride = w * 4
  const rows = Buffer.alloc((stride + 1) * h)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  const line = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    let best = null
    let bestCost = Infinity
    for (let filter = 0; filter < 5; filter++) {
      let cost = 0
      for (let i = 0; i < stride; i++) {
        const x = pixels[y * stride + i]
        const a = i >= 4 ? pixels[y * stride + i - 4] : 0
        const b = y > 0 ? pixels[(y - 1) * stride + i] : 0
        const c = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4] : 0
        const guess = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c)
        const v = (x - guess + 256) & 255
        line[i] = v
        cost += v < 128 ? v : 256 - v
      }
      if (cost < bestCost) {
        bestCost = cost
        best = [filter, Buffer.from(line)]
      }
    }
    rows[y * (stride + 1)] = best[0]
    best[1].copy(rows, y * (stride + 1) + 1)
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Each card is drawn at four times its size and then halved, two by two pixels into one. Drawn
// at twice its size straight away, Chrome's dither on the gradients made the file over 1 MB,
// more than GitHub takes for a social preview; averaged, it is about 0.7 MB, and the letters'
// edges come out smoother too. The card's fonts are inside the SVG; the shot waits for them.
const browser = await chromium.launch()
const card = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 4 })
const halve = await browser.newPage()
for (const [lang, name] of [['en', 'social-preview.png'], ['zh-TW', 'social-preview-zh-TW.png'], ['zh-CN', 'social-preview-zh-CN.png']]) {
  await card.goto(`file://${join(images, `promo-${lang}.svg`)}`)
  await card.evaluate(() => document.fonts.ready)
  const shot = await card.screenshot({ omitBackground: true })
  const { w, h, pixels } = await halve.evaluate(async png => {
    const image = new Image()
    image.src = `data:image/png;base64,${png}`
    await image.decode()
    const canvas = new OffscreenCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const from = context.getImageData(0, 0, image.width, image.height).data
    const w = image.width / 2
    const h = image.height / 2
    const to = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // The four pixels, weighted by how opaque each is, so the rounded corners' clear
        // pixels do not darken the edge.
        const top = (2 * y * image.width + 2 * x) * 4
        const at = [top, top + 4, top + image.width * 4, top + image.width * 4 + 4]
        const alpha = at.reduce((sum, i) => sum + from[i + 3], 0)
        const out = (y * w + x) * 4
        for (let c = 0; c < 3; c++) to[out + c] = alpha === 0 ? 0 : Math.round(at.reduce((sum, i) => sum + from[i + c] * from[i + 3], 0) / alpha)
        to[out + 3] = Math.round(alpha / 4)
      }
    }
    let text = ''
    for (let i = 0; i < to.length; i += 0x8000) text += String.fromCharCode(...to.subarray(i, i + 0x8000))
    return { w, h, pixels: btoa(text) }
  }, shot.toString('base64'))
  writeFileSync(join(images, name), encode(Buffer.from(pixels, 'base64'), w, h))
}
await browser.close()
console.log(`wrote social-preview.png (and -zh-TW, -zh-CN) to ${images}`)
