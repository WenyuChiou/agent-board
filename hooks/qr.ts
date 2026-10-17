// A QR code for the board page's address on the network, so a phone's camera can open it. Byte
// mode, error correction level M (a code still reads with about 15% of it smudged or cut),
// versions 1 to 10: up to 213 bytes, far more than an address with its key. No dependency: the
// steps are those of ISO/IEC 18004, as Project Nayuki's reference generator lays them out.

// Error-correction codewords per block and blocks, level M, versions 1 to 10 (index 0 unused).
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const MAX_VERSION = 10
// Level M's two bits in the format information.
const LEVEL_M = 0

// Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1.
const mul = (x: number, y: number): number => {
  let z = 0
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

const divisorOf = (degree: number): number[] => {
  const result: number[] = Array.from({ length: degree }, (_, i) => (i === degree - 1 ? 1 : 0))
  let root = 1
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = mul(result[j] ?? 0, root)
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0)
    }
    root = mul(root, 0x02)
  }
  return result
}

const remainderOf = (data: number[], divisor: number[]): number[] => {
  const result = divisor.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    divisor.forEach((coefficient, i) => {
      result[i] = (result[i] ?? 0) ^ mul(coefficient, factor)
    })
  }
  return result
}

const rawModules = (version: number): number => {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2
    result -= (25 * count - 10) * count - 55
    if (version >= 7) result -= 36
  }
  return result
}

const dataCodewords = (version: number): number => Math.floor(rawModules(version) / 8) - (ECC_PER_BLOCK[version] ?? 0) * (BLOCKS[version] ?? 0)

const alignmentOf = (version: number): number[] => {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2
  const result = [6]
  for (let at = version * 4 + 10; result.length < count; at -= step) result.splice(1, 0, at)
  return result
}

const isMasked = (mask: number, x: number, y: number): boolean =>
  [
    (x + y) % 2 === 0,
    y % 2 === 0,
    x % 3 === 0,
    (x + y) % 3 === 0,
    (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    ((x * y) % 2) + ((x * y) % 3) === 0,
    (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ][mask] === true

// How hard a masked code is to read (the four rules of the standard); the lowest one is used.
const penaltyOf = (grid: boolean[][]): number => {
  const size = grid.length
  const at = (x: number, y: number): boolean => grid[y]?.[x] === true
  let result = 0
  const lines = [
    ...grid.map((_, y) => grid.map((_, x) => at(x, y))),
    ...grid.map((_, x) => grid.map((_, y) => at(x, y))),
  ]
  const finder = [true, false, true, true, true, false, true]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) {
        run += 1
        continue
      }
      if (run >= 5) result += run - 2
      run = 1
    }
    for (let i = 0; i + 7 <= size; i += 1) {
      if (!finder.every((isDark, j) => line[i + j] === isDark)) continue
      const before = Array.from({ length: 4 }, (_, j) => line[i - 1 - j] ?? false)
      const after = Array.from({ length: 4 }, (_, j) => line[i + 7 + j] ?? false)
      if (before.every(isDark => !isDark) || after.every(isDark => !isDark)) result += 40
    }
  }
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const isDark = at(x, y)
      if (at(x + 1, y) === isDark && at(x, y + 1) === isDark && at(x + 1, y + 1) === isDark) result += 3
    }
  }
  const darkCount = grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  const total = size * size
  result += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10
  return result
}

