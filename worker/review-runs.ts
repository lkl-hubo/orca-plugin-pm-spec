import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcaWorkerApi, PluginEvents, PluginHooks } from 'orca/worker'
import type { RunView } from '../src/protocol.ts'
import type { NormalizedFinding, WorkspaceConfig } from '../core/spec-types.ts'
import { appendLocalMetric } from './local-metrics.ts'
import {
  buildAgentLaunchPrompt,
  cancelStoredRun,
  decideRunFinding,
  listRunsForSpec,
  prepareRunWorkspace,
  scanRunRecords,
  toRunView,
  writeJsonAtomic
} from './review-prompt.ts'
import {
  type ActiveRunHandle,
  attachRunMonitors,
  clearRunTimers,
  collectAndFinalizeRun,
  createActiveRunHandle,
  runDirOf,
  type RunMonitorDeps,
  scheduleFindingsStability
} from './run-collection.ts'
import { loadAndLintSpec, resolveActiveWorkspace } from './spec-workspace.ts'
import {
  applyPendingPiLaunch,
  buildPendingPiLaunch,
  evaluateToolGuard,
  matchPendingPiLaunch,
  startGuardClaimCheck,
  type ActiveReviewTerminal,
  type PendingPiLaunch,
  type ToolViolationRecord
} from './tool-guard.ts'

export class ReviewRunManager {
  private readonly orca: OrcaWorkerApi
  private readonly activeRuns = new Map<string, ActiveRunHandle>()
  private readonly specLocks = new Set<string>()
  private readonly activeTerminals = new Map<string, ActiveReviewTerminal>()
  private pendingPiLaunch: PendingPiLaunch | null = null
  private disposed = false

  constructor(orca: OrcaWorkerApi) {
    this.orca = orca
  }

  private monitorDeps(): RunMonitorDeps {
    return {
      orca: this.orca,
      isAlive: (runId) => !this.disposed && this.activeRuns.has(runId),
      persistAndPost: (h, findings = []) => this.persistAndPost(h, findings),
      releaseAndPersist: async (h, findings) => {
        this.releaseRun(h)
        await this.persistAndPost(h, findings)
      },
      failTerminalRun: (h, status, code, message) => this.failTerminalRun(h, status, code, message)
    }
  }

  private releaseRun(h: ActiveRunHandle): void {
    clearRunTimers(h)
    this.activeRuns.delete(h.run.runId)
    this.specLocks.delete(h.specLockKey)
    if (h.run.terminalId) {
      this.activeTerminals.delete(h.run.terminalId)
    }
  }

  private async persistAndPost(
    h: ActiveRunHandle,
    findings: readonly NormalizedFinding[] = []
  ): Promise<RunView> {
    await writeJsonAtomic(join(runDirOf(h.workspacePath, h.run.runId), 'run.json'), h.run)
    const view = toRunView(h.run, findings)
    this.orca.panels.post('pmspec.run.updated', view)
    return view
  }

  handleLaunchBefore(
    event: PluginHooks['agent.launch.before']['event'],
    next: (
      e?: PluginHooks['agent.launch.before']['event']
    ) => ReturnType<Parameters<OrcaWorkerApi['hooks']['on']>[1]>
  ) {
    if (!matchPendingPiLaunch(event, this.pendingPiLaunch)) {
      return undefined
    }
    const launch = this.pendingPiLaunch!
    this.pendingPiLaunch = null
    return applyPendingPiLaunch(event, launch, next)
  }

  handleToolBefore(event: PluginHooks['agent.tool.before']['event']) {
    return evaluateToolGuard(event, this.activeTerminals, (runId, v: ToolViolationRecord) => {
      const h = this.activeRuns.get(runId)
      if (!h) {
        return
      }
      h.run.toolViolations.push(v)
      void writeJsonAtomic(join(runDirOf(h.workspacePath, runId), 'run.json'), h.run).catch(
        () => undefined
      )
    })
  }

  async handleAgentStatusChanged(event: PluginEvents['agent.status.changed']): Promise<void> {
    if (this.disposed || event.state !== 'done' || !event.terminalId) {
      return
    }
    const h = [...this.activeRuns.values()].find((x) => x.run.terminalId === event.terminalId)
    if (!h || h.collecting) {
      return
    }
    const findingsPath = join(runDirOf(h.workspacePath, h.run.runId), 'findings.json')
    if (existsSync(findingsPath)) {
      scheduleFindingsStability(h, findingsPath, 0, this.monitorDeps())
      return
    }
    if (!h.doneTimer) {
      h.doneTimer = setTimeout(() => {
        if (this.disposed || !this.activeRuns.has(h.run.runId) || h.collecting) {
          return
        }
        if (existsSync(findingsPath)) {
          scheduleFindingsStability(h, findingsPath, 0, this.monitorDeps())
        } else {
          void this.failTerminalRun(h, 'failed', 'E_NO_FINDINGS', '智能体未产出结果文件')
        }
      }, 60_000)
      h.doneTimer.unref?.()
    }
  }

  private async failTerminalRun(
    h: ActiveRunHandle,
    status: 'failed' | 'timed_out',
    code: string,
    message: string
  ) {
    h.run.status = status
    h.run.finishedAt = new Date().toISOString()
    h.run.error = { code, message }
    this.releaseRun(h)
    await this.persistAndPost(h)
  }

