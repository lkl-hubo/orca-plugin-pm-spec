import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceConfig } from '../core/spec-types.ts'
import { bumpSpecVersionOnDisk } from './frontmatter-write.ts'
import { GatewayClient } from './gateway-client.ts'
import { appendLocalMetric } from './local-metrics.ts'
import { ReviewRunManager } from './review-runs.ts'
import {
  closeReviewBySlug,
  listReviewsForSpec,
  markSpecApproved,
  publishSpecReview,
  resolveReviewComment,
  rotateReviewKeyBySlug,
  syncOpenWorkspaceReviews,
  syncReviewBySlug
} from './review-sync.ts'
import { diffSpecSnapshotVersions, listSpecSnapshots, writeSpecSnapshot } from './snapshot-store.ts'
import { buildSpecSummary, createSpecStatusController } from './spec-status-controller.ts'
import {
  assertLintCleanForPublish,
  createSpecFile,
  getSpecFilePaths,
  initSpecWorkspace,
  loadAndLintSpec,
  requireLocalWorkspace,
  resolveActiveWorkspace
} from './spec-workspace.ts'
import { registerWorkerCommands } from './worker-commands.ts'

let activeManager: ReviewRunManager | null = null
let disposeStatusCtrl: (() => void) | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null

export function deactivate(): void {
  disposeStatusCtrl?.()
  disposeStatusCtrl = null
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  activeManager?.dispose()
  activeManager = null
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const gateway = new GatewayClient(orca)
  const runs = new ReviewRunManager(orca)
  activeManager = runs
  let lastPanelRequestAt = 0

  const metricsOn = async () => (await orca.settings.get('collectLocalMetrics')) !== false
  const statusCtrl = createSpecStatusController(orca, metricsOn)
  disposeStatusCtrl = statusCtrl.dispose

  const withWs = async <T>(
    fn: (ws: { id: string; name: string; path: string }, config: WorkspaceConfig) => Promise<T>
  ) => {
    lastPanelRequestAt = Date.now()
    const { workspace, config } = await requireLocalWorkspace(orca)
    return fn(workspace, config)
  }

  orca.panels.handle('workspace.init', async () => {
    lastPanelRequestAt = Date.now()
    const res = await initSpecWorkspace(orca)
    await statusCtrl.refreshWatcher()
    return res
  })

  orca.panels.handle('spec.list', async () => {
    lastPanelRequestAt = Date.now()
    return statusCtrl.listSpecs()
  })

  orca.panels.handle('spec.create', ({ specId, title }) =>
    withWs(async (ws, config) => {
      const created = await createSpecFile(ws.path, config, { specId, title })
      await appendLocalMetric(
        ws.path,
        { event: 'spec.created', specId: created.specId },
        await metricsOn()
      )
      await statusCtrl.runAndBroadcastLint(ws.id, ws.path, config, created.specId)
      await orca.storage.set(`selectedSpec:${ws.id}`, created.specId)
      await orca.host
        .call('editor.open', { workspaceId: ws.id, path: created.path })
        .catch(() => undefined)
      return created
    })
  )

  orca.panels.handle('spec.select', ({ specId }) =>
    withWs(async (ws, config) => {
      await orca.storage.set(`selectedSpec:${ws.id}`, specId)
      await statusCtrl.runAndBroadcastLint(ws.id, ws.path, config, specId).catch(() => undefined)
      return { specId }
    })
  )

  orca.panels.handle('spec.detail', ({ specId }) =>
    withWs(async (ws, config) => {
      await orca.storage.set(`selectedSpec:${ws.id}`, specId)
      const { loaded, cached } = await statusCtrl.runAndBroadcastLint(
        ws.id,
        ws.path,
        config,
        specId
      )
      const [snapshots, specRuns, reviews] = await Promise.all([
        listSpecSnapshots(ws.path, specId),
        runs.listRunsForSpec(ws.path, specId),
        listReviewsForSpec(orca, gateway, ws.path, specId, loaded.parsed.rawSha256)
      ])
      const openRev = reviews.find((r) => r.status === 'open')
      const openReview = openRev
        ? {
            slug: openRev.slug,
            openIssues: openRev.comments.filter((c) => c.kind === 'issue' && c.status === 'open')
              .length,
            expiresAt: openRev.expiresAt
          }
        : null
      return {
        summary: buildSpecSummary(loaded, specId, specRuns[0], openReview),
        lint: { issues: cached.issues, durationMs: cached.durationMs },
        snapshots: snapshots.map((s) => ({
          version: s.version,
          sha256: s.sha256,
          createdAt: s.createdAt
        })),
        currentSha256: loaded.parsed.rawSha256,
        runs: specRuns,
        reviews
      }
    })
  )

  orca.panels.handle('spec.lint', ({ specId }) =>
    withWs(async (ws, config) => {
      const { cached } = await statusCtrl.runAndBroadcastLint(ws.id, ws.path, config, specId)
      return { issues: cached.issues, ...cached.counts, durationMs: cached.durationMs }
    })
  )

  orca.panels.handle('spec.open', ({ specId }) =>
    withWs(async (ws, config) => {
      await orca.host.call('editor.open', {
        workspaceId: ws.id,
        path: getSpecFilePaths(ws.path, config, specId).relPosixPath
      })
      return { opened: true }
    })
  )

  orca.panels.handle('spec.snapshot', ({ specId }) =>
    withWs(async (ws, config) => {
      const loaded = await loadAndLintSpec(ws.path, config, specId, 'publish')
      assertLintCleanForPublish(loaded.report, '保存快照')
      const res = await writeSpecSnapshot(ws.path, loaded.parsed, loaded.rawBytes, {
        lint: loaded.report.counts
      })
      await appendLocalMetric(
        ws.path,
        { event: 'snapshot.created', specId, version: res.version, reused: res.reused },
        await metricsOn()
      )
      return { version: res.version, sha256: res.sha256, reused: res.reused }
    })
  )

  orca.panels.handle('spec.bumpVersion', ({ specId }) =>
    withWs(async (ws, config) => {
      const loaded = await loadAndLintSpec(ws.path, config, specId, 'edit')
      if (!loaded.parsed.frontmatter) {
        throw new Error('E_LINT_ERRORS: 缺少有效头信息，无法递增版本号')
      }
      return bumpSpecVersionOnDisk(
        loaded.specPath,
        loaded.parsed.rawSha256,
        loaded.parsed.frontmatter.version
      )
    })
  )

  orca.panels.handle('spec.diff', ({ specId, fromVersion, toVersion }) =>
    withWs((ws) => diffSpecSnapshotVersions(ws.path, specId, fromVersion, toVersion))
  )
  orca.panels.handle('review.start', ({ specId }) =>
    withWs(async (ws, config) =>
      runs.startReview({ workspace: ws, config, specId, metricsEnabled: await metricsOn() })
    )
  )
  orca.panels.handle('review.cancel', ({ runId }) => withWs((ws) => runs.cancelRun(ws.path, runId)))
  orca.panels.handle('review.decide', ({ runId, findingId, decision }) =>
    withWs(async (ws) => runs.decideFinding(ws.path, runId, findingId, decision, await metricsOn()))
  )
  orca.panels.handle('review.publish', ({ specId, version }) =>
    withWs(async (ws, config) =>
      publishSpecReview({
        orca,
        gateway,
        wsPath: ws.path,
        config,
        specId,
        version,
        metricsEnabled: await metricsOn()
      })
    )
  )
  orca.panels.handle('review.sync', ({ slug }) =>
    withWs((ws) => syncReviewBySlug(orca, gateway, ws.path, slug))
  )
  orca.panels.handle('review.resolveComment', ({ slug, commentId, status, note }) =>
    withWs(async (ws) =>
      resolveReviewComment({
        orca,
        gateway,
        wsPath: ws.path,
        slug,
        commentId,
        status,
        note,
        metricsEnabled: await metricsOn()
      })
    )
  )
  orca.panels.handle('review.close', ({ slug }) =>
    withWs((ws) => closeReviewBySlug(orca, gateway, ws.path, slug))
  )
  orca.panels.handle('review.rotateKey', ({ slug }) =>
    withWs(() => rotateReviewKeyBySlug(orca, gateway, slug))
  )
  orca.panels.handle('review.markApproved', ({ specId, slug }) =>
    withWs(async (ws, config) =>
      markSpecApproved({
        orca,
        gateway,
        wsPath: ws.path,
        config,
        specId,
        slug,
        metricsEnabled: await metricsOn()
      })
    )
  )
  orca.panels.handle('gateway.status', () => {
    lastPanelRequestAt = Date.now()
    return gateway.getStatus()
  })
  orca.panels.handle('gateway.saveToken', ({ token }) => {
    lastPanelRequestAt = Date.now()
    return gateway.saveToken(token)
  })
  orca.panels.handle('gateway.clearOverride', () => {
    lastPanelRequestAt = Date.now()
    return gateway.clearOverride()
  })
  orca.panels.handle('gateway.test', () => {
    lastPanelRequestAt = Date.now()
    return gateway.testConnection()
  })

  registerWorkerCommands(orca, {
    gateway,
    runs,
    metricsOn,
    runAndBroadcastLint: statusCtrl.runAndBroadcastLint
  })

  orca.events.on('agent.status.changed', (event) => runs.handleAgentStatusChanged(event))
  orca.events.on('workspace.changed', async ({ context }) => {
    orca.panels.post('pmspec.workspace.changed', { workspaceId: context?.workspaceId ?? null })
    await statusCtrl.refreshWatcher().catch(() => undefined)
  })
  orca.hooks.on('agent.launch.before', (event, next) => runs.handleLaunchBefore(event, next))
  orca.hooks.on('agent.tool.before', (event) => runs.handleToolBefore(event))

  await runs.recoverOnActivate()
  const syncSec = Math.min(
    600,
    Math.max(30, Number((await orca.settings.get('commentSyncSeconds')) ?? 60))
  )
  syncTimer = setInterval(async () => {
    if (Date.now() - lastPanelRequestAt > 5 * 60_000) {
      return
    }
    const resolved = await resolveActiveWorkspace(orca).catch(() => null)
    if (resolved?.ok) {
      await syncOpenWorkspaceReviews(orca, gateway, resolved.workspace.path, resolved.config)
    }
  }, syncSec * 1000)
  syncTimer.unref?.()
}
