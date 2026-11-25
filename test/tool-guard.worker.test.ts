import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import * as main from '../worker/main.ts'

const tempDirs: string[] = []

async function createSpecWorkspace(agent: string) {
  const wsDir = mkdtempSync(join(tmpdir(), 'pmspec-guard-'))
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
  await mkdir(join(wsDir, 'specs', 'PAY-GUARD-001'), { recursive: true })
  await writeFile(
    join(wsDir, 'specs', 'PAY-GUARD-001', 'spec.md'),
    `---
id: PAY-GUARD-001
title: 守卫测试规格
owner: 张三
status: draft
version: 1
product: 收单商户平台
reviewers: [李四（研发）, 王五（测试）]
codeRefs: []
updated: 2026-11-21
---

# 守卫测试规格

## 背景与目标

验证只读工具守卫。

## 范围

- 范围内：预检工具拦截验证。
- 范围外：线上部署。

## 角色与权限

| 角色 | 可执行操作 |
| ---- | ---------- |
| 系统 | 处理交易 |

## 需求明细

### REQ-001 [P0] 示例规则

- AC-001-01：假如发起交易请求，当系统收到请求，那么校验幂等键并返回明确状态。

## 状态流转

## 非功能需求

- 响应时间 ≤ 500 毫秒。

## 埋点

## 待决问题
`,
    'utf8'
  )
  const host = mockHost({
    settings: { reviewAgent: agent, reviewTimeoutMinutes: 5, collectLocalMetrics: false },
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
      'agent.launch': { terminalId: `term-${agent}-1` }
    }
  })
  const worker = await mountWorker(main, { host })
  return { wsDir, host, worker }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('E20: Claude Code & non-Claude agent.tool.before guard', () => {
  test('denies Claude Code writes outside runDir, allows writes inside runDir, leaves non-review terminals untouched', async () => {
    const { wsDir, worker } = await createSpecWorkspace('claude')
    try {
      const started = await worker.request('review.start', { specId: 'PAY-GUARD-001' })
      const runDir = join(wsDir, '.pmspec', 'runs', started.runId)

      const outsideWrite = await worker.hooks.fire('agent.tool.before', {
        agent: 'claude',
        workspaceId: 'ws-1',
        terminalId: 'term-claude-1',
        tool: 'Write',
        input: { file_path: join(wsDir, 'src', 'hack.ts'), content: 'bad' }
      })
      assert.equal(outsideWrite.kind, 'deny')

      const relativeOutsideWrite = await worker.hooks.fire('agent.tool.before', {
        agent: 'claude',
        workspaceId: 'ws-1',
        terminalId: 'term-claude-1',
        tool: 'Edit',
        input: { file_path: 'src/a.ts' }
      })
      assert.equal(relativeOutsideWrite.kind, 'deny')

      const insideWrite = await worker.hooks.fire('agent.tool.before', {
        agent: 'claude',
        workspaceId: 'ws-1',
        terminalId: 'term-claude-1',
        tool: 'Write',
        input: { file_path: join(runDir, 'findings.tmp.json'), content: '{}' }
      })
      assert.equal(insideWrite.kind, 'continue')

      const bashRedirectOutside = await worker.hooks.fire('agent.tool.before', {
        agent: 'claude',
        workspaceId: 'ws-1',
        terminalId: 'term-claude-1',
        tool: 'Bash',
        input: { command: 'echo x > src/evil.ts' }
      })
      assert.equal(bashRedirectOutside.kind, 'deny')

      const bashGitReset = await worker.hooks.fire('agent.tool.before', {
        agent: 'claude',
        workspaceId: 'ws-1',
        terminalId: 'term-claude-1',
        tool: 'Bash',
        input: { command: 'git reset --hard' }
      })
      assert.equal(bashGitReset.kind, 'deny')

      const otherTerminal = await worker.hooks.fire('agent.tool.before', {
        agent: 'claude',
        workspaceId: 'ws-1',
        terminalId: 'unrelated-terminal-99',
        tool: 'Write',
        input: { file_path: join(wsDir, 'src', 'normal.ts') }
      })
      assert.equal(otherTerminal.kind, 'continue')
      assert.deepEqual(worker.refusals, [])
    } finally {
      await worker.deactivate()
    }
  })

  test('non-claude review terminals record toolViolations without returning deny', async () => {
    const { wsDir, worker } = await createSpecWorkspace('opencode')
    try {
      const started = await worker.request('review.start', { specId: 'PAY-GUARD-001' })
      const decision = await worker.hooks.fire('agent.tool.before', {
        agent: 'opencode',
        workspaceId: 'ws-1',
        terminalId: 'term-opencode-1',
        tool: 'Write',
        input: { file_path: join(wsDir, 'src', 'touched.ts') }
      })
      assert.equal(decision.kind, 'continue')
      const detail = await worker.request('spec.detail', { specId: 'PAY-GUARD-001' })
      assert.equal(detail.runs[0]!.runId, started.runId)
    } finally {
      await worker.deactivate()
    }
  })
})
