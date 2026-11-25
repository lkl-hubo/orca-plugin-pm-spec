#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

function parsePositiveInt(raw, flagName) {
  const num = Number(raw)
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`${flagName} must be a positive integer, got: ${raw}`)
  }
  return num
}

export function parseCliArgs(argv) {
  const parsed = {
    baseUrl: 'http://127.0.0.1:8787',
    concurrency: 20,
    durationSeconds: 60,
    budgetMs: 200,
    rotateEvery: 1800,
    token:
      process.env.PMSPEC_BEARER_TOKEN ??
      process.env.GATEWAY_BEARER_TOKEN ??
      process.env.AUTH_TOKEN ??
      null,
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
    if (flag === '--base') {
      parsed.baseUrl = value ?? ''
    } else if (flag === '--concurrency') {
      parsed.concurrency = parsePositiveInt(value, '--concurrency')
    } else if (flag === '--duration') {
      parsed.durationSeconds = parsePositiveInt(value, '--duration')
    } else if (flag === '--budget-ms') {
      parsed.budgetMs = parsePositiveInt(value, '--budget-ms')
    } else if (flag === '--rotate-every') {
      parsed.rotateEvery = parsePositiveInt(value, '--rotate-every')
    } else if (flag === '--token') {
      parsed.token = value ?? ''
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  parsed.baseUrl = parsed.baseUrl.trim().replace(/\/+$/, '')
  parsed.token = parsed.token?.trim() || null
  if (!parsed.help) {
    const url = new URL(parsed.baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`--base must use http or https: ${parsed.baseUrl}`)
    }
  }
  return parsed
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

async function createLoadSpecReview(baseUrl, token) {
  const tag = randomBytes(4).toString('hex').toUpperCase()
  const specId = `PAY-LOAD-${tag}`
  const payload = {
    specId,
    title: `压测规格 ${tag}`,
    version: 1,
    snapshotSha256: createHash('sha256').update(specId).digest('hex'),
    requiredSignoffRoles: ['研发', '测试'],
    expiresInDays: 1,
    items: [
      {
        anchor: 'S-01',
        kind: 'section',
        parent: null,
        title: '需求明细',
        markdown: '负载测试章节。'
      },
      {
        anchor: 'REQ-001',
        kind: 'req',
        parent: 'S-01',
        title: '[P0] 负载测试需求条目',
        markdown:
          '- AC-001-01：假如 网关处于运行状态，当 并发提交评审意见，那么 服务端返回 303 重定向。'
      }
    ]
  }
  const headers = {
    'content-type': 'application/json',
    'idempotency-key': `spec-review-load-${tag}`
  }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  const response = await fetch(`${baseUrl}/v1/spec-reviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })
  const text = await response.text()
  if (response.status !== 201) {
    const hint = response.status === 401 ? ' (pass --token <bearer> if AUTH_MODE=static)' : ''
    throw new Error(`POST /v1/spec-reviews failed (${response.status}): ${text}${hint}`)
  }
  const created = JSON.parse(text)
  return { slug: created.slug, reviewerKey: created.reviewerKey, editToken: created.editToken }
}

async function deleteLoadSpecReview(baseUrl, token, review) {
  const headers = { 'x-pms-edit-token': review.editToken }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  try {
    const response = await fetch(`${baseUrl}/v1/spec-reviews/${review.slug}`, {
      method: 'DELETE',
      headers
    })
    await response.body?.cancel()
  } catch {
    // Best-effort cleanup after load test completes.
  }
}

export async function runSpecReviewLoad(options) {
  const { baseUrl, concurrency, durationSeconds, budgetMs, rotateEvery, token } = options
  const createdReviews = []
  let active = await createLoadSpecReview(baseUrl, token)
  createdReviews.push(active)
  let countOnActive = 0
  let rotationPromise = null

  async function acquireTarget() {
    if (countOnActive < rotateEvery) {
      countOnActive += 1
      return active
    }
    if (!rotationPromise) {
      rotationPromise = (async () => {
        const nextReview = await createLoadSpecReview(baseUrl, token)
        createdReviews.push(nextReview)
        active = nextReview
        countOnActive = 0
      })().finally(() => {
        rotationPromise = null
      })
    }
    await rotationPromise
    countOnActive += 1
    return active
  }

  const latencies = []
  const errorSamples = []
  let totalRequests = 0
  let errorCount = 0
  let sequence = 0
  const startedAt = performance.now()
  const deadline = startedAt + durationSeconds * 1000

  try {
    async function workerLoop(workerId) {
      while (performance.now() < deadline) {
        const seq = (sequence += 1)
        const target = await acquireTarget()
        const body = new URLSearchParams({
          k: target.reviewerKey,
          anchor: 'REQ-001',
          name: `压测评审人-${workerId}`,
          role: '研发',
          kind: 'suggestion',
          body: `load-test-comment-${seq}`
        }).toString()
        const reqStart = performance.now()
        try {
          const response = await fetch(`${baseUrl}/r/${target.slug}/comments`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
            redirect: 'manual'
          })
          await response.body?.cancel()
          latencies.push(performance.now() - reqStart)
          totalRequests += 1
          if (response.status !== 303) {
            errorCount += 1
            if (errorSamples.length < 5) {
              errorSamples.push(`HTTP ${response.status}`)
            }
          }
        } catch (error) {
          latencies.push(performance.now() - reqStart)
          totalRequests += 1
          errorCount += 1
          if (errorSamples.length < 5) {
            errorSamples.push(error instanceof Error ? error.message : String(error))
          }
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, idx) => workerLoop(idx + 1)))
  } finally {
    await Promise.all(createdReviews.map((review) => deleteLoadSpecReview(baseUrl, token, review)))
  }

  const totalDurationSec = Math.max(0.001, (performance.now() - startedAt) / 1000)
  latencies.sort((a, b) => a - b)
  const p50Ms = percentile(latencies, 50)
  const p95Ms = percentile(latencies, 95)
  const p99Ms = percentile(latencies, 99)
  const maxMs = latencies.at(-1) ?? 0
  const passed = totalRequests > 0 && errorCount === 0 && p95Ms <= budgetMs

  return {
    baseUrl,
    concurrency,
    durationSeconds,
    actualDurationSeconds: Number(totalDurationSec.toFixed(2)),
    reviewsCreated: createdReviews.length,
    totalRequests,
    rps: Number((totalRequests / totalDurationSec).toFixed(1)),
    errorCount,
    errorSamples,
    p50Ms: Number(p50Ms.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    p99Ms: Number(p99Ms.toFixed(2)),
    maxMs: Number(maxMs.toFixed(2)),
    budgetMs,
    passed
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseCliArgs(process.argv.slice(2))
    if (options.help) {
      console.log(
        'Usage: node scripts/spec-review-load.mjs [--base http://127.0.0.1:8787] [--concurrency 20] [--duration 60] [--budget-ms 200] [--token <bearer>] [--json]'
      )
    } else {
      const result = await runSpecReviewLoad(options)
      const lines = [
        `[spec-review-load] ${result.passed ? 'PASS' : 'FAIL'} — ${result.baseUrl}`,
        `Concurrency: ${result.concurrency} | Duration: ${result.actualDurationSeconds}s | Reviews rotated: ${result.reviewsCreated}`,
        `Requests: ${result.totalRequests} (${result.rps} req/s) | Errors: ${result.errorCount}`,
        `Latency: P50=${result.p50Ms}ms | P95=${result.p95Ms}ms (budget <= ${result.budgetMs}ms) | P99=${result.p99Ms}ms | Max=${result.maxMs}ms`
      ]
      if (result.errorSamples.length > 0) {
        lines.push(`Sample errors: ${result.errorSamples.join(', ')}`)
      }
      console.log(options.json ? JSON.stringify(result, null, 2) : lines.join('\n'))
      process.exitCode = result.passed ? 0 : 1
    }
  } catch (error) {
    console.error(`[spec-review-load] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
