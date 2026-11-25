import { describe, expect, it } from './test-kit.ts'
import { validateFindings } from '../core/findings-validate.ts'
import type { FindingInput } from '../core/spec-types.ts'

const RUN_ID = 'R-20261121-163012-a3f9'
const SPEC_ID = 'PAY-REFUND-001'
const VALID_ANCHORS = new Set(['REQ-001', 'REQ-002', 'SM-refund_order'])

function makeFinding(index: number, overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    id: `F-${String(index).padStart(3, '0')}`,
    anchor: 'REQ-001',
    category: 'reverse-flow',
    severity: 'major',
    title: `发现标题示例 ${index}`,
    detail: `这里是足够长度的详细说明文本用于通过最小字符数校验 ${index}`,
    suggestion: `建议补充逆向处理流程 ${index}`,
    confidence: 'inferred',
    evidence: [],
    ...overrides
  }
}

describe('findings-validate', () => {
  it('E14: fails V1 schema with E_FINDINGS_SCHEMA and exact field path detail', () => {
    const raw = {
      schemaVersion: 1,
      runId: RUN_ID,
      specId: SPEC_ID,
      findings: [
        {
          ...makeFinding(1),
          category: 'security'
        }
      ]
    }
    const res = validateFindings(raw, {
      runId: RUN_ID,
      specId: SPEC_ID,
      validAnchors: VALID_ANCHORS
    })
    expect(res).toMatchObject({
      ok: false,
      code: 'E_FINDINGS_SCHEMA',
      detail: 'findings[0].category'
    })
  })

  it('rejects runId or specId mismatch with E_FINDINGS_MISMATCH (V2)', () => {
    const raw = {
      schemaVersion: 1,
      runId: 'R-20261121-163012-beef',
      specId: SPEC_ID,
      findings: [makeFinding(1)]
    }
    const res = validateFindings(raw, {
      runId: RUN_ID,
      specId: SPEC_ID,
      validAnchors: VALID_ANCHORS
    })
    expect(res).toMatchObject({
      ok: false,
      code: 'E_FINDINGS_MISMATCH',
      detail: 'runId'
    })
  })

  it('normalizes unknown anchors (V3) and downgrades verified findings without evidence (V4)', () => {
    const raw = {
      schemaVersion: 1,
      runId: RUN_ID,
      specId: SPEC_ID,
      findings: [
        makeFinding(1, { anchor: 'REQ-999', confidence: 'verified', evidence: [] }),
        makeFinding(2, {
          anchor: 'REQ-002',
          confidence: 'verified',
          evidence: [{ kind: 'spec', anchor: 'REQ-002', quote: '当 系统收到渠道退款成功回调' }]
        })
      ]
    }
    const res = validateFindings(raw, {
      runId: RUN_ID,
      specId: SPEC_ID,
      validAnchors: VALID_ANCHORS
    })
    expect(res.ok).toBe(true)
    if (!res.ok) {
      return
    }
    expect(res.findings[0]).toMatchObject({
      anchor: null,
      anchorUnknown: true,
      confidence: 'inferred',
      downgradeReason: 'no-evidence'
    })
    expect(res.findings[1]).toMatchObject({
      anchor: 'REQ-002',
      anchorUnknown: false,
      confidence: 'verified',
      downgradeReason: null
    })
    expect(res.summary).toMatchObject({ total: 2, verified: 1, inferred: 1, downgraded: 1 })
  })

  it('E18: deduplicates duplicate IDs (V10) and truncates past 40 items (V11)', () => {
    const findings: FindingInput[] = []
    for (let i = 1; i <= 43; i += 1) {
      findings.push(makeFinding(i))
    }
    findings.splice(5, 0, makeFinding(3, { title: '重复的 F-003 第一条冗余' }))
    findings.splice(10, 0, makeFinding(3, { title: '重复的 F-003 第二条冗余' }))
    expect(findings).toHaveLength(45)

    const res = validateFindings(
      { schemaVersion: 1, runId: RUN_ID, specId: SPEC_ID, findings },
      { runId: RUN_ID, specId: SPEC_ID, validAnchors: VALID_ANCHORS }
    )
    expect(res.ok).toBe(true)
    if (!res.ok) {
      return
    }
    expect(res.findings).toHaveLength(40)
    expect(res.summary.total).toBe(40)
    expect(res.summary.truncated).toBe(true)
    expect(res.summary.duplicateCount).toBe(2)
    expect(res.findings.filter((f) => f.id === 'F-003')).toHaveLength(1)
  })
})
