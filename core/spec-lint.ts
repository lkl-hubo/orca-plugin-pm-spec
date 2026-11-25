import { scanSensitiveData } from './sensitive-data-scan.ts'
import {
  collectEventAndRoleIssues,
  collectRequirementAndMachineIssues,
  makeLintIssue,
  REQUIRED_SECTIONS,
  STRUCTURAL_RULE_IDS
} from './spec-lint-rules.ts'
import type {
  EvidenceCheckResult,
  EvidenceRef,
  LintIssue,
  LintReport,
  LintStage,
  ParsedSpec,
  WorkspaceConfig
} from './spec-types.ts'

export type LintSpecOptions = {
  stage?: LintStage
  evidence?: readonly EvidenceCheckResult[]
}

const EVIDENCE_REASON_LABELS: Record<Exclude<EvidenceCheckResult['reason'], null>, string> = {
  'unknown-repo': '仓库键未声明',
  'path-escape': '路径逃逸出仓库根目录',
  'not-found': '文件不存在',
  'line-out-of-range': '行号越界'
}

function lexicalPathEscapesRoot(rawPath: string): boolean {
  const normalized = rawPath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return true
  }
  let depth = 0
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    depth += segment === '..' ? -1 : 1
    if (depth < 0) {
      return true
    }
  }
  return false
}

function checkPureEvidenceRefs(
  refs: readonly EvidenceRef[],
  config: WorkspaceConfig | null
): EvidenceCheckResult[] {
  const repoKeys = config ? new Set(config.codeRepos.map((repo) => repo.key)) : null
  return refs.map((ref) => {
    if (repoKeys !== null && !repoKeys.has(ref.repo)) {
      return { ref, ok: false, reason: 'unknown-repo' }
    }
    if (lexicalPathEscapesRoot(ref.path)) {
      return { ref, ok: false, reason: 'path-escape' }
    }
    if (
      (ref.startLine !== null && ref.startLine < 1) ||
      (ref.endLine !== null && ref.endLine < 1) ||
      (ref.startLine !== null && ref.endLine !== null && ref.startLine > ref.endLine)
    ) {
      return { ref, ok: false, reason: 'line-out-of-range' }
    }
    return { ref, ok: true, reason: null }
  })
}

function formatEvidenceCheckIssues(results: readonly EvidenceCheckResult[]): LintIssue[] {
  const out: LintIssue[] = []
  for (const check of results) {
    if (!check.ok && check.reason !== null) {
      const { ref } = check
      const linePart =
        ref.startLine === null
          ? ''
          : ref.endLine === null
            ? `#L${ref.startLine}`
            : `#L${ref.startLine}-L${ref.endLine}`
      out.push(
        makeLintIssue(
          'PMS-L019',
          'error',
          `证据引用 ${ref.repo}:${ref.path}${linePart} 无效：${EVIDENCE_REASON_LABELS[check.reason]}`,
          '修正路径或行号',
          null,
          ref.range
        )
      )
    }
  }
  return out
}

