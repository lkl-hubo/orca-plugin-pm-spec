import { describe, expect, it } from './test-kit.ts'
import {
  isValidChineseIdCard,
  isValidLuhn,
  scanSensitiveData
} from '../core/sensitive-data-scan.ts'

describe('sensitive-data-scan', () => {
  it('E09: validates 18-char Chinese ID card ISO 7064 MOD 11-2 check digit', () => {
    expect(isValidChineseIdCard('11010519491231002X')).toBe(true)
    expect(isValidChineseIdCard('110105194912310021')).toBe(false)

    const matches = scanSensitiveData(['合法 11010519491231002X，非法 110105194912310021'], 10)
    expect(matches).toEqual([
      { type: 'id-card', label: '身份证号', line: 10, value: '11010519491231002X' }
    ])
  })

  it('E10: validates 16-19 digit bank card with Luhn check', () => {
    expect(isValidLuhn('6222021234567890128')).toBe(true)
    expect(isValidLuhn('6222021234567890127')).toBe(false)

    const matches = scanSensitiveData(['卡1 6222021234567890128 卡2 6222021234567890127'], 5)
    expect(matches).toEqual([
      { type: 'bank-card', label: '银行卡号', line: 5, value: '6222021234567890128' }
    ])
  })

  it('E11: ignores masked phone numbers while detecting unmasked phone and email', () => {
    const matches = scanSensitiveData([
      '脱敏 138****5678',
      '真实 13812345678 和 pm-owner@example.com'
    ])
    expect(matches).toEqual([
      { type: 'phone', label: '手机号', line: 2, value: '13812345678' },
      { type: 'email', label: '邮箱', line: 2, value: 'pm-owner@example.com' }
    ])
  })
})
