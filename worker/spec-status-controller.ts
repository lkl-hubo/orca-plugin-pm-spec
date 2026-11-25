import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { RunView, SpecSummary } from '../src/protocol.ts'
import type { WorkspaceConfig } from '../core/spec-types.ts'
import { appendLocalMetric } from './local-metrics.ts'
import { findOpenReviewSummary } from './review-cache.ts'
import { listRunsForSpec } from './review-prompt.ts'
import {
  loadAndLintSpec,
  resolveActiveWorkspace,
  scanWorkspaceSpecEntries,
  toLintIssueView
} from './spec-workspace.ts'

export function watchWorkspaceSpecs(
  workspacePath: string,
  config: WorkspaceConfig,
  onSpecChanged: (specId: string) => void
): () => void {
  const root = join(workspacePath, config.specsDir)
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastMtimes = new Map<string, number>()
  const trigger = (specId: string): void => {
    const prev = timers.get(specId)
    if (prev) {
      clearTimeout(prev)
    }
    timers.set(
      specId,
      setTimeout(() => {
        timers.delete(specId)
        onSpecChanged(specId)
      }, 800)
    )
  }
  const startPolling = (): void => {
    if (pollTimer) {
      return
    }
    pollTimer = setInterval(async () => {
      for (const entry of await scanWorkspaceSpecEntries(workspacePath, config).catch(() => [])) {
        const prev = lastMtimes.get(entry.specId)
        lastMtimes.set(entry.specId, entry.mtimeMs)
        if (prev !== undefined && prev !== entry.mtimeMs) {
          trigger(entry.specId)
        }
      }
    }, 3000)
    pollTimer.unref?.()
  }
  if (existsSync(root)) {
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        const parts = filename ? filename.replaceAll('\\', '/').split('/') : []
        if (parts.length === 2 && parts[1] === 'spec.md' && parts[0]) {
          trigger(parts[0].normalize('NFC'))
        }
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        startPolling()
      })
    } catch {
      startPolling()
    }
  }
  return () => {
    watcher?.close()
    if (pollTimer) {
      clearInterval(pollTimer)
    }
    timers.forEach((t) => clearTimeout(t))
    timers.clear()
  }
}

export function buildSpecSummary(
  loaded: Awaited<ReturnType<typeof loadAndLintSpec>>,
  specIdFallback: string,
  latestRun: RunView | undefined,
  openReview: SpecSummary['openReview']
): SpecSummary {
  return {
    specId: loaded.parsed.frontmatter?.id || specIdFallback,
    title: loaded.parsed.frontmatter?.title || specIdFallback,
    status: loaded.parsed.frontmatter?.status ?? 'draft',
    version: loaded.parsed.frontmatter?.version ?? 1,
    path: loaded.relPosixPath,
    lint: loaded.report.counts,
    lastRun: latestRun
      ? { runId: latestRun.runId, status: latestRun.status, finishedAt: latestRun.finishedAt }
      : null,
    openReview
  }
}

