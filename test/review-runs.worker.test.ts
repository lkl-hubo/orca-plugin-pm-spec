import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'node:test'
import { afterEach, assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { HOST_SHARE_GATEWAY_SECRET_KEY } from '../worker/gateway-config.ts'
import * as main from '../worker/main.ts'

const tempDirs: string[] = []
const originalFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout

function makeSpecContent(specId: string, extraLine = ''): string {
  return `---
id: ${specId}
title: 预检与网关测试 ${specId}
owner: 张三
status: draft
version: 1
product: 收单商户平台
reviewers: [李四（研发）, 王五（测试）]
codeRefs: []
updated: 2026-11-21
---

# 预检与网关测试 ${specId}

## 背景与目标

验证预检运行与分享网关同步。${extraLine}

## 范围

- 范围内：退款与评审同步。
- 范围外：跨月手续费。

## 角色与权限

| 角色 | 可执行操作 |
| ---- | ---------- |
| 系统 | 处理退款 |

## 需求明细

### REQ-001 [P0] 发起退款

- AC-001-01：假如订单已支付，当用户申请退款，那么系统校验实付上限并返回状态码。

## 状态流转

## 非功能需求

- 接口 P95 响应时间 ≤ 800 毫秒。

## 埋点

## 待决问题
`
}

async function setupWorkspace(
  specIds: string[],
  opts: { extraBySpec?: Record<string, string> } = {}
) {
  const wsDir = mkdtempSync(join(tmpdir(), 'pmspec-runs-'))
  tempDirs.push(wsDir)
  await writeFile(
    join(wsDir, 'pmspec.json'),
    JSON.stringify({
      version: 1,
      product: '收单商户平台',
      specsDir: 'specs',
      codeRepos: [],
      roles: ['系统', '用户'],
      review: { requiredSignoffRoles: ['研发', '测试'] }
    }),
    'utf8'
  )
  for (const id of specIds) {
    await mkdir(join(wsDir, 'specs', id), { recursive: true })
    await writeFile(
      join(wsDir, 'specs', id, 'spec.md'),
      makeSpecContent(id, opts.extraBySpec?.[id] ?? ''),
      'utf8'
    )
  }
  return wsDir
}

async function tickUntilSettled<T>(promise: Promise<T>, stepMs = 250, maxSteps = 400): Promise<T> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  for (let i = 0; i < maxSteps && !settled; i += 1) {
    await new Promise((r) => setImmediate(r))
    if (!settled && i % 10 === 9) {
      await new Promise((r) => realSetTimeout(r, 2))
    }
    if (!settled) {
      mock.timers.tick(stepMs)
    }
  }
  if (!settled) {
    throw new Error('Timed out waiting for async mocked-timer operation to settle')
  }
  return promise
}

function isRunUpdate(payload: unknown, runId: string, status: string): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'runId' in payload &&
    'status' in payload &&
    payload.runId === runId &&
    payload.status === status
  )
}