function collectAllIssues(
  parsed: ParsedSpec,
  config: WorkspaceConfig | null,
  stage: LintStage,
  evidence?: readonly EvidenceCheckResult[]
): LintIssue[] {
  if (parsed.sizeLimitExceeded) {
    return [
      makeLintIssue(
        'PMS-L024',
        'error',
        '规格文件超过上限（> 1 MiB 或 > 5,000 行）',
        '拆分为多个规格',
        null,
        { startLine: 1, endLine: 1 }
      )
    ]
  }

  const raw: LintIssue[] = []
  if (parsed.frontmatter === null) {
    raw.push(
      makeLintIssue(
        'PMS-L001',
        'error',
        parsed.frontmatterError ?? '缺少头信息或格式错误',
        '在文件开头补齐 --- 包裹的头信息',
        null,
        { startLine: 1, endLine: 1 }
      )
    )
    if (parsed.frontmatterError === '文件不是 UTF-8 编码') {
      return raw
    }
  } else {
    for (const fmIssue of parsed.frontmatterIssues) {
      raw.push(
        makeLintIssue(fmIssue.ruleId, 'error', fmIssue.message, fmIssue.hint, null, fmIssue.range)
      )
    }
    if (config !== null) {
      const declaredRepos = new Set(config.codeRepos.map((repo) => repo.key))
      for (const refKey of parsed.frontmatter.codeRefs) {
        if (!declaredRepos.has(refKey)) {
          raw.push(
            makeLintIssue(
              'PMS-L022',
              'error',
              `头信息 codeRefs 中的 ${refKey} 未在 pmspec.json 声明`,
              '在 codeRepos 中声明',
              null,
              parsed.frontmatter.range
            )
          )
        }
      }
    }
  }

  const sectionTitles = new Set(parsed.sections.map((section) => section.title))
  for (const required of REQUIRED_SECTIONS) {
    if (!sectionTitles.has(required.title)) {
      raw.push(
        makeLintIssue(
          'PMS-L005',
          required.severity,
          `缺少章节「${required.title}」`,
          '按模板补齐章节',
          null,
          null
        )
      )
    }
  }

  for (const [anchor, ranges] of Object.entries(parsed.anchorOccurrences)) {
    if (ranges.length > 1) {
      const lines = ranges.map((r) => r.startLine).join('、')
      raw.push(
        makeLintIssue(
          'PMS-L006',
          'error',
          `锚点 ${anchor} 重复，出现在第 ${lines} 行`,
          '重新编号',
          anchor,
          ranges[1] ?? ranges[0]!
        )
      )
    }
  }

  const effectiveStatus =
    parsed.frontmatter === null || parsed.statusInvalid ? 'draft' : parsed.frontmatter.status

  raw.push(...collectRequirementAndMachineIssues(parsed, effectiveStatus))
  raw.push(...collectEventAndRoleIssues(parsed, config))

  if (effectiveStatus === 'in-review' || effectiveStatus === 'approved') {
    for (const q of parsed.questions) {
      if (q.status === 'open' || q.conclusion === null) {
        const sev = effectiveStatus === 'approved' ? 'error' : 'warning'
        raw.push(
          makeLintIssue(
            'PMS-L018',
            sev,
            `待决问题 ${q.id} 尚未关闭`,
            '给出结论并标记 resolved',
            q.id,
            q.range
          )
        )
      }
    }
  }

  raw.push(
    ...formatEvidenceCheckIssues(evidence ?? checkPureEvidenceRefs(parsed.evidenceRefs, config))
  )

  for (const match of scanSensitiveData(parsed.bodyLines, parsed.bodyStartLine)) {
    if (match.type === 'email' && stage === 'publish') {
      continue
    }
    raw.push(
      makeLintIssue(
        'PMS-L023',
        stage === 'publish' ? 'error' : 'warning',
        `第 ${match.line} 行疑似包含${match.label}`,
        '改为脱敏写法，例如 138****1234',
        null,
        { startLine: match.line, endLine: match.line }
      )
    )
  }

  return raw
}

export function lintSpec(
  parsed: ParsedSpec,
  config: WorkspaceConfig | null,
  options: LintSpecOptions = {}
): LintReport {
  const start = performance.now()
  const stage: LintStage = options.stage ?? 'edit'
  const rawIssues = collectAllIssues(parsed, config, stage, options.evidence)

  const disabled = new Set(config?.lint.disabled ?? [])
  const overrides = config?.lint.severityOverrides ?? {}
  const issues: LintIssue[] = []
  let errorCount = 0
  let warningCount = 0

  for (const item of rawIssues) {
    const canOverride = !STRUCTURAL_RULE_IDS.has(item.ruleId)
    if (canOverride && disabled.has(item.ruleId)) {
      continue
    }
    const overridden = canOverride ? overrides[item.ruleId] : undefined
    const severity = overridden ?? item.severity
    if (severity === 'error') {
      errorCount += 1
    } else {
      warningCount += 1
    }
    issues.push(overridden ? { ...item, severity } : item)
  }

  const durationMs = Math.max(0, Math.round((performance.now() - start) * 100) / 100)
  return {
    specId: parsed.frontmatter?.id ?? null,
    filePath: parsed.filePath,
    rawSha256: parsed.rawSha256,
    stage,
    issues,
    counts: { error: errorCount, warning: warningCount },
    durationMs
  }
}
