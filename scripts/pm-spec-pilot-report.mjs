#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PILOT_TARGETS = {
  draftToCleanLintMedianMsMax: 48 * 60 * 60 * 1000,
  verifiedEvidencePassRateMin: 0.7,
  aiUsefulAcceptanceRateMin: 0.4,
  stopLossAcceptanceThreshold: 0.2
}

function parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  const ms = typeof raw === 'string' && raw.trim() ? Date.parse(raw) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function median(values) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function readMetricsJsonl(metricsPath) {
  if (!existsSync(metricsPath)) {
    return []
  }
  const records = []
  for (const [index, rawLine] of readFileSync(metricsPath, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') {
        records.push(parsed)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid JSON in ${metricsPath}:${index + 1}: ${msg}`)
    }
  }
  return records
}

function readSubdirJsonFiles(baseDir, fileName) {
  if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
    return []
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const out = []
  for (const entry of readdirSync(baseDir, { withFileTypes: true }).sort(byName)) {
    const target = entry.isDirectory() ? join(baseDir, entry.name, fileName) : null
    if (target && existsSync(target)) {
      const data = JSON.parse(readFileSync(target, 'utf8'))
      if (data && typeof data === 'object') {
        out.push({ dirName: entry.name, data })
      }
    }
  }
  return out
}

function computeReviewAndLintMetrics(records, reviewsDir) {
  const roundCounts = new Map()
  const seenVersions = new Map()
  const resolvedCommentIds = new Set()
  const defectSpecs = new Set()
  const createdAt = new Map()
  const firstCleanAt = new Map()
  let resolvedDefectCount = 0

  for (const record of records) {
    const event = record.event ?? record.type
    const specId = typeof record.specId === 'string' ? record.specId : null
    const tsMs = parseTimestampMs(record.ts ?? record.timestamp ?? record.createdAt ?? record.at)

    if (event === 'review.published' && specId) {
      const ver = record.version ?? record.specVersion
      const seen = seenVersions.get(specId) ?? new Set()
      if (ver === undefined || ver === null || !seen.has(String(ver))) {
        if (ver !== undefined && ver !== null) {
          seen.add(String(ver))
          seenVersions.set(specId, seen)
        }
        roundCounts.set(specId, (roundCounts.get(specId) ?? 0) + 1)
      }
    } else if (
      event === 'comment.resolved' &&
      (record.status ?? 'resolved') === 'resolved' &&
      (record.kind ?? 'issue') === 'issue'
    ) {
      const cid = typeof record.commentId === 'string' ? record.commentId : null
      if (!cid || !resolvedCommentIds.has(cid)) {
        if (cid) {
          resolvedCommentIds.add(cid)
        }
        resolvedDefectCount += 1
        if (specId) {
          defectSpecs.add(specId)
        }
      }
    } else if (event === 'spec.created' && specId && tsMs !== null) {
      if (createdAt.get(specId) === undefined || tsMs < createdAt.get(specId)) {
        createdAt.set(specId, tsMs)
      }
    } else if (
      (event === 'lint.clean' ||
        (event === 'lint.run' && (record.error === 0 || record.errors === 0))) &&
      specId &&
      tsMs !== null
    ) {
      const start = createdAt.get(specId)
      if (
        start !== undefined &&
        tsMs >= start &&
        (firstCleanAt.get(specId) === undefined || tsMs < firstCleanAt.get(specId))
      ) {
        firstCleanAt.set(specId, tsMs)
      }
    }
  }

  let defectSource = 'metrics.jsonl'
  if (resolvedDefectCount === 0) {
    for (const { data } of readSubdirJsonFiles(reviewsDir, 'comments.json')) {
      const comments = Array.isArray(data) ? data : (data.comments ?? [])
      resolvedDefectCount += comments.filter(
        (c) => c?.kind === 'issue' && c?.status === 'resolved'
      ).length
    }
    if (resolvedDefectCount > 0) {
      defectSource = 'reviews-cache'
    }
  }

  const rounds = [...roundCounts.values()]
  const totalReviewRounds = rounds.reduce((sum, count) => sum + count, 0)
  const publishedSpecCount = roundCounts.size
  const defectDenom = publishedSpecCount > 0 ? publishedSpecCount : defectSpecs.size
  const durationsMs = [...firstCleanAt.entries()].map(([id, end]) => end - createdAt.get(id))

  return {
    publishedSpecCount,
    totalReviewRounds,
    avgReviewRoundsPerSpec: publishedSpecCount > 0 ? totalReviewRounds / publishedSpecCount : null,
    medianReviewRoundsPerSpec: median(rounds),
    resolvedPostReviewDefects: resolvedDefectCount,
    avgPostReviewDefectsPerSpec: defectDenom > 0 ? resolvedDefectCount / defectDenom : null,
    defectSource,
    draftToCleanSamples: durationsMs.length,
    draftToCleanLintMedianMs: median(durationsMs)
  }
}

function computeAiPrecheckMetrics(records, runResults) {
  let verifiedPassed = 0
  let verifiedDowngraded = 0
  let totalFindings = 0
  const decisions = new Map()

  for (const { dirName, data } of runResults) {
    const runId = typeof data.runId === 'string' ? data.runId : dirName
    if (Array.isArray(data.findings)) {
      totalFindings += data.findings.length
      for (const finding of data.findings) {
        if (finding?.downgradeReason) {
          verifiedDowngraded += 1
        } else if (finding?.confidence === 'verified') {
          verifiedPassed += 1
        }
        if (finding?.id) {
          decisions.set(`${runId}::${finding.id}`, finding.pmDecision ?? null)
        }
      }
    } else if (data.summary && typeof data.summary === 'object') {
      totalFindings += Number(data.summary.total ?? 0)
      verifiedPassed += Number(data.summary.verified ?? 0)
      verifiedDowngraded += Number(data.summary.downgraded ?? 0)
    }
  }

  for (const record of records) {
    const event = record.event ?? record.type
    if (runResults.length === 0 && event === 'review.finished') {
      totalFindings += Number(record.total ?? record.findingsTotal ?? 0)
      verifiedPassed += Number(record.verified ?? 0)
      verifiedDowngraded += Number(record.downgraded ?? 0)
    } else if (event === 'finding.decided' && typeof record.findingId === 'string') {
      const runId = typeof record.runId === 'string' ? record.runId : 'unknown-run'
      decisions.set(`${runId}::${record.findingId}`, record.decision ?? null)
    }
  }

  const values = [...decisions.values()]
  const acceptedFindings = values.filter((d) => d === 'accepted').length
  const rejectedFindings = values.filter((d) => d === 'rejected').length
  const effectiveTotal = Math.max(totalFindings, decisions.size)
  const totalOriginallyVerified = verifiedPassed + verifiedDowngraded

  return {
    runResultCount: runResults.length,
    totalFindings: effectiveTotal,
    verifiedPassed,
    verifiedDowngraded,
    totalOriginallyVerified,
    verifiedEvidencePassRate:
      totalOriginallyVerified > 0 ? verifiedPassed / totalOriginallyVerified : null,
    acceptedFindings,
    rejectedFindings,
    aiUsefulAcceptanceRate: effectiveTotal > 0 ? acceptedFindings / effectiveTotal : null
  }
}

export function computePilotReport(workspacePath) {
  const resolvedWorkspace = resolve(workspacePath)
  if (!existsSync(resolvedWorkspace) || !statSync(resolvedWorkspace).isDirectory()) {
    throw new Error(`Spec workspace directory does not exist: ${resolvedWorkspace}`)
  }
  const pmspecDir = join(resolvedWorkspace, '.pmspec')
  const records = readMetricsJsonl(join(pmspecDir, 'metrics.jsonl'))
  const runResults = readSubdirJsonFiles(join(pmspecDir, 'runs'), 'result.json')
  return {
    workspacePath: resolvedWorkspace,
    eventCount: records.length,
    metrics: {
      ...computeReviewAndLintMetrics(records, join(pmspecDir, 'reviews')),
      ...computeAiPrecheckMetrics(records, runResults)
    },
    targets: PILOT_TARGETS
  }
}

function formatDuration(ms) {
  if (ms === null) {
    return 'N/A'
  }
  const min = ms / 60_000
  return min < 60
    ? `${min.toFixed(1)} min (${Math.round(ms)} ms)`
    : `${(min / 60).toFixed(2)} h (${min.toFixed(1)} min)`
}

export function formatPilotReport(report) {
  const { metrics: m, targets: t } = report
  const fmtPct = (v) => (v === null ? 'N/A' : `${(v * 100).toFixed(1)}%`)
  const fmtNum = (v) => (v === null ? 'N/A' : v.toFixed(2))
  const tag = (v, pass, fail = 'FAIL') => (v === null ? 'NO_DATA' : pass(v) ? 'PASS' : fail)
  const draftTag = tag(m.draftToCleanLintMedianMs, (v) => v <= t.draftToCleanLintMedianMsMax)
  const evTag = tag(m.verifiedEvidencePassRate, (v) => v >= t.verifiedEvidencePassRateMin)
  const accTag = tag(
    m.aiUsefulAcceptanceRate,
    (v) => v >= t.aiUsefulAcceptanceRateMin,
    m.aiUsefulAcceptanceRate !== null && m.aiUsefulAcceptanceRate < t.stopLossAcceptanceThreshold
      ? 'STOP_LOSS_RISK'
      : 'BELOW_TARGET'
  )
  return [
    `PM Spec Hub Pilot Report — ${report.workspacePath}`,
    `Events: ${report.eventCount} | Run results: ${m.runResultCount}`,
    `1. Review rounds / spec: ${fmtNum(m.avgReviewRoundsPerSpec)} avg (median ${m.medianReviewRoundsPerSpec ?? 'N/A'}, ${m.totalReviewRounds} rounds / ${m.publishedSpecCount} specs)`,
    `2. Post-review defects / spec: ${fmtNum(m.avgPostReviewDefectsPerSpec)} (${m.resolvedPostReviewDefects} resolved issues, source: ${m.defectSource})`,
    `3. Draft -> clean-lint median time: ${formatDuration(m.draftToCleanLintMedianMs)} (${m.draftToCleanSamples} specs) [${draftTag}, target <= 2 workdays]`,
    `4. AI verified-evidence pass rate: ${fmtPct(m.verifiedEvidencePassRate)} (${m.verifiedPassed}/${m.totalOriginallyVerified} verified) [${evTag}, target >= 70%]`,
    `5. AI useful acceptance rate: ${fmtPct(m.aiUsefulAcceptanceRate)} (${m.acceptedFindings}/${m.totalFindings} accepted, ${m.rejectedFindings} rejected) [${accTag}, target >= 40%]`
  ].join('\n')
}

export function parseCliArgs(argv) {
  const parsed = { workspacePath: null, json: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--json') {
      parsed.json = true
    } else if (arg.startsWith('-') || parsed.workspacePath !== null) {
      throw new Error(`${arg.startsWith('-') ? 'Unknown option' : 'Unexpected argument'}: ${arg}`)
    } else {
      parsed.workspacePath = arg
    }
  }
  return parsed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { workspacePath, json, help } = parseCliArgs(process.argv.slice(2))
    if (help) {
      console.log(
        'Usage: node scripts/pm-spec-pilot-report.mjs <spec-workspace-path> [--json]'
      )
    } else if (!workspacePath) {
      throw new Error(
        'Missing required argument: <spec-workspace-path>. Run with --help for usage.'
      )
    } else {
      const report = computePilotReport(workspacePath)
      console.log(json ? JSON.stringify(report, null, 2) : formatPilotReport(report))
    }
  } catch (error) {
    console.error(
      `[pm-spec-pilot-report] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
