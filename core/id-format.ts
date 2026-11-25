export const SPEC_ID_REGEX = /^[\p{L}0-9][\p{L}0-9_-]{1,63}$/u
const WINDOWS_RESERVED_NAME_REGEX = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const ASCII_SAFE_ID_REGEX = /^[A-Za-z0-9_-]{2,64}$/
export const REQ_HEADING_REGEX = /^### (REQ-(\d{3})) (?:\[(P[0-2])\] )?(\[假设\] )?(.{2,80})$/
export const AC_ITEM_REGEX = /^- (AC-(\d{3})-(\d{2}))[：:]\s*(.+)$/
export const QUESTION_ITEM_REGEX = /^- (Q-\d{3}) \[(open|resolved)\] (.+)$/
export const STATE_KEY_REGEX = /^[a-z][a-z0-9_]{1,39}$/
export const EVENT_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/
export const EVENT_PROP_NAME_REGEX = /^[a-z][a-z0-9_]{1,63}$/
export const CODE_REF_PATTERN =
  '@code\\(([a-z0-9][a-z0-9-]{1,39}):([^#\\s)]+)(?:#L(\\d+)(?:-L(\\d+))?)?\\)'
export const REPO_KEY_REGEX = /^[a-z0-9][a-z0-9-]{1,39}$/
export const SPECS_DIR_REGEX = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,3}$/
export const DATE_YYYY_MM_DD_REGEX = /^\d{4}-\d{2}-\d{2}$/
export const GATEWAY_ANCHOR_REGEX =
  /^(S-\d{2}|REQ-\d{3}|Q-\d{3}|SM-[a-z][a-z0-9_]{1,39}|EVT-[a-z][a-z0-9_]{2,63})$/
export const RUN_ID_REGEX = /^R-\d{8}-\d{6}-[0-9a-f]{4}$/
export const FINDING_ID_REGEX = /^F-\d{3}$/

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

export function isValidSpecId(id: string): boolean {
  return SPEC_ID_REGEX.test(id) && !WINDOWS_RESERVED_NAME_REGEX.test(id)
}

/** HTTP Idempotency-Key must be printable ASCII (RFC 7230 / gateway validator). */
export function buildReviewIdempotencyKey(
  specId: string,
  version: number,
  snapshotSha256: string
): string {
  const safeId = ASCII_SAFE_ID_REGEX.test(specId) ? specId : `u-${sha256Hex(specId).slice(0, 16)}`
  return `pmspec-${safeId}-v${version}-${snapshotSha256.slice(0, 16)}`
}

export function isValidDateString(value: string): boolean {
  if (!DATE_YYYY_MM_DD_REGEX.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export function extractSpecDirName(filePath: string): string | null {
  const normalized = filePath.replaceAll('\\', '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (parts.length < 2) {
    return null
  }
  const parent = parts.at(-2)
  return !parent || parent === '..' ? null : parent
}

/** Pure FIPS 180-4 SHA-256 hex digest with zero Node built-in dependencies. */
export function sha256Hex(input: string | Uint8Array): string {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const bitLen = data.length * 8
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
      const temp1 = (hh! + s1 + ((e! & f!) ^ (~e! & g!)) + SHA256_K[i]! + w[i]!) >>> 0
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
      const temp2 = (s0 + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0
      hh = g
      g = f
      f = e
      e = (d! + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    const vals = [a!, b!, c!, d!, e!, f!, g!, hh!]
    for (let i = 0; i < 8; i += 1) {
      h[i] = (h[i]! + vals[i]!) >>> 0
    }
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('')
}

export function decodeUtf8Fatal(
  input: string | Uint8Array
):
  | { ok: true; text: string; rawSha256: string; byteLength: number }
  | { ok: false; error: string; rawSha256: string; byteLength: number } {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const rawSha256 = sha256Hex(bytes)
  if (typeof input === 'string') {
    return { ok: true, text: input, rawSha256, byteLength: bytes.byteLength }
  }
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(input),
      rawSha256,
      byteLength: bytes.byteLength
    }
  } catch {
    return { ok: false, error: '文件不是 UTF-8 编码', rawSha256, byteLength: bytes.byteLength }
  }
}

export function normalizeSpecText(text: string): string {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  return withoutBom.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

const GIVEN_RE = /假如|\bgiven\b/i
const WHEN_RE = /当|\bwhen\b/i
const THEN_RE = /那么|\bthen\b/i

export function hasGivenWhenThenOrder(text: string): boolean {
  const givenMatch = GIVEN_RE.exec(text)
  if (!givenMatch) {
    return false
  }
  const afterGiven = text.slice(givenMatch.index + givenMatch[0].length)
  const whenMatch = WHEN_RE.exec(afterGiven)
  return whenMatch ? THEN_RE.test(afterGiven.slice(whenMatch.index + whenMatch[0].length)) : false
}

export function splitMarkdownLines(normalized: string): string[] {
  if (normalized === '') {
    return []
  }
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return trimmed.split('\n')
}

export function parseTableCells(line: string): string[] {
  const t = line.trim()
  return t
    .slice(t.startsWith('|') ? 1 : 0, t.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((cell) => cell.trim())
}

export function parseQuestionContent(rest: string): { text: string; conclusion: string | null } {
  const idxFull = rest.indexOf('结论：')
  const idxAscii = rest.indexOf('结论:')
  const sepIndex = idxFull !== -1 && (idxAscii === -1 || idxFull <= idxAscii) ? idxFull : idxAscii
  if (sepIndex === -1) {
    return { text: rest.trim(), conclusion: null }
  }
  const conclusionText = rest.slice(sepIndex + 3).trim()
  return {
    text: rest.slice(0, sepIndex).trim() || rest.trim(),
    conclusion: conclusionText.length > 0 ? conclusionText : null
  }
}
