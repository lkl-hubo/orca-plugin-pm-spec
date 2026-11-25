import { FINDING_ID_REGEX, RUN_ID_REGEX } from './id-format.ts'
import type {
  FindingCategory,
  FindingConfidence,
  FindingEvidence,
  FindingInput,
  FindingSeverity,
  FindingsSummary,
  NormalizedFinding
} from './spec-types.ts'
import { isPlainRecord } from './yaml-frontmatter.ts'

export const MAX_FINDINGS = 40

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'runId', 'specId', 'findings'])
const FINDING_KEYS = new Set([
  'id',
  'anchor',
  'category',
  'severity',
  'title',
  'detail',
  'suggestion',
  'confidence',
  'evidence'
])
const CODE_EVIDENCE_KEYS = new Set(['kind', 'repo', 'path', 'startLine', 'endLine', 'quote'])
const SPEC_EVIDENCE_KEYS = new Set(['kind', 'anchor', 'quote'])
const CATEGORIES: ReadonlySet<string> = new Set([
  'reverse-flow',
  'idempotency',
  'concurrency',
  'permission',
  'state-machine',
  'data-consistency',
  'compatibility',
  'boundary-value',
  'ambiguity',
  'code-conflict',
  'missing-nfr',
  'tracking'
])
const SEVERITIES: ReadonlySet<string> = new Set(['blocker', 'major', 'minor'])
const CONFIDENCES: ReadonlySet<string> = new Set(['verified', 'inferred', 'assumption'])

export type SchemaIssue = { detail: string; message: string }

function unknownKey(record: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return key
    }
  }
  return null
}

function checkStr(val: unknown, path: string, min: number, max: number): SchemaIssue | null {
  if (typeof val !== 'string' || val.length < min || val.length > max) {
    return { detail: path, message: `${path} 需为 ${min}～${max} 个字符` }
  }
  return null
}

function checkPosInt(val: unknown, path: string): SchemaIssue | null {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
    return { detail: path, message: `${path} 需为 >= 1 的整数` }
  }
  return null
}

function validateEvidenceItem(ev: unknown, prefix: string): SchemaIssue | null {
  if (!isPlainRecord(ev)) {
    return { detail: prefix, message: `${prefix} 必须是对象` }
  }
  if (ev.kind === 'code') {
    const extra = unknownKey(ev, CODE_EVIDENCE_KEYS)
    if (extra) {
      return { detail: `${prefix}.${extra}`, message: `${prefix}.${extra} 为未声明字段` }
    }
    return (
      checkStr(ev.repo, `${prefix}.repo`, 1, 200) ??
      checkStr(ev.path, `${prefix}.path`, 1, 512) ??
      checkPosInt(ev.startLine, `${prefix}.startLine`) ??
      checkPosInt(ev.endLine, `${prefix}.endLine`) ??
      checkStr(ev.quote, `${prefix}.quote`, 8, 200)
    )
  }
  if (ev.kind === 'spec') {
    const extra = unknownKey(ev, SPEC_EVIDENCE_KEYS)
    if (extra) {
      return { detail: `${prefix}.${extra}`, message: `${prefix}.${extra} 为未声明字段` }
    }
    return (
      checkStr(ev.anchor, `${prefix}.anchor`, 1, 128) ??
      checkStr(ev.quote, `${prefix}.quote`, 4, 200)
    )
  }
  return { detail: `${prefix}.kind`, message: `${prefix}.kind 取值无效` }
}

function validateFindingItem(item: unknown, index: number): SchemaIssue | null {
  const p = `findings[${index}]`
  if (!isPlainRecord(item)) {
    return { detail: p, message: `${p} 必须是对象` }
  }
  const extra = unknownKey(item, FINDING_KEYS)
  if (extra) {
    return { detail: `${p}.${extra}`, message: `${p}.${extra} 为未声明字段` }
  }
  if (typeof item.id !== 'string' || !FINDING_ID_REGEX.test(item.id)) {
    return { detail: `${p}.id`, message: `${p}.id 格式需为 F-001` }
  }
  if (item.anchor !== null && typeof item.anchor !== 'string') {
    return { detail: `${p}.anchor`, message: `${p}.anchor 需为字符串或 null` }
  }
  if (typeof item.category !== 'string' || !CATEGORIES.has(item.category)) {
    return { detail: `${p}.category`, message: `${p}.category 取值无效` }
  }
  if (typeof item.severity !== 'string' || !SEVERITIES.has(item.severity)) {
    return { detail: `${p}.severity`, message: `${p}.severity 取值无效` }
  }
  const textIssue =
    checkStr(item.title, `${p}.title`, 4, 80) ??
    checkStr(item.detail, `${p}.detail`, 10, 1200) ??
    checkStr(item.suggestion, `${p}.suggestion`, 4, 600)
  if (textIssue) {
    return textIssue
  }
  if (typeof item.confidence !== 'string' || !CONFIDENCES.has(item.confidence)) {
    return { detail: `${p}.confidence`, message: `${p}.confidence 取值无效` }
  }
  if (!Array.isArray(item.evidence) || item.evidence.length > 5) {
    return { detail: `${p}.evidence`, message: `${p}.evidence 需为最多 5 项的数组` }
  }
  for (const [evIndex, ev] of item.evidence.entries()) {
    const issue = validateEvidenceItem(ev, `${p}.evidence[${evIndex}]`)
    if (issue) {
      return issue
    }
  }
  return null
}

