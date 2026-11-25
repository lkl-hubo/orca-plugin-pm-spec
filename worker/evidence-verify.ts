import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { validateFindings, type FindingsValidationResult } from '../core/findings-validate.ts'
import { decodeUtf8Fatal, normalizeSpecText, splitMarkdownLines } from '../core/id-format.ts'
import { parseSpec } from '../core/spec-parser.ts'
import type {
  EvidenceCheckResult,
  EvidenceRef,
  FindingsSummary,
  FindingConfidence,
  NormalizedFinding,
  ParsedSpec,
  SourceRange,
  WorkspaceConfig
} from '../core/spec-types.ts'
import { resolveWorkspaceRepoPath } from '../core/workspace-config.ts'

export type EvidenceFailureReason =
  | 'unknown-repo'
  | 'path-escape'
  | 'not-found'
  | 'line-out-of-range'
  | 'quote-mismatch'

function isInsideRoot(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function lexicalEscapesRoot(rawPath: string): boolean {
  if (!rawPath || rawPath.includes('\0')) {
    return true
  }
  const normalized = rawPath.replaceAll('\\', '/')
  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
}

async function resolveRepoFileLines(
  repoRoot: string,
  relPath: string
): Promise<{ ok: true; lines: string[] } | { ok: false; reason: 'path-escape' | 'not-found' }> {
  if (lexicalEscapesRoot(relPath)) {
    return { ok: false, reason: 'path-escape' }
  }
  const joined = join(repoRoot, ...relPath.split(/[\\/]/))
  if (!isInsideRoot(resolve(joined), resolve(repoRoot))) {
    return { ok: false, reason: 'path-escape' }
  }
  let repoReal: string
  try {
    repoReal = await realpath(repoRoot)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  let targetReal: string
  try {
    targetReal = await realpath(joined)
  } catch {
    try {
      const linkStat = await lstat(joined)
      if (linkStat.isSymbolicLink()) {
        const linkTarget = resolve(dirname(joined), await readlink(joined))
        if (!isInsideRoot(linkTarget, repoReal)) {
          return { ok: false, reason: 'path-escape' }
        }
      }
    } catch {
      // Missing target falls through to not-found.
    }
    return { ok: false, reason: 'not-found' }
  }
  if (!isInsideRoot(targetReal, repoReal)) {
    return { ok: false, reason: 'path-escape' }
  }
  try {
    if (!(await stat(targetReal)).isFile()) {
      return { ok: false, reason: 'not-found' }
    }
    return {
      ok: true,
      lines: splitMarkdownLines(normalizeSpecText(await readFile(targetReal, 'utf8')))
    }
  } catch {
    return { ok: false, reason: 'not-found' }
  }
}

export async function verifySpecEvidenceRefs(
  refs: readonly EvidenceRef[],
  workspacePath: string,
  config: WorkspaceConfig | null
): Promise<EvidenceCheckResult[]> {
  const repoRoots = new Map(
    (config?.codeRepos ?? []).map((r) => [r.key, resolveWorkspaceRepoPath(workspacePath, r.path)])
  )
  const results: EvidenceCheckResult[] = []
  for (const ref of refs) {
    const repoRoot = repoRoots.get(ref.repo)
    if (!repoRoot) {
      results.push({ ref, ok: false, reason: 'unknown-repo' })
      continue
    }
    const fileRes = await resolveRepoFileLines(repoRoot, ref.path)
    if (!fileRes.ok) {
      results.push({ ref, ok: false, reason: fileRes.reason })
      continue
    }
    const total = fileRes.lines.length
    const badRange =
      (ref.startLine !== null && (ref.startLine < 1 || ref.startLine > total)) ||
      (ref.endLine !== null &&
        (ref.endLine < 1 || ref.endLine < (ref.startLine ?? 1) || ref.endLine > total))
    results.push(
      badRange ? { ref, ok: false, reason: 'line-out-of-range' } : { ref, ok: true, reason: null }
    )
  }
  return results
}

const normalizeWs = (text: string): string => text.replace(/\s+/g, ' ').trim()

function buildSpecAnchorTextMap(parsed: ParsedSpec, rawSpecText: string): Map<string, string> {
  const map = new Map<string, string>()
  const allLines = splitMarkdownLines(normalizeSpecText(rawSpecText))
  const add = (anchor: string, range: SourceRange): void => {
    map.set(
      anchor,
      normalizeWs(allLines.slice(Math.max(0, range.startLine - 1), range.endLine).join('\n'))
    )
  }
  parsed.sections.forEach((s) => add(s.anchor, s.range))
  parsed.requirements.forEach((r) => {
    add(r.id, r.range)
    r.criteria.forEach((ac) => add(ac.id, ac.range))
  })
  parsed.questions.forEach((q) => add(q.id, q.range))
  parsed.stateMachines.forEach((sm) => add(`SM-${sm.machine}`, sm.range))
  parsed.events.forEach((ev) => ev.event && add(`EVT-${ev.event}`, ev.range))
  return map
}

function recomputeSummary(
  findings: readonly NormalizedFinding[],
  base: FindingsSummary
): FindingsSummary {
  const counts = {
    verified: 0,
    inferred: 0,
    assumption: 0,
    downgraded: 0,
    blocker: 0,
    major: 0,
    minor: 0
  }
  for (const f of findings) {
    counts[f.confidence] += 1
    counts[f.severity] += 1
    if (f.downgradeReason !== null) {
      counts.downgraded += 1
    }
  }
  return {
    total: findings.length,
    ...counts,
    duplicateCount: base.duplicateCount,
    truncated: base.truncated
  }
}

export async function collectAndVerifyFindings(
  rawJson: unknown,
  context: {
    runId: string
    specId: string
    parsedSpec: ParsedSpec
    rawSpecText: string
    workspacePath: string
    config: WorkspaceConfig
  }
): Promise<FindingsValidationResult> {
  const specTexts = buildSpecAnchorTextMap(context.parsedSpec, context.rawSpecText)
  const validated = validateFindings(rawJson, {
    runId: context.runId,
    specId: context.specId,
    validAnchors: new Set(specTexts.keys())
  })
  if (!validated.ok) {
    return validated
  }
  const repoRoots = new Map(
    context.config.codeRepos.map((r) => [
      r.key,
      resolveWorkspaceRepoPath(context.workspacePath, r.path)
    ])
  )
  const verifiedFindings: NormalizedFinding[] = []
  for (const item of validated.findings) {
    let okCount = 0
    let firstFailure: EvidenceFailureReason | null = null
    const fail = (reason: EvidenceFailureReason): void => {
      firstFailure ??= reason
    }
    for (const ev of item.evidence) {
      if (ev.kind === 'spec') {
        if (specTexts.get(ev.anchor)?.includes(normalizeWs(ev.quote))) {
          okCount += 1
        } else {
          fail('quote-mismatch')
        }
        continue
      }
      const repoRoot = repoRoots.get(ev.repo)
      if (!repoRoot) {
        fail('unknown-repo')
        continue
      }
      const fileRes = await resolveRepoFileLines(repoRoot, ev.path)
      if (!fileRes.ok) {
        fail(fileRes.reason)
        continue
      }
      if (ev.startLine < 1 || ev.endLine < ev.startLine || ev.endLine > fileRes.lines.length) {
        fail('line-out-of-range')
        continue
      }
      const windowNorm = normalizeWs(
        fileRes.lines
          .slice(Math.max(0, ev.startLine - 4), Math.min(fileRes.lines.length, ev.endLine + 3))
          .join(' ')
      )
      if (windowNorm.includes(normalizeWs(ev.quote))) {
        okCount += 1
      } else {
        fail('quote-mismatch')
      }
    }
    const shouldDowngrade =
      item.confidence === 'verified' && okCount === 0 && item.downgradeReason === null
    const confidence: FindingConfidence = shouldDowngrade ? 'inferred' : item.confidence
    const downgradeReason = shouldDowngrade ? (firstFailure ?? 'no-evidence') : item.downgradeReason
    verifiedFindings.push({ ...item, confidence, downgradeReason, verifiedEvidenceCount: okCount })
  }
  return {
    ok: true,
    runId: validated.runId,
    specId: validated.specId,
    findings: verifiedFindings,
    summary: recomputeSummary(verifiedFindings, validated.summary)
  }
}

export async function readAndVerifyRunFindingsFile(params: {
  findingsPath: string
  specPath: string
  specRelPath: string
  runId: string
  specId: string
  workspacePath: string
  config: WorkspaceConfig
}): Promise<FindingsValidationResult> {
  let rawJson: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rawJson = JSON.parse(await readFile(params.findingsPath, 'utf8'))
      break
    } catch (error) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
      const msg = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        code: 'E_FINDINGS_SCHEMA',
        detail: 'json',
        message: `结果格式错误：${msg}`
      }
    }
  }
  const rawBytes = await readFile(params.specPath)
  const decoded = decodeUtf8Fatal(rawBytes)
  const parsedSpec = parseSpec(rawBytes, params.specRelPath)
  return collectAndVerifyFindings(rawJson, {
    runId: params.runId,
    specId: params.specId,
    parsedSpec,
    rawSpecText: decoded.ok ? decoded.text : '',
    workspacePath: params.workspacePath,
    config: params.config
  })
}
