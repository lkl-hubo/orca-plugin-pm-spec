import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export type LocalMetricPayload =
  | { event: 'spec.created'; specId: string }
  | { event: 'lint.run'; specId: string; error: number; warning: number }
  | { event: 'lint.clean'; specId: string }
  | { event: 'review.started'; specId: string; runId: string; agent: string }
  | {
      event: 'review.finished'
      specId: string
      runId: string
      status: string
      total: number
      verified: number
      downgraded: number
    }
  | {
      event: 'finding.decided'
      specId: string
      runId: string
      findingId: string
      decision: 'accepted' | 'rejected' | null
    }
  | { event: 'snapshot.created'; specId: string; version: number; reused: boolean }
  | { event: 'review.published'; specId: string; version: number; slug: string }
  | {
      event: 'comment.resolved'
      specId: string
      slug: string
      commentId: string
      status: 'open' | 'resolved' | 'wont_fix'
      kind: 'issue' | 'suggestion' | 'question'
    }
  | { event: 'spec.approved'; specId: string; slug: string }

export async function appendLocalMetric(
  workspacePath: string,
  payload: LocalMetricPayload,
  enabled: boolean
): Promise<void> {
  if (!enabled) {
    return
  }
  const pmspecDir = join(workspacePath, '.pmspec')
  await mkdir(pmspecDir, { recursive: true })
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`
  await appendFile(join(pmspecDir, 'metrics.jsonl'), line, 'utf8')
}
