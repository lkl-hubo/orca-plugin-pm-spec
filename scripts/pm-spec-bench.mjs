#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DEFAULT_WORKSPACE_CONFIG = {
  version: 1,
  product: '收单商户平台',
  specsDir: 'specs',
  codeRepos: [],
  roles: ['商户管理员', '商户操作员', '运营', '系统'],
  review: { requiredSignoffRoles: ['研发', '测试'] },
  lint: { disabled: [], severityOverrides: {} }
}

function parsePositiveInt(raw, flagName) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer, got: ${raw}`)
  }
  return value
}

export function parseCliArgs(argv) {
  const parsed = {
    filePath: null,
    lines: 2000,
    runs: 200,
    budgetMs: null,
    json: false,
    help: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    const eqIndex = arg.indexOf('=')
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex)
    const value = eqIndex === -1 ? argv[++i] : arg.slice(eqIndex + 1)
    if (flag === '--file') {
      parsed.filePath = value ?? ''
    } else if (flag === '--lines') {
      parsed.lines = parsePositiveInt(value, '--lines')
    } else if (flag === '--runs') {
      parsed.runs = parsePositiveInt(value, '--runs')
    } else if (flag === '--budget-ms') {
      parsed.budgetMs = parsePositiveInt(value, '--budget-ms')
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return parsed
}

function buildStateMachineBlock(machineName, stateCount) {
  const out = ['```pmspec-states', `machine: ${machineName}`, 'initial: st_00', 'states:']
  for (let i = 0; i < stateCount; i += 1) {
    const key = `st_${String(i).padStart(2, '0')}`
    const tail = i === stateCount - 1 ? ', terminal: true' : ''
    out.push(`  ${key}: { label: 状态_${i}${tail} }`)
  }
  out.push('transitions:')
  for (let i = 0; i < stateCount - 1; i += 1) {
    const fromKey = `st_${String(i).padStart(2, '0')}`
    const toKey = `st_${String(i + 1).padStart(2, '0')}`
    out.push(`  - { from: ${fromKey}, to: ${toKey}, trigger: 步骤_${i}, actor: 系统 }`)
  }
  out.push('```')
  return out
}

export function generateDeterministicSpec(targetLines) {
  if (targetLines > 5000) {
    throw new Error(`--lines cannot exceed 5000 (L024 hard limit), got ${targetLines}`)
  }
  const stateCount = targetLines >= 250 ? 30 : 4
  const machineCount = targetLines >= 250 ? 2 : 1
  const prefix = [
    '---',
    'id: PAY-LARGE-001',
    'title: 基准测试大规模规格文档',
    'owner: 基准测试',
    'status: draft',
    'version: 1',
    'product: 收单商户平台',
    'updated: 2026-11-21',
    '---',
    '',
    '# 基准测试大规模规格文档',
    '',
    '## 背景与目标',
    '',
    '用于测量结构化规格解析与校验引擎在多需求与多状态场景下的耗时表现。',
    '',
    '## 范围',
    '',
    '- 范围内：支付订单创建、退款申请、渠道异步通知处理。',
    '',
    '## 角色与权限',
    '',
    '| 角色 | 可执行操作 |',
    '| --- | --- |',
    '| 商户管理员 | 发起退款与查询明细 |',
    '| 商户操作员 | 查询退款明细 |',
    '| 系统 | 处理渠道异步通知与定时关闭 |',
    '',
    '## 状态流转',
    ''
  ]
  for (let m = 1; m <= machineCount; m += 1) {
    prefix.push(...buildStateMachineBlock(`bench_flow_${m}`, stateCount), '')
  }
  prefix.push('## 需求明细', '')

  const suffix = [
    '## 非功能需求',
    '',
    '- 接口在 20 并发请求下 P95 响应时间不超过 200 毫秒。',
    '',
    '## 埋点',
    '',
    '```pmspec-events',
    '- event: bench_refund_submit',
    '  trigger: 商户管理员点击提交',
    '  anchor: REQ-001',
    '  properties:',
    '    - { name: order_id, type: string, required: true }',
    '    - { name: amount_fen, type: integer, required: true }',
    '```',
    '',
    '## 待决问题',
    '',
    '- Q-001 [resolved] 基准测试口径是否已确认？结论：已确认。'
  ]

  const acsPerReq = targetLines >= 500 ? 5 : 1
  const linesPerReq = acsPerReq + 2
  const maxFit = Math.max(
    1,
    Math.floor((targetLines - prefix.length - suffix.length) / linesPerReq)
  )
  const desired = targetLines >= 4500 ? 300 : targetLines >= 1500 ? 120 : maxFit
  const reqCount = Math.min(desired, maxFit, 999)

  const reqLines = []
  for (let r = 1; r <= reqCount; r += 1) {
    const reqNum = String(r).padStart(3, '0')
    reqLines.push(`### REQ-${reqNum} [P0] 基准需求条目 ${reqNum}`)
    for (let a = 1; a <= acsPerReq; a += 1) {
      const acNum = String(a).padStart(2, '0')
      reqLines.push(
        `- AC-${reqNum}-${acNum}：假如 订单状态为已支付，当 商户管理员提交第 ${a} 项操作，那么 系统在 100 毫秒内完成状态更新。`
      )
    }
    reqLines.push('')
  }

  const allLines = [...prefix, ...reqLines, ...suffix]
  const paddingCount = targetLines - allLines.length
  if (paddingCount > 0) {
    const insertAt = prefix.length + reqLines.length + 2
    const padding = Array.from(
      { length: paddingCount },
      (_, idx) => `- 非功能基线约束第 ${idx + 1} 条：单次请求处理耗时不超过 200 毫秒。`
    )
    allLines.splice(insertAt, 0, ...padding)
  }
  return `${allLines.join('\n')}\n`
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return 0
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  )
  return sortedValues[index]
}

