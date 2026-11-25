import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { OrcaWorkerApi, PluginHooks } from 'orca/worker'

export type ActiveReviewTerminal = {
  runId: string
  runDir: string
  workspacePath: string
  agent: string
}

export type ToolViolationRecord = {
  tool: string
  detail: string
  at: string
}

export type PendingPiLaunch = {
  runId: string
  specId: string
  workspaceId: string
  workspaceKind: 'folder' | 'worktree'
  workspacePath: string
  runDirAbsolute: string
  tools: string[]
  codegraphRepos: { key: string; path: string }[]
  expiresAt: number
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const BASH_MODIFY_RE =
  /(^|[;&|]\s*)(git\s+(commit|push|reset|checkout|switch|stash|clean|rebase|merge|am|apply)\b|rm\s|mv\s|cp\s|chmod\s|chown\s|sed\s+-i|perl\s+-i|tee\s|npm\s+(i|install)|pnpm\s+(i|install|add)|yarn\s+add|pip\s+install)/

const BASH_REDIRECT_RE = /(^|[^0-9&])>{1,2}\s*(?!\/dev\/null)(\S+)/g

function isPathInsideDir(targetPath: string, dirPath: string): boolean {
  const rel = relative(resolve(dirPath), resolve(targetPath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function resolveAgainstWorkspace(rawPath: string, workspacePath: string): string {
  const unquoted = rawPath.replace(/^['"]|['"]$/g, '')
  return isAbsolute(unquoted) ? resolve(unquoted) : resolve(workspacePath, unquoted)
}

function normalizeForMatch(fsPath: string): string {
  const resolved = resolve(fsPath).replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function matchPendingPiLaunch(
  event: PluginHooks['agent.launch.before']['event'],
  pending: PendingPiLaunch | null,
  nowMs = Date.now()
): boolean {
  if (event.agent !== 'pi' || pending === null || nowMs > pending.expiresAt) {
    return false
  }
  if (pending.workspaceKind === 'folder') {
    return event.workspaceKind === 'folder' && event.workspaceId === pending.workspaceId
  }
  if (event.workspaceKind !== 'worktree') {
    return false
  }
  if (typeof event.workspaceId === 'string' && event.workspaceId.includes('::')) {
    const trailing = event.workspaceId.slice(event.workspaceId.indexOf('::') + 2)
    return normalizeForMatch(trailing) === normalizeForMatch(pending.workspacePath)
  }
  return true
}

export function applyPendingPiLaunch(
  event: PluginHooks['agent.launch.before']['event'],
  launch: PendingPiLaunch,
  next: (
    e?: PluginHooks['agent.launch.before']['event']
  ) => ReturnType<Parameters<OrcaWorkerApi['hooks']['on']>[1]>
) {
  const extraFlags = `--tools ${launch.tools.join(',')} --extension .pmspec/runs/${launch.runId}/ext/pi/pmspec-review-guard.ts`
  const sepIdx = event.command.indexOf(' -- ')
  const command =
    sepIdx === -1
      ? `${event.command} ${extraFlags}`
      : `${event.command.slice(0, sepIdx)} ${extraFlags}${event.command.slice(sepIdx)}`
  return next({
    ...event,
    command,
    env: {
      ...event.env,
      PMSPEC_RUN_ID: launch.runId,
      PMSPEC_RUN_DIR: launch.runDirAbsolute,
      PMSPEC_SPEC_ID: launch.specId,
      PMSPEC_CODEGRAPH_REPOS: JSON.stringify(launch.codegraphRepos)
    }
  })
}

function checkBashCommand(command: string, entry: ActiveReviewTerminal): string | null {
  if (BASH_MODIFY_RE.test(command)) {
    return '规格预检禁止执行修改类命令'
  }
  const redirectRe = new RegExp(BASH_REDIRECT_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = redirectRe.exec(command)) !== null) {
    const targetRaw = match[2]
    if (!targetRaw) {
      continue
    }
    const resolved = resolveAgainstWorkspace(targetRaw, entry.workspacePath)
    if (!isPathInsideDir(resolved, entry.runDir)) {
      return '规格预检禁止重定向写文件'
    }
  }
  return null
}

function readInputField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null
  }
  const value = Object.entries(input).find(([entryKey]) => entryKey === key)?.[1]
  return typeof value === 'string' ? value : null
}

export function evaluateToolGuard(
  event: PluginHooks['agent.tool.before']['event'],
  activeTerminals: ReadonlyMap<string, ActiveReviewTerminal>,
  onViolation?: (runId: string, violation: ToolViolationRecord) => void
): { deny: string } | undefined {
  if (!event.terminalId) {
    return undefined
  }
  const entry = activeTerminals.get(event.terminalId)
  if (!entry) {
    return undefined
  }

  let denyReason: string | null = null
  if (WRITE_TOOLS.has(event.tool)) {
    const rawPath =
      readInputField(event.input, 'file_path') ?? readInputField(event.input, 'notebook_path')
    if (
      !rawPath ||
      !isPathInsideDir(resolveAgainstWorkspace(rawPath, entry.workspacePath), entry.runDir)
    ) {
      denyReason = `规格预检为只读任务，只能写入 ${entry.runDir}`
    }
  } else if (event.tool === 'Bash') {
    denyReason = checkBashCommand(readInputField(event.input, 'command') ?? '', entry)
  }

  if (!denyReason) {
    return undefined
  }
  onViolation?.(entry.runId, { tool: event.tool, detail: denyReason, at: new Date().toISOString() })
  return entry.agent === 'claude' ? { deny: denyReason } : undefined
}

export async function buildPendingPiLaunch(
  orca: OrcaWorkerApi,
  params: {
    runId: string
    specId: string
    workspaceId: string
    workspacePath: string
    runDirAbsolute: string
    codegraphRepos: { key: string; path: string }[]
  }
): Promise<PendingPiLaunch> {
  const wsEntry = (await orca.host.call('workspace.list')).workspaces.find(
    (w) => w.id === params.workspaceId
  )
  const tools = [
    'read',
    'grep',
    'find',
    'ls',
    'pmspec_submit_findings',
    ...(params.codegraphRepos.length > 0 ? ['pmspec_codegraph_explore'] : [])
  ]
  return {
    ...params,
    workspaceKind: wsEntry?.kind ?? 'folder',
    tools,
    expiresAt: Date.now() + 15_000
  }
}

export function startGuardClaimCheck(
  runDir: string,
  onResolved: (guard: 'enforced' | 'unguarded') => void,
  shouldContinue: () => boolean
): ReturnType<typeof setInterval> {
  const claimPath = join(runDir, 'guard-claim.json')
  const deadline = Date.now() + 30_000
  const timer = setInterval(() => {
    if (!shouldContinue()) {
      clearInterval(timer)
      return
    }
    const claimed = existsSync(claimPath)
    if (claimed || Date.now() >= deadline) {
      clearInterval(timer)
      onResolved(claimed ? 'enforced' : 'unguarded')
    }
  }, 500)
  timer.unref?.()
  return timer
}
