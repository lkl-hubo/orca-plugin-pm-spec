import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from './test-kit.ts'
import { lintSpec } from '../core/spec-lint.ts'
import { parseSpec } from '../core/spec-parser.ts'
import type {
  EvidenceCheckResult,
  WorkspaceConfig
} from '../core/spec-types.ts'
import { validateWorkspaceConfig } from '../core/workspace-config.ts'

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures')
const CLEAN_SPEC_PATH = resolve(FIXTURES_DIR, 'clean/specs/PAY-REFUND-001/spec.md')
const CLEAN_CONFIG_PATH = resolve(FIXTURES_DIR, 'clean/pmspec.json')
const CONTROLLER_JAVA_PATH = resolve(FIXTURES_DIR, 'merchant-api/src/refund/RefundController.java')

function loadCleanConfig(): WorkspaceConfig {
  const res = validateWorkspaceConfig(JSON.parse(readFileSync(CLEAN_CONFIG_PATH, 'utf8')))
  if (!res.ok) {
    throw new Error(`Invalid clean config: ${JSON.stringify(res.errors)}`)
  }
  return res.config
}

function lintDefect(filename: string, stage: 'edit' | 'publish' = 'edit') {
  const config = loadCleanConfig()
  const raw = readFileSync(resolve(FIXTURES_DIR, 'defects', filename), 'utf8')
  const parsed = parseSpec(raw, 'specs/PAY-REFUND-001/spec.md')
  return { parsed, report: lintSpec(parsed, config, { stage }) }
}