async function waitForRunUpdatedPost(
  worker: Awaited<ReturnType<typeof mountWorker>>,
  runId: string,
  expectedStatus: string
): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const matched = worker.posts.some(
      (p) => p.event === 'pmspec.run.updated' && isRunUpdate(p.payload, runId, expectedStatus)
    )
    if (matched) {
      return
    }
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`Timed out waiting for pmspec.run.updated (${expectedStatus})`)
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  mock.timers.reset()
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('E21-E25: ReviewRunManager lifecycle, concurrency, timeouts and recovery', () => {
  test('E21: agent.launch rejection records failed E_AGENT_UNAVAILABLE run and rolls back lock & concurrency', async () => {
    const wsDir = await setupWorkspace(['PAY-E21-001'])
    const host = mockHost({
      settings: { reviewAgent: 'opencode', maxConcurrentReviews: 1, collectLocalMetrics: false },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    try {
      await assert.rejects(
        () => worker.request('review.start', { specId: 'PAY-E21-001' }),
        /E_AGENT_UNAVAILABLE/
      )
      const failedPost = worker.posts.find((p) => p.event === 'pmspec.run.updated')
      assert.ok(failedPost)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pmspec.run.updated payload conforms to RunView in worker handler.
      const payload = failedPost.payload as {
        runId: string
        status: string
        error: { code: string }
      }
      assert.equal(payload.status, 'failed')
      assert.equal(payload.error.code, 'E_AGENT_UNAVAILABLE')

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run.json is persisted as RunRecord in review-runs.
      const diskRun = JSON.parse(
        await readFile(join(wsDir, '.pmspec', 'runs', payload.runId, 'run.json'), 'utf8')
      ) as { status: string; error: { code: string } }
      assert.equal(diskRun.status, 'failed')
      assert.equal(diskRun.error.code, 'E_AGENT_UNAVAILABLE')

      // Lock and concurrency slot were released, so retrying succeeds once agent.launch works.
      host.respond('agent.launch', { terminalId: 'term-retry-1' })
      const retried = await worker.request('review.start', { specId: 'PAY-E21-001' })
      assert.equal(retried.status, 'running')
    } finally {
      await worker.deactivate()
    }
  })

  test('E22: marks run failed with E_NO_FINDINGS 60s after agent emits done without findings.json', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
    const wsDir = await setupWorkspace(['PAY-E22-001'])
    const host = mockHost({
      settings: { reviewAgent: 'claude', reviewTimeoutMinutes: 15, collectLocalMetrics: false },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        },
        'agent.launch': { terminalId: 'term-e22' }
      }
    })
    const worker = await mountWorker(main, { host })
    try {
      const started = await worker.request('review.start', { specId: 'PAY-E22-001' })
      await worker.emit('agent.status.changed', {
        workspaceId: 'ws-1',
        paneKey: 'pane-1',
        terminalId: 'term-e22',
        state: 'done',
        receivedAt: Date.now()
      })
      mock.timers.tick(60_500)
      await waitForRunUpdatedPost(worker, started.runId, 'failed')

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run.json is persisted as RunRecord in review-runs.
      const diskRun = JSON.parse(
        await readFile(join(wsDir, '.pmspec', 'runs', started.runId, 'run.json'), 'utf8')
      ) as { status: string; error: { code: string } }
      assert.equal(diskRun.status, 'failed')
      assert.equal(diskRun.error.code, 'E_NO_FINDINGS')
    } finally {
      await worker.deactivate()
    }
  })

  test('E23: review timeout sets timed_out without closing agent terminal', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
    const wsDir = await setupWorkspace(['PAY-E23-001'])
    const host = mockHost({
      settings: { reviewAgent: 'claude', reviewTimeoutMinutes: 1, collectLocalMetrics: false },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        },
        'agent.launch': { terminalId: 'term-e23' }
      }
    })
    const worker = await mountWorker(main, { host })
    try {
      const started = await worker.request('review.start', { specId: 'PAY-E23-001' })
      mock.timers.tick(61_000)
      await waitForRunUpdatedPost(worker, started.runId, 'timed_out')

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run.json is persisted as RunRecord in review-runs.
      const diskRun = JSON.parse(
        await readFile(join(wsDir, '.pmspec', 'runs', started.runId, 'run.json'), 'utf8')
      ) as { status: string; error: { code: string } }
      assert.equal(diskRun.status, 'timed_out')
      assert.equal(diskRun.error.code, 'E_TIMEOUT')
      assert.equal(host.callsOf('terminal.close').length, 0)
    } finally {
      await worker.deactivate()
    }
  })

  test('E24: activate recovers unfinished running review when findings.json is already on disk', async () => {
    const wsDir = await setupWorkspace(['PAY-E24-001'])
    const runId = 'R-20261121-120000-aa11'
    const runDir = join(wsDir, '.pmspec', 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'run.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        specId: 'PAY-E24-001',
        specPath: 'specs/PAY-E24-001/spec.md',
        specSha256: 'abc',
        agent: 'claude',
        terminalId: 'term-old',
        status: 'running',
        createdAt: '2026-11-21T10:00:00.000Z',
        startedAt: '2026-11-21T10:00:01.000Z',
        finishedAt: null,
        timeoutAt: '2099-01-01T00:00:00.000Z',
        repos: [],
        guard: 'enforced',
        toolViolations: [],
        taint: { changed: false, repos: [] },
        error: null,
        summary: null
      }),
      'utf8'
    )
    await writeFile(
      join(runDir, 'findings.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        specId: 'PAY-E24-001',
        findings: [
          {
            id: 'F-001',
            anchor: 'REQ-001',
            category: 'reverse-flow',
            severity: 'blocker',
            title: '崩溃恢复收集到的预检发现',
            detail: '在 worker 重启后，已有 findings.json 应自动完成核验并持久化。',
            suggestion: '在规格中补充异步状态补偿规则。',
            confidence: 'inferred',
            evidence: []
          }
        ]
      }),
      'utf8'
    )

    const host = mockHost({
      settings: { collectLocalMetrics: false },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run.json is persisted as RunRecord in review-runs.
      const recoveredRun = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as {
        status: string
        summary: { total: number } | null
      }
      assert.equal(recoveredRun.status, 'succeeded')
      assert.equal(recoveredRun.summary?.total, 1)

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: result.json is written with findings: NormalizedFinding[] in run-collection.
      const resultJson = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as {
        findings: { id: string }[]
      }
      assert.equal(resultJson.findings[0]!.id, 'F-001')

      const succeededPost = worker.posts.find(
        (p) => p.event === 'pmspec.run.updated' && isRunUpdate(p.payload, runId, 'succeeded')
      )
      assert.ok(succeededPost)
    } finally {
      await worker.deactivate()
    }
  })

  test('E25: enforces maxConcurrentReviews=2 and per-spec busy lock', async () => {
    const wsDir = await setupWorkspace(['PAY-E25-001', 'PAY-E25-002', 'PAY-E25-003'])
    let seq = 0
    const host = mockHost({
      settings: { reviewAgent: 'claude', maxConcurrentReviews: 2, collectLocalMetrics: false },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        },
        'agent.launch': { terminalId: 'term-e25-1' }
      }
    })
    const worker = await mountWorker(main, { host })
    try {
      const r1 = await worker.request('review.start', { specId: 'PAY-E25-001' })
      assert.equal(r1.status, 'running')
      await assert.rejects(
        () => worker.request('review.start', { specId: 'PAY-E25-001' }),
        /E_REVIEW_BUSY/
      )
      host.respond('agent.launch', { terminalId: `term-e25-${++seq}` })
      const r2 = await worker.request('review.start', { specId: 'PAY-E25-002' })
      assert.equal(r2.status, 'running')
      host.respond('agent.launch', { terminalId: `term-e25-${++seq}` })
      await assert.rejects(
        () => worker.request('review.start', { specId: 'PAY-E25-003' }),
        /E_REVIEW_LIMIT/
      )
    } finally {
      await worker.deactivate()
    }
  })
})

