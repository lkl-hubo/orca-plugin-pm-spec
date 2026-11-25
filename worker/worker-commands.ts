import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceConfig } from '../core/spec-types.ts'
import type { GatewayClient } from './gateway-client.ts'
import type { ReviewRunManager } from './review-runs.ts'
import { findOpenReviewSummary, publishSpecReview, syncReviewBySlug } from './review-sync.ts'
import { writeSpecSnapshot } from './snapshot-store.ts'
import {
  createSpecFile,
  loadAndLintSpec,
  requireLocalWorkspace,
  resolveCurrentSpecId
} from './spec-workspace.ts'

export function registerWorkerCommands(
  orca: OrcaWorkerApi,
  deps: {
    gateway: GatewayClient
    runs: ReviewRunManager
    metricsOn: () => Promise<boolean>
    runAndBroadcastLint: (
      wsId: string,
      wsPath: string,
      config: WorkspaceConfig,
      specId: string
    ) => Promise<{ cached: { counts: { error: number; warning: number } } }>
  }
): void {
  const { gateway, runs, metricsOn, runAndBroadcastLint } = deps
  const withCur = async (
    fn: (
      ws: { id: string; name: string; path: string },
      config: WorkspaceConfig,
      specId: string
    ) => Promise<string>
  ) => {
    const { workspace, config } = await requireLocalWorkspace(orca)
    const specId = await resolveCurrentSpecId(orca, workspace.id, workspace.path, config)
    return fn(workspace, config, specId)
  }

  orca.commands.register('pmspec.openHub', async () => {
    await orca.host.call('commands.run', { action: 'sidebar.right.toggle' }).catch(() => undefined)
    return '请在右侧栏打开「需求中心」面板'
  })

  orca.commands.register('pmspec.newSpec', async (args) => {
    const { workspace, config } = await requireLocalWorkspace(orca)
    if (
      typeof args === 'object' &&
      args !== null &&
      'specId' in args &&
      'title' in args &&
      typeof args.specId === 'string' &&
      typeof args.title === 'string'
    ) {
      const created = await createSpecFile(workspace.path, config, {
        specId: args.specId,
        title: args.title
      })
      return `已创建规格 ${created.specId}`
    }
    await orca.host.call('commands.run', { action: 'sidebar.right.toggle' }).catch(() => undefined)
    return '请在需求中心面板填写 ID 与标题创建规格'
  })

  orca.commands.register('pmspec.lintCurrent', () =>
    withCur(async (ws, config, specId) => {
      const { cached } = await runAndBroadcastLint(ws.id, ws.path, config, specId)
      return `${specId} · ${cached.counts.error} 错误 · ${cached.counts.warning} 警告`
    })
  )

  orca.commands.register('pmspec.reviewCurrent', () =>
    withCur(async (ws, config, specId) => {
      const started = await runs.startReview({
        workspace: ws,
        config,
        specId,
        metricsEnabled: await metricsOn()
      })
      return `已启动预检 ${started.runId}`
    })
  )

  orca.commands.register('pmspec.snapshotCurrent', () =>
    withCur(async (ws, config, specId) => {
      const loaded = await loadAndLintSpec(ws.path, config, specId, 'publish')
      const snap = await writeSpecSnapshot(ws.path, loaded.parsed, loaded.rawBytes, {
        lint: loaded.report.counts
      })
      return `快照 v${snap.version} ${snap.reused ? '已复用' : '已保存'}`
    })
  )

  orca.commands.register('pmspec.publishCurrent', () =>
    withCur(async (ws, config, specId) => {
      const loaded = await loadAndLintSpec(ws.path, config, specId, 'publish')
      const view = await publishSpecReview({
        orca,
        gateway,
        wsPath: ws.path,
        config,
        specId,
        version: loaded.parsed.frontmatter?.version ?? 1,
        metricsEnabled: await metricsOn()
      })
      return view.reviewUrl
    })
  )

  orca.commands.register('pmspec.syncReviews', () =>
    withCur(async (ws, _config, specId) => {
      const open = await findOpenReviewSummary(ws.path, specId)
      if (!open) {
        return `${specId} 没有进行中的评审`
      }
      const synced = await syncReviewBySlug(orca, gateway, ws.path, open.slug)
      return `已同步 ${open.slug}（${synced.comments.length} 条意见）`
    })
  )
}
