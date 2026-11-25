import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from './test-kit.ts'
import {
  buildGatewayReviewPayload,
  buildSnapshotManifest,
  extractSpecItems
} from '../core/review-payload.ts'
import { parseSpec } from '../core/spec-parser.ts'
import { validateWorkspaceConfig } from '../core/workspace-config.ts'

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures')
const CLEAN_SPEC_PATH = resolve(FIXTURES_DIR, 'clean/specs/PAY-REFUND-001/spec.md')
const CLEAN_CONFIG_PATH = resolve(FIXTURES_DIR, 'clean/pmspec.json')

describe('review-payload', () => {
  it('extracts 14 items with parent hierarchy from clean PAY-REFUND-001', () => {
    const parsed = parseSpec(readFileSync(CLEAN_SPEC_PATH, 'utf8'), 'specs/PAY-REFUND-001/spec.md')
    const items = extractSpecItems(parsed)

    expect(items).toHaveLength(14)
    expect(items.map((i) => `${i.anchor}:${i.kind}:${i.parent ?? 'root'}`)).toEqual([
      'S-01:section:root',
      'S-02:section:root',
      'S-03:section:root',
      'S-04:section:root',
      'REQ-001:req:S-04',
      'REQ-002:req:S-04',
      'REQ-003:req:S-04',
      'S-05:section:root',
      'SM-refund_order:states:S-05',
      'S-06:section:root',
      'S-07:section:root',
      'EVT-refund_submit_click:events:S-07',
      'S-08:section:root',
      'Q-001:question:S-08'
    ])
    expect(items.find((i) => i.anchor === 'S-04')?.markdown).toBe('')
    expect(items.find((i) => i.anchor === 'SM-refund_order')?.markdown).toContain(
      '| 起始状态 | 目标状态 |'
    )
  })

  it('builds snapshot manifest and gateway review payload matching schema', () => {
    const parsed = parseSpec(readFileSync(CLEAN_SPEC_PATH, 'utf8'), 'specs/PAY-REFUND-001/spec.md')
    const cfgRes = validateWorkspaceConfig(JSON.parse(readFileSync(CLEAN_CONFIG_PATH, 'utf8')))
    if (!cfgRes.ok) {
      throw new Error('Invalid clean config')
    }

    const manifest = buildSnapshotManifest(parsed, {
      createdAt: '2026-11-21T08:40:00.000Z',
      createdBy: '张三',
      lint: { error: 0, warning: 0 }
    })
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.specId).toBe('PAY-REFUND-001')
    expect(manifest.version).toBe(3)
    expect(manifest.items).toHaveLength(14)
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)

    const payload = buildGatewayReviewPayload(parsed, cfgRes.config, {
      snapshotSha256: manifest.sha256,
      expiresInDays: 14,
      previousVersionDiff: { fromVersion: 2, added: 1, modified: 2, removed: 0 }
    })
    expect(payload.requiredSignoffRoles).toEqual(['研发', '测试'])
    expect(payload.previousVersionDiff).toEqual({
      fromVersion: 2,
      added: 1,
      modified: 2,
      removed: 0
    })
    expect(payload.items).toHaveLength(14)
  })
})
