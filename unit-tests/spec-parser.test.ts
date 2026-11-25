import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from './test-kit.ts'
import {
  buildReviewIdempotencyKey,
  isValidSpecId,
  sha256Hex
} from '../core/id-format.ts'
import { lintSpec } from '../core/spec-lint.ts'
import { parseSpec } from '../core/spec-parser.ts'
import { validateWorkspaceConfig } from '../core/workspace-config.ts'

const CLEAN_SPEC_PATH = resolve(import.meta.dirname, 'fixtures/clean/specs/PAY-REFUND-001/spec.md')

describe('spec-parser', () => {
  it('H04: parses clean PAY-REFUND-001 spec accurately', () => {
    const raw = readFileSync(CLEAN_SPEC_PATH, 'utf8')
    const parsed = parseSpec(raw, 'specs/PAY-REFUND-001/spec.md')

    expect(parsed.frontmatterError).toBeNull()
    expect(parsed.frontmatter).toMatchObject({
      id: 'PAY-REFUND-001',
      title: '商户自助退款',
      owner: '张三',
      status: 'draft',
      version: 3,
      product: '收单商户平台',
      codeRefs: ['merchant-api'],
      updated: '2026-11-21'
    })
    expect(parsed.sections.map((s) => `${s.anchor}:${s.title}`)).toEqual([
      'S-01:背景与目标',
      'S-02:范围',
      'S-03:角色与权限',
      'S-04:需求明细',
      'S-05:状态流转',
      'S-06:非功能需求',
      'S-07:埋点',
      'S-08:待决问题'
    ])
    expect(parsed.roleTable).toEqual(['商户管理员', '商户操作员', '系统'])
    expect(parsed.requirements).toHaveLength(3)
    expect(parsed.requirements[0]?.criteria).toHaveLength(2)
    expect(parsed.stateMachines).toHaveLength(1)
    expect(parsed.stateMachines[0]?.initial).toBe('refunding')
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]?.properties).toHaveLength(3)
    expect(parsed.questions).toEqual([
      {
        id: 'Q-001',
        status: 'resolved',
        text: '部分退款是否允许多次？',
        conclusion: '允许，累计金额不超过订单实付金额。',
        range: { startLine: 87, endLine: 87 }
      }
    ])
    expect(parsed.evidenceRefs[0]).toMatchObject({
      repo: 'merchant-api',
      path: 'src/refund/RefundController.java',
      startLine: 40,
      endLine: 58
    })
  })

  it('E02: strips UTF-8 BOM and normalizes CRLF while preserving rawSha256 difference', () => {
    const lfText = readFileSync(CLEAN_SPEC_PATH, 'utf8').replaceAll('\r\n', '\n')
    const bomCrlfBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(lfText.replaceAll('\n', '\r\n'), 'utf8')
    ])

    const lfParsed = parseSpec(lfText, 'specs/PAY-REFUND-001/spec.md')
    const bomParsed = parseSpec(bomCrlfBytes, 'specs/PAY-REFUND-001/spec.md')

    expect(bomParsed.rawSha256).not.toBe(lfParsed.rawSha256)
    expect(bomParsed.frontmatter).toEqual(lfParsed.frontmatter)
    expect(bomParsed.requirements).toEqual(lfParsed.requirements)
    expect(bomParsed.stateMachines).toEqual(lfParsed.stateMachines)
    expect(bomParsed.events).toEqual(lfParsed.events)
    expect(bomParsed.lineCount).toBe(lfParsed.lineCount)
  })

  it('E03: rejects non-UTF-8 (GBK) bytes with L001 encoding error', () => {
    const gbkBytes = Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0xb2, 0xe2, 0xca, 0xd4, 0x0a])
    const parsed = parseSpec(gbkBytes, 'specs/PAY-REFUND-001/spec.md')

    expect(parsed.frontmatter).toBeNull()
    expect(parsed.frontmatterError).toContain('不是 UTF-8 编码')
  })

  it('E05: ignores REQ headings inside non-pmspec fenced code blocks', () => {
    const raw = readFileSync(CLEAN_SPEC_PATH, 'utf8')
    const withJavaFence = `${raw}\n## 附录\n\n\`\`\`java\n### REQ-009 [P0] 示例\n- AC-009-01：示例\n\`\`\`\n`
    const parsed = parseSpec(withJavaFence, 'specs/PAY-REFUND-001/spec.md')

    expect(parsed.requirements.map((r) => r.id)).toEqual(['REQ-001', 'REQ-002', 'REQ-003'])
    expect(parsed.anchorOccurrences['REQ-009']).toBeUndefined()
  })

  it('computes pure FIPS 180-4 SHA-256 identical to node:crypto', () => {
    const samples = ['', 'abc', '商户自助退款 PAY-REFUND-001\n', 'x'.repeat(250)]
    for (const sample of samples) {
      const expected = createHash('sha256').update(sample, 'utf8').digest('hex')
      expect(sha256Hex(sample)).toBe(expected)
    }
  })

  it('validates Scheme B spec IDs (Chinese, alphanumeric, hyphen/underscore) and builds ASCII idempotency keys', () => {
    for (const valid of [
      'PAY-REFUND-001',
      'refund',
      'v2_pay',
      'PAY-1',
      '商户自助退款',
      '2026-商户退款_v2'
    ]) {
      expect(isValidSpecId(valid), valid).toBe(true)
    }
    for (const invalid of [
      'a',
      '-bad',
      '_bad',
      '../etc',
      'a/b',
      'a b',
      'CON',
      'nul',
      'COM1',
      'x'.repeat(65)
    ]) {
      expect(isValidSpecId(invalid), invalid).toBe(false)
    }

    const asciiKey = buildReviewIdempotencyKey('PAY-REFUND-001', 3, 'a'.repeat(64))
    expect(asciiKey).toBe(`pmspec-PAY-REFUND-001-v3-${'a'.repeat(16)}`)

    const zhKey = buildReviewIdempotencyKey('商户自助退款', 1, 'b'.repeat(64))
    expect(zhKey).toMatch(/^[\x21-\x7e]{1,128}$/)
    expect(zhKey).toMatch(/^pmspec-u-[0-9a-f]{16}-v1-b{16}$/)

    const cfgRes = validateWorkspaceConfig(
      JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/clean/pmspec.json'), 'utf8'))
    )
    expect(cfgRes.ok).toBe(true)
    if (cfgRes.ok) {
      const cleanRaw = readFileSync(CLEAN_SPEC_PATH, 'utf8').replace(
        'id: PAY-REFUND-001',
        'id: 商户自助退款'
      )
      const parsed = parseSpec(cleanRaw, 'specs/商户自助退款/spec.md')
      const report = lintSpec(parsed, cfgRes.config, { stage: 'edit' })
      expect(parsed.frontmatter?.id).toBe('商户自助退款')
      expect(report.counts.error).toBe(0)
    }
  })
})
