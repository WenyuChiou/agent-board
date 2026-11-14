// Vendored from release tag agent-board--v0.24.3 (3fffc559), hooks/sha256.ts,
// blob 0fe946855c1c26f132b6e1151a3d47ed413db4bd. Do not edit: re-copy from the tag.

// SHA-256 of a string's UTF-8 bytes, as lower-case hex. Pure and with no dependency, so the
// plugin can tell a file an earlier release wrote by its hash in hooks/released.ts, which
// scripts/build-released.ts computes with node:crypto and checks against this one.
//
// The loop keeps the running hash in locals (not a per-block array) and builds the hex
// output from a byte lookup, because this runs once per question id, future-time key and
// confirm key on the board path; the arithmetic is the same SHA-256, only the bookkeeping
// is cheaper. Every index read below is in range, so the reads carry `!` instead of `?? 0` guards.

const HEX: string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

const rotate = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

const encoder = new TextEncoder()

const computeSha256 = (text: string): string => {
  const bytes = encoder.encode(text)
  const length = bytes.length
  // The message, a 1 bit, zeros, and its length in bits, in 512-bit blocks of 16 words.
  const words = new Uint32Array(((length + 8) >> 6) * 16 + 16)
  for (let i = 0; i < length; i++) words[i >> 2] = words[i >> 2]! | (bytes[i]! << (24 - (i % 4) * 8))
  words[length >> 2] = words[length >> 2]! | (0x80 << (24 - (length % 4) * 8))
  words[words.length - 2] = Math.floor(length / 0x20000000)
  words[words.length - 1] = length * 8
  let a = 0x6a09e667
  let b = 0xbb67ae85
  let c = 0x3c6ef372
  let d = 0xa54ff53a
  let e = 0x510e527f
  let f = 0x9b05688c
  let g = 0x1f83d9ab
  let h = 0x5be0cd19
  const w = new Uint32Array(64)
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[block + t]!
    for (let t = 16; t < 64; t++) {
      const early = w[t - 15]!
      const late = w[t - 2]!
      const s0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3)
      const s1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10)
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0
    }
    let aa = a
    let bb = b
    let cc = c
    let dd = d
    let ee = e
    let ff = f
    let gg = g
    let hh = h
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotate(ee, 6) ^ rotate(ee, 11) ^ rotate(ee, 25)) + ((ee & ff) ^ (~ee & gg)) + K[t]! + w[t]!) | 0
      const t2 = ((rotate(aa, 2) ^ rotate(aa, 13) ^ rotate(aa, 22)) + ((aa & bb) ^ (aa & cc) ^ (bb & cc))) | 0
      hh = gg
      gg = ff
      ff = ee
      ee = (dd + t1) | 0
      dd = cc
      cc = bb
      bb = aa
      aa = (t1 + t2) | 0
    }
    a = (a + aa) | 0
    b = (b + bb) | 0
    c = (c + cc) | 0
    d = (d + dd) | 0
    e = (e + ee) | 0
    f = (f + ff) | 0
    g = (g + gg) | 0
    h = (h + hh) | 0
  }

  let out = ''
  for (const word of [a, b, c, d, e, f, g, h]) {
    const unsigned = word >>> 0
    out += HEX[(unsigned >>> 24) & 255]! + HEX[(unsigned >>> 16) & 255]! + HEX[(unsigned >>> 8) & 255]! + HEX[unsigned & 255]!
  }
  return out
}

// SHA-256 is a pure function of its input string: the same string always hashes to
// the same output, so a repeated input may reuse its hash. The cache is keyed by
// the exact input string, so a caller that changes its input between calls passes
// a different string and misses — no stale hash is ever returned, and no
// invalidation is needed. It stays bounded two ways: only short inputs are kept
// (a file-content hash must never retain the file), and when the entry count tops
// the limit the cache is cleared, which only costs recomputation. The board
// re-hashes the same ids, time keys and confirm keys on every poll of an unchanged
// file, so the steady state is hits; a changed board misses only for its new
// strings.
const CACHE_ENTRIES = 2048
const CACHE_INPUT = 4096
const cache = new Map<string, string>()

export const sha256 = (text: string): string => {
  if (text.length > CACHE_INPUT) return computeSha256(text)
  const held = cache.get(text)
  if (held !== undefined) return held
  const hash = computeSha256(text)
  if (cache.size >= CACHE_ENTRIES) cache.clear()
  cache.set(text, hash)
  return hash
}
