import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mock } from 'node:test'
import { pathToFileURL } from 'node:url'
import { afterEach, assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import * as main from '../worker/main.ts'

const tempDirs: string[] = []
function resolvePiCodingAgentDist(): string | null {
  const candidates = [
    process.env.ORCA_PI_RUNTIME_DIST,
    resolve(
      import.meta.dirname,
      '../../../out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    ),
    resolve(
      import.meta.dirname,
      '../../PMStudio/out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    ),
    '/Applications/LKL-PMStudio.app/Contents/Resources/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    '/Applications/Orca.app/Contents/Resources/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

const PI_CODING_AGENT_DIST = resolvePiCodingAgentDist()

async function setupPiWorkspace(kind: 'folder' | 'worktree' = 'folder') {
  const wsDir = mkdtempSync(join(tmpdir(), 'pmspec-pi-'))
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
  await mkdir(join(wsDir, 'specs', 'PAY-PI-001'), { recursive: true })
  await writeFile(
    join(wsDir, 'specs', 'PAY-PI-001', 'spec.md'),
    `---
id: PAY-PI-001
title: Pi 守卫注入验证
owner: 张三
status: draft
version: 1
product: 收单商户平台
reviewers: [李四（研发）, 王五（测试）]
codeRefs: []
updated: 2026-11-21
---

# Pi 守卫注入验证

## 背景与目标

验证 Pi 扩展参数注入。

## 范围

- 范围内：Pi 预检。
- 范围外：生产写操作。

## 角色与权限

| 角色 | 可执行操作 |
| ---- | ---------- |
| 系统 | 校验幂等键 |

## 需求明细

### REQ-001 [P0] 幂等检验

- AC-001-01：假如请求重复提交，当系统再次收到请求，那么接口返回幂等成功结果。

## 状态流转

## 非功能需求

- 响应时间 ≤ 500 毫秒。

## 埋点

## 待决问题
`,
    'utf8'
  )
  const host = mockHost({
    settings: { reviewAgent: 'pi', reviewTimeoutMinutes: 5, collectLocalMetrics: false },
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-pi-1',
        branch: 'main',
        displayName: 'ws-pi-1',
        terminals: []
      },
      'workspace.list': {
        workspaces: [
          { id: 'ws-pi-1', kind, name: 'ws-pi-1', path: wsDir, branch: 'main', hostId: null }
        ],
        truncated: false
      },
      'agent.launch': { terminalId: 'term-pi-1' }
    }
  })
  const worker = await mountWorker(main, { host })
  return { wsDir, host, worker }
}

afterEach(async () => {
  mock.timers.reset()
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('E51-E53: Pi launch guard injection, tool execution, and missing guard claim fallback', () => {
  test('E51 & E52: injects --tools, staged extension path and env on matching Pi launch, clears pending, runs staged guard extension', async () => {
    const { wsDir, worker } = await setupPiWorkspace('worktree')
    try {
      const started = await worker.request('review.start', { specId: 'PAY-PI-001' })
      const runDir = join(wsDir, '.pmspec', 'runs', started.runId)

      const mismatchedAgent = await worker.hooks.fire('agent.launch.before', {
        agent: 'claude',
        workspaceId: `repo-1::${wsDir}`,
        workspaceKind: 'worktree',
        command: 'claude',
        env: {}
      })
      assert.equal(mismatchedAgent.kind, 'continue')
      if (mismatchedAgent.kind === 'continue') {
        assert.equal(mismatchedAgent.event.command, 'claude')
      }

      const mismatchedPath = await worker.hooks.fire('agent.launch.before', {
        agent: 'pi',
        workspaceId: 'repo-1::/tmp/some-other-worktree',
        workspaceKind: 'worktree',
        command: 'pi --print',
        env: {}
      })
      assert.equal(mismatchedPath.kind, 'continue')
      if (mismatchedPath.kind === 'continue') {
        assert.equal(mismatchedPath.event.command, 'pi --print')
      }

      const matched = await worker.hooks.fire('agent.launch.before', {
        agent: 'pi',
        workspaceId: `repo-1::${wsDir}`,
        workspaceKind: 'worktree',
        command: 'pi --print -- prompt.txt',
        env: { PATH: '/usr/bin' }
      })
      assert.equal(matched.kind, 'continue')
      assert.ok(matched.kind === 'continue')
      assert.ok(matched.event.command.includes('--tools read,grep,find,ls,pmspec_submit_findings'))
      assert.ok(
        matched.event.command.includes(
          `--extension .pmspec/runs/${started.runId}/ext/pi/pmspec-review-guard.ts -- prompt.txt`
        )
      )
      assert.equal(matched.event.env.PMSPEC_RUN_ID, started.runId)
      assert.equal(matched.event.env.PMSPEC_RUN_DIR, runDir)
      assert.equal(matched.event.env.PMSPEC_SPEC_ID, 'PAY-PI-001')

      const secondLaunch = await worker.hooks.fire('agent.launch.before', {
        agent: 'pi',
        workspaceId: `repo-1::${wsDir}`,
        workspaceKind: 'worktree',
        command: 'pi --interactive',
        env: {}
      })
      assert.equal(secondLaunch.kind, 'continue')
      if (secondLaunch.kind === 'continue') {
        assert.equal(secondLaunch.event.command, 'pi --interactive')
      }

      // Exercise the actual staged pi/pmspec-review-guard.ts module and verify E49/E50 + guard-claim.json + findings.json
      const prevEnv = {
        PMSPEC_RUN_ID: process.env.PMSPEC_RUN_ID,
        PMSPEC_RUN_DIR: process.env.PMSPEC_RUN_DIR,
        PMSPEC_SPEC_ID: process.env.PMSPEC_SPEC_ID,
        PMSPEC_CODEGRAPH_REPOS: process.env.PMSPEC_CODEGRAPH_REPOS
      }
      process.env.PMSPEC_RUN_ID = matched.event.env.PMSPEC_RUN_ID
      process.env.PMSPEC_RUN_DIR = matched.event.env.PMSPEC_RUN_DIR
      process.env.PMSPEC_SPEC_ID = matched.event.env.PMSPEC_SPEC_ID
      process.env.PMSPEC_CODEGRAPH_REPOS = matched.event.env.PMSPEC_CODEGRAPH_REPOS
      try {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vendored @earendil-works/pi-coding-agent bundle exports discoverAndLoadExtensions.
        if (!PI_CODING_AGENT_DIST) {
          return
        }
        const piPkg = (await import(pathToFileURL(PI_CODING_AGENT_DIST).href)) as {
          discoverAndLoadExtensions: (
            paths: string[],
            cwd: string
          ) => Promise<{
            errors: unknown[]
            extensions: {
              handlers: Map<string, ((ev: unknown, ctx: unknown) => Promise<unknown>)[]>
              tools: Map<
                string,
                {
                  definition: {
                    execute: (
                      id: string,
                      params: unknown,
                      signal: AbortSignal | undefined,
                      onUpdate: unknown,
                      ctx: unknown
                    ) => Promise<unknown>
                  }
                }
              >
            }[]
          }>
        }
        const guardPath = join(runDir, 'ext', 'pi', 'pmspec-review-guard.ts')
        const loaded = await piPkg.discoverAndLoadExtensions([guardPath], wsDir)
        assert.deepEqual(loaded.errors, [])
        assert.equal(loaded.extensions.length, 1)
        assert.equal(existsSync(join(runDir, 'guard-claim.json')), true)

        const ext = loaded.extensions[0]!
        const toolCallHandler = ext.handlers.get('tool_call')![0]!
        const blockedTool = await toolCallHandler({ toolName: 'write', input: {} }, {})
        assert.deepEqual(blockedTool, {
          block: true,
          reason: '规格预检为只读任务，禁止使用工具 write'
        })
        const allowedTool = await toolCallHandler({ toolName: 'read', input: {} }, {})
        assert.equal(allowedTool, undefined)

        const submitTool = ext.tools.get('pmspec_submit_findings')!
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pmspec_submit_findings execute returns { details: { ok, count } } in this test fixture.
        const submitRes = (await submitTool.definition.execute(
          'call-1',
          {
            findings: [
              {
                id: 'F-001',
                anchor: 'REQ-001',
                category: 'idempotency',
                severity: 'major',
                title: '幂等检验测试发现',
                detail: '这是通过守卫工具原子写入 findings.json 的测试发现条目。',
                suggestion: '补充明确幂等键时效说明。',
                confidence: 'inferred',
                evidence: []
              }
            ]
          },
          undefined,
          undefined,
          {}
        )) as { details?: { ok?: boolean; count?: number } }
        assert.equal(submitRes.details?.ok, true)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pmspec_submit_findings writes canonical { runId, specId, findings } JSON.
        const written = JSON.parse(await readFile(join(runDir, 'findings.json'), 'utf8')) as {
          runId: string
          specId: string
          findings: { id: string }[]
        }
        assert.equal(written.runId, started.runId)
        assert.equal(written.specId, 'PAY-PI-001')
        assert.equal(written.findings[0]!.id, 'F-001')
      } finally {
        process.env.PMSPEC_RUN_ID = prevEnv.PMSPEC_RUN_ID
        process.env.PMSPEC_RUN_DIR = prevEnv.PMSPEC_RUN_DIR
        process.env.PMSPEC_SPEC_ID = prevEnv.PMSPEC_SPEC_ID
        process.env.PMSPEC_CODEGRAPH_REPOS = prevEnv.PMSPEC_CODEGRAPH_REPOS
      }
    } finally {
      await worker.deactivate()
    }
  })

  test('E53: downgrades Pi run to unguarded with W_UNGUARDED warning if guard-claim.json is missing after 30s', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
    const { worker } = await setupPiWorkspace('folder')
    try {
      const started = await worker.request('review.start', { specId: 'PAY-PI-001' })
      assert.equal(started.error?.code, 'W_UNGUARDED')

      // Advance 30.5s without guard-claim.json appearing
      mock.timers.tick(30_500)
      await new Promise((r) => setImmediate(r))

      const unguardedPost = worker.posts.findLast((p) => p.event === 'pmspec.run.updated')
      assert.ok(unguardedPost)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pmspec.run.updated payload conforms to RunView.
      const payload = unguardedPost.payload as { status: string; error: { code: string } | null }
      assert.equal(payload.status, 'running')
      assert.equal(payload.error?.code, 'W_UNGUARDED')
    } finally {
      await worker.deactivate()
    }
  })
})