// The code's modules, row by row, true for dark; null when the text does not fit version 10.
export const qrModules = (text: string): boolean[][] | null => {
  const bytes = [...new TextEncoder().encode(text)]
  let version = 1
  const countBits = (v: number): number => (v < 10 ? 8 : 16)
  while (version <= MAX_VERSION && 4 + countBits(version) + bytes.length * 8 > dataCodewords(version) * 8) version += 1
  if (version > MAX_VERSION) return null
  const capacity = dataCodewords(version) * 8

  const bits: number[] = []
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, countBits(version))
  for (const byte of bytes) put(byte, 8)
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const data = Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((byte, bit) => (byte << 1) | bit, 0))

  // Split into blocks, each with its error-correction codewords, then read across the blocks.
  const blockCount = BLOCKS[version] ?? 1
  const eccLength = ECC_PER_BLOCK[version] ?? 0
  const raw = Math.floor(rawModules(version) / 8)
  const shortCount = blockCount - (raw % blockCount)
  const shortLength = Math.floor(raw / blockCount)
  const divisor = divisorOf(eccLength)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < blockCount; i += 1) {
    const part = data.slice(k, k + shortLength - eccLength + (i < shortCount ? 0 : 1))
    k += part.length
    const ecc = remainderOf(part, divisor)
    blocks.push([...part, ...(i < shortCount ? [0] : []), ...ecc])
  }
  const codewords: number[] = []
  for (let i = 0; i < (blocks[0]?.length ?? 0); i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortCount) codewords.push(block[i] ?? 0)
    })
  }

  const size = version * 4 + 17
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const isFunction = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const set = (x: number, y: number, isDark: boolean): void => {
    const row = grid[y]
    const marks = isFunction[y]
    if (row === undefined || marks === undefined || x < 0 || x >= size) return
    row[x] = isDark
    marks[x] = true
  }
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        if (cy + dy >= 0 && cy + dy < size) set(cx + dx, cy + dy, distance !== 2 && distance !== 4)
      }
    }
  }
  const spots = alignmentOf(version)
  spots.forEach((cy, i) =>
    spots.forEach((cx, j) => {
      const isCorner = (i === 0 && j === 0) || (i === 0 && j === spots.length - 1) || (i === spots.length - 1 && j === 0)
      if (isCorner) return
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }),
  )
  const drawFormat = (mask: number): void => {
    const value = (LEVEL_M << 3) | mask
    let rem = value
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const format = ((value << 10) | rem) ^ 0x5412
    const bit = (i: number): boolean => ((format >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  drawFormat(0)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const info = (version << 12) | rem
    for (let i = 0; i < 18; i += 1) {
      const isDark = ((info >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, isDark)
      set(b, a, isDark)
    }
  }
  // The codewords go up and down two columns at a time, from the right, around the patterns.
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        const row = grid[y]
        if (row === undefined || isFunction[y]?.[x] === true || index >= codewords.length * 8) continue
        row[x] = (((codewords[index >>> 3] ?? 0) >>> (7 - (index & 7))) & 1) !== 0
        index += 1
      }
    }
  }

  const masked = (mask: number): boolean[][] => grid.map((row, y) => row.map((isDark, x) => (isFunction[y]?.[x] === true ? isDark : isDark !== isMasked(mask, x, y))))
  let best = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    drawFormat(mask)
    const score = penaltyOf(masked(mask))
    if (score < bestScore) {
      best = mask
      bestScore = score
    }
  }
  drawFormat(best)
  return masked(best)
}

// The code as text, two rows of modules to a line, with the four-module quiet zone round it.
// With colour it is black on white whatever the terminal's own colours; without, the light
// modules are drawn and the dark ones left blank, which reads right on a dark terminal.
export const qrText = (modules: boolean[][], isColor: boolean): string => {
  const quiet = 4
  const size = modules.length + quiet * 2
  const isDark = (x: number, y: number): boolean => modules[y - quiet]?.[x - quiet] === true
  const lines: string[] = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x += 1) {
      const isTopDark = isDark(x, y)
      const isBottomDark = y + 1 < size ? isDark(x, y + 1) : false
      // Ink is dark with colour, light without.
      const isTopInk = isColor ? isTopDark : !isTopDark
      const isBottomInk = isColor ? isBottomDark : y + 1 < size ? !isBottomDark : false
      line += isTopInk && isBottomInk ? '█' : isTopInk ? '▀' : isBottomInk ? '▄' : ' '
    }
    lines.push(isColor ? `\u001b[30;107m${line}\u001b[0m` : line)
  }
  return lines.join('\n')
}