export function createSpecStatusController(orca: OrcaWorkerApi, metricsOn: () => Promise<boolean>) {
  let stopWatcher: (() => void) | null = null
  let watchedWsPath: string | null = null

  const updateStatusBar = async (specId?: string, counts?: { error: number; warning: number }) => {
    const tone = !counts
      ? ('neutral' as const)
      : counts.error > 0
        ? ('danger' as const)
        : counts.warning > 0
          ? ('warning' as const)
          : ('neutral' as const)
    await orca.host
      .call('statusBar.update', {
        id: 'pmspec-status',
        text:
          specId && counts
            ? `${specId} · ${counts.error} 错误 · ${counts.warning} 警告`
            : '需求中心',
        tone,
        tooltip: specId ? `打开需求中心：${specId}` : '打开需求中心'
      })
      .catch(() => undefined)
  }

  const cacheLint = async (
    wsId: string,
    loaded: Awaited<ReturnType<typeof loadAndLintSpec>>,
    specId: string
  ) => {
    const cached = {
      sha256: loaded.parsed.rawSha256,
      counts: loaded.report.counts,
      issues: loaded.report.issues.map(toLintIssueView),
      durationMs: loaded.report.durationMs
    }
    await orca.storage.set(`lint:${wsId}:${specId}`, cached)
    return cached
  }

  const runAndBroadcastLint = async (
    wsId: string,
    wsPath: string,
    config: WorkspaceConfig,
    specId: string
  ) => {
    const loaded = await loadAndLintSpec(wsPath, config, specId, 'edit')
    const cached = await cacheLint(wsId, loaded, specId)
    orca.panels.post('pmspec.lint.updated', { specId, ...loaded.report.counts })
    await updateStatusBar(specId, loaded.report.counts)
    const on = await metricsOn()
    await appendLocalMetric(
      wsPath,
      { event: 'lint.run', specId, ...loaded.report.counts },
      on
    ).catch(() => undefined)
    if (loaded.report.counts.error === 0) {
      await appendLocalMetric(wsPath, { event: 'lint.clean', specId }, on).catch(() => undefined)
    }
    return { loaded, cached }
  }

  const refreshWatcher = async () => {
    const resolved = await resolveActiveWorkspace(orca).catch(() => null)
    if (!resolved?.ok) {
      stopWatcher?.()
      stopWatcher = null
      watchedWsPath = null
      await updateStatusBar()
      return
    }
    if (watchedWsPath !== resolved.workspace.path) {
      stopWatcher?.()
      watchedWsPath = resolved.workspace.path
      stopWatcher = watchWorkspaceSpecs(resolved.workspace.path, resolved.config, (specId) => {
        void runAndBroadcastLint(
          resolved.workspace.id,
          resolved.workspace.path,
          resolved.config,
          specId
        ).catch(() => undefined)
      })
    }
    const selected = await orca.storage.get(`selectedSpec:${resolved.workspace.id}`)
    const cached =
      typeof selected === 'string'
        ? await orca.storage.get(`lint:${resolved.workspace.id}:${selected}`)
        : null
    if (
      typeof selected === 'string' &&
      cached &&
      typeof cached === 'object' &&
      'counts' in cached &&
      cached.counts &&
      typeof cached.counts === 'object' &&
      'error' in cached.counts &&
      'warning' in cached.counts &&
      typeof cached.counts.error === 'number' &&
      typeof cached.counts.warning === 'number'
    ) {
      await updateStatusBar(selected, {
        error: cached.counts.error,
        warning: cached.counts.warning
      })
    }
  }

  const dispose = () => {
    stopWatcher?.()
    stopWatcher = null
    watchedWsPath = null
  }

  const listSpecs = async () => {
    const resolved = await resolveActiveWorkspace(orca)
    if (!resolved.ok) {
      const emptySpecs: SpecSummary[] = []
      return {
        workspace: resolved.workspace,
        unsupportedReason: resolved.unsupportedReason,
        configErrors: resolved.configErrors,
        specs: emptySpecs
      }
    }
    await refreshWatcher()
    const specs: SpecSummary[] = []
    for (const entry of await scanWorkspaceSpecEntries(resolved.workspace.path, resolved.config)) {
      const loaded = await loadAndLintSpec(
        resolved.workspace.path,
        resolved.config,
        entry.specId,
        'edit'
      )
      await cacheLint(resolved.workspace.id, loaded, entry.specId)
      const [latestRun] = await listRunsForSpec(resolved.workspace.path, entry.specId)
      specs.push(
        buildSpecSummary(
          loaded,
          entry.specId,
          latestRun,
          await findOpenReviewSummary(resolved.workspace.path, entry.specId)
        )
      )
    }
    return { workspace: resolved.workspace, unsupportedReason: null, configErrors: [], specs }
  }

  return { cacheLint, runAndBroadcastLint, refreshWatcher, listSpecs, dispose }
}
