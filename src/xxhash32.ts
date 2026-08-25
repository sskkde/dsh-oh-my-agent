/**
 * xxhash32 (Seed 0) — pure JS.
 *
 * Used by the hashline editor to derive the 2-char line checksum, mirroring
 * oh-my-openagent's deterministic "line → short hash" scheme. The charset is
 * OmO's 16-symbol alphabet ('ZPMQVRWSNKTXJBYH'): each symbol encodes 4 bits,
 * so two symbols give a stable 8-bit fingerprint of the line content.
 */

export const HASHLINE_CHARSET = 'ZPMQVRWSNKTXJBYH'

function rotl(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0
}

const P1 = 2654435761
const P2 = 2246822519
const P3 = 3266489917
const P4 = 668265263
const P5 = 374761393

/** Standard xxhash32 over a UTF-8 string, seed 0. Returns an unsigned 32-bit int. */
export function xxhash32(input: string): number {
  const bytes = Buffer.from(input, 'utf8')
  const n = bytes.length
  if (n >= 16) {
    let v1 = (P1 + P2) >>> 0
    let v2 = P2 >>> 0
    let v3 = 0
    let v4 = (0 - P1) >>> 0
    let i = 0
    while (i + 16 <= n) {
      v1 = rotl((v1 + (bytes.readUInt32LE(i) * P2) >>> 0), 13) * P1 >>> 0
      v2 = rotl((v2 + (bytes.readUInt32LE(i + 4) * P2) >>> 0), 13) * P1 >>> 0
      v3 = rotl((v3 + (bytes.readUInt32LE(i + 8) * P2) >>> 0), 13) * P1 >>> 0
      v4 = rotl((v4 + (bytes.readUInt32LE(i + 12) * P2) >>> 0), 13) * P1 >>> 0
      i += 16
    }
    let h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0
    for (let j = 0; j < 16; j++) {
      h = (h * P2 + bytes.readUInt32LE(i + j * 4) * P2) >>> 0
      h = rotl(h, 11) * P1 >>> 0
    }
    h ^= h >>> 15
    h = (h * P3) >>> 0
    h ^= h >>> 13
    h = (h * P4) >>> 0
    h ^= h >>> 16
    return h >>> 0
  }
  let h = (P5 + n) >>> 0
  let i = 0
  while (i + 4 <= n) {
    h = (h + bytes.readUInt32LE(i) * P3) >>> 0
    h = rotl(h, 17) * P4 >>> 0
    i += 4
  }
  while (i < n) {
    h = (h + bytes[i] * P5) >>> 0
    h = rotl(h, 11) * P1 >>> 0
    i += 1
  }
  h ^= h >>> 15
  h = (h * P3) >>> 0
  h ^= h >>> 13
  h = (h * P4) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** 2-char hashline checksum for a line's content (no trailing newline). */
export function hashlineChecksum(content: string): string {
  const h = xxhash32(content)
  const a = HASHLINE_CHARSET[h & 0xf]
  const b = HASHLINE_CHARSET[(h >>> 8) & 0xf]
  return (a ?? '?') + (b ?? '?')
}