describe('E43-E46: Gateway retries, auth handling, keyring guard, and local L023 publish block', () => {
  test('E43: retries transient 503 GET (x3) and 502 POST (x2) with stable Idempotency-Key', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const wsDir = await setupWorkspace(['PAY-E43-001'])
    const host = mockHost({
      settings: { gatewayUrl: 'https://gw.example.com', collectLocalMetrics: false },
      secrets: { 'gateway:token': 'tok-123' },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })

    let syncDetailCalls = 0
    const postIdempotencyKeys: string[] = []
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const u = String(url)
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && u.endsWith('/v1/spec-reviews')) {
          const headers = new Headers(init?.headers)
          postIdempotencyKeys.push(headers.get('Idempotency-Key') ?? '')
          if (postIdempotencyKeys.length <= 2) {
            return new Response('upstream busy', { status: 502 })
          }
          return new Response(
            JSON.stringify({
              version: 1,
              slug: 'rev-e43',
              status: 'open',
              specId: 'PAY-E43-001',
              specVersion: 1,
              reviewUrl: 'https://gw.example.com/r/rev-e43?k=secret-k',
              reviewerKey: 'secret-k',
              editToken: 'edit-tok',
              createdAt: '2026-11-21T10:00:00.000Z',
              expiresAt: '2026-12-05T10:00:00.000Z'
            }),
            { status: 201 }
          )
        }
        if (method === 'GET' && u.endsWith('/v1/spec-reviews/rev-e43')) {
          syncDetailCalls += 1
          if (syncDetailCalls <= 3) {
            return new Response('bad gateway', { status: 503 })
          }
          return new Response(
            JSON.stringify({
              slug: 'rev-e43',
              specId: 'PAY-E43-001',
              title: '预检与网关测试 PAY-E43-001',
              specVersion: 1,
              snapshotSha256: 'abc',
              status: 'open',
              expired: false,
              requiredSignoffRoles: ['研发', '测试'],
              signoffs: [],
              createdAt: '2026-11-21T10:00:00.000Z',
              updatedAt: '2026-11-21T10:00:00.000Z',
              expiresAt: '2026-12-05T10:00:00.000Z',
              closedAt: null
            }),
            { status: 200 }
          )
        }
        if (method === 'GET' && u.includes('/comments')) {
          return new Response(JSON.stringify({ comments: [], nextCursor: null }), { status: 200 })
        }
        return new Response('unexpected', { status: 500 })
      },
      { preconnect: originalFetch.preconnect }
    )

    const worker = await mountWorker(main, { host })
    try {
      await worker.request('spec.snapshot', { specId: 'PAY-E43-001' })
      const published = await tickUntilSettled(
        worker.request('review.publish', { specId: 'PAY-E43-001', version: 1 })
      )
      assert.equal(published.slug, 'rev-e43')
      assert.equal(postIdempotencyKeys.length, 3)
      assert.ok(postIdempotencyKeys[0]!.length > 0)
      assert.equal(postIdempotencyKeys[1], postIdempotencyKeys[0])
      assert.equal(postIdempotencyKeys[2], postIdempotencyKeys[0])

      const synced = await tickUntilSettled(worker.request('review.sync', { slug: 'rev-e43' }))
      assert.equal(synced.slug, 'rev-e43')
      assert.equal(syncDetailCalls, 4)
    } finally {
      await worker.deactivate()
    }
  })

  test('E44: HTTP 401 fails immediately with E_GATEWAY_AUTH without retries', async () => {
    const wsDir = await setupWorkspace(['PAY-E44-001'])
    const host = mockHost({
      settings: { gatewayUrl: 'https://gw.example.com' },
      secrets: { 'gateway:token': 'bad-tok' },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    let calls = 0
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        calls += 1
        return new Response('unauthorized', { status: 401 })
      },
      { preconnect: originalFetch.preconnect }
    )

    const worker = await mountWorker(main, { host })
    try {
      await assert.rejects(
        () => worker.request('review.sync', { slug: 'any-slug' }),
        /E_GATEWAY_AUTH/
      )
      assert.equal(calls, 1)
    } finally {
      await worker.deactivate()
    }
  })

  test('E45: secrets.protection unavailable rejects token save with E_SECRETS_UNAVAILABLE', async () => {
    const host = mockHost({
      results: { 'secrets.protection': { status: 'unavailable' } }
    })
    const worker = await mountWorker(main, { host })
    try {
      await assert.rejects(
        () => worker.request('gateway.saveToken', { token: 'my-secret-token' }),
        /E_SECRETS_UNAVAILABLE/
      )
      assert.equal(host.data().secrets['gateway:token'], undefined)
    } finally {
      await worker.deactivate()
    }
  })

  test('E46: sensitive data PMS-L023 blocks review.publish locally with E_SENSITIVE_DATA and zero network requests', async () => {
    const wsDir = await setupWorkspace(['PAY-E46-001'], {
      extraBySpec: { 'PAY-E46-001': ' 身份证 11010519491231002X ' }
    })
    const host = mockHost({
      settings: { gatewayUrl: 'https://gw.example.com', collectLocalMetrics: false },
      secrets: { 'gateway:token': 'tok-123' },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    let fetchCalls = 0
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1
        return new Response('{}', { status: 200 })
      },
      { preconnect: originalFetch.preconnect }
    )

    const worker = await mountWorker(main, { host })
    try {
      await assert.rejects(
        () => worker.request('review.publish', { specId: 'PAY-E46-001', version: 1 }),
        /E_SENSITIVE_DATA/
      )
      assert.equal(fetchCalls, 0)
    } finally {
      await worker.deactivate()
    }
  })

  test('gateway shares host static-token config when plugin settings are empty', async () => {
    const wsDir = await setupWorkspace(['PAY-E47-001'])
    const host = mockHost({
      settings: { gatewayUrl: '', collectLocalMetrics: false },
      secrets: {
        [HOST_SHARE_GATEWAY_SECRET_KEY]: JSON.stringify({
          gatewayUrl: 'https://host-gw.example.com',
          authMode: 'static',
          token: 'host-tok',
          connected: true,
          envOverrideActive: false,
          unreadableError: null
        })
      },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    let authHeader: string | null = null
    let requestedUrl = ''
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestedUrl = String(input)
        authHeader = new Headers(init?.headers).get('Authorization')
        if (requestedUrl.endsWith('/comments?limit=500')) {
          return new Response(JSON.stringify({ comments: [], nextCursor: null }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            slug: 'rev-host-1',
            specId: 'PAY-E47-001',
            title: 'Host Gateway Test',
            specVersion: 1,
            snapshotSha256: 'a'.repeat(64),
            status: 'open',
            expired: false,
            requiredSignoffRoles: ['研发'],
            signoffs: [],
            createdAt: '2026-11-21T00:00:00.000Z',
            updatedAt: '2026-11-21T00:00:00.000Z',
            expiresAt: '2026-12-05T00:00:00.000Z',
            closedAt: null
          }),
          { status: 200 }
        )
      },
      { preconnect: originalFetch.preconnect }
    )

    const worker = await mountWorker(main, { host })
    try {
      const status = await worker.request('gateway.status', {})
      assert.equal(status.configured, true)
      assert.equal(status.source, 'host')
      assert.equal(status.tokenStored, true)
      assert.equal(status.effectiveGatewayUrl, 'https://host-gw.example.com')

      const synced = await worker.request('review.sync', { slug: 'rev-host-1' })
      assert.equal(synced.slug, 'rev-host-1')
      assert.equal(authHeader, 'Bearer host-tok')
      assert.ok(requestedUrl.startsWith('https://host-gw.example.com/v1/spec-reviews/rev-host-1'))
    } finally {
      await worker.deactivate()
    }
  })

  test('gateway shares host authMode=none config without requiring a bearer token', async () => {
    const wsDir = await setupWorkspace(['PAY-E48-001'])
    const host = mockHost({
      settings: { gatewayUrl: '', collectLocalMetrics: false },
      secrets: {
        [HOST_SHARE_GATEWAY_SECRET_KEY]: JSON.stringify({
          gatewayUrl: 'http://192.168.1.50:8787',
          authMode: 'none',
          token: null,
          connected: true,
          envOverrideActive: false,
          unreadableError: null
        })
      },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    let authHeader: string | null = 'unexpected'
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        authHeader = new Headers(init?.headers).get('Authorization')
        if (String(input).endsWith('/comments?limit=500')) {
          return new Response(JSON.stringify({ comments: [], nextCursor: null }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            slug: 'rev-host-none',
            specId: 'PAY-E48-001',
            title: 'Host Gateway No Auth',
            specVersion: 1,
            snapshotSha256: 'b'.repeat(64),
            status: 'open',
            expired: false,
            requiredSignoffRoles: ['研发'],
            signoffs: [],
            createdAt: '2026-11-21T00:00:00.000Z',
            updatedAt: '2026-11-21T00:00:00.000Z',
            expiresAt: '2026-12-05T00:00:00.000Z',
            closedAt: null
          }),
          { status: 200 }
        )
      },
      { preconnect: originalFetch.preconnect }
    )

    const worker = await mountWorker(main, { host })
    try {
      const status = await worker.request('gateway.status', {})
      assert.equal(status.configured, true)
      assert.equal(status.source, 'host')
      assert.equal(status.authMode, 'none')
      assert.equal(status.tokenStored, false)

      const synced = await worker.request('review.sync', { slug: 'rev-host-none' })
      assert.equal(synced.slug, 'rev-host-none')
      assert.equal(authHeader, null)
    } finally {
      await worker.deactivate()
    }
  })

  test('origin-isolation blocks sending host token to a different overridden URL and clearOverride restores host config', async () => {
    const wsDir = await setupWorkspace(['PAY-E49-001'])
    const host = mockHost({
      settings: { gatewayUrl: 'https://other-gw.example.com', collectLocalMetrics: false },
      secrets: {
        [HOST_SHARE_GATEWAY_SECRET_KEY]: JSON.stringify({
          gatewayUrl: 'https://host-gw.example.com',
          authMode: 'static',
          token: 'host-tok',
          connected: true,
          envOverrideActive: false,
          unreadableError: null
        })
      },
      results: {
        'workspace.readContext': {
          workspaceId: 'ws-1',
          branch: 'main',
          displayName: 'ws-1',
          terminals: []
        },
        'workspace.list': {
          workspaces: [
            { id: 'ws-1', kind: 'folder', name: 'ws-1', path: wsDir, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    let fetchCalls = 0
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1
        return new Response('{}', { status: 200 })
      },
      { preconnect: originalFetch.preconnect }
    )

    const worker = await mountWorker(main, { host })
    try {
      const overrideStatus = await worker.request('gateway.status', {})
      assert.equal(overrideStatus.configured, false)
      assert.equal(overrideStatus.source, 'plugin')
      assert.equal(overrideStatus.tokenStored, false)
      assert.equal(overrideStatus.hasPluginOverride, true)

      await assert.rejects(
        () => worker.request('review.sync', { slug: 'any-slug' }),
        /E_GATEWAY_NOT_CONFIGURED/
      )
      assert.equal(fetchCalls, 0)

      await worker.request('gateway.saveToken', { token: 'plugin-tok' })
      const cleared = await worker.request('gateway.clearOverride', {})
      assert.equal(cleared.cleared, true)

      const restoredStatus = await worker.request('gateway.status', {})
      assert.equal(restoredStatus.configured, true)
      assert.equal(restoredStatus.source, 'host')
      assert.equal(restoredStatus.hasPluginOverride, false)
      assert.equal(restoredStatus.effectiveGatewayUrl, 'https://host-gw.example.com')
    } finally {
      await worker.deactivate()
    }
  })
})
