import { existsSync, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { NormalizedFinding, RunRecord, WorkspaceConfig } from '../core/spec-types.ts'
import { readAndVerifyRunFindingsFile } from './evidence-verify.ts'
import { appendLocalMetric } from './local-metrics.ts'
import { compareRepoSnapshotsAfter } from './repo-taint-check.ts'
import { writeJsonAtomic } from './review-prompt.ts'
import { getSpecFilePaths } from './spec-workspace.ts'

export type ActiveRunHandle = {
  run: RunRecord
  workspacePath: string
  config: WorkspaceConfig
  metricsEnabled: boolean
  specLockKey: string
  watcher: FSWatcher | null
  pollTimer: ReturnType<typeof setInterval> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
  claimTimer: ReturnType<typeof setInterval> | null
  doneTimer: ReturnType<typeof setTimeout> | null
  stabilityTimer: ReturnType<typeof setTimeout> | null
  collecting: boolean
}

export type RunMonitorDeps = {
  orca: OrcaWorkerApi
  isAlive: (runId: string) => boolean
  persistAndPost: (h: ActiveRunHandle, findings?: readonly NormalizedFinding[]) => Promise<unknown>
  releaseAndPersist: (h: ActiveRunHandle, findings: readonly NormalizedFinding[]) => Promise<void>
  failTerminalRun: (
    h: ActiveRunHandle,
    status: 'failed' | 'timed_out',
    code: string,
    message: string
  ) => Promise<void>
}

export const runDirOf = (wsPath: string, runId: string): string =>
  join(wsPath, '.pmspec', 'runs', runId)

export function createActiveRunHandle(
  run: RunRecord,
  workspacePath: string,
  config: WorkspaceConfig,
  metricsEnabled: boolean
): ActiveRunHandle {
  return {
    run,
    workspacePath,
    config,
    metricsEnabled,
    specLockKey: `${workspacePath}::${run.specId}`,
    watcher: null,
    pollTimer: null,
    timeoutTimer: null,
    claimTimer: null,
    doneTimer: null,
    stabilityTimer: null,
    collecting: false
  }
}

export function clearRunTimers(h: ActiveRunHandle): void {
  h.watcher?.close()
  h.watcher = null
  if (h.pollTimer) {
    clearInterval(h.pollTimer)
  }
  if (h.claimTimer) {
    clearInterval(h.claimTimer)
  }
  if (h.timeoutTimer) {
    clearTimeout(h.timeoutTimer)
  }
  if (h.doneTimer) {
    clearTimeout(h.doneTimer)
  }
  if (h.stabilityTimer) {
    clearTimeout(h.stabilityTimer)
  }
  h.pollTimer = h.claimTimer = h.timeoutTimer = h.doneTimer = h.stabilityTimer = null
}

export async function collectAndFinalizeRun(
  h: ActiveRunHandle,
  deps: RunMonitorDeps
): Promise<void> {
  if (h.collecting || !deps.isAlive(h.run.runId)) {
    return
  }
  h.collecting = true
  h.run.status = 'collecting'
  await deps.persistAndPost(h)
  const dir = runDirOf(h.workspacePath, h.run.runId)
  const { specPath, relPosixPath } = getSpecFilePaths(h.workspacePath, h.config, h.run.specId)
  const verified = await readAndVerifyRunFindingsFile({
    findingsPath: join(dir, 'findings.json'),
    specPath,
    specRelPath: relPosixPath,
    runId: h.run.runId,
    specId: h.run.specId,
    workspacePath: h.workspacePath,
    config: h.config
  })
  const taintResult = await compareRepoSnapshotsAfter(h.run.repos)
  h.run.repos = taintResult.repos
  h.run.taint = taintResult.taint
  let findings: NormalizedFinding[] = []
  if (!verified.ok) {
    h.run.status = 'failed'
    h.run.error = { code: verified.code, message: verified.message, detail: verified.detail }
  } else {
    findings = verified.findings
    h.run.summary = verified.summary
    h.run.status = taintResult.taint.changed ? 'tainted' : 'succeeded'
    await writeJsonAtomic(join(dir, 'result.json'), {
      schemaVersion: 1,
      runId: h.run.runId,
      specId: h.run.specId,
      findings,
      summary: verified.summary
    })
  }
  h.run.finishedAt = new Date().toISOString()
  await deps.releaseAndPersist(h, findings)
  const ms = Math.max(0, Date.now() - (h.run.startedAt ? Date.parse(h.run.startedAt) : Date.now()))
  const s = h.run.summary
  deps.orca.log(
    `[pmspec] event=run.completed runId=${h.run.runId} status=${h.run.status} durationMs=${ms} findings=${s?.total ?? 0} verified=${s?.verified ?? 0} downgraded=${s?.downgraded ?? 0}`
  )
  await appendLocalMetric(
    h.workspacePath,
    {
      event: 'review.finished',
      specId: h.run.specId,
      runId: h.run.runId,
      status: h.run.status,
      total: s?.total ?? 0,
      verified: s?.verified ?? 0,
      downgraded: s?.downgraded ?? 0
    },
    h.metricsEnabled
  ).catch(() => undefined)
  void deps.orca.host
    .call('notifications.show', {
      title: `规格 ${h.run.specId} AI 预检完成`,
      body:
        h.run.status === 'tainted'
          ? `检测到代码仓改动（${h.run.taint.repos.join(', ')}）`
          : `状态：${h.run.status}`
    })
    .catch(() => undefined)
}

export function scheduleFindingsStability(
  h: ActiveRunHandle,
  findingsPath: string,
  delayMs: number,
  deps: RunMonitorDeps
): void {
  if (h.collecting || !deps.isAlive(h.run.runId)) {
    return
  }
  if (h.stabilityTimer) {
    clearTimeout(h.stabilityTimer)
  }
  const beforePromise = existsSync(findingsPath)
    ? stat(findingsPath)
        .then((s) => s.mtimeMs)
        .catch(() => null)
    : Promise.resolve(null)
  h.stabilityTimer = setTimeout(async () => {
    if (h.collecting || !deps.isAlive(h.run.runId)) {
      return
    }
    try {
      const [before, after] = await Promise.all([
        beforePromise,
        stat(findingsPath).then((s) => s.mtimeMs)
      ])
      if (before !== null && after !== before && delayMs > 0) {
        scheduleFindingsStability(h, findingsPath, 1500, deps)
        return
      }
      await collectAndFinalizeRun(h, deps)
    } catch {
      // File disappeared before collection.
    }
  }, delayMs)
  h.stabilityTimer.unref?.()
}

export function attachRunMonitors(
  h: ActiveRunHandle,
  timeoutMs: number,
  deps: RunMonitorDeps
): void {
  const dir = runDirOf(h.workspacePath, h.run.runId)
  const fPath = join(dir, 'findings.json')
  let lastMtime: number | null = null
  try {
    h.watcher = watch(dir, (_ev, name) => {
      if (name === 'findings.json') {
        scheduleFindingsStability(h, fPath, 1500, deps)
      }
    })
    h.watcher.on('error', () => {
      h.watcher?.close()
      h.watcher = null
    })
  } catch {
    h.watcher = null
  }
  h.pollTimer = setInterval(async () => {
    if (h.collecting || !deps.isAlive(h.run.runId) || !existsSync(fPath)) {
      return
    }
    const mtime = (await stat(fPath).catch(() => null))?.mtimeMs ?? null
    if (mtime === null) {
      return
    }
    scheduleFindingsStability(h, fPath, lastMtime !== null && mtime === lastMtime ? 0 : 1500, deps)
    lastMtime = mtime
  }, 3000)
  h.pollTimer.unref?.()
  h.timeoutTimer = setTimeout(
    () => {
      if (!h.collecting && deps.isAlive(h.run.runId)) {
        void deps.failTerminalRun(h, 'timed_out', 'E_TIMEOUT', '预检超时，可在终端查看智能体输出')
      }
    },
    Math.max(10, timeoutMs)
  )
  h.timeoutTimer.unref?.()
}
