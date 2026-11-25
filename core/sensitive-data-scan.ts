export type SensitiveMatchType = 'phone' | 'id-card' | 'bank-card' | 'email'

export type SensitiveMatch = {
  type: SensitiveMatchType
  label: string
  line: number
  value: string
}

const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const ID_CARD_RE = /(?<![0-9Xx])[1-9]\d{16}[0-9Xx](?![0-9Xx])/g
const BANK_CARD_RE = /(?<!\d)\d{16,19}(?!\d)/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const ID_CHECK_CHARS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const

export function isValidChineseIdCard(value: string): boolean {
  if (!/^[1-9]\d{16}[0-9Xx]$/.test(value)) {
    return false
  }
  let sum = 0
  for (let i = 0; i < 17; i += 1) {
    sum += Number(value[i]) * ID_WEIGHTS[i]!
  }
  const expected = ID_CHECK_CHARS[sum % 11]
  return value[17]!.toUpperCase() === expected
}

export function isValidLuhn(digits: string): boolean {
  if (!/^\d{16,19}$/.test(digits)) {
    return false
  }
  let sum = 0
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i])
    if ((digits.length - 1 - i) % 2 === 1) {
      digit *= 2
      if (digit > 9) {
        digit -= 9
      }
    }
    sum += digit
  }
  return sum % 10 === 0
}

export function scanSensitiveData(lines: readonly string[], startLineNumber = 1): SensitiveMatch[] {
  const matches: SensitiveMatch[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const lineNum = startLineNumber + i
    const idSpans: [number, number][] = []

    const idRe = new RegExp(ID_CARD_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = idRe.exec(line)) !== null) {
      const value = m[0]
      if (isValidChineseIdCard(value)) {
        idSpans.push([m.index, m.index + value.length])
        matches.push({ type: 'id-card', label: '身份证号', line: lineNum, value })
      }
    }

    const phoneRe = new RegExp(PHONE_RE.source, 'g')
    while ((m = phoneRe.exec(line)) !== null) {
      matches.push({ type: 'phone', label: '手机号', line: lineNum, value: m[0] })
    }

    const bankRe = new RegExp(BANK_CARD_RE.source, 'g')
    while ((m = bankRe.exec(line)) !== null) {
      const start = m.index
      const end = start + m[0].length
      const overlapsId = idSpans.some(([s, e]) => start === s && end === e)
      if (!overlapsId && isValidLuhn(m[0])) {
        matches.push({ type: 'bank-card', label: '银行卡号', line: lineNum, value: m[0] })
      }
    }

    const emailRe = new RegExp(EMAIL_RE.source, 'g')
    while ((m = emailRe.exec(line)) !== null) {
      matches.push({ type: 'email', label: '邮箱', line: lineNum, value: m[0] })
    }
  }

  return matches
}
