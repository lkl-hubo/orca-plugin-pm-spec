import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from './test-kit.ts'
import { parseSpec } from '../core/spec-parser.ts'
import type { WorkspaceConfig } from '../core/spec-types.ts'
import {
  collectAndVerifyFindings,
  verifySpecEvidenceRefs
} from '../worker/evidence-verify.ts'
import {
  bumpSpecVersionOnDisk,
  updateFrontmatterStatusAndVersion
} from '../worker/frontmatter-write.ts'
import {
  captureRepoSnapshotsBefore,
  compareRepoSnapshotsAfter
} from '../worker/repo-taint-check.ts'
import { stageGuardExtensionFiles } from '../worker/guard-staging.ts'
import { writeSpecSnapshot } from '../worker/snapshot-store.ts'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeConfig(repoPath = './repo'): WorkspaceConfig {
  return {
    version: 1,
    product: '收单商户平台',
    specsDir: 'specs',
    codeRepos: [{ key: 'pay-core', path: repoPath, description: '核心仓库' }],
    roles: ['商户管理员', '系统'],
    review: { requiredSignoffRoles: ['研发', '测试'] },
    lint: { disabled: [], severityOverrides: {} }
  }
}

const VALID_SPEC = `---
id: PAY-REFUND-001
title: 部分退款
owner: alice
status: draft
version: 1
updated: 2026-11-21
relatedRepos: [pay-core]
---

## 需求与规则

### REQ-001 发起退款

假如订单已支付，用户申请部分退款时按实付比例退回。

#### 验收标准
- AC-001: 校验累计退款金额不超过实付金额（参见 [pay-core:src/refund.ts#L1-L4]）。
`

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('pm-spec worker filesystem and verification logic', () => {
  it('H06 & E12: creates snapshot once, reuses identical content keeping mtime, rejects divergent content on same version', async () => {
    const ws = makeTempDir('pmspec-snap-')
    const parsedV1 = parseSpec(VALID_SPEC, 'specs/PAY-REFUND-001/spec.md')

    const first = await writeSpecSnapshot(ws, parsedV1, VALID_SPEC, {
      lint: { error: 0, warning: 0 }
    })
    expect(first.reused).toBe(false)
    expect(first.version).toBe(1)

    const jsonPath = join(ws, '.pmspec', 'snapshots', 'PAY-REFUND-001', 'v1.json')
    const sentinelTime = new Date('2025-01-02T03:04:05.000Z')
    await utimes(jsonPath, sentinelTime, sentinelTime)

    const reused = await writeSpecSnapshot(ws, parsedV1, VALID_SPEC, {
      lint: { error: 0, warning: 0 }
    })
    expect(reused.reused).toBe(true)
    expect(reused.sha256).toBe(first.sha256)
    expect((await stat(jsonPath)).mtimeMs).toBe(sentinelTime.getTime())

    const modified = VALID_SPEC.replace('按实付比例退回', '按原支付渠道退回')
    const parsedModified = parseSpec(modified, 'specs/PAY-REFUND-001/spec.md')
    await expect(
      writeSpecSnapshot(ws, parsedModified, modified, { lint: { error: 0, warning: 0 } })
    ).rejects.toThrow(/E_SNAPSHOT_VERSION_EXISTS/)
  })

  it('E13: rejects frontmatter status/version update with E_FILE_CHANGED when disk file was modified concurrently', async () => {
    const ws = makeTempDir('pmspec-fm-')
    const specPath = join(ws, 'spec.md')
    await writeFile(specPath, VALID_SPEC, 'utf8')
    const parsed = parseSpec(VALID_SPEC, 'specs/PAY-REFUND-001/spec.md')

    const updated = VALID_SPEC.replace('部分退款', '部分退款（已编辑）')
    await writeFile(specPath, updated, 'utf8')

    await expect(
      updateFrontmatterStatusAndVersion(specPath, {
        expectedSha256: parsed.rawSha256,
        status: 'in-review'
      })
    ).rejects.toThrow(/E_FILE_CHANGED/)

    await expect(bumpSpecVersionOnDisk(specPath, parsed.rawSha256, 1)).rejects.toThrow(
      /E_FILE_CHANGED/
    )
    expect(await readFile(specPath, 'utf8')).toBe(updated)
  })

  it('E15, E16, E17: verifies evidence quotes, blocks path escapes and symlinks escaping repo, rejects out-of-range lines', async () => {
    const ws = makeTempDir('pmspec-ev-')
    const outsideDir = makeTempDir('pmspec-outside-')
    const outsideSecret = join(outsideDir, 'secret.txt')
    await writeFile(outsideSecret, 'TOP_SECRET_OUTSIDE_REPO_CONTENT\n', 'utf8')

    const repoDir = join(ws, 'repo')
    await mkdir(join(repoDir, 'src'), { recursive: true })
    const refundTs = join(repoDir, 'src', 'refund.ts')
    await writeFile(
      refundTs,
      [
        'export function applyRefund(amount: number) {',
        '  if (amount <= 0) {',
        '    throw new Error("INVALID_AMOUNT")',
        '  }',
        '  return amount',
        '}'
      ].join('\n'),
      'utf8'
    )
    const escapeLink = join(repoDir, 'src', 'leak.ts')
    await symlink(outsideSecret, escapeLink)

    const config = makeConfig('./repo')
    const refs = [
      {
        repo: 'pay-core',
        path: 'src/refund.ts',
        startLine: 1,
        endLine: 4,
        range: { startLine: 1, endLine: 1 }
      },
      {
        repo: 'pay-core',
        path: '../../etc/hosts',
        startLine: 1,
        endLine: 2,
        range: { startLine: 1, endLine: 1 }
      },
      {
        repo: 'pay-core',
        path: 'src/leak.ts',
        startLine: 1,
        endLine: 1,
        range: { startLine: 1, endLine: 1 }
      },
      {
        repo: 'pay-core',
        path: 'src/refund.ts',
        startLine: 1,
        endLine: 99,
        range: { startLine: 1, endLine: 1 }
      }
    ]
    const refResults = await verifySpecEvidenceRefs(refs, ws, config)
    expect(refResults.map((r) => [r.ok, r.reason])).toEqual([
      [true, null],
      [false, 'path-escape'],
      [false, 'path-escape'],
      [false, 'line-out-of-range']
    ])

    const parsedSpec = parseSpec(VALID_SPEC, 'specs/PAY-REFUND-001/spec.md')
    const rawFindings = {
      schemaVersion: 1,
      runId: 'R-20261121-010203-ab12',
      specId: 'PAY-REFUND-001',
      findings: [
        {
          id: 'F-001',
          anchor: 'REQ-001',
          category: 'reverse-flow',
          severity: 'blocker',
          title: '退款路径引用越界文件被降级',
          detail: '尝试引用仓库外路径来作为证据。',
          suggestion: '仅引用仓库内部已存在的源码路径。',
          confidence: 'verified',
          evidence: [
            {
              kind: 'code',
              repo: 'pay-core',
              path: '../../etc/hosts',
              startLine: 1,
              endLine: 1,
              quote: 'localhost'
            }
          ]
        },
        {
          id: 'F-002',
          anchor: 'REQ-001',
          category: 'boundary-value',
          severity: 'major',
          title: '引用摘录与原文不一致被降级',
          detail: '规格原文并无该段落引用，核验后应自动降级。',
          suggestion: '核对规格并重写正确摘录。',
          confidence: 'verified',
          evidence: [{ kind: 'spec', anchor: 'REQ-001', quote: '原文完全不存在的虚假摘录内容' }]
        },
        {
          id: 'F-003',
          anchor: 'REQ-001',
          category: 'code-conflict',
          severity: 'major',
          title: '真实存在的源码与行号摘录保持 verified',
          detail: '代码在金额小于等于零时直接抛异常，需要对齐规格提示。',
          suggestion: '在规格中补充非法金额报错码约定。',
          confidence: 'verified',
          evidence: [
            {
              kind: 'code',
              repo: 'pay-core',
              path: 'src/refund.ts',
              startLine: 2,
              endLine: 3,
              quote: 'if (amount <= 0)'
            }
          ]
        }
      ]
    }

    const verified = await collectAndVerifyFindings(rawFindings, {
      runId: 'R-20261121-010203-ab12',
      specId: 'PAY-REFUND-001',
      parsedSpec,
      rawSpecText: VALID_SPEC,
      workspacePath: ws,
      config
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.findings[0]!.confidence).toBe('inferred')
      expect(verified.findings[0]!.downgradeReason).toBe('path-escape')
      expect(verified.findings[1]!.confidence).toBe('inferred')
      expect(verified.findings[1]!.downgradeReason).toBe('quote-mismatch')
      expect(verified.findings[2]!.confidence).toBe('verified')
      expect(verified.findings[2]!.downgradeReason).toBeNull()
      expect(verified.summary).toMatchObject({ total: 3, verified: 1, inferred: 2, downgraded: 2 })
    }
  })

  it('E19: captures git HEAD & porcelain before run and detects untracked/dirty taint after run', async () => {
    const ws = makeTempDir('pmspec-taint-')
    const repoDir = join(ws, 'repo')
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, 'index.ts'), 'export const v = 1\n', 'utf8')
    execFileSync('git', ['init'], { cwd: repoDir, windowsHide: true })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, windowsHide: true })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      windowsHide: true
    })
    execFileSync('git', ['add', 'index.ts'], { cwd: repoDir, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true })

    const config = makeConfig('./repo')
    const before = await captureRepoSnapshotsBefore(ws, config.codeRepos)
    expect(before).toHaveLength(1)
    expect(before[0]!.git).toBe(true)
    expect(before[0]!.headBefore).toMatch(/^[0-9a-f]{40}$/)

    await writeFile(join(repoDir, 'dirty.txt'), 'modified during run\n', 'utf8')
    const after = await compareRepoSnapshotsAfter(before)
    expect(after.taint).toEqual({ changed: true, repos: ['pay-core'] })
  })

  it('stages all transitive guard extension modules under runDir/ext preserving relative core imports', async () => {
    const ws = makeTempDir('pmspec-stage-')
    const runDir = join(ws, '.pmspec', 'runs', 'R-20261121-010203-ab12')
    await stageGuardExtensionFiles(runDir)

    const guardSrc = await readFile(join(runDir, 'ext', 'pi', 'pmspec-review-guard.ts'), 'utf8')
    const policySrc = await readFile(join(runDir, 'ext', 'core', 'pi-guard-policy.ts'), 'utf8')
    const yamlVendor = await readFile(join(runDir, 'ext', 'vendor', 'js-yaml.mjs'), 'utf8')
    expect(guardSrc).toContain('../core/pi-guard-policy.ts')
    expect(policySrc).toContain('validateSubmittedFindings')
    expect(yamlVendor.length).toBeGreaterThan(1000)
  })
})
