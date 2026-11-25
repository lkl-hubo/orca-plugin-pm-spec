import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from './test-kit.ts'
import {
  resolveWorkspaceRepoPath,
  validateWorkspaceConfig
} from '../core/workspace-config.ts'

const CLEAN_CONFIG_PATH = resolve(import.meta.dirname, 'fixtures/clean/pmspec.json')

describe('workspace-config', () => {
  it('accepts clean pmspec.json fixture', () => {
    const raw = JSON.parse(readFileSync(CLEAN_CONFIG_PATH, 'utf8'))
    const res = validateWorkspaceConfig(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) {
      return
    }
    expect(res.config.product).toBe('收单商户平台')
    expect(res.config.specsDir).toBe('specs')
    expect(res.config.review.requiredSignoffRoles).toEqual(['研发', '测试'])
  })

  it('rejects unknown fields, duplicate repo keys, invalid signoff roles, and structural lint overrides', () => {
    const parsed: unknown = JSON.parse(readFileSync(CLEAN_CONFIG_PATH, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Expected clean config object')
    }
    const base = Object.fromEntries(Object.entries(parsed))

    const withExtra = { ...base, extraField: true }
    expect(validateWorkspaceConfig(withExtra).ok).toBe(false)

    const withDupRepo = {
      ...base,
      codeRepos: [
        { key: 'merchant-api', path: '../a' },
        { key: 'merchant-api', path: '../b' }
      ]
    }
    const dupRes = validateWorkspaceConfig(withDupRepo)
    expect(dupRes.ok).toBe(false)
    if (!dupRes.ok) {
      expect(dupRes.errors.some((e) => e.path === 'codeRepos[1].key')).toBe(true)
    }

    const withBadSignoff = { ...base, review: { requiredSignoffRoles: ['外部顾问'] } }
    expect(validateWorkspaceConfig(withBadSignoff).ok).toBe(false)

    for (const structuralRule of ['PMS-L001', 'PMS-L002', 'PMS-L006', 'PMS-L024']) {
      const disabledStructural = {
        ...base,
        lint: { disabled: [structuralRule], severityOverrides: {} }
      }
      expect(validateWorkspaceConfig(disabledStructural).ok, structuralRule).toBe(false)

      const overrideStructural = {
        ...base,
        lint: { disabled: [], severityOverrides: { [structuralRule]: 'warning' } }
      }
      expect(validateWorkspaceConfig(overrideStructural).ok, structuralRule).toBe(false)
    }
  })

  it('resolves relative and absolute code repository paths without node:path', () => {
    expect(resolveWorkspaceRepoPath('/Users/pm/specs/pay', '../merchant-api')).toBe(
      '/Users/pm/specs/merchant-api'
    )
    expect(resolveWorkspaceRepoPath('/Users/pm/specs/pay', '/opt/code/merchant-api')).toBe(
      '/opt/code/merchant-api'
    )
    expect(resolveWorkspaceRepoPath('C:\\work\\specs', '..\\merchant-api')).toBe(
      'C:/work/merchant-api'
    )
  })
})