async function resolveWorkspaceConfig(specFilePath) {
  let current = dirname(resolve(specFilePath))
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, 'pmspec.json')
    if (existsSync(candidate)) {
      return JSON.parse(await readFile(candidate, 'utf8'))
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return DEFAULT_WORKSPACE_CONFIG
}

export async function runBenchmark(options) {
  const repoRoot = resolve(import.meta.dirname, '..')
  const { parseSpec } = await import(
    pathToFileURL(join(repoRoot, 'core/spec-parser.ts')).href
  )
  const { lintSpec } = await import(
    pathToFileURL(join(repoRoot, 'core/spec-lint.ts')).href
  )

  let tempRoot = null
  let targetFilePath = options.filePath ? resolve(options.filePath) : null
  const generated = !targetFilePath

  try {
    if (!targetFilePath) {
      tempRoot = await mkdtemp(join(tmpdir(), 'pm-spec-bench-'))
      const specDir = join(tempRoot, 'specs', 'PAY-LARGE-001')
      await mkdir(specDir, { recursive: true })
      targetFilePath = join(specDir, 'spec.md')
      await writeFile(targetFilePath, generateDeterministicSpec(options.lines), 'utf8')
    }

    const rawBytes = await readFile(targetFilePath)
    const config = await resolveWorkspaceConfig(targetFilePath)
    const warmupParsed = parseSpec(rawBytes, targetFilePath)
    const warmupLint = lintSpec(warmupParsed, config, { stage: 'edit', evidence: [] })
    const lineCount = warmupParsed.lineCount
    const budgetMs = options.budgetMs ?? (lineCount <= 2500 ? 150 : 500)

    const durationsMs = []
    for (let i = 0; i < options.runs; i += 1) {
      const start = performance.now()
      lintSpec(parseSpec(rawBytes, targetFilePath), config, { stage: 'edit', evidence: [] })
      durationsMs.push(performance.now() - start)
    }

    durationsMs.sort((a, b) => a - b)
    const p50Ms = percentile(durationsMs, 50)
    const p95Ms = percentile(durationsMs, 95)
    const p99Ms = percentile(durationsMs, 99)
    const maxMs = durationsMs.at(-1) ?? 0
    const meanMs = durationsMs.reduce((sum, v) => sum + v, 0) / durationsMs.length
    const passed = p95Ms <= budgetMs && (!generated || warmupLint.counts.error === 0)

    return {
      filePath: generated ? `<generated:${lineCount}-lines>` : targetFilePath,
      generated,
      lineCount,
      byteLength: rawBytes.byteLength,
      requirements: warmupParsed.requirements.length,
      stateMachines: warmupParsed.stateMachines.length,
      lintCounts: warmupLint.counts,
      runs: options.runs,
      p50Ms: Number(p50Ms.toFixed(2)),
      p95Ms: Number(p95Ms.toFixed(2)),
      p99Ms: Number(p99Ms.toFixed(2)),
      meanMs: Number(meanMs.toFixed(2)),
      maxMs: Number(maxMs.toFixed(2)),
      budgetMs,
      passed
    }
  } finally {
    if (tempRoot && targetFilePath) {
      await unlink(targetFilePath).catch(() => {})
      await rmdir(join(tempRoot, 'specs', 'PAY-LARGE-001')).catch(() => {})
      await rmdir(join(tempRoot, 'specs')).catch(() => {})
      await rmdir(tempRoot).catch(() => {})
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseCliArgs(process.argv.slice(2))
    if (options.help) {
      console.log(
        'Usage: node scripts/pm-spec-bench.mjs [--file <path>] [--lines <2000|5000>] [--runs 200] [--budget-ms <n>] [--json]'
      )
    } else {
      const result = await runBenchmark(options)
      const summary = [
        `[pm-spec-bench] ${result.passed ? 'PASS' : 'FAIL'} — ${result.filePath}`,
        `Spec: ${result.lineCount} lines, ${result.byteLength} bytes, ${result.requirements} REQs, ${result.stateMachines} state machines (lint errors=${result.lintCounts.error}, warnings=${result.lintCounts.warning})`,
        `Runs: ${result.runs} | Mean=${result.meanMs}ms | P50=${result.p50Ms}ms | P95=${result.p95Ms}ms (budget <= ${result.budgetMs}ms) | P99=${result.p99Ms}ms | Max=${result.maxMs}ms`
      ].join('\n')
      console.log(options.json ? JSON.stringify(result, null, 2) : summary)
      process.exitCode = result.passed ? 0 : 1
    }
  } catch (error) {
    console.error(`[pm-spec-bench] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
