// SHA-256 of a string's UTF-8 bytes, as lower-case hex. Pure and with no dependency, so the
// plugin can tell a file an earlier release wrote by its hash in hooks/released.ts, which
// scripts/build-released.ts computes with node:crypto and checks against this one.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

const rotate = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

export const sha256 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  const length = bytes.length
  // The message, a 1 bit, zeros, and its length in bits, in 512-bit blocks of 16 words.
  const words = new Uint32Array(((length + 8) >> 6) * 16 + 16)
  for (let i = 0; i < length; i++) words[i >> 2] = (words[i >> 2] ?? 0) | ((bytes[i] ?? 0) << (24 - (i % 4) * 8))
  words[length >> 2] = (words[length >> 2] ?? 0) | (0x80 << (24 - (length % 4) * 8))
  words[words.length - 2] = Math.floor(length / 0x20000000)
  words[words.length - 1] = length * 8
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[block + t] ?? 0
    for (let t = 16; t < 64; t++) {
      const early = w[t - 15] ?? 0
      const late = w[t - 2] ?? 0
      const s0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3)
      const s1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10)
      w[t] = (w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number]
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + (K[t] ?? 0) + (w[t] ?? 0)) | 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    const next = [a, b, c, d, e, f, g, h]
    for (let i = 0; i < 8; i++) hash[i] = ((hash[i] ?? 0) + (next[i] ?? 0)) | 0
  }

  return hash.map(word => (word >>> 0).toString(16).padStart(8, '0')).join('')
}
