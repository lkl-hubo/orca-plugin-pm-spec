import { describe, expect, it } from './test-kit.ts'
import {
  isToolAllowed,
  validateSubmittedFindings
} from '../core/pi-guard-policy.ts'
import type { FindingInput } from '../core/spec-types.ts'

function validFinding(index: number): FindingInput {
  return {
    id: `F-${String(index).padStart(3, '0')}`,
    anchor: 'REQ-001',
    category: 'reverse-flow',
    severity: 'major',
    title: `发现标题示例 ${index}`,
    detail: `足够长度的详细说明文本用于验证提交守卫 ${index}`,
    suggestion: `建议补充逆向处理分支 ${index}`,
    confidence: 'inferred',
    evidence: []
  }
}

describe('pi-guard-policy', () => {
  it('E49: enforces case-sensitive exact tool allowlist', () => {
    const allowed = ['read', 'grep', 'find', 'ls', 'pmspec_submit_findings']
    expect(isToolAllowed('write', allowed)).toBe(false)
    expect(isToolAllowed('bash', allowed)).toBe(false)
    expect(isToolAllowed('Read', allowed)).toBe(false)
    expect(isToolAllowed('pmspec_submit_findings', allowed)).toBe(true)
  })

  it('E50: validates submitted findings schema, 40-item cap, and duplicate IDs', () => {
    const badCategory = [{ ...validFinding(1), category: 'security' }]
    expect(validateSubmittedFindings(badCategory)).toBe('findings[0].category 取值无效')

    const fortyOne = Array.from({ length: 41 }, (_, i) => validFinding(i + 1))
    expect(validateSubmittedFindings(fortyOne)).toBe('findings 超过 40 条')

    const dupId = [validFinding(1), validFinding(2), validFinding(3), validFinding(2)]
    expect(validateSubmittedFindings(dupId)).toBe('findings[3].id 重复')

    expect(validateSubmittedFindings([validFinding(1), validFinding(2)])).toBeNull()
  })
})