  async startReview(params: {
    workspace: { id: string; path: string }
    config: WorkspaceConfig
    specId: string
    metricsEnabled: boolean
  }): Promise<RunView> {
    const { workspace, config, specId, metricsEnabled } = params
    const loaded = await loadAndLintSpec(workspace.path, config, specId, 'edit')
    if (loaded.report.counts.error > 0) {
      throw new Error(
        `E_LINT_ERRORS: 当前规格有 ${loaded.report.counts.error} 个错误，修复后才能发起预检`
      )
    }
    const lockKey = `${workspace.path}::${specId}`
    if (this.specLocks.has(lockKey)) {
      throw new Error('E_REVIEW_BUSY: 该规格已有进行中的预检')
    }
    const maxConcurrent = Math.min(
      3,
      Math.max(1, Number((await this.orca.settings.get('maxConcurrentReviews')) ?? 2))
    )
    if (this.activeRuns.size >= maxConcurrent) {
      throw new Error(`E_REVIEW_LIMIT: 已有 ${this.activeRuns.size} 个预检在运行`)
    }
    const agent = String((await this.orca.settings.get('reviewAgent')) ?? 'pi')
    const timeoutMin = Number((await this.orca.settings.get('reviewTimeoutMinutes')) ?? 15)
    const { runId, dir, run, codegraphRepos } = await prepareRunWorkspace({
      workspacePath: workspace.path,
      specId,
      relPosixPath: loaded.relPosixPath,
      parsed: loaded.parsed,
      codeRepos: config.codeRepos,
      agent
    })
    const h = createActiveRunHandle(run, workspace.path, config, metricsEnabled)
    this.specLocks.add(lockKey)
    this.activeRuns.set(runId, h)
    if (agent === 'pi') {
      this.pendingPiLaunch = await buildPendingPiLaunch(this.orca, {
        runId,
        specId,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        runDirAbsolute: dir,
        codegraphRepos
      })
    }
    let terminalId: string
    try {
      terminalId = (
        await this.orca.host.call('agent.launch', {
          workspaceId: workspace.id,
          agent,
          prompt: buildAgentLaunchPrompt(runId)
        })
      ).terminalId
    } catch (error) {
      this.pendingPiLaunch = null
      const msg = error instanceof Error ? error.message : String(error)
      await this.failTerminalRun(
        h,
        'failed',
        'E_AGENT_UNAVAILABLE',
        `智能体 ${agent} 无法启动：${msg}`
      )
      throw new Error(`E_AGENT_UNAVAILABLE: 智能体 ${agent} 无法启动：${msg}`)
    }
    const nowMs = Date.now()
    const timeoutMs = (Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin : 15) * 60_000
    run.status = 'running'
    run.terminalId = terminalId
    run.startedAt = new Date(nowMs).toISOString()
    run.timeoutAt = new Date(nowMs + timeoutMs).toISOString()
    this.registerActiveTerminal(h, dir, terminalId)
    attachRunMonitors(h, timeoutMs, this.monitorDeps())
    if (agent === 'pi' && run.guard !== 'enforced') {
      h.claimTimer = startGuardClaimCheck(
        dir,
        (guard) => {
          if (h.run.guard !== guard || guard === 'unguarded') {
            h.run.guard = guard
            void this.persistAndPost(h)
          }
        },
        () => !this.disposed && this.activeRuns.has(runId)
      )
    }
    await appendLocalMetric(
      workspace.path,
      { event: 'review.started', specId, runId, agent },
      metricsEnabled
    )
    return this.persistAndPost(h)
  }

  private registerActiveTerminal(h: ActiveRunHandle, dir: string, terminalId: string | null): void {
    if (terminalId) {
      this.activeTerminals.set(terminalId, {
        runId: h.run.runId,
        runDir: dir,
        workspacePath: h.workspacePath,
        agent: h.run.agent
      })
    }
    if (h.run.agent === 'pi' && existsSync(join(dir, 'guard-claim.json'))) {
      h.run.guard = 'enforced'
    }
  }

  async cancelRun(workspacePath: string, runId: string): Promise<RunView> {
    const h = this.activeRuns.get(runId)
    if (h) {
      h.run.status = 'cancelled'
      h.run.finishedAt = new Date().toISOString()
      this.releaseRun(h)
      return this.persistAndPost(h)
    }
    const view = await cancelStoredRun(workspacePath, runId)
    this.orca.panels.post('pmspec.run.updated', view)
    return view
  }

  decideFinding = decideRunFinding
  listRunsForSpec = listRunsForSpec

  async recoverOnActivate(): Promise<void> {
    const resolved = await resolveActiveWorkspace(this.orca).catch(() => null)
    if (!resolved?.ok) {
      return
    }
    const metricsEnabled = (await this.orca.settings.get('collectLocalMetrics')) !== false
    for (const { dir, run } of await scanRunRecords(resolved.workspace.path)) {
      if (run.status !== 'running' && run.status !== 'collecting') {
        continue
      }
      const h = createActiveRunHandle(run, resolved.workspace.path, resolved.config, metricsEnabled)
      this.specLocks.add(h.specLockKey)
      this.activeRuns.set(run.runId, h)
      this.registerActiveTerminal(h, dir, run.terminalId)
      if (existsSync(join(dir, 'findings.json'))) {
        await collectAndFinalizeRun(h, this.monitorDeps())
        continue
      }
      const remainingMs = run.timeoutAt ? Date.parse(run.timeoutAt) - Date.now() : 60_000
      if (remainingMs <= 0) {
        await this.failTerminalRun(h, 'timed_out', 'E_TIMEOUT', '预检超时，可在终端查看智能体输出')
      } else {
        attachRunMonitors(h, remainingMs, this.monitorDeps())
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.pendingPiLaunch = null
    for (const h of this.activeRuns.values()) {
      clearRunTimers(h)
    }
    this.activeRuns.clear()
    this.specLocks.clear()
    this.activeTerminals.clear()
  }
}