describe('spec-lint', () => {
  it('H03: clean PAY-REFUND-001 has 0 errors and 0 warnings', () => {
    const config = loadCleanConfig()
    const raw = readFileSync(CLEAN_SPEC_PATH, 'utf8')
    const parsed = parseSpec(raw, 'specs/PAY-REFUND-001/spec.md')
    const report = lintSpec(parsed, config, { stage: 'edit' })

    expect(report.counts).toEqual({ error: 0, warning: 0 })
    expect(report.issues).toEqual([])
  })

  it('E01: detects every defect fixture D01..D20 with exact expected rules', () => {
    const singleRuleCases: {
      file: string
      ruleId: string
      severity: 'error' | 'warning'
      count?: number
    }[] = [
      { file: 'D01-missing-frontmatter.md', ruleId: 'PMS-L001', severity: 'error' },
      { file: 'D02-id-mismatch.md', ruleId: 'PMS-L002', severity: 'error' },
      { file: 'D03-bad-version.md', ruleId: 'PMS-L003', severity: 'error' },
      { file: 'D04-bad-status.md', ruleId: 'PMS-L004', severity: 'error' },
      { file: 'D05-missing-req-section.md', ruleId: 'PMS-L005', severity: 'error' },
      { file: 'D06-duplicate-anchor.md', ruleId: 'PMS-L006', severity: 'error' },
      { file: 'D07-req-without-ac.md', ruleId: 'PMS-L007', severity: 'error' },
      { file: 'D08-ac-not-gwt.md', ruleId: 'PMS-L008', severity: 'warning' },
      { file: 'D09-ac-wrong-parent.md', ruleId: 'PMS-L009', severity: 'error' },
      { file: 'D10-unreachable-state.md', ruleId: 'PMS-L010', severity: 'error' },
      { file: 'D11-dead-end-state.md', ruleId: 'PMS-L011', severity: 'error' },
      { file: 'D12-terminal-with-exit.md', ruleId: 'PMS-L012', severity: 'error' },
      { file: 'D13-undefined-state.md', ruleId: 'PMS-L013', severity: 'error' },
      { file: 'D14-event-invalid.md', ruleId: 'PMS-L015', severity: 'error', count: 2 },
      { file: 'D15-vague-ac.md', ruleId: 'PMS-L017', severity: 'warning' },
      { file: 'D16-open-question-approved.md', ruleId: 'PMS-L018', severity: 'error' },
      { file: 'D18-evidence-escape.md', ruleId: 'PMS-L019', severity: 'error' },
      { file: 'D19-unknown-coderef.md', ruleId: 'PMS-L022', severity: 'error' }
    ]

    for (const testCase of singleRuleCases) {
      const { report } = lintDefect(testCase.file)
      const matched = report.issues.filter((issue) => issue.ruleId === testCase.ruleId)
      expect(matched.length, testCase.file).toBe(testCase.count ?? 1)
      expect(matched[0]?.severity, testCase.file).toBe(testCase.severity)
      if (testCase.severity === 'warning') {
        expect(report.counts.error, testCase.file).toBe(0)
      } else {
        const otherErrors = report.issues.filter(
          (issue) => issue.severity === 'error' && issue.ruleId !== testCase.ruleId
        )
        expect(otherErrors, testCase.file).toEqual([])
      }
    }

    const config = loadCleanConfig()
    const javaLineCount = readFileSync(CONTROLLER_JAVA_PATH, 'utf8').trimEnd().split('\n').length
    expect(javaLineCount).toBe(60)
    const d17Parsed = parseSpec(
      readFileSync(resolve(FIXTURES_DIR, 'defects/D17-evidence-out-of-range.md'), 'utf8'),
      'specs/PAY-REFUND-001/spec.md'
    )
    const d17Evidence: EvidenceCheckResult[] = d17Parsed.evidenceRefs.map((ref) => ({
      ref,
      ok: ref.endLine !== null && ref.endLine <= javaLineCount,
      reason: ref.endLine !== null && ref.endLine > javaLineCount ? 'line-out-of-range' : null
    }))
    const d17Report = lintSpec(d17Parsed, config, { stage: 'edit', evidence: d17Evidence })
    expect(d17Report.issues.map((i) => i.ruleId)).toEqual(['PMS-L019'])

    const d20Edit = lintDefect('D20-sensitive-data.md', 'edit').report
    expect(d20Edit.counts).toEqual({ error: 0, warning: 2 })
    expect(d20Edit.issues.map((i) => i.ruleId)).toEqual(['PMS-L023', 'PMS-L023'])

    const d20Publish = lintDefect('D20-sensitive-data.md', 'publish').report
    expect(d20Publish.counts).toEqual({ error: 2, warning: 0 })
    expect(d20Publish.issues.map((i) => i.ruleId)).toEqual(['PMS-L023', 'PMS-L023'])
  })

  it('E04: aborts early with only PMS-L024 when spec exceeds 5000 lines', () => {
    const config = loadCleanConfig()
    const oversized = Array.from({ length: 5001 }, (_, idx) => `line ${idx + 1}`).join('\n')
    const parsed = parseSpec(oversized, 'specs/PAY-REFUND-001/spec.md')
    const report = lintSpec(parsed, config, { stage: 'edit' })

    expect(parsed.sizeLimitExceeded).toBe(true)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.ruleId).toBe('PMS-L024')
    expect(report.counts).toEqual({ error: 1, warning: 0 })
  })

  it('E06 & E07: accepts English Given/When/Then and warns on wrong order', () => {
    const config = loadCleanConfig()
    const clean = readFileSync(CLEAN_SPEC_PATH, 'utf8')
    const englishSpec = clean.replace(
      '假如 订单状态为「已支付」且未发生过退款，当 商户管理员提交全额退款，那么 系统创建退款单，状态为「退款中」，并冻结订单可退金额。',
      'Given the order is paid, When the merchant submits a refund, Then a refund order is created.'
    )
    const englishReport = lintSpec(parseSpec(englishSpec, 'specs/PAY-REFUND-001/spec.md'), config)
    expect(englishReport.counts).toEqual({ error: 0, warning: 0 })

    const reversedSpec = clean.replace(
      '假如 订单状态为「已支付」且未发生过退款，当 商户管理员提交全额退款，那么 系统创建退款单，状态为「退款中」，并冻结订单可退金额。',
      '当 A，假如 B，那么 C'
    )
    const reversedReport = lintSpec(parseSpec(reversedSpec, 'specs/PAY-REFUND-001/spec.md'), config)
    expect(reversedReport.counts).toEqual({ error: 0, warning: 1 })
    expect(reversedReport.issues[0]?.ruleId).toBe('PMS-L008')
  })

  it('E08: reports L013 on state machine YAML syntax error while continuing other rules', () => {
    const config = loadCleanConfig()
    const clean = readFileSync(CLEAN_SPEC_PATH, 'utf8')
    const badStateYaml = clean
      .replace('  refunding: { label: 退款中 }', '  refunding: [unclosed')
      .replace('### REQ-003 [P1]', '### REQ-003')
    const parsed = parseSpec(badStateYaml, 'specs/PAY-REFUND-001/spec.md')
    const report = lintSpec(parsed, config)

    expect(parsed.blockErrors).toHaveLength(1)
    expect(parsed.blockErrors[0]?.range.startLine).toBe(53)
    expect(report.issues.some((i) => i.ruleId === 'PMS-L013' && i.range?.startLine === 53)).toBe(
      true
    )
    expect(report.issues.some((i) => i.ruleId === 'PMS-L021')).toBe(true)
  })

  it('forbids disabling or downgrading structural rules L001, L002, L006, L024', () => {
    const config = loadCleanConfig()
    config.lint.disabled = ['PMS-L001', 'PMS-L002', 'PMS-L006', 'PMS-L024', 'PMS-L008']
    config.lint.severityOverrides = {
      'PMS-L001': 'warning',
      'PMS-L002': 'warning',
      'PMS-L006': 'warning',
      'PMS-L024': 'warning'
    }

    const d02 = lintSpec(
      parseSpec(
        readFileSync(resolve(FIXTURES_DIR, 'defects/D02-id-mismatch.md'), 'utf8'),
        'specs/PAY-REFUND-001/spec.md'
      ),
      config
    )
    expect(d02.issues.find((i) => i.ruleId === 'PMS-L002')?.severity).toBe('error')

    const d06 = lintSpec(
      parseSpec(
        readFileSync(resolve(FIXTURES_DIR, 'defects/D06-duplicate-anchor.md'), 'utf8'),
        'specs/PAY-REFUND-001/spec.md'
      ),
      config
    )
    expect(d06.issues.find((i) => i.ruleId === 'PMS-L006')?.severity).toBe('error')

    const d08 = lintSpec(
      parseSpec(
        readFileSync(resolve(FIXTURES_DIR, 'defects/D08-ac-not-gwt.md'), 'utf8'),
        'specs/PAY-REFUND-001/spec.md'
      ),
      config
    )
    expect(d08.issues).toEqual([])
  })

  it('handles email only in edit stage, L016 undeclared roles, and L020 assumptions by status', () => {
    const config = loadCleanConfig()
    const clean = readFileSync(CLEAN_SPEC_PATH, 'utf8')
    const withEmailAndAssumption = clean
      .replace('### REQ-001 [P0] 商户发起全额退款', '### REQ-001 [P0] [假设] 商户发起全额退款')
      .replace('商户操作员', '外部审计员')
      .replace('90% 的退款申请在 10 分钟内完成渠道受理。', '联系邮箱 ops@example.com。')

    const draftReport = lintSpec(
      parseSpec(withEmailAndAssumption, 'specs/PAY-REFUND-001/spec.md'),
      config,
      { stage: 'edit' }
    )
    expect(draftReport.issues.filter((i) => i.ruleId === 'PMS-L020')).toEqual([])
    expect(draftReport.issues.filter((i) => i.ruleId === 'PMS-L016')).toHaveLength(1)
    expect(draftReport.issues.filter((i) => i.ruleId === 'PMS-L023')).toHaveLength(1)

    const inReviewPublish = lintSpec(
      parseSpec(
        withEmailAndAssumption.replace('status: draft', 'status: in-review'),
        'specs/PAY-REFUND-001/spec.md'
      ),
      config,
      { stage: 'publish' }
    )
    expect(inReviewPublish.issues.find((i) => i.ruleId === 'PMS-L020')?.severity).toBe('warning')
    expect(inReviewPublish.issues.filter((i) => i.ruleId === 'PMS-L023')).toEqual([])

    const approvedReport = lintSpec(
      parseSpec(
        withEmailAndAssumption.replace('status: draft', 'status: approved'),
        'specs/PAY-REFUND-001/spec.md'
      ),
      config,
      { stage: 'publish' }
    )
    expect(approvedReport.issues.find((i) => i.ruleId === 'PMS-L020')?.severity).toBe('error')
  })
})
