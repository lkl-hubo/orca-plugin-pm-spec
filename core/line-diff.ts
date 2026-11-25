import type { DiffLineOp } from './spec-types.ts'

export const MAX_DIFF_LINES = 2000

function toLines(text: string): string[] {
  if (text === '') {
    return []
  }
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return trimmed.split('\n')
}

export function diffLines(beforeText: string, afterText: string): DiffLineOp[] | null {
  const before = toLines(beforeText)
  const after = toLines(afterText)

  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
    return null
  }

  let prefixLen = 0
  const minLen = Math.min(before.length, after.length)
  while (prefixLen < minLen && before[prefixLen] === after[prefixLen]) {
    prefixLen += 1
  }

  let beforeEnd = before.length
  let afterEnd = after.length
  while (
    beforeEnd > prefixLen &&
    afterEnd > prefixLen &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  const ops: DiffLineOp[] = []
  for (let i = 0; i < prefixLen; i += 1) {
    ops.push({ op: 'equal', text: before[i]! })
  }

  const aMid = before.slice(prefixLen, beforeEnd)
  const bMid = after.slice(prefixLen, afterEnd)
  const m = aMid.length
  const n = bMid.length

  if (m === 0) {
    for (const line of bMid) {
      ops.push({ op: 'add', text: line })
    }
  } else if (n === 0) {
    for (const line of aMid) {
      ops.push({ op: 'del', text: line })
    }
  } else {
    const cols = n + 1
    const dp = new Int32Array((m + 1) * cols)
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (aMid[i] === bMid[j]) {
          dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)]! + 1
        } else {
          const down = dp[(i + 1) * cols + j]!
          const right = dp[i * cols + (j + 1)]!
          dp[i * cols + j] = down >= right ? down : right
        }
      }
    }

    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        ops.push({ op: 'equal', text: aMid[i]! })
        i += 1
        j += 1
      } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
        ops.push({ op: 'del', text: aMid[i]! })
        i += 1
      } else {
        ops.push({ op: 'add', text: bMid[j]! })
        j += 1
      }
    }
    while (i < m) {
      ops.push({ op: 'del', text: aMid[i]! })
      i += 1
    }
    while (j < n) {
      ops.push({ op: 'add', text: bMid[j]! })
      j += 1
    }
  }

  for (let i = beforeEnd; i < before.length; i += 1) {
    ops.push({ op: 'equal', text: before[i]! })
  }

  return ops
}