export function findFindingsSchemaIssue(
  findings: unknown,
  enforceMaxCount: boolean
): SchemaIssue | null {
  if (!Array.isArray(findings)) {
    return { detail: 'findings', message: 'findings 必须是数组' }
  }
  if (enforceMaxCount && findings.length > MAX_FINDINGS) {
    return { detail: 'findings', message: `findings 超过 ${MAX_FINDINGS} 条` }
  }
  for (const [index, item] of findings.entries()) {
    const issue = validateFindingItem(item, index)
    if (issue) {
      return issue
    }
  }
  return null
}

export function findDuplicateFindingId(
  findings: readonly unknown[]
): { index: number; id: string } | null {
  const seen = new Set<string>()
  for (const [index, item] of findings.entries()) {
    const id = isPlainRecord(item) && typeof item.id === 'string' ? item.id : null
    if (!id) {
      continue
    }
    if (seen.has(id)) {
      return { index, id }
    }
    seen.add(id)
  }
  return null
}

export type FindingsValidationResult =
  | {
      ok: true
      runId: string
      specId: string
      findings: NormalizedFinding[]
      summary: FindingsSummary
    }
  | {
      ok: false
      code: 'E_FINDINGS_SCHEMA' | 'E_FINDINGS_MISMATCH'
      detail: string
      message: string
    }

function schemaErr(detail: string, message: string): FindingsValidationResult {
  return { ok: false, code: 'E_FINDINGS_SCHEMA', detail, message }
}

export function validateFindings(
  raw: unknown,
  context: { runId: string; specId: string; validAnchors: ReadonlySet<string> }
): FindingsValidationResult {
  if (!isPlainRecord(raw)) {
    return schemaErr('root', 'findings 根必须是对象')
  }
  const extra = unknownKey(raw, TOP_LEVEL_KEYS)
  if (extra) {
    return schemaErr(extra, `未声明字段 ${extra}`)
  }
  if (raw.schemaVersion !== 1) {
    return schemaErr('schemaVersion', 'schemaVersion 必须为 1')
  }
  if (typeof raw.runId !== 'string' || !RUN_ID_REGEX.test(raw.runId)) {
    return schemaErr('runId', 'runId 格式无效')
  }
  if (typeof raw.specId !== 'string' || raw.specId.length === 0) {
    return schemaErr('specId', 'specId 必须是非空字符串')
  }
  if (raw.runId !== context.runId) {
    return {
      ok: false,
      code: 'E_FINDINGS_MISMATCH',
      detail: 'runId',
      message: `runId 不匹配：期望 ${context.runId}，实际 ${raw.runId}`
    }
  }
  if (raw.specId !== context.specId) {
    return {
      ok: false,
      code: 'E_FINDINGS_MISMATCH',
      detail: 'specId',
      message: `specId 不匹配：期望 ${context.specId}，实际 ${raw.specId}`
    }
  }

  const itemIssue = findFindingsSchemaIssue(raw.findings, false)
  if (itemIssue) {
    return schemaErr(itemIssue.detail, itemIssue.message)
  }

  const deduped: FindingInput[] = []
  const seenIds = new Set<string>()
  let duplicateCount = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: findFindingsSchemaIssue verified every entry matches FindingInput.
  for (const item of raw.findings as FindingInput[]) {
    if (seenIds.has(item.id)) {
      duplicateCount += 1
    } else {
      seenIds.add(item.id)
      deduped.push(item)
    }
  }

  const truncated = deduped.length > MAX_FINDINGS
  const capped = truncated ? deduped.slice(0, MAX_FINDINGS) : deduped
  const counts = {
    verified: 0,
    inferred: 0,
    assumption: 0,
    downgraded: 0,
    blocker: 0,
    major: 0,
    minor: 0
  }

  const normalized: NormalizedFinding[] = capped.map((item) => {
    const anchorUnknown = item.anchor !== null && !context.validAnchors.has(item.anchor)
    const anchor = anchorUnknown ? null : item.anchor
    const needsNoEvidenceDowngrade = item.confidence === 'verified' && item.evidence.length === 0
    const confidence: FindingConfidence = needsNoEvidenceDowngrade ? 'inferred' : item.confidence
    const downgradeReason = needsNoEvidenceDowngrade ? 'no-evidence' : null
    if (needsNoEvidenceDowngrade) {
      counts.downgraded += 1
    }
    counts[confidence] += 1
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: item.severity was validated against SEVERITIES.
    counts[item.severity as FindingSeverity] += 1

    return {
      id: item.id,
      anchor,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: item.category was validated against CATEGORIES.
      category: item.category as FindingCategory,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      suggestion: item.suggestion,
      confidence,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each evidence entry passed validateEvidenceItem().
      evidence: item.evidence as FindingEvidence[],
      anchorUnknown,
      downgradeReason,
      verifiedEvidenceCount: item.evidence.length,
      pmDecision: null
    }
  })

  return {
    ok: true,
    runId: raw.runId,
    specId: raw.specId,
    findings: normalized,
    summary: { total: normalized.length, ...counts, duplicateCount, truncated }
  }
}
