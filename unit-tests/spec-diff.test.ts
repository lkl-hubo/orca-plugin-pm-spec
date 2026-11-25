import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from './test-kit.ts'
import { diffLines } from '../core/line-diff.ts'
import { buildSnapshotManifest } from '../core/review-payload.ts'
import { diffSnapshots } from '../core/spec-diff.ts'
import { parseSpec } from '../core/spec-parser.ts'

const CLEAN_SPEC_PATH = resolve(import.meta.dirname, 'fixtures/clean/specs/PAY-REFUND-001/spec.md')

describe('spec-diff and line-diff', () => {
  it('H07: detects added REQ-003 and 1-del/1-add line diff on REQ-002', () => {
    const v3Raw = readFileSync(CLEAN_SPEC_PATH, 'utf8')
    const v2Raw = v3Raw
      .replace('version: 3', 'version: 2')
      .replace(
        '- AC-002-02：假如 同一渠道回调重复送达，当 系统再次处理，那么 退款单状态与金额不发生变化，并记录重复回调日志。',
        '- AC-002-02：假如 同一渠道回调重复送达，当 系统再次处理，那么 仅记录重复回调日志。'
      )
      .replace(
        '\n### REQ-003 [P1] 退款失败后重发\n\n- AC-003-01：假如 退款单状态为「退款失败」且失败时间在 7 天内，当 商户管理员点击「重新发起」，那么 系统将该退款单状态改为「退款中」并重新请求渠道。\n- AC-003-02：假如 退款单状态为「退款失败」且失败时间超过 7 天，当 系统执行每日关闭任务，那么 退款单状态变为「已关闭」，解冻可退金额。\n',
        '\n'
      )

    const v2Parsed = parseSpec(v2Raw, 'specs/PAY-REFUND-001/spec.md')
    const v3Parsed = parseSpec(v3Raw, 'specs/PAY-REFUND-001/spec.md')
    const v2Manifest = buildSnapshotManifest(v2Parsed, {
      createdAt: '2026-11-20T08:00:00.000Z',
      createdBy: '张三',
      lint: { error: 0, warning: 0 }
    })
    const v3Manifest = buildSnapshotManifest(v3Parsed, {
      createdAt: '2026-11-21T08:40:00.000Z',
      createdBy: '张三',
      lint: { error: 0, warning: 0 }
    })

    const diff = diffSnapshots(
      { manifest: v2Manifest, markdown: v2Raw },
      { manifest: v3Manifest, markdown: v3Raw }
    )

    expect(diff.fromVersion).toBe(2)
    expect(diff.toVersion).toBe(3)
    expect(diff.added).toEqual([{ anchor: 'REQ-003', title: '[P1] 退款失败后重发' }])
    expect(diff.removed).toEqual([])
    expect(diff.modified).toHaveLength(1)
    expect(diff.modified[0]?.anchor).toBe('REQ-002')
    const lines = diff.modified[0]?.lines ?? []
    expect(lines.filter((l) => l.op === 'del')).toHaveLength(1)
    expect(lines.filter((l) => l.op === 'add')).toHaveLength(1)

    const reverseDiff = diffSnapshots(
      { manifest: v3Manifest, markdown: v3Raw },
      { manifest: v2Manifest, markdown: v2Raw }
    )
    expect(reverseDiff.removed).toEqual([{ anchor: 'REQ-003', title: '[P1] 退款失败后重发' }])
  })

  it('returns null line ops when either side exceeds 2000 lines', () => {
    const longText = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join('\n')
    expect(diffLines(longText, 'short')).toBeNull()
    expect(diffLines('short', longText)).toBeNull()

    const boundaryText = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const boundaryModified = boundaryText.replace('line 1999', 'line 1999 edited')
    const ops = diffLines(boundaryText, boundaryModified)
    expect(ops).not.toBeNull()
    expect(ops?.filter((o) => o.op === 'del')).toEqual([{ op: 'del', text: 'line 1999' }])
    expect(ops?.filter((o) => o.op === 'add')).toEqual([{ op: 'add', text: 'line 1999 edited' }])
  })
})
